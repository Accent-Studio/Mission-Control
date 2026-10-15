//! The HTTP-aware forwarder.
//!
//! `serve` runs a hyper HTTP/1.1 server on any byte stream (an iroh bi-stream
//! in production) and forwards every request to one upstream address. hyper does
//! all the framing, so Content-Length and chunked bodies cannot be confused the
//! way a hand-written parser could confuse them. Bodies stream in both
//! directions without buffering.
//!
//! Every request gets its own fresh TCP connection to the upstream (loopback,
//! so it costs next to nothing). That removes the stale keep-alive race (the
//! server closing an idle socket just as a request is written to it) and keeps
//! one slow request from queueing behind another.
//!
//! Timeouts: the response head must arrive within `Timeouts::head` of the end of
//! the request body; a body that produces no frame for `Timeouts::body_idle` is
//! cut (the server pings its event stream every 25 s, so the default sits well
//! above that); a write to the peer that makes no progress for
//! `Timeouts::write_stall` ends the connection.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::body::{Body as HttpBody, Frame, Incoming, SizeHint};
use hyper::client::conn::http1::SendRequest;
use hyper::header::{HeaderMap, HeaderName, HeaderValue, CONNECTION, CONTENT_LENGTH, HOST, ORIGIN, TRANSFER_ENCODING, UPGRADE};
use hyper::rt::{Read, ReadBufCursor, Write};
use hyper::server::conn::http1 as server_http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode, Version};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpStream;
use tokio::time::Sleep;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
/// Body type used on both sides of the forwarder.
pub type Body = BoxBody<Bytes, BoxError>;

/// Header that tells the caller why a 502 or 504 happened.
pub const BRIDGE_ERROR_HEADER: &str = "x-mc-bridge-error";

/// Largest request body the forwarder lets through.
pub const MAX_REQUEST_BODY: u64 = 48 * 1024 * 1024;

/// How long each part of an exchange may stand still before it is cut.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    /// Response head, counted from the last activity on the request body.
    pub head: Duration,
    /// A request or response body that yields no frame for this long is aborted.
    pub body_idle: Duration,
    /// A write to the peer that makes no progress for this long ends the connection.
    pub write_stall: Duration,
    /// Time to open the upstream TCP connection (loopback: it either works at once or the server is down;
    /// Windows needs about two seconds to report a refused connection, so this answers sooner).
    pub connect: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts {
            head: Duration::from_secs(120),
            body_idle: Duration::from_secs(60),
            write_stall: Duration::from_secs(45),
            connect: Duration::from_secs(1),
        }
    }
}

/// What the forwarder tells the logger about one finished request. The path has
/// no query string and no control characters.
#[derive(Debug, Clone)]
pub struct RequestRecord {
    pub device: String,
    pub method: String,
    pub path: String,
    pub status: u16,
    /// Response body bytes handed to the peer.
    pub bytes: u64,
    pub millis: u64,
}

pub type RequestLog = Arc<dyn Fn(&RequestRecord) + Send + Sync>;

/// Produces headers to add to each upstream request.
pub type InjectFn = Arc<dyn Fn() -> Vec<(HeaderName, HeaderValue)> + Send + Sync>;

/// How long a connection may wait for the next request head. This also bounds an idle keep-alive stream:
/// a browser keeps its connections open between page loads, so the limit is generous, and the phone proxy
/// retries on a fresh stream when an idle one has been closed.
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone)]
pub struct ForwardConfig {
    /// Where requests go (the Mission Control bridge listener).
    pub upstream: SocketAddr,
    /// Value for the upstream `Host` header. The same text, with `http://` in
    /// front, replaces a loopback `Origin`.
    pub host: String,
    /// Id of the authenticated peer, sent as `X-MC-Device` on every request.
    pub device: String,
    /// Extra headers added to every upstream request (fixed values).
    pub inject: Vec<(HeaderName, HeaderValue)>,
    /// Extra headers whose values are looked up for each request, so a value that changes while a stream is
    /// open (the bridge secret, after the server rotated it) is picked up by the next request on that stream.
    pub inject_fn: Option<InjectFn>,
    pub max_body: u64,
    pub timeouts: Timeouts,
    /// Called once per request when its response has been fully handed over (or dropped).
    pub on_request: Option<RequestLog>,
}

impl ForwardConfig {
    pub fn new(upstream: SocketAddr, device: impl Into<String>) -> Self {
        ForwardConfig {
            upstream,
            host: upstream.to_string(),
            device: device.into(),
            inject: Vec::new(),
            inject_fn: None,
            max_body: MAX_REQUEST_BODY,
            timeouts: Timeouts::default(),
            on_request: None,
        }
    }
}

impl std::fmt::Debug for ForwardConfig {
    /// Lists header names only, so the bridge secret never reaches a log.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names: Vec<&str> = self.inject.iter().map(|(k, _)| k.as_str()).collect();
        f.debug_struct("ForwardConfig")
            .field("upstream", &self.upstream)
            .field("host", &self.host)
            .field("device", &self.device)
            .field("inject", &format_args!("{names:?} (values redacted)"))
            .field("max_body", &self.max_body)
            .field("timeouts", &self.timeouts)
            .finish()
    }
}

// ---- Request target checks ----

/// Decodes `%XX` escapes. Returns None for a malformed escape.
fn percent_decode(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    Some(out)
}

fn is_bad_byte(c: u8) -> bool {
    c < 0x20 || c == 0x7f || c == b'\\'
}

/// True when the request target is a plain origin-form path that is safe to
/// judge by its text: no dot segments, empty segments, backslashes or control
/// characters, whether raw or percent-encoded.
fn target_is_clean(uri: &hyper::Uri) -> bool {
    if uri.scheme().is_some() || uri.authority().is_some() {
        return false;
    }
    let raw = uri.path_and_query().map_or(uri.path(), |pq| pq.as_str());
    if !raw.starts_with('/') || raw.bytes().any(is_bad_byte) {
        return false;
    }
    let path = uri.path();
    let lower = path.to_ascii_lowercase();
    if lower.contains("%2f") || lower.contains("%5c") || path.contains("//") {
        return false;
    }
    let Some(decoded) = percent_decode(path) else { return false };
    if decoded.iter().copied().any(is_bad_byte) {
        return false;
    }
    // Checked on the decoded text, which catches %2e and %2E.
    // A single trailing slash is fine (`//` was refused above), so the last segment may be empty.
    let segs: Vec<&[u8]> = decoded.split(|&c| c == b'/').skip(1).collect();
    let body = segs.split_last().map_or(&segs[..], |(_, rest)| rest);
    !body.iter().any(|seg| seg.is_empty() || *seg == b"." || *seg == b"..") && segs.last().is_none_or(|s| *s != b"." && *s != b"..")
}

/// True for `/api/bridge` and everything under it, and for `/__` paths.
fn is_blocked_path(uri: &hyper::Uri) -> bool {
    let decoded = percent_decode(uri.path()).unwrap_or_default();
    let lower = String::from_utf8_lossy(&decoded).to_ascii_lowercase();
    lower == "/api/bridge" || lower.starts_with("/api/bridge/") || lower.starts_with("/__")
}

/// The path for the log: no query string, no fragment, printable ASCII only, at most 160 bytes.
fn log_path(uri: &hyper::Uri) -> String {
    let mut out = String::new();
    for c in uri.path().chars() {
        if out.len() >= 160 {
            out.push_str("...");
            break;
        }
        out.push(if c.is_ascii_graphic() { c } else { '?' });
    }
    if out.is_empty() {
        out.push('/');
    }
    out
}

/// `http://127.0.0.1:1234` or `http://localhost:1234` (any port, no path): the phone's own loopback origin.
fn is_loopback_origin(v: &HeaderValue) -> bool {
    let Ok(s) = v.to_str() else { return false };
    let Some(rest) = s.strip_prefix("http://") else { return false };
    let Some((host, port)) = rest.split_once(':') else { return false };
    (host == "127.0.0.1" || host == "localhost") && (1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit())
}

// ---- Timeout helpers ----

/// A restartable idle timer that only measures time spent waiting: it starts when a
/// poll returns Pending after progress, not while nobody polls (backpressure from
/// the other side is not idleness).
struct Idle {
    limit: Duration,
    sleep: Pin<Box<Sleep>>,
    armed: bool,
}

impl Idle {
    fn new(limit: Duration) -> Self {
        Idle { limit, sleep: Box::pin(tokio::time::sleep(limit)), armed: false }
    }

    fn progressed(&mut self) {
        self.armed = false;
    }

    /// Call when the inner poll returned Pending. True when the limit has run out.
    fn expired(&mut self, cx: &mut Context<'_>) -> bool {
        if !self.armed {
            self.sleep.as_mut().reset(tokio::time::Instant::now() + self.limit);
            self.armed = true;
        }
        self.sleep.as_mut().poll(cx).is_ready()
    }
}

/// Wraps the byte stream to the peer; a write or flush that stays Pending past the limit fails.
struct StallGuard<I> {
    inner: I,
    idle: Idle,
}

impl<I: Read + Unpin> Read for StallGuard<I> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: ReadBufCursor<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<I: Write + Unpin> StallGuard<I> {
    fn guard<T>(&mut self, cx: &mut Context<'_>, r: Poll<io::Result<T>>) -> Poll<io::Result<T>> {
        match r {
            Poll::Pending => {
                if self.idle.expired(cx) {
                    Poll::Ready(Err(io::Error::new(io::ErrorKind::TimedOut, "write to the peer stalled")))
                } else {
                    Poll::Pending
                }
            }
            ready => {
                self.idle.progressed();
                ready
            }
        }
    }
}

impl<I: Write + Unpin> Write for StallGuard<I> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let r = Pin::new(&mut self.inner).poll_write(cx, buf);
        self.guard(cx, r)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let r = Pin::new(&mut self.inner).poll_flush(cx);
        self.guard(cx, r)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let r = Pin::new(&mut self.inner).poll_shutdown(cx);
        self.guard(cx, r)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_write_vectored(mut self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> {
        let r = Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        self.guard(cx, r)
    }
}

/// When the request body last moved, so the head timeout counts from the end of the upload.
struct Activity {
    t0: Instant,
    last_ms: AtomicU64,
}

impl Activity {
    fn new() -> Self {
        Activity { t0: Instant::now(), last_ms: AtomicU64::new(0) }
    }
    fn touch(&self) {
        self.last_ms.store(self.t0.elapsed().as_millis() as u64, Ordering::Relaxed);
    }
    fn quiet_for(&self) -> Duration {
        self.t0.elapsed().saturating_sub(Duration::from_millis(self.last_ms.load(Ordering::Relaxed)))
    }
}

const FLAG_NONE: u8 = 0;
const FLAG_TOO_LARGE: u8 = 1;
const FLAG_IDLE: u8 = 2;

/// The request body on its way upstream: size cap and idle timeout.
struct ReqBody {
    inner: Incoming,
    idle: Idle,
    seen: u64,
    max: u64,
    flag: Arc<AtomicU8>,
    activity: Arc<Activity>,
}

impl HttpBody for ReqBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = &mut *self;
        match Pin::new(&mut this.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                this.idle.progressed();
                this.activity.touch();
                if let Some(d) = frame.data_ref() {
                    this.seen += d.len() as u64;
                    if this.seen > this.max {
                        this.flag.store(FLAG_TOO_LARGE, Ordering::SeqCst);
                        return Poll::Ready(Some(Err("request body is over the limit".into())));
                    }
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(Box::new(e)))),
            Poll::Ready(None) => {
                this.activity.touch();
                Poll::Ready(None)
            }
            Poll::Pending => {
                if this.idle.expired(cx) {
                    this.flag.store(FLAG_IDLE, Ordering::SeqCst);
                    Poll::Ready(Some(Err("request body stalled".into())))
                } else {
                    Poll::Pending
                }
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// The response body on its way to the peer: idle timeout, byte count, and the
/// upstream sender kept alive until the body is done.
struct RespBody {
    inner: Incoming,
    idle: Idle,
    _sender: SendRequest<Body>,
}

impl HttpBody for RespBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = &mut *self;
        match Pin::new(&mut this.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                this.idle.progressed();
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(Box::new(e)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => {
                if this.idle.expired(cx) {
                    Poll::Ready(Some(Err("response body stalled".into())))
                } else {
                    Poll::Pending
                }
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Counts the bytes of the final response body and reports the request when it is dropped.
struct Counted {
    inner: Body,
    bytes: u64,
    pending: Option<(RequestLog, RequestRecord, Instant)>,
}

impl HttpBody for Counted {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = &mut *self;
        let r = Pin::new(&mut this.inner).poll_frame(cx);
        if let Poll::Ready(Some(Ok(frame))) = &r {
            if let Some(d) = frame.data_ref() {
                this.bytes += d.len() as u64;
            }
        }
        r
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        if let Some((log, mut rec, t0)) = self.pending.take() {
            rec.bytes = self.bytes;
            rec.millis = t0.elapsed().as_millis() as u64;
            log(&rec);
        }
    }
}

// ---- Serving ----

/// Serves HTTP/1.1 on `io` until the peer goes away, forwarding to `cfg.upstream`.
pub async fn serve<I>(io: I, cfg: ForwardConfig) -> Result<(), hyper::Error>
where
    I: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let io = StallGuard { inner: io, idle: Idle::new(cfg.timeouts.write_stall) };
    let cfg = Arc::new(cfg);
    let svc = service_fn(move |req: Request<Incoming>| {
        let cfg = cfg.clone();
        async move { Ok::<_, std::convert::Infallible>(handle(&cfg, req).await) }
    });
    server_http1::Builder::new()
        .timer(TokioTimer::new())
        .max_buf_size(64 * 1024)
        .max_headers(100)
        .header_read_timeout(HEADER_READ_TIMEOUT)
        .keep_alive(true)
        .serve_connection(io, svc)
        .await
}

/// Answers every request with 503 and closes. Used when a connection already has its
/// full share of open streams.
pub async fn serve_busy<I>(io: I) -> Result<(), hyper::Error>
where
    I: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let svc = service_fn(|_req: Request<Incoming>| async {
        let mut r = text_response(StatusCode::SERVICE_UNAVAILABLE, "too many open requests", Some("busy"), true);
        r.headers_mut().insert("retry-after", HeaderValue::from_static("1"));
        Ok::<_, std::convert::Infallible>(r)
    });
    server_http1::Builder::new()
        .timer(TokioTimer::new())
        .max_buf_size(16 * 1024)
        .header_read_timeout(Duration::from_secs(10))
        .keep_alive(false)
        .serve_connection(io, svc)
        .await
}

fn text_response(status: StatusCode, msg: &str, bridge_error: Option<&str>, close: bool) -> Response<Body> {
    let mut b = Response::builder().status(status).header("content-type", "application/json");
    if let Some(e) = bridge_error {
        b = b.header(BRIDGE_ERROR_HEADER, e);
    }
    if close {
        b = b.header(CONNECTION, "close");
    }
    let body = format!("{{\"error\":{}}}", serde_json::Value::String(msg.to_owned()));
    b.body(Full::new(Bytes::from(body)).map_err(|never| match never {}).boxed())
        .expect("static response parts are valid")
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(name, "connection" | "keep-alive" | "te" | "trailer" | "transfer-encoding" | "upgrade") || name.starts_with("proxy-")
}

/// Headers that would tell the Mission Control server where a request really came from.
fn is_forwarding_header(name: &str) -> bool {
    matches!(name, "forwarded" | "x-real-ip" | "via" | "expect") || name.starts_with("x-forwarded-")
}

/// Removes hop-by-hop headers, including every header the `Connection` header names.
fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let named: Vec<HeaderName> = headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|s| s.split(','))
        .filter_map(|t| HeaderName::from_bytes(t.trim().as_bytes()).ok())
        .collect();
    for n in named {
        headers.remove(n);
    }
    let doomed: Vec<HeaderName> = headers.keys().filter(|k| is_hop_by_hop(k.as_str())).cloned().collect();
    for n in doomed {
        headers.remove(n);
    }
}

fn wants_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key(UPGRADE)
        || headers
            .get_all(CONNECTION)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .any(|s| s.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")))
}

fn has_body(headers: &HeaderMap) -> bool {
    headers.contains_key(TRANSFER_ENCODING)
        || headers
            .get(CONTENT_LENGTH)
            .is_some_and(|v| v.to_str().ok().and_then(|s| s.trim().parse::<u64>().ok()).is_none_or(|n| n > 0))
}

/// Runs the exchange, then attaches the request log to the response body.
async fn handle(cfg: &ForwardConfig, req: Request<Incoming>) -> Response<Body> {
    let t0 = Instant::now();
    let method = req.method().to_string();
    let path = log_path(req.uri());
    let resp = exchange(cfg, req).await;
    let Some(log) = cfg.on_request.clone() else { return resp };
    let rec = RequestRecord { device: cfg.device.clone(), method, path, status: resp.status().as_u16(), bytes: 0, millis: 0 };
    let (parts, body) = resp.into_parts();
    Response::from_parts(parts, Counted { inner: body, bytes: 0, pending: Some((log, rec, t0)) }.boxed())
}

async fn exchange(cfg: &ForwardConfig, req: Request<Incoming>) -> Response<Body> {
    // An early refusal never reads the request body, so a request that has one closes the stream.
    let refuse = |status: StatusCode, msg: &str, headers: &HeaderMap| text_response(status, msg, None, has_body(headers));

    if req.method() == Method::CONNECT || wants_upgrade(req.headers()) {
        return refuse(StatusCode::NOT_IMPLEMENTED, "not supported", req.headers());
    }
    let uri = req.uri();
    if !target_is_clean(uri) {
        return refuse(StatusCode::BAD_REQUEST, "bad request target", req.headers());
    }
    if is_blocked_path(uri) {
        return refuse(StatusCode::NOT_FOUND, "not found", req.headers());
    }
    let declared = req
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());
    if declared.is_some_and(|n| n > cfg.max_body) {
        return text_response(StatusCode::PAYLOAD_TOO_LARGE, "body too large", None, true);
    }
    // The page's own origin is the phone's loopback address; the Mission Control server only knows its
    // listener address, so a loopback origin is rewritten to that and anything else is refused.
    let origins = req.headers().get_all(ORIGIN);
    let origin_count = origins.iter().count();
    if origin_count > 1 || origins.iter().next().is_some_and(|o| !is_loopback_origin(o)) {
        return refuse(StatusCode::FORBIDDEN, "foreign origin", req.headers());
    }

    let (mut parts, body) = req.into_parts();
    strip_hop_by_hop(&mut parts.headers);
    let doomed: Vec<HeaderName> = parts
        .headers
        .keys()
        .filter(|k| {
            let k = k.as_str();
            (k.starts_with("x-mc-") && k != "x-mc-app") || is_forwarding_header(k)
        })
        .cloned()
        .collect();
    for n in doomed {
        parts.headers.remove(n);
    }
    parts.headers.remove("referer");
    if origin_count == 1 {
        if let Ok(o) = HeaderValue::from_str(&format!("http://{}", cfg.host)) {
            parts.headers.insert(ORIGIN, o);
        }
    }
    if let Ok(h) = HeaderValue::from_str(&cfg.host) {
        parts.headers.insert(HOST, h);
    }
    // The device id is mandatory: without it the request would look internal.
    let device = match HeaderValue::from_str(&cfg.device) {
        Ok(d) if !cfg.device.is_empty() => d,
        _ => return text_response(StatusCode::INTERNAL_SERVER_ERROR, "invalid device id", None, true),
    };
    parts.headers.insert("x-mc-device", device);
    for (k, v) in &cfg.inject {
        let mut v = v.clone();
        v.set_sensitive(true);
        parts.headers.insert(k.clone(), v);
    }
    if let Some(f) = &cfg.inject_fn {
        for (k, mut v) in f() {
            v.set_sensitive(true);
            parts.headers.insert(k, v);
        }
    }
    // One request per upstream connection: the server closes it when the response is done.
    parts.headers.insert(CONNECTION, HeaderValue::from_static("close"));
    parts.version = Version::HTTP_11;

    let flag = Arc::new(AtomicU8::new(FLAG_NONE));
    let activity = Arc::new(Activity::new());
    activity.touch();
    let upstream_body = ReqBody {
        inner: body,
        idle: Idle::new(cfg.timeouts.body_idle),
        seen: 0,
        max: cfg.max_body,
        flag: flag.clone(),
        activity: activity.clone(),
    };
    let upstream_req = Request::from_parts(parts, upstream_body.boxed());

    let down = || text_response(StatusCode::BAD_GATEWAY, "Mission Control is not running", Some("server_down"), false);
    let mut sender = match connect(cfg).await {
        Ok(s) => s,
        Err(_) => return down(),
    };

    // The head timeout counts from the last movement of the request body, so a long upload is not "slow".
    let send = sender.send_request(upstream_req);
    tokio::pin!(send);
    let result = loop {
        let wait = cfg.timeouts.head.saturating_sub(activity.quiet_for());
        tokio::select! {
            r = &mut send => break Some(r),
            _ = tokio::time::sleep(wait) => {
                if activity.quiet_for() >= cfg.timeouts.head {
                    break None;
                }
            }
        }
    };
    match result {
        Some(Ok(resp)) => {
            let (mut parts, body) = resp.into_parts();
            strip_hop_by_hop(&mut parts.headers);
            let body = RespBody { inner: body, idle: Idle::new(cfg.timeouts.body_idle), _sender: sender };
            Response::from_parts(parts, body.boxed())
        }
        Some(Err(_)) => match flag.load(Ordering::SeqCst) {
            FLAG_TOO_LARGE => text_response(StatusCode::PAYLOAD_TOO_LARGE, "body too large", None, true),
            FLAG_IDLE => text_response(StatusCode::REQUEST_TIMEOUT, "request body stalled", None, true),
            _ => text_response(StatusCode::BAD_GATEWAY, "Mission Control did not answer", Some("server_down"), false),
        },
        None => text_response(StatusCode::GATEWAY_TIMEOUT, "Mission Control took too long to answer", Some("timeout"), true),
    }
}

async fn connect(cfg: &ForwardConfig) -> Result<SendRequest<Body>, BoxError> {
    let tcp = tokio::time::timeout(cfg.timeouts.connect, TcpStream::connect(cfg.upstream)).await??;
    tcp.set_nodelay(true)?;
    let (sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tcp)).await?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    Ok(sender)
}
