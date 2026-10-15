//! End to end tests of the PC bridge, offline: real iroh endpoints on loopback
//! (`presets::Minimal`, no relay, no discovery) in front of a fake Mission Control
//! server that behaves like the bridge listener (secret, X-MC marker, pairing,
//! control stream).
//!
//! Numbers match section 6.1 of the phone design: 1 headers, 2 SSE, 3 uploads,
//! 4 downloads, 5 pairing, 6 revocation, 7 server down, 8 the phone's local proxy
//! (`client` module, the tests whose names start with `phone_`), 9 limits.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::body::{Body, Frame, Incoming};
use hyper::client::conn::http1::SendRequest;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use iroh::endpoint::{presets, Connection, ConnectionError};
use iroh::Endpoint;
use mc_bridge::bridge::{Bridge, Exit, Limits, Options};
use mc_bridge::client::{Client, ClientConfig, Link, ProxyHandle, SavedState};
use mc_bridge::forward::Timeouts;
use mc_bridge::logfile::LogFile;
use mc_bridge::stream_io;
use mc_bridge::wire::{self, PairReply, PairRequest, ALPN_HTTP, ALPN_PAIR};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinSet;

type B = BoxBody<Bytes, Infallible>;

const SECRET: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
/// What the server changes the secret to in the tests about a rotated secret.
const SECRET_NEW: &str = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
const CODE: &str = "TEST-CODE";
const MIB: usize = 1024 * 1024;

// ---- Small helpers ----

fn full(s: impl Into<Bytes>) -> B {
    Full::new(s.into()).boxed()
}

/// FNV-1a, enough to prove bytes arrive intact and in order.
fn fnv(mut h: u64, data: &[u8]) -> u64 {
    for b in data {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}
const FNV_START: u64 = 0xcbf2_9ce4_8422_2325;

fn pattern(len: usize) -> Bytes {
    Bytes::from((0..len).map(|i| (i.wrapping_mul(31) % 251) as u8).collect::<Vec<u8>>())
}

async fn wait_until(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(secs);
    while !f() {
        assert!(Instant::now() < end, "timed out waiting for: {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> TempDir {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!("mcb-e2e-{}-{}-{tag}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A body fed by a channel. `_guard` is dropped with the body, which is how the fake
/// notices that the bridge closed its connection.
struct ChanBody {
    rx: mpsc::Receiver<Bytes>,
    _guard: Option<CountGuard>,
}

impl Body for ChanBody {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.rx.poll_recv(cx).map(|o| o.map(|b| Ok(Frame::data(b))))
    }
}

struct CountGuard(Arc<AtomicUsize>);

impl CountGuard {
    fn new(c: &Arc<AtomicUsize>) -> CountGuard {
        c.fetch_add(1, Ordering::SeqCst);
        CountGuard(c.clone())
    }
}

impl Drop for CountGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Produces `left` bytes on demand, so the counter shows how far the producer got.
struct GenBody {
    left: u64,
    sent: Arc<AtomicU64>,
    chunk: Bytes,
}

impl Body for GenBody {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        if self.left == 0 {
            return Poll::Ready(None);
        }
        let n = (self.left as usize).min(self.chunk.len());
        self.left -= n as u64;
        self.sent.fetch_add(n as u64, Ordering::SeqCst);
        Poll::Ready(Some(Ok(Frame::data(self.chunk.slice(..n)))))
    }
    fn size_hint(&self) -> hyper::body::SizeHint {
        hyper::body::SizeHint::with_exact(self.left)
    }
}

// ---- The fake Mission Control ----

struct PairState {
    code: Option<String>,
    failures: u32,
    expired: bool,
}

struct FakeState {
    port: u16,
    devices: Mutex<Vec<String>>,
    control_tx: broadcast::Sender<String>,
    pair: Mutex<PairState>,
    pair_calls: AtomicUsize,
    hello: Mutex<Vec<Value>>,
    presence: Mutex<Vec<Value>>,
    uploads: Mutex<Vec<String>>,
    echo_hits: AtomicUsize,
    streams_open: Arc<AtomicUsize>,
    control_opens: AtomicUsize,
    big_sent: Arc<AtomicU64>,
    /// The secret the fake accepts.
    secret: Mutex<String>,
    /// The next presence call is answered 400 ms late (shows whether reports keep their order).
    presence_slow_first: AtomicBool,
}

struct FakeMc {
    state: Arc<FakeState>,
    addr: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

fn normalize(s: &str) -> String {
    s.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_uppercase()
}

fn sse(msg: &str) -> Bytes {
    Bytes::from(format!("data: {msg}\n\n"))
}

impl FakeMc {
    async fn start(devices: Vec<String>, port: Option<u16>) -> FakeMc {
        let listener = TcpListener::bind(("127.0.0.1", port.unwrap_or(0))).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (control_tx, _) = broadcast::channel(16);
        let state = Arc::new(FakeState {
            port: addr.port(),
            devices: Mutex::new(devices),
            control_tx,
            pair: Mutex::new(PairState { code: Some(CODE.to_owned()), failures: 0, expired: false }),
            pair_calls: AtomicUsize::new(0),
            hello: Mutex::default(),
            presence: Mutex::default(),
            uploads: Mutex::default(),
            echo_hits: AtomicUsize::new(0),
            streams_open: Arc::default(),
            control_opens: AtomicUsize::new(0),
            big_sent: Arc::default(),
            secret: Mutex::new(SECRET.to_owned()),
            presence_slow_first: AtomicBool::new(false),
        });
        let st = state.clone();
        // The JoinSet lives inside the task: aborting the task closes the listener and every connection.
        let task = tokio::spawn(async move {
            let mut conns = JoinSet::new();
            loop {
                let Ok((tcp, _)) = listener.accept().await else { return };
                let st = st.clone();
                conns.spawn(async move {
                    let svc = service_fn(move |req| handle(st.clone(), req));
                    let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tcp), svc).await;
                });
            }
        });
        FakeMc { state, addr, task }
    }

    async fn stop(self) {
        self.task.abort();
        let _ = self.task.await;
    }

    fn push_control(&self, v: Value) {
        let _ = self.state.control_tx.send(v.to_string());
    }
}

fn header(req: &Request<Incoming>, name: &str) -> Option<String> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

fn json_response(status: u16, v: Value) -> Response<B> {
    Response::builder().status(status).header("content-type", "application/json").body(full(v.to_string())).unwrap()
}

async fn handle(st: Arc<FakeState>, req: Request<Incoming>) -> Result<Response<B>, Infallible> {
    // The real listener answers 401 to anything without the secret and 403 to a wrong Host.
    let secret = st.secret.lock().unwrap().clone();
    if header(&req, "x-mc-bridge").as_deref() != Some(secret.as_str()) {
        return Ok(json_response(401, json!({})));
    }
    if header(&req, "host").as_deref() != Some(&format!("127.0.0.1:{}", st.port)) {
        return Ok(json_response(403, json!({"error": "host"})));
    }
    let path = req.uri().path().to_owned();
    let method = req.method().to_string();
    let is_control_call = path.starts_with("/api/bridge/");
    let has_device = req.headers().contains_key("x-mc-device");
    if is_control_call && has_device {
        return Ok(json_response(403, json!({"error": "device on a control call"})));
    }
    if method == "POST" && is_control_call && header(&req, "x-mc").as_deref() != Some("1") {
        return Ok(json_response(403, json!({"error": "x-mc"})));
    }
    Ok(match (method.as_str(), path.as_str()) {
        (_, "/echo") => {
            st.echo_hits.fetch_add(1, Ordering::SeqCst);
            let h = |n: &str| header(&req, n);
            let v = json!({
                "method": method,
                "query": req.uri().query(),
                "host": h("host"),
                "origin": h("origin"),
                "x_mc": h("x-mc"),
                "device": h("x-mc-device"),
                "secret_ok": h("x-mc-bridge").as_deref() == Some(secret.as_str()),
                "forged": h("x-mc-evil"),
                "app": h("x-mc-app"),
                "referer": h("referer"),
                "forwarded": h("forwarded"),
                "xff": h("x-forwarded-for"),
                "real_ip": h("x-real-ip"),
                "via": h("via"),
                "expect": h("expect"),
                "te": h("te"),
                "connection": h("connection"),
                "cookie": h("cookie"),
            });
            let len = req.into_body().collect().await.map_or(0, |b| b.to_bytes().len());
            let mut v = v;
            v["body_len"] = json!(len);
            json_response(200, v)
        }
        ("GET", "/sse") => {
            let (tx, rx) = mpsc::channel(1);
            let guard = CountGuard::new(&st.streams_open);
            tokio::spawn(async move {
                for i in 0..5 {
                    if tx.send(sse(&format!("{{\"n\":{i}}}"))).await.is_err() {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
            });
            Response::builder()
                .header("content-type", "text/event-stream")
                .header("cache-control", "no-store")
                .body(ChanBody { rx, _guard: Some(guard) }.boxed())
                .unwrap()
        }
        // Answers at once and then never finishes: holds a stream open.
        ("GET", "/stream") => {
            let (tx, rx) = mpsc::channel(1);
            let guard = CountGuard::new(&st.streams_open);
            tokio::spawn(async move {
                while tx.send(Bytes::from_static(b": hold\n\n")).await.is_ok() {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            });
            Response::builder().header("content-type", "text/event-stream").body(ChanBody { rx, _guard: Some(guard) }.boxed()).unwrap()
        }
        ("POST", "/upload") => {
            let mut body = req.into_body();
            let (mut n, mut sum) = (0usize, FNV_START);
            while let Some(frame) = body.frame().await {
                match frame {
                    Ok(f) => {
                        if let Some(d) = f.data_ref() {
                            n += d.len();
                            sum = fnv(sum, d);
                        }
                    }
                    Err(_) => {
                        st.uploads.lock().unwrap().push(format!("aborted n={n}"));
                        return Ok(json_response(400, json!({})));
                    }
                }
            }
            let result = format!("len={n} sum={sum:x}");
            st.uploads.lock().unwrap().push(result.clone());
            Response::new(full(result))
        }
        // Never answers at all.
        ("GET", "/hang") => {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            json_response(200, json!({}))
        }
        ("GET", "/big") => Response::new(GenBody { left: 80 * MIB as u64, sent: st.big_sent.clone(), chunk: pattern(64 * 1024) }.boxed()),
        ("POST", "/api/bridge/hello") => {
            let v: Value = serde_json::from_slice(&req.into_body().collect().await.unwrap().to_bytes()).unwrap();
            st.hello.lock().unwrap().push(v);
            json_response(200, json!({"ok": true}))
        }
        ("POST", "/api/bridge/presence") => {
            let v: Value = serde_json::from_slice(&req.into_body().collect().await.unwrap().to_bytes()).unwrap();
            if st.presence_slow_first.swap(false, Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
            st.presence.lock().unwrap().push(v);
            json_response(200, json!({"ok": true}))
        }
        ("POST", "/api/bridge/pair") => {
            st.pair_calls.fetch_add(1, Ordering::SeqCst);
            let v: Value = serde_json::from_slice(&req.into_body().collect().await.unwrap().to_bytes()).unwrap();
            let mut p = st.pair.lock().unwrap();
            let given = normalize(v["code"].as_str().unwrap_or(""));
            let good = !p.expired && p.code.as_deref().map(normalize).as_deref() == Some(given.as_str());
            if good {
                p.code = None;
                drop(p);
                let id = v["endpointId"].as_str().unwrap().to_owned();
                st.devices.lock().unwrap().push(id.clone());
                let _ = st.control_tx.send(json!({"type": "add", "id": id}).to_string());
                json_response(200, json!({"ok": true, "serverName": "TestPC"}))
            } else {
                p.failures += 1;
                if p.failures >= 5 {
                    p.code = None;
                }
                json_response(200, json!({"ok": false, "code": "bad_code"}))
            }
        }
        ("GET", "/api/bridge/control") => {
            st.control_opens.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = mpsc::channel(16);
            let ids = st.devices.lock().unwrap().clone();
            let mut sub = st.control_tx.subscribe();
            tokio::spawn(async move {
                let _ = tx.send(Bytes::from_static(b"retry: 1000\n\n")).await;
                let _ = tx.send(sse(&json!({"type": "devices", "ids": ids}).to_string())).await;
                loop {
                    tokio::select! {
                        _ = tx.closed() => return,
                        m = sub.recv() => match m {
                            Ok(m) => { if tx.send(sse(&m)).await.is_err() { return; } }
                            Err(broadcast::error::RecvError::Lagged(_)) => {}
                            Err(_) => return,
                        },
                    }
                }
            });
            Response::builder().header("content-type", "text/event-stream").body(ChanBody { rx, _guard: None }.boxed()).unwrap()
        }
        _ => json_response(404, json!({"error": "not found"})),
    })
}

// ---- The rig: fake server + bridge + one paired client endpoint ----

struct RigOpts {
    paired: bool,
    limits: Limits,
    timeouts: Timeouts,
    start_server: bool,
}

impl Default for RigOpts {
    fn default() -> Self {
        RigOpts { paired: true, limits: Limits::default(), timeouts: Timeouts::default(), start_server: true }
    }
}

struct Rig {
    mc: Option<FakeMc>,
    bridge: Bridge,
    client: Endpoint,
    log: Arc<LogFile>,
    _tmp: TempDir,
}

async fn new_endpoint() -> Endpoint {
    Endpoint::builder(presets::Minimal).bind_addr("127.0.0.1:0").unwrap().bind().await.unwrap()
}

impl Rig {
    async fn new(o: RigOpts) -> Rig {
        let tmp = TempDir::new("rig");
        let client = new_endpoint().await;
        let devices = if o.paired { vec![client.id().to_string()] } else { vec![] };
        let (mc, mc_addr) = if o.start_server {
            let mc = FakeMc::start(devices, None).await;
            let a = mc.addr;
            (Some(mc), a)
        } else {
            // An address where nothing listens.
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            (None, l.local_addr().unwrap())
        };
        let log = Arc::new(LogFile::memory());
        let mut opts = Options::new(tmp.0.join("endpoint.key"), mc_addr, SECRET.to_owned(), log.clone());
        opts.relay = false;
        opts.bind = Some("127.0.0.1:0".parse().unwrap());
        opts.restrict_key_acl = false;
        opts.limits = o.limits;
        opts.timeouts = o.timeouts;
        let bridge = Bridge::start(opts).await.unwrap();
        let rig = Rig { mc, bridge, client, log, _tmp: tmp };
        if o.paired && o.start_server {
            let id = rig.client.id().to_string();
            wait_until("device list received", 10, || rig.bridge.allowed().contains(&id)).await;
        }
        rig
    }

    fn mc(&self) -> &FakeState {
        &self.mc.as_ref().unwrap().state
    }

    async fn connect(&self, ep: &Endpoint, alpn: &[u8]) -> Connection {
        ep.connect(self.bridge.direct_addr(), alpn).await.unwrap()
    }

    async fn http_conn(&self) -> Connection {
        self.connect(&self.client, ALPN_HTTP).await
    }

    async fn close(self) {
        self.client.close().await;
        self.bridge.shutdown().await;
        if let Some(mc) = self.mc {
            mc.stop().await;
        }
    }
}

/// A hyper client on a fresh bi-stream (the phone opens one per WebView connection).
async fn open_http(conn: &Connection) -> SendRequest<B> {
    let (send, recv) = conn.open_bi().await.unwrap();
    let (sender, driver) = hyper::client::conn::http1::handshake(stream_io(recv, send)).await.unwrap();
    tokio::spawn(async move {
        let _ = driver.await;
    });
    sender
}

fn get(path: &str) -> Request<B> {
    Request::get(path).header("host", "phone.invalid").body(full(Bytes::new())).unwrap()
}

async fn text(resp: Response<Incoming>) -> String {
    String::from_utf8(resp.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
}

async fn json_of(resp: Response<Incoming>) -> Value {
    serde_json::from_str(&text(resp).await).unwrap()
}

async fn close_code(conn: &Connection) -> u64 {
    match tokio::time::timeout(Duration::from_secs(5), conn.closed()).await {
        Ok(ConnectionError::ApplicationClosed(c)) => u64::from(c.error_code),
        other => panic!("expected an application close, got {other:?}"),
    }
}

/// One pairing attempt on its own connection.
async fn try_pair(rig: &Rig, ep: &Endpoint, code: &str) -> PairReply {
    let conn = rig.connect(ep, ALPN_PAIR).await;
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    wire::write_json(&mut send, &PairRequest::Pair { code: code.to_owned(), device_name: "Test phone".to_owned() }).await.unwrap();
    let reply = wire::read_json::<_, PairReply>(&mut recv).await;
    conn.close(0u32.into(), b"done");
    reply.unwrap_or_else(|e| PairReply::Error { code: "stream_error".to_owned(), message: e.to_string() })
}

fn is_error(r: &PairReply, code: &str) -> bool {
    matches!(r, PairReply::Error { code: c, .. } if c == code)
}

/// One pairing attempt from an endpoint that has not been seen before.
async fn stranger_pair(rig: &Rig, code: &str) -> PairReply {
    let ep = new_endpoint().await;
    let reply = try_pair(rig, &ep, code).await;
    ep.close().await;
    reply
}

fn count_lines(rig: &Rig, needle: &str) -> usize {
    rig.log.lines().iter().filter(|l| l.contains(needle)).count()
}

/// The newest presence report for a device: Some(true) online, Some(false) offline.
fn last_presence(rig: &Rig, id: &str) -> Option<bool> {
    rig.mc().presence.lock().unwrap().iter().rev().find(|p| p["id"] == id).and_then(|p| p["online"].as_bool())
}

fn quick_opts(tmp: &TempDir, server: SocketAddr, secret: &str, log: Arc<LogFile>) -> Options {
    let mut opts = Options::new(tmp.0.join("endpoint.key"), server, secret.to_owned(), log);
    opts.relay = false;
    opts.bind = Some("127.0.0.1:0".parse().unwrap());
    opts.restrict_key_acl = false;
    opts
}

async fn within<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(180), f).await.expect("test timed out")
}

// ---- 1. Headers ----

#[tokio::test(flavor = "multi_thread")]
async fn headers_are_rewritten_and_forgeries_dropped() {
    within(async {
        let rig = Rig::new(RigOpts::default()).await;
        let conn = rig.http_conn().await;
        let mut http = open_http(&conn).await;
        let port = rig.mc().port;

        // A loopback Origin on a POST is rewritten; everything the phone must not control is gone.
        let req = Request::post("/echo?x=1")
            .header("host", "127.0.0.1:55555")
            .header("origin", "http://127.0.0.1:55555")
            .header("referer", "http://127.0.0.1:55555/page")
            .header("x-mc", "1")
            .header("x-mc-device", "evil")
            .header("x-mc-bridge", "wrong")
            .header("x-mc-evil", "1")
            .header("x-mc-app", "0.1")
            .header("forwarded", "for=1.2.3.4")
            .header("x-forwarded-for", "1.2.3.4")
            .header("x-forwarded-host", "evil.example")
            .header("x-real-ip", "1.2.3.4")
            .header("via", "1.1 evil")
            .header("expect", "100-continue")
            .header("te", "trailers")
            .body(full("hello"))
            .unwrap();
        let resp = http.send_request(req).await.unwrap();
        assert_eq!(resp.status(), 200);
        let v = json_of(resp).await;
        assert_eq!(v["device"], rig.client.id().to_string());
        assert_eq!(v["secret_ok"], true);
        assert_eq!(v["host"], format!("127.0.0.1:{port}"));
        assert_eq!(v["origin"], format!("http://127.0.0.1:{port}"));
        assert_eq!(v["x_mc"], "1");
        assert_eq!(v["app"], "0.1");
        assert_eq!(v["query"], "x=1");
        assert_eq!(v["body_len"], 5);
        for gone in ["forged", "referer", "forwarded", "xff", "real_ip", "via", "expect", "te"] {
            assert!(v[gone].is_null(), "{gone} reached the server: {v}");
        }
        assert_eq!(v["connection"], "close");

        // No Origin stays no Origin; a localhost origin is accepted too.
        let resp = http.send_request(get("/echo")).await.unwrap();
        assert!(json_of(resp).await["origin"].is_null());
        let req = Request::get("/echo").header("host", "x").header("origin", "http://localhost:1").body(full(Bytes::new())).unwrap();
        let resp = http.send_request(req).await.unwrap();
        assert_eq!(json_of(resp).await["origin"], format!("http://127.0.0.1:{port}"));

        // Foreign origins never leave the bridge.
        let hits = rig.mc().echo_hits.load(Ordering::SeqCst);
        for origin in ["http://evil.example", "https://127.0.0.1:1", "http://127.0.0.1.evil.example:80", "null", "http://127.0.0.1", "http://127.0.0.1:12345/x"] {
            let req = Request::post("/echo").header("host", "x").header("origin", origin).header("x-mc", "1").body(full("x")).unwrap();
            let mut fresh = open_http(&conn).await;
            let resp = fresh.send_request(req).await.unwrap();
            assert_eq!(resp.status(), 403, "origin {origin}");
        }
        assert_eq!(rig.mc().echo_hits.load(Ordering::SeqCst), hits, "a foreign origin reached the server");

        // Upgrades, the bridge's private namespace and the phone's own namespace.
        let mut fresh = open_http(&conn).await;
        let req = Request::get("/echo").header("host", "x").header("connection", "upgrade").header("upgrade", "websocket").body(full(Bytes::new())).unwrap();
        assert_eq!(fresh.send_request(req).await.unwrap().status(), 501);
        let mut fresh = open_http(&conn).await;
        for p in ["/api/bridge/x", "/api/bridge/control", "/__app/x", "/__mc/enter"] {
            let resp = fresh.send_request(get(p)).await.unwrap();
            assert_eq!(resp.status(), 404, "{p}");
            text(resp).await;
        }
        assert_eq!(rig.mc().echo_hits.load(Ordering::SeqCst), hits);
        drop(conn);
        rig.close().await;
    })
    .await;
}

// ---- 2. SSE ----

#[tokio::test(flavor = "multi_thread")]
async fn sse_arrives_in_chunks_and_client_close_closes_upstream() {
    within(async {
        let rig = Rig::new(RigOpts::default()).await;
        let conn = rig.http_conn().await;
        let mut http = open_http(&conn).await;
        let start = Instant::now();
        let resp = http.send_request(get("/sse")).await.unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.headers().get("content-type").unwrap(), "text/event-stream");
        assert_eq!(rig.mc().streams_open.load(Ordering::SeqCst), 1);
        let mut body = resp.into_body();
        let (mut first, mut last, mut all) = (None, Duration::ZERO, String::new());
        while let Some(frame) = body.frame().await {
            if let Some(d) = frame.unwrap().data_ref() {
                first.get_or_insert(start.elapsed());
                last = start.elapsed();
                all.push_str(std::str::from_utf8(d).unwrap());
            }
        }
        let first = first.unwrap();
        assert_eq!(all.matches("data:").count(), 5, "{all}");
        // The fake sends its fifth event 600 ms after the first; the first must not wait for it.
        assert!(first < Duration::from_millis(400), "first event took {first:?}");
        assert!(last >= first + Duration::from_millis(500), "events were buffered: {first:?} then {last:?}");

        // A client that walks away closes the upstream socket quickly.
        let mut http = open_http(&conn).await;
        let resp = http.send_request(get("/stream")).await.unwrap();
        assert_eq!(rig.mc().streams_open.load(Ordering::SeqCst), 1);
        drop(resp);
        drop(http);
        let t = Instant::now();
        wait_until("upstream stream closed", 5, || rig.mc().streams_open.load(Ordering::SeqCst) == 0).await;
        assert!(t.elapsed() < Duration::from_secs(1), "upstream took {:?} to notice", t.elapsed());
        drop(conn);
        rig.close().await;
    })
    .await;
}

// ---- 3. Uploads ----

async fn upload(rig: &Rig, data: &Bytes, chunked: bool) -> Result<u16, String> {
    let conn = rig.http_conn().await;
    let mut http = open_http(&conn).await;
    let body: B = if chunked {
        // No Content-Length, so hyper sends Transfer-Encoding: chunked.
        let (tx, rx) = mpsc::channel(4);
        let data = data.clone();
        tokio::spawn(async move {
            for piece in data.chunks(64 * 1024) {
                if tx.send(data.slice_ref(piece)).await.is_err() {
                    return;
                }
            }
        });
        ChanBody { rx, _guard: None }.boxed()
    } else {
        full(data.clone())
    };
    let req = Request::post("/upload").header("host", "x").header("x-mc", "1").body(body).unwrap();
    match http.send_request(req).await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if status == 413 {
                assert_eq!(resp.headers().get("connection").map(|v| v.to_str().unwrap()), Some("close"), "413 must close the stream");
            }
            let _ = resp.into_body().collect().await;
            Ok(status)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn uploads_arrive_byte_exact_and_the_cap_holds() {
    within(async {
        let rig = Rig::new(RigOpts::default()).await;
        let data = pattern(40 * MIB);
        let want = format!("len={} sum={:x}", data.len(), fnv(FNV_START, &data));
        for chunked in [false, true] {
            assert_eq!(upload(&rig, &data, chunked).await, Ok(200), "chunked={chunked}");
            let got = rig.mc().uploads.lock().unwrap().last().cloned().unwrap();
            assert_eq!(got, want, "chunked={chunked}");
        }

        // 49 MiB with a Content-Length: refused before anything is read.
        let before = rig.mc().uploads.lock().unwrap().len();
        let big = pattern(49 * MIB);
        let r = upload(&rig, &big, false).await;
        eprintln!("oversized upload result: {r:?}");
        assert!(matches!(r, Ok(413) | Err(_)), "{r:?}");
        // 49 MiB chunked: cut at the cap.
        let r = upload(&rig, &big, true).await;
        eprintln!("oversized upload result: {r:?}");
        assert!(matches!(r, Ok(413) | Err(_)), "{r:?}");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let uploads = rig.mc().uploads.lock().unwrap().clone();
        assert!(uploads[before..].iter().all(|u| !u.starts_with("len=")), "an oversized upload completed: {uploads:?}");
        rig.close().await;
    })
    .await;
}

// ---- 4. Downloads ----

#[tokio::test(flavor = "multi_thread")]
async fn download_with_a_slow_reader_does_not_run_ahead() {
    within(async {
        let rig = Rig::new(RigOpts::default()).await;
        let conn = rig.http_conn().await;
        let mut http = open_http(&conn).await;
        let resp = http.send_request(get("/big")).await.unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.headers().get("content-length").unwrap(), &(80 * MIB).to_string());
        let mut body = resp.into_body();
        let (mut got, mut sum) = (0usize, FNV_START);
        // Read about 1.5 MiB slowly while the fake would happily produce 80 MiB.
        let slow_until = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < slow_until {
            let frame = body.frame().await.unwrap().unwrap();
            let d = frame.into_data().unwrap();
            got += d.len();
            sum = fnv(sum, &d);
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        let ahead = rig.mc().big_sent.load(Ordering::SeqCst) as usize - got;
        assert!(ahead < 32 * MIB, "the server produced {ahead} bytes more than the reader took: no backpressure");
        while let Some(frame) = body.frame().await {
            let d = frame.unwrap().into_data().unwrap();
            got += d.len();
            sum = fnv(sum, &d);
        }
        let chunk = pattern(64 * 1024);
        let want = (0..(80 * MIB / chunk.len())).fold(FNV_START, |h, _| fnv(h, &chunk));
        assert_eq!(got, 80 * MIB);
        assert_eq!(sum, want, "download arrived damaged");
        drop(conn);
        rig.close().await;
    })
    .await;
}

// ---- 5. Pairing ----

#[tokio::test(flavor = "multi_thread")]
async fn unpaired_endpoint_is_closed_before_any_stream() {
    within(async {
        let rig = Rig::new(RigOpts { paired: false, ..RigOpts::default() }).await;
        let stranger = new_endpoint().await;
        let conn = rig.connect(&stranger, ALPN_HTTP).await;
        assert_eq!(close_code(&conn).await, 1);
        assert!(conn.open_bi().await.is_err() || conn.close_reason().is_some());
        assert_eq!(rig.mc().echo_hits.load(Ordering::SeqCst), 0);
        assert!(rig.bridge.connected().is_empty());
        stranger.close().await;
        rig.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn right_code_works_once_and_five_wrong_codes_burn_it() {
    within(async {
        // The right code works once, then the paired phone can use the tunnel.
        let rig = Rig::new(RigOpts { paired: false, ..RigOpts::default() }).await;
        let phone = new_endpoint().await;
        let reply = try_pair(&rig, &phone, "test-code").await;
        assert!(matches!(reply, PairReply::Paired { ref server_name } if server_name == "TestPC"), "{reply:?}");
        assert!(rig.bridge.allowed().contains(&phone.id().to_string()));
        let conn = rig.connect(&phone, ALPN_HTTP).await;
        let mut http = open_http(&conn).await;
        let resp = http.send_request(get("/echo")).await.unwrap();
        assert_eq!(json_of(resp).await["device"], phone.id().to_string());
        let again = try_pair(&rig, &new_endpoint().await, CODE).await;
        assert!(is_error(&again, "bad_code"), "{again:?}");
        drop(conn);
        phone.close().await;
        rig.close().await;

        // Five wrong codes burn the right one: attempt six fails with the correct code.
        let rig = Rig::new(RigOpts { paired: false, ..RigOpts::default() }).await;
        let phone = new_endpoint().await;
        // (Each try comes from a new endpoint: one endpoint is capped at three wrong codes a minute.)
        for i in 0..5 {
            let r = stranger_pair(&rig, &format!("WRONG-{i}0000")).await;
            assert!(is_error(&r, "bad_code"), "{r:?}");
        }
        let r = try_pair(&rig, &phone, CODE).await;
        assert!(is_error(&r, "bad_code"), "the burned code still worked: {r:?}");
        assert!(rig.bridge.allowed().is_empty());
        phone.close().await;
        rig.close().await;

        // An expired code fails.
        let rig = Rig::new(RigOpts { paired: false, ..RigOpts::default() }).await;
        rig.mc().pair.lock().unwrap().expired = true;
        let phone = new_endpoint().await;
        let r = try_pair(&rig, &phone, CODE).await;
        assert!(is_error(&r, "bad_code"), "{r:?}");
        phone.close().await;
        rig.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn pair_stream_limits_size_time_and_rate() {
    within(async {
        let limits = Limits { pair_read_timeout: Duration::from_secs(1), ..Limits::default() };
        let rig = Rig::new(RigOpts { paired: false, limits, ..RigOpts::default() }).await;
        let phone = new_endpoint().await;

        // More than 4 KiB: refused, and the server never hears of it.
        let conn = rig.connect(&phone, ALPN_PAIR).await;
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        send.write_all(&5000u32.to_le_bytes()).await.unwrap();
        send.write_all(&vec![b'x'; 5000]).await.ok();
        let reply = wire::read_json::<_, PairReply>(&mut recv).await;
        eprintln!("pair stream limit result: {reply:?}");
        assert!(!matches!(reply, Ok(PairReply::Paired { .. })), "{reply:?}");
        if let Ok(r) = &reply {
            assert!(is_error(r, "bridge_error"), "{r:?}");
        }
        conn.close(0u32.into(), b"done");

        // Silence: the bridge gives up after the read timeout (one second here).
        let conn = rig.connect(&phone, ALPN_PAIR).await;
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        send.write_all(&[1]).await.unwrap(); // a stream only exists for the peer once a byte is sent
        let t = Instant::now();
        let reply = wire::read_json::<_, PairReply>(&mut recv).await;
        assert!(t.elapsed() < Duration::from_secs(5), "took {:?}", t.elapsed());
        eprintln!("pair stream limit result: {reply:?}");
        assert!(!matches!(reply, Ok(PairReply::Paired { .. })), "{reply:?}");
        conn.close(0u32.into(), b"done");
        assert_eq!(rig.mc().pair_calls.load(Ordering::SeqCst), 0);

        // Six wrong codes a minute in total; the seventh is turned away without asking the server.
        // The two failed requests above did not use any of the six.
        for i in 0..6 {
            let r = stranger_pair(&rig, &format!("NOPE-{i}0000")).await;
            assert!(is_error(&r, "bad_code"), "attempt {i}: {r:?}");
        }
        let r = stranger_pair(&rig, CODE).await;
        assert!(is_error(&r, "rate_limited"), "{r:?}");
        assert_eq!(rig.mc().pair_calls.load(Ordering::SeqCst), 6);
        assert!(rig.bridge.allowed().is_empty(), "the right code worked while the bridge was locked");
        phone.close().await;
        rig.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn one_endpoint_has_its_own_cap_and_only_wrong_codes_count() {
    within(async {
        // One endpoint: three wrong codes, then it is turned away even with the right code.
        let rig = Rig::new(RigOpts { paired: false, ..RigOpts::default() }).await;
        let phone = new_endpoint().await;
        for i in 0..3 {
            let r = try_pair(&rig, &phone, &format!("NOPE-{i}0000")).await;
            assert!(is_error(&r, "bad_code"), "attempt {i}: {r:?}");
        }
        let r = try_pair(&rig, &phone, CODE).await;
        assert!(is_error(&r, "rate_limited"), "{r:?}");
        assert_eq!(rig.mc().pair_calls.load(Ordering::SeqCst), 3);
        // Someone else is not affected by that endpoint's wrong codes.
        let other = stranger_pair(&rig, CODE).await;
        assert!(matches!(other, PairReply::Paired { .. }), "{other:?}");
        phone.close().await;
        rig.close().await;

        // A right code uses nothing up: with room for one wrong code, two pairings and one wrong code all get through.
        let limits = Limits { pair_attempts: 1, ..Limits::default() };
        let rig = Rig::new(RigOpts { paired: false, limits, ..RigOpts::default() }).await;
        for _ in 0..2 {
            rig.mc().pair.lock().unwrap().code = Some(CODE.to_owned());
            let r = stranger_pair(&rig, CODE).await;
            assert!(matches!(r, PairReply::Paired { .. }), "{r:?}");
        }
        let r = stranger_pair(&rig, "NOPE-00000").await;
        assert!(is_error(&r, "bad_code"), "{r:?}");
        let r = stranger_pair(&rig, "NOPE-11111").await;
        assert!(is_error(&r, "rate_limited"), "{r:?}");
        rig.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_silent_peer_does_not_block_a_real_pair() {
    within(async {
        // A long read timeout: the silent peers below hold their connections for the whole test.
        let limits = Limits { pair_read_timeout: Duration::from_secs(30), ..Limits::default() };
        let rig = Rig::new(RigOpts { paired: false, limits, ..RigOpts::default() }).await;
        let mut silent = Vec::new();
        // More silent peers than the old limit of 16 slots.
        for _ in 0..20 {
            let ep = new_endpoint().await;
            let conn = rig.connect(&ep, ALPN_PAIR).await;
            let (mut send, recv) = conn.open_bi().await.unwrap();
            send.write_all(&[1]).await.unwrap();
            silent.push((ep, conn, send, recv));
        }
        // Give the bridge time to pick the silent streams up before the real phone shows up.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let t = Instant::now();
        let reply = tokio::time::timeout(Duration::from_secs(5), stranger_pair(&rig, CODE)).await.expect("the real pairing waited behind a silent peer");
        assert!(matches!(reply, PairReply::Paired { .. }), "{reply:?}");
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
        for (ep, conn, _, _) in silent {
            conn.close(0u32.into(), b"done");
            ep.close().await;
        }
        rig.close().await;
    })
    .await;
}

// ---- 6. Revocation ----

#[tokio::test(flavor = "multi_thread")]
async fn revoke_ends_streams_closes_the_connection_and_blocks_redial() {
    within(async {
        let rig = Rig::new(RigOpts::default()).await;
        let conn = rig.http_conn().await;
        let mut http = open_http(&conn).await;
        let resp = http.send_request(get("/stream")).await.unwrap();
        assert_eq!(rig.mc().streams_open.load(Ordering::SeqCst), 1);
        let id = rig.client.id().to_string();
        wait_until("presence reported online", 5, || rig.mc().presence.lock().unwrap().iter().any(|p| p["id"] == id && p["online"] == true)).await;

        let t = Instant::now();
        rig.mc.as_ref().unwrap().push_control(json!({"type": "revoke", "id": id}));
        let mut body = resp.into_body();
        let ended = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                match body.frame().await {
                    None | Some(Err(_)) => return,
                    Some(Ok(_)) => {}
                }
            }
        })
        .await;
        assert!(ended.is_ok(), "the open stream survived the revoke");
        assert_eq!(close_code(&conn).await, 2);
        assert!(t.elapsed() < Duration::from_secs(2), "revoke took {:?}", t.elapsed());
        assert!(!rig.bridge.allowed().contains(&id));
        wait_until("upstream stream closed", 3, || rig.mc().streams_open.load(Ordering::SeqCst) == 0).await;

        // A new dial from the same id is closed with code 1 before any stream.
        let again = rig.http_conn().await;
        assert_eq!(close_code(&again).await, 1);
        rig.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_snapshot_without_a_connected_device_closes_its_connection() {
    within(async {
        let rig = Rig::new(RigOpts::default()).await;
        let id = rig.client.id().to_string();
        let conn = rig.http_conn().await;
        let mut http = open_http(&conn).await;
        let resp = http.send_request(get("/stream")).await.unwrap();
        assert_eq!(rig.mc().streams_open.load(Ordering::SeqCst), 1);

        // The server's new full list no longer holds the device (removed while the bridge was not looking).
        rig.mc.as_ref().unwrap().push_control(json!({"type": "devices", "ids": []}));
        assert_eq!(close_code(&conn).await, 2);
        assert!(rig.bridge.allowed().is_empty());
        assert!(!rig.bridge.connected().contains(&id));
        drop(resp);
        wait_until("upstream stream closed", 3, || rig.mc().streams_open.load(Ordering::SeqCst) == 0).await;
        let again = rig.http_conn().await;
        assert_eq!(close_code(&again).await, 1);
        rig.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn presence_reports_keep_their_order_when_the_server_is_slow() {
    within(async {
        let rig = Rig::new(RigOpts::default()).await;
        let id = rig.client.id().to_string();
        // The first report ("online") takes 400 ms to be answered. The device leaves, returns and leaves
        // again in the meantime. The server must still end up with "offline", and must hear "online" first.
        rig.mc().presence_slow_first.store(true, Ordering::SeqCst);
        let conn = rig.http_conn().await;
        wait_until("first connection registered", 5, || count_lines(&rig, "conn accepted") == 1).await;
        conn.close(0u32.into(), b"done");
        wait_until("first connection closed", 5, || count_lines(&rig, "conn closed") == 1).await;
        let again = rig.http_conn().await;
        wait_until("second connection registered", 5, || count_lines(&rig, "conn accepted") == 2).await;
        again.close(0u32.into(), b"done");
        wait_until("second connection closed", 5, || count_lines(&rig, "conn closed") == 2).await;

        wait_until("offline is the last report", 10, || last_presence(&rig, &id) == Some(false)).await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        let states: Vec<bool> = rig.mc().presence.lock().unwrap().iter().filter(|p| p["id"] == id).filter_map(|p| p["online"].as_bool()).collect();
        assert_eq!(states.first(), Some(&true), "an older report overtook the first one: {states:?}");
        assert_eq!(states.last(), Some(&false), "an older report arrived after the newest: {states:?}");
        assert!(states.len() <= 4, "{states:?}");
        rig.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn hello_and_presence_are_reported() {
    within(async {
        let rig = Rig::new(RigOpts::default()).await;
        let hello = rig.mc().hello.lock().unwrap().first().cloned().expect("no hello");
        assert_eq!(hello["endpointId"], rig.bridge.id().to_string());
        assert!(hello["version"].is_string() && hello["startedAt"].as_str().unwrap().ends_with('Z'), "{hello}");
        assert_eq!(hello["online"], json!([]));

        let id = rig.client.id().to_string();
        let conn = rig.http_conn().await;
        let mut http = open_http(&conn).await;
        text(http.send_request(get("/echo")).await.unwrap()).await;
        wait_until("online", 5, || rig.mc().presence.lock().unwrap().iter().any(|p| p["id"] == id && p["online"] == true)).await;
        // A second connection coming and going does not make the device look offline.
        let second = rig.http_conn().await;
        wait_until("second connection registered", 5, || count_lines(&rig, "conn accepted") == 2).await;
        second.close(0u32.into(), b"done");
        wait_until("second connection closed", 5, || count_lines(&rig, "conn closed") == 1).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(last_presence(&rig, &id), Some(true));
        // Closing the last connection reports offline, and that stays the last word.
        conn.close(0u32.into(), b"done");
        wait_until("offline", 5, || last_presence(&rig, &id) == Some(false)).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(last_presence(&rig, &id), Some(false));
        rig.close().await;
    })
    .await;
}

// ---- 7. Server down ----

#[tokio::test(flavor = "multi_thread")]
async fn server_down_gives_502_and_the_link_recovers() {
    within(async {
        let mut rig = Rig::new(RigOpts::default()).await;
        let conn = rig.http_conn().await;
        let mut http = open_http(&conn).await;
        let first = http.send_request(get("/echo")).await.unwrap();
        assert_eq!(first.status(), 200);
        // Read the whole answer: a client that drops an unfinished body closes its connection, and this stream is used again below.
        text(first).await;

        let port = rig.mc().port;
        rig.mc.take().unwrap().stop().await;
        let resp = http.send_request(get("/echo")).await.unwrap();
        assert_eq!(resp.status(), 502);
        assert_eq!(resp.headers().get("x-mc-bridge-error").unwrap(), "server_down");
        text(resp).await;
        // The iroh connection itself stays up while the server is away.
        assert!(conn.close_reason().is_none());

        // The server comes back on the same port with a different device list.
        let other = new_endpoint().await;
        let id = rig.client.id().to_string();
        let mc = FakeMc::start(vec![id.clone(), other.id().to_string()], Some(port)).await;
        rig.mc = Some(mc);
        wait_until("new snapshot taken", 20, || rig.bridge.allowed().contains(&other.id().to_string())).await;
        assert!(rig.mc().control_opens.load(Ordering::SeqCst) >= 1);
        assert_eq!(rig.mc().hello.lock().unwrap().len(), 1, "the bridge says hello again after reconnecting");
        let resp = http.send_request(get("/echo")).await.unwrap();
        assert_eq!(resp.status(), 200);
        text(resp).await;
        let mut fresh = open_http(&conn).await;
        assert_eq!(fresh.send_request(get("/echo")).await.unwrap().status(), 200);
        let log = rig.log.lines().join("\n");
        assert!(log.contains("control stream down") && log.matches("control stream up").count() >= 2, "{log}");
        other.close().await;
        rig.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn restart_event_and_orphan_timeout_stop_the_bridge() {
    within(async {
        let mut rig = Rig::new(RigOpts::default()).await;
        rig.mc.as_ref().unwrap().push_control(json!({"type": "restart"}));
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), rig.bridge.wait_exit()).await.unwrap(), Exit::Restart);
        rig.close().await;

        // No server at all: the bridge gives up after the orphan time.
        let tmp = TempDir::new("orphan");
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        let log = Arc::new(LogFile::memory());
        let mut opts = Options::new(tmp.0.join("endpoint.key"), addr, SECRET.to_owned(), log.clone());
        opts.relay = false;
        opts.bind = Some("127.0.0.1:0".parse().unwrap());
        opts.restrict_key_acl = false;
        opts.orphan = Duration::from_secs(2);
        let mut bridge = Bridge::start(opts).await.unwrap();
        let t = Instant::now();
        assert_eq!(tokio::time::timeout(Duration::from_secs(15), bridge.wait_exit()).await.unwrap(), Exit::Orphan);
        assert!(t.elapsed() >= Duration::from_secs(2), "{:?}", t.elapsed());
        bridge.shutdown().await;
    })
    .await;
}

// ---- 9. Limits ----

#[tokio::test(flavor = "multi_thread")]
async fn the_65th_stream_and_the_9th_connection_are_refused() {
    within(async {
        let rig = Rig::new(RigOpts::default()).await;
        let conn = rig.http_conn().await;
        let mut held = Vec::new();
        for i in 0..64 {
            let mut http = open_http(&conn).await;
            let resp = http.send_request(get("/stream")).await.unwrap();
            assert_eq!(resp.status(), 200, "stream {i}");
            held.push((http, resp));
        }
        assert_eq!(rig.mc().streams_open.load(Ordering::SeqCst), 64);
        let mut extra = open_http(&conn).await;
        let resp = extra.send_request(get("/echo")).await.unwrap();
        assert_eq!(resp.status(), 503);
        assert_eq!(resp.headers().get("x-mc-bridge-error").unwrap(), "busy");
        text(resp).await;
        assert_eq!(rig.mc().echo_hits.load(Ordering::SeqCst), 0);
        // The connection is fine: when a stream goes away a new one is served.
        held.pop();
        let mut ok = false;
        for _ in 0..40 {
            let mut http = open_http(&conn).await;
            let resp = http.send_request(get("/echo")).await.unwrap();
            if resp.status() == 200 {
                ok = true;
                break;
            }
            text(resp).await;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(ok, "no slot came free after a stream was released");
        drop(held);
        drop(conn);

        // Eight connections per device; the ninth is closed with code 4.
        let mut conns = Vec::new();
        for _ in 0..8 {
            let c = rig.http_conn().await;
            let mut http = open_http(&c).await;
            assert_eq!(http.send_request(get("/echo")).await.unwrap().status(), 200);
            conns.push(c);
        }
        let ninth = rig.http_conn().await;
        assert_eq!(close_code(&ninth).await, 4);
        assert!(conns.iter().all(|c| c.close_reason().is_none()));
        rig.close().await;
    })
    .await;
}

// ---- Refused connections in the log ----

#[tokio::test(flavor = "multi_thread")]
async fn refused_connections_are_summarized_not_listed() {
    within(async {
        let limits = Limits { denied_log_interval: Duration::from_secs(2), ..Limits::default() };
        let rig = Rig::new(RigOpts { paired: false, limits, ..RigOpts::default() }).await;
        for _ in 0..3 {
            let stranger = new_endpoint().await;
            let conn = rig.connect(&stranger, ALPN_HTTP).await;
            assert_eq!(close_code(&conn).await, 1);
            stranger.close().await;
        }
        let total = |rig: &Rig| -> u64 {
            rig.log
                .lines()
                .iter()
                .filter_map(|l| l.split("refused count=").nth(1))
                .filter_map(|rest| rest.split(' ').next()?.parse::<u64>().ok())
                .sum()
        };
        wait_until("summary line", 10, || total(&rig) == 3).await;
        let lines = rig.log.lines();
        assert!(!lines.iter().any(|l| l.contains("conn denied")), "one line per refusal: {lines:?}");
        assert!(lines.iter().filter(|l| l.contains("refused count=")).count() <= 2, "{lines:?}");
        assert!(lines.iter().any(|l| l.contains("not_paired=")));
        rig.close().await;
    })
    .await;
}

// ---- The bridge secret ----

#[tokio::test(flavor = "multi_thread")]
async fn a_rotated_secret_is_read_again_from_the_file() {
    within(async {
        let tmp = TempDir::new("rotate");
        let client = new_endpoint().await;
        let id = client.id().to_string();
        let mc = FakeMc::start(vec![id.clone()], None).await;
        // The server runs with a new secret; the bridge was started with the old one but the file is current.
        *mc.state.secret.lock().unwrap() = SECRET_NEW.to_owned();
        let file = tmp.0.join("secret");
        std::fs::write(&file, SECRET_NEW).unwrap();
        let log = Arc::new(LogFile::memory());
        let mut opts = quick_opts(&tmp, mc.addr, SECRET, log.clone());
        opts.secret_file = Some(file);
        let bridge = Bridge::start(opts).await.unwrap();
        wait_until("device list received", 10, || bridge.allowed().contains(&id)).await;
        assert_eq!(mc.state.hello.lock().unwrap().len(), 1);

        // Requests that go through the tunnel carry the new secret too.
        let conn = client.connect(bridge.direct_addr(), ALPN_HTTP).await.unwrap();
        let mut http = open_http(&conn).await;
        let resp = http.send_request(get("/echo")).await.unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(json_of(resp).await["secret_ok"], true);
        drop(conn);
        client.close().await;
        bridge.shutdown().await;
        mc.stop().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_secret_the_server_keeps_refusing_ends_with_the_restart_exit() {
    within(async {
        let tmp = TempDir::new("refused");
        let mc = FakeMc::start(vec![], None).await;
        *mc.state.secret.lock().unwrap() = SECRET_NEW.to_owned();
        // The file still holds the old secret, so reading it again does not help.
        let file = tmp.0.join("secret");
        std::fs::write(&file, SECRET).unwrap();
        let log = Arc::new(LogFile::memory());
        let mut opts = quick_opts(&tmp, mc.addr, SECRET, log.clone());
        opts.secret_file = Some(file);
        // Shorter than the three tries take: a refused secret must not be taken for a gone server (exit 0).
        opts.orphan = Duration::from_secs(1);
        let mut bridge = Bridge::start(opts).await.unwrap();
        let exit = tokio::time::timeout(Duration::from_secs(20), bridge.wait_exit()).await.expect("the bridge never gave up");
        assert_eq!(exit, Exit::SecretRejected);
        assert!(mc.state.hello.lock().unwrap().is_empty());
        let lines = log.lines().join("\n");
        assert!(lines.contains("try 3 of 3"), "{lines}");
        bridge.shutdown().await;
        mc.stop().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dead_link_task_stops_the_bridge() {
    within(async {
        let mut rig = Rig::new(RigOpts::default()).await;
        rig.bridge.abort_link_task();
        let exit = tokio::time::timeout(Duration::from_secs(5), rig.bridge.wait_exit()).await.expect("the bridge carried on without its link");
        assert_eq!(exit, Exit::LinkLost);
        // Asking again gives the same answer.
        assert_eq!(rig.bridge.wait_exit().await, Exit::LinkLost);
        rig.close().await;
    })
    .await;
}

// ---- The program itself ----

fn bridge_program() -> std::process::Command {
    let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_mc-bridge"));
    cmd.env_remove("MC_DATA_DIR");
    cmd
}

#[test]
fn a_second_bridge_on_the_same_data_folder_exits_73() {
    let tmp = TempDir::new("lock");
    let bridge_dir = tmp.0.join("bridge");
    std::fs::create_dir_all(&bridge_dir).unwrap();
    let held = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(bridge_dir.join("lock")).unwrap();
    held.try_lock().unwrap();
    let out = bridge_program().arg("--data-dir").arg(&tmp.0).output().unwrap();
    assert_eq!(out.status.code(), Some(73), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stderr).contains("already running"));
    drop(held);
}

#[test]
fn no_data_folder_means_exit_2_not_the_current_folder() {
    // Only meaningful when the test program does not sit in a Mission Control checkout.
    let exe = PathBuf::from(env!("CARGO_BIN_EXE_mc-bridge"));
    if exe.ancestors().nth(3).is_some_and(|root| root.join("server").join("config.js").is_file()) {
        return;
    }
    let tmp = TempDir::new("nodata");
    let out = bridge_program().current_dir(&tmp.0).output().unwrap();
    assert_eq!(out.status.code(), Some(2), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stderr).contains("data folder"));
    assert!(!tmp.0.join(".data").exists(), "a data folder was made in the current folder");
}

// ---- The log ----

#[tokio::test(flavor = "multi_thread")]
async fn log_has_no_queries_secrets_or_codes() {
    within(async {
        let rig = Rig::new(RigOpts { paired: false, ..RigOpts::default() }).await;
        let phone = new_endpoint().await;
        let _ = try_pair(&rig, &phone, "WRONG-1234").await;
        let reply = try_pair(&rig, &phone, CODE).await;
        assert!(matches!(reply, PairReply::Paired { .. }));
        let conn = rig.connect(&phone, ALPN_HTTP).await;
        let mut http = open_http(&conn).await;
        let resp = http.send_request(get("/echo?file=C:%5Csecret%5Cplans.txt&token=abc123")).await.unwrap();
        assert_eq!(resp.status(), 200);
        text(resp).await;
        conn.close(0u32.into(), b"done");
        wait_until("conn closed line", 5, || rig.log.lines().iter().any(|l| l.contains("conn closed"))).await;

        let lines = rig.log.lines();
        let all = lines.join("\n");
        for needle in ["?", "abc123", "plans.txt", CODE, "WRONG-1234", "WRONG1234", SECRET, "x-mc-bridge"] {
            assert!(!all.contains(needle), "the log contains {needle:?}:\n{all}");
        }
        for want in ["bridge started version=", "conn accepted dev=", "pair failed dev=", "pair ok dev=", "req dev=", "GET /echo 200", "conn closed dev=", "control stream up"] {
            assert!(all.contains(want), "the log lacks {want:?}:\n{all}");
        }
        phone.close().await;
        rig.close().await;
    })
    .await;
}

// ---- Timeouts in the forwarder (in memory, no iroh) ----

fn short_timeouts() -> Timeouts {
    Timeouts { head: Duration::from_millis(1500), body_idle: Duration::from_millis(500), write_stall: Duration::from_millis(600), connect: Duration::from_secs(2) }
}

/// A client wired straight to `forward::serve` through an in-memory pipe.
async fn forward_client(mc: &FakeMc, pipe: usize) -> (SendRequest<B>, tokio::task::JoinHandle<()>) {
    let (a, b) = tokio::io::duplex(pipe);
    let mut cfg = mc_bridge::forward::ForwardConfig::new(mc.addr, "test-device");
    cfg.inject.push(("x-mc-bridge".parse().unwrap(), SECRET.parse().unwrap()));
    cfg.timeouts = short_timeouts();
    let served = tokio::spawn(async move {
        let _ = mc_bridge::forward::serve(TokioIo::new(b), cfg).await;
    });
    let (sender, driver) = hyper::client::conn::http1::handshake::<_, B>(TokioIo::new(a)).await.unwrap();
    tokio::spawn(async move {
        let _ = driver.await;
    });
    (sender, served)
}

#[tokio::test(flavor = "multi_thread")]
async fn forwarder_timeouts_cut_stalled_exchanges() {
    within(async {
        let mc = FakeMc::start(vec![], None).await;

        // The server never answers: 504 after the head timeout.
        let (mut http, _) = forward_client(&mc, 64 * 1024).await;
        let t = Instant::now();
        let resp = http.send_request(get("/hang")).await.unwrap();
        assert_eq!(resp.status(), 504);
        assert_eq!(resp.headers().get("x-mc-bridge-error").unwrap(), "timeout");
        assert!(t.elapsed() >= Duration::from_millis(1400) && t.elapsed() < Duration::from_secs(4), "{:?}", t.elapsed());

        // A response body that goes quiet for longer than the idle limit is cut (the fake pings every second).
        let (mut http, _) = forward_client(&mc, 64 * 1024).await;
        let resp = http.send_request(get("/stream")).await.unwrap();
        assert_eq!(resp.status(), 200);
        let mut body = resp.into_body();
        let t = Instant::now();
        let end = loop {
            match body.frame().await {
                None => break "ended",
                Some(Err(_)) => break "error",
                Some(Ok(_)) => {}
            }
        };
        assert!(t.elapsed() < Duration::from_secs(3), "the idle body lived {:?} ({end})", t.elapsed());
        wait_until("upstream stream closed", 3, || mc.state.streams_open.load(Ordering::SeqCst) == 0).await;

        // A request body that stalls halfway is answered with 408 and the stream closes.
        let (mut http, served) = forward_client(&mc, 64 * 1024).await;
        let (tx, rx) = mpsc::channel(2);
        tx.send(Bytes::from_static(b"first part")).await.unwrap();
        let req = Request::post("/upload").header("host", "x").header("x-mc", "1").body(ChanBody { rx, _guard: None }.boxed()).unwrap();
        let r = http.send_request(req).await;
        match r {
            Ok(resp) => assert_eq!(resp.status(), 408),
            Err(e) => eprintln!("stalled upload ended with an error: {e}"),
        }
        drop(tx);
        tokio::time::timeout(Duration::from_secs(3), served).await.expect("the connection stayed open").unwrap();

        // A peer that stops reading stalls the write; the connection is dropped instead of waiting for ever.
        let (mut http, served) = forward_client(&mc, 16 * 1024).await;
        let resp = http.send_request(get("/big")).await.unwrap();
        assert_eq!(resp.status(), 200);
        tokio::time::timeout(Duration::from_secs(5), served).await.expect("a stalled write kept the connection open").unwrap();
        drop(resp);
        mc.stop().await;
    })
    .await;
}

// ---- More bridge checks (from the audit) ----

#[tokio::test(flavor = "multi_thread")]
async fn one_endpoint_cannot_hold_many_pairing_connections() {
    within(async {
        let rig = Rig::new(RigOpts { paired: false, ..RigOpts::default() }).await;
        let stranger = new_endpoint().await;
        let mut held = Vec::new();
        for _ in 0..2 {
            let conn = rig.connect(&stranger, ALPN_PAIR).await;
            let (mut send, recv) = conn.open_bi().await.unwrap();
            send.write_all(&[1]).await.unwrap();
            held.push((conn, send, recv));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        // The third and fourth are turned away at once, with the "too many" code.
        for _ in 0..2 {
            let conn = rig.connect(&stranger, ALPN_PAIR).await;
            assert_eq!(close_code(&conn).await, 4);
        }
        // Somebody else can still pair meanwhile.
        let other = stranger_pair(&rig, CODE).await;
        assert!(matches!(other, PairReply::Paired { .. }), "{other:?}");
        stranger.close().await;
        rig.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dead_worker_task_stops_the_bridge() {
    within(async {
        let mut rig = Rig::new(RigOpts::default()).await;
        rig.bridge.abort_worker_task();
        let exit = tokio::time::timeout(Duration::from_secs(5), rig.bridge.wait_exit()).await.expect("the bridge carried on without its worker");
        assert_eq!(exit, Exit::LinkLost);
        assert_eq!(rig.bridge.wait_exit().await, Exit::LinkLost);
        rig.close().await;
    })
    .await;
}

// ---- 8. The phone's local proxy (client module) ----

type Answer = (u16, hyper::HeaderMap, Bytes);
type ReqBuilder = hyper::http::request::Builder;

fn local(port: u16, method: &str, path: &str) -> ReqBuilder {
    Request::builder().method(method).uri(path).header("host", format!("127.0.0.1:{port}"))
}

async fn local_open(port: u16) -> SendRequest<B> {
    let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let (sender, driver) = hyper::client::conn::http1::handshake(TokioIo::new(tcp)).await.unwrap();
    tokio::spawn(async move {
        let _ = driver.await;
    });
    sender
}

/// One request on its own TCP connection to the proxy, answered in full.
async fn local_call(port: u16, req: Request<B>) -> Answer {
    let mut http = local_open(port).await;
    let resp = http.send_request(req).await.unwrap();
    let (parts, body) = resp.into_parts();
    (parts.status.as_u16(), parts.headers, body.collect().await.unwrap().to_bytes())
}

fn empty() -> B {
    full(Bytes::new())
}

fn body_text(b: &Bytes) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn client_config(dir: &TempDir, bridge: &Bridge) -> ClientConfig {
    let mut cfg = ClientConfig::new(&dir.0);
    cfg.relay = false;
    cfg.bind = Some("127.0.0.1:0".parse().unwrap());
    cfg.addrs = bridge.direct_addr().ip_addrs().copied().collect();
    cfg.connect_timeout = Duration::from_secs(3);
    cfg.app_version = "9.9".to_owned();
    cfg.shell_url = Some("http://shell.invalid/".to_owned());
    cfg
}

async fn pair_client(client: &Client, bridge: &Bridge) {
    let text = format!("missioncontrol-pair:{}:{CODE}", bridge.id());
    let info = client.pair(&text, "Test phone").await.unwrap();
    assert_eq!(info.name, "TestPC");
}

/// The cookie a successful `/__mc/enter` sets, as `name=value`.
async fn enter(proxy: &ProxyHandle) -> String {
    let url = proxy.enter_url();
    let path = url.strip_prefix(proxy.origin()).unwrap();
    let (status, headers, _) = local_call(proxy.port(), local(proxy.port(), "GET", path).body(empty()).unwrap()).await;
    assert_eq!(status, 302);
    headers.get("set-cookie").unwrap().to_str().unwrap().split(';').next().unwrap().to_owned()
}

fn nav(b: ReqBuilder) -> ReqBuilder {
    b.header("accept", "text/html,*/*").header("sec-fetch-mode", "navigate")
}

/// A paired phone with its proxy running and the session cookie in hand.
struct Phone {
    client: Client,
    proxy: ProxyHandle,
    cookie: String,
    dir: TempDir,
}

impl Phone {
    async fn new(rig: &Rig) -> Phone {
        let dir = TempDir::new("phone");
        let client = Client::start(client_config(&dir, &rig.bridge)).await.unwrap();
        pair_client(&client, &rig.bridge).await;
        let proxy = client.start_proxy(0).await.unwrap();
        assert!(proxy.wait_online(Duration::from_secs(10)).await, "the proxy never came online: {}", proxy.link());
        let cookie = enter(&proxy).await;
        Phone { client, proxy, cookie, dir }
    }

    fn port(&self) -> u16 {
        self.proxy.port()
    }

    /// A request with the cookie, the proxy's own Host and (for non-GET) its Origin and the X-MC marker.
    fn req(&self, method: &str, path: &str) -> ReqBuilder {
        let mut b = local(self.port(), method, path).header("cookie", &self.cookie);
        if method != "GET" {
            b = b.header("origin", self.proxy.origin()).header("x-mc", "1");
        }
        b
    }

    async fn call(&self, method: &str, path: &str) -> Answer {
        local_call(self.port(), self.req(method, path).body(empty()).unwrap()).await
    }

    async fn close(self) {
        self.proxy.stop().await;
        self.client.close().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn phone_proxy_checks_host_cookie_and_origin() {
    within(async {
        let rig = Rig::new(RigOpts { paired: false, ..RigOpts::default() }).await;
        let phone = Phone::new(&rig).await;
        let port = phone.port();
        let hits = rig.mc().echo_hits.load(Ordering::SeqCst);

        // The enter address: a wrong Host is refused without using the token up; then it works once.
        let url = phone.proxy.enter_url();
        let path = url.strip_prefix(phone.proxy.origin()).unwrap().to_owned();
        let mut req = local(port, "GET", &path).body(empty()).unwrap();
        req.headers_mut().insert("host", "evil.example".parse().unwrap());
        assert_eq!(local_call(port, req).await.0, 403, "wrong Host on the enter address");
        let (status, headers, _) = local_call(port, local(port, "GET", &path).body(empty()).unwrap()).await;
        assert_eq!(status, 302);
        let set_cookie = headers.get("set-cookie").unwrap().to_str().unwrap().to_owned();
        assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Strict") && set_cookie.contains("Path=/"), "{set_cookie}");
        assert!(set_cookie.starts_with(&format!("mcs-{port}=")), "{set_cookie}");
        assert_eq!(headers.get("location").unwrap(), "/");
        let (status, _, body) = local_call(port, nav(local(port, "GET", &path)).body(empty()).unwrap()).await;
        assert_eq!(status, 401, "the token worked twice");
        assert!(body_text(&body).contains("Open Mission Control from the app") && body_text(&body).contains("shell.invalid"), "{}", body_text(&body));
        for bad in ["/__mc/enter?t=00000000000000000000000000000000", "/__mc/enter", "/__mc/enter?t="] {
            assert_eq!(local_call(port, local(port, "GET", bad).body(empty()).unwrap()).await.0, 401, "{bad}");
        }

        // Host: exactly the proxy's address, whatever the cookie says.
        for host in ["evil.example".to_owned(), format!("localhost:{port}"), "127.0.0.1".to_owned(), format!("127.0.0.1:{}", port.wrapping_add(1)), format!("127.0.0.1:{port}.evil.example")] {
            let mut req = phone.req("GET", "/echo").body(empty()).unwrap();
            req.headers_mut().insert("host", host.parse().unwrap());
            assert_eq!(local_call(port, req).await.0, 403, "host {host}");
        }

        // No cookie or a wrong one: 401 for a fetch, a page for a navigation.
        assert_eq!(local_call(port, local(port, "GET", "/echo").body(empty()).unwrap()).await.0, 401);
        assert_eq!(local_call(port, local(port, "GET", "/echo").header("cookie", format!("mcs-{port}=wrong")).body(empty()).unwrap()).await.0, 401);
        assert_eq!(local_call(port, local(port, "GET", "/echo").header("cookie", "mcs=other; x=1").body(empty()).unwrap()).await.0, 401);
        let (status, _, body) = local_call(port, nav(local(port, "GET", "/")).body(empty()).unwrap()).await;
        assert_eq!(status, 401);
        assert!(body_text(&body).contains("Open Mission Control"), "{}", body_text(&body));

        // Origin: absent or exactly the proxy's own.
        let origins = [
            "http://evil.example".to_owned(),
            "http://localhost:1".to_owned(),
            format!("http://localhost:{port}"),
            format!("http://127.0.0.1:{}", port.wrapping_add(1)),
            "null".to_owned(),
            format!("{}/", phone.proxy.origin()),
        ];
        for origin in origins {
            let mut req = phone.req("POST", "/echo").body(full("x")).unwrap();
            req.headers_mut().insert("origin", origin.parse().unwrap());
            assert_eq!(local_call(port, req).await.0, 403, "origin {origin}");
        }
        assert_eq!(rig.mc().echo_hits.load(Ordering::SeqCst), hits, "a refused request reached the server");

        // A good request: cookie and internal names stay on the phone, the marker and the real identity arrive.
        let req = phone
            .req("POST", "/echo?x=1")
            .header("x-mc-device", "evil")
            .header("x-mc-bridge", "evil")
            .header("x-mc-evil", "1")
            .header("x-mc-app", "evil")
            .header("referer", "http://127.0.0.1/secret")
            .body(full("hello"))
            .unwrap();
        let (status, _, body) = local_call(port, req).await;
        assert_eq!(status, 200);
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert!(v["cookie"].is_null(), "the cookie went to the server: {v}");
        assert!(v["forged"].is_null() && v["referer"].is_null(), "{v}");
        assert_eq!(v["device"], phone.client.device_id());
        assert_eq!(v["secret_ok"], true);
        assert_eq!(v["app"], "9.9");
        assert_eq!(v["x_mc"], "1");
        assert_eq!(v["body_len"], 5);
        assert_eq!(v["query"], "x=1");
        assert_eq!(v["origin"], format!("http://127.0.0.1:{}", rig.mc().port));

        // The phone's own namespaces are never forwarded, however they are spelled.
        let hits = rig.mc().echo_hits.load(Ordering::SeqCst);
        for p in ["/__app/x", "/__mc/x", "/%5f%5fapp/x", "/%5F%5Fmc/enter", "/__app", "/api/bridge/x"] {
            assert_eq!(phone.call("GET", p).await.0, 404, "{p}");
        }
        assert_eq!(rig.mc().echo_hits.load(Ordering::SeqCst), hits);
        // Upgrades are not supported.
        let req = phone.req("GET", "/echo").header("connection", "upgrade").header("upgrade", "websocket").body(empty()).unwrap();
        assert_eq!(local_call(port, req).await.0, 501);

        // The ping page answers with the link state, and probes the server.
        let (status, _, body) = phone.call("GET", "/__app/ping").await;
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["state"], "online", "{}", body_text(&body));

        // A second start on the same port works once the first has stopped.
        let Phone { client, proxy, .. } = phone;
        proxy.stop().await;
        let again = client.start_proxy(port).await.unwrap();
        assert_eq!(again.port(), port);
        again.stop().await;
        client.close().await;
        rig.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn phone_proxy_streams_events_and_uploads_and_reuses_streams() {
    within(async {
        let rig = Rig::new(RigOpts { paired: false, ..RigOpts::default() }).await;
        let phone = Phone::new(&rig).await;
        let port = phone.port();

        // Server-sent events arrive as they are produced.
        let start = Instant::now();
        let mut http = local_open(port).await;
        let resp = http.send_request(phone.req("GET", "/sse").header("accept", "text/event-stream").body(empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.headers().get("content-type").unwrap(), "text/event-stream");
        let mut body = resp.into_body();
        let (mut first, mut last, mut all) = (None, Duration::ZERO, String::new());
        while let Some(frame) = body.frame().await {
            if let Some(d) = frame.unwrap().data_ref() {
                first.get_or_insert(start.elapsed());
                last = start.elapsed();
                all.push_str(std::str::from_utf8(d).unwrap());
            }
        }
        assert_eq!(all.matches("data:").count(), 5, "{all}");
        let first = first.unwrap();
        assert!(first < Duration::from_millis(450), "first event took {first:?}");
        assert!(last >= first + Duration::from_millis(500), "events were buffered: {first:?} then {last:?}");

        // A browser that walks away closes the server's stream quickly.
        let mut http = local_open(port).await;
        let resp = http.send_request(phone.req("GET", "/stream").body(empty()).unwrap()).await.unwrap();
        assert_eq!(rig.mc().streams_open.load(Ordering::SeqCst), 1);
        drop(resp);
        drop(http);
        let t = Instant::now();
        wait_until("upstream stream closed", 5, || rig.mc().streams_open.load(Ordering::SeqCst) == 0).await;
        assert!(t.elapsed() < Duration::from_secs(2), "upstream took {:?} to notice", t.elapsed());

        // Uploads: with a length and chunked, byte exact.
        let data = pattern(24 * MIB);
        let want = format!("len={} sum={:x}", data.len(), fnv(FNV_START, &data));
        for chunked in [false, true] {
            let body: B = if chunked {
                let (tx, rx) = mpsc::channel(4);
                let data = data.clone();
                tokio::spawn(async move {
                    for piece in data.chunks(64 * 1024) {
                        if tx.send(data.slice_ref(piece)).await.is_err() {
                            return;
                        }
                    }
                });
                ChanBody { rx, _guard: None }.boxed()
            } else {
                full(data.clone())
            };
            let (status, _, answer) = local_call(port, phone.req("POST", "/upload").body(body).unwrap()).await;
            assert_eq!(status, 200, "chunked={chunked}");
            assert_eq!(body_text(&answer), want, "chunked={chunked}");
        }

        // One browser connection, several requests: the stream is reused, and when the bridge closes it
        // (an early refusal of a request that has a body does that) the next request gets a fresh one.
        let mut http = local_open(port).await;
        for i in 0..3 {
            let resp = http.send_request(phone.req("GET", &format!("/echo?n={i}")).body(empty()).unwrap()).await.unwrap();
            assert_eq!(json_of(resp).await["query"], format!("n={i}"));
        }
        let resp = http.send_request(phone.req("POST", "/api/bridge/x").body(full("a body that is not read")).unwrap()).await.unwrap();
        assert_eq!(resp.status(), 404);
        text(resp).await;
        for i in 0..3 {
            let resp = http.send_request(phone.req("GET", &format!("/echo?m={i}")).body(empty()).unwrap()).await.unwrap();
            assert_eq!(resp.status(), 200, "request {i} after the bridge closed the stream");
            assert_eq!(json_of(resp).await["query"], format!("m={i}"));
        }
        // All of that went over one connection to the bridge.
        assert_eq!(rig.bridge.connected(), vec![phone.client.device_id()]);
        assert_eq!(count_lines(&rig, "conn accepted"), 1);

        phone.close().await;
        rig.close().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn phone_proxy_dies_at_once_when_the_phone_is_removed() {
    within(async {
        let rig = Rig::new(RigOpts { paired: false, ..RigOpts::default() }).await;
        let phone = Phone::new(&rig).await;
        let port = phone.port();
        let id = phone.client.device_id();

        let mut http = local_open(port).await;
        let resp = http.send_request(phone.req("GET", "/stream").header("accept", "text/event-stream").body(empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(phone.proxy.link(), Link::Online);

        let t = Instant::now();
        rig.mc.as_ref().unwrap().push_control(json!({"type": "revoke", "id": id}));
        let mut body = resp.into_body();
        let ended = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                match body.frame().await {
                    None | Some(Err(_)) => return,
                    Some(Ok(_)) => {}
                }
            }
        })
        .await;
        assert!(ended.is_ok(), "the open stream survived the removal");
        wait_until("link says revoked", 2, || phone.proxy.link() == Link::Revoked).await;
        assert!(t.elapsed() < Duration::from_secs(2), "took {:?}", t.elapsed());
        assert!(matches!(phone.client.state(), SavedState::Revoked { .. }));
        let saved = std::fs::read_to_string(phone.dir.0.join("server.json")).unwrap();
        assert!(saved.contains("\"revoked\": true"), "{saved}");

        // A page load says so; a fetch gets a short error.
        let (status, headers, body) = local_call(port, nav(phone.req("GET", "/")).body(empty()).unwrap()).await;
        assert_eq!(status, 403);
        assert_eq!(headers.get("x-mc-phone").unwrap(), "revoked");
        assert!(body_text(&body).contains("no longer paired") && body_text(&body).contains("shell.invalid"), "{}", body_text(&body));
        let (status, _, body) = phone.call("GET", "/echo").await;
        assert_eq!(status, 403);
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["error"], "not_paired");
        let (_, _, body) = phone.call("GET", "/__app/ping").await;
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["state"], "revoked");
        wait_until("upstream stream closed", 3, || rig.mc().streams_open.load(Ordering::SeqCst) == 0).await;

        phone.close().await;
        rig.close().await;
    })
    .await;
}

fn free_udp_port() -> u16 {
    std::net::UdpSocket::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

#[tokio::test(flavor = "multi_thread")]
async fn phone_proxy_shows_an_offline_page_and_reconnects_by_itself() {
    within(async {
        let tmp = TempDir::new("offline");
        let log = Arc::new(LogFile::memory());
        let mc = FakeMc::start(vec![], None).await;
        let udp: SocketAddr = format!("127.0.0.1:{}", free_udp_port()).parse().unwrap();
        let start_bridge = |log: Arc<LogFile>| {
            let mut opts = quick_opts(&tmp, mc.addr, SECRET, log);
            opts.bind = Some(udp);
            Bridge::start(opts)
        };
        let bridge = start_bridge(log.clone()).await.unwrap();

        let phone_dir = TempDir::new("offline-phone");
        let client = Client::start(client_config(&phone_dir, &bridge)).await.unwrap();
        pair_client(&client, &bridge).await;
        let proxy = client.start_proxy(0).await.unwrap();
        assert!(proxy.wait_online(Duration::from_secs(10)).await);
        let port = proxy.port();
        let cookie = enter(&proxy).await;
        let get = |path: &str, as_page: bool| {
            let b = local(port, "GET", path).header("cookie", &cookie);
            (if as_page { nav(b) } else { b }).body(empty()).unwrap()
        };
        assert_eq!(local_call(port, get("/echo", false)).await.0, 200);

        // The PC goes away.
        bridge.shutdown().await;
        wait_until("link offline", 5, || matches!(proxy.link(), Link::Offline(_))).await;
        let (status, headers, body) = local_call(port, get("/", true)).await;
        assert_eq!(status, 503);
        let page = body_text(&body);
        assert!(page.contains("Retry") && page.contains("Cannot reach your PC") && page.contains("/__app/ping"), "{page}");
        assert_eq!(headers.get("content-type").unwrap(), "text/html; charset=utf-8");
        let (status, _, body) = local_call(port, get("/api/anything", false)).await;
        assert_eq!(status, 503);
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["error"], "pc_unreachable");

        // It comes back; the proxy dials again without anybody asking.
        let bridge = start_bridge(log.clone()).await.unwrap();
        assert!(proxy.wait_online(Duration::from_secs(25)).await, "no reconnect: {}", proxy.link());
        assert_eq!(local_call(port, get("/echo", false)).await.0, 200);

        // The server stops: a page load gets the offline page too, a fetch gets the bridge's 502.
        mc.stop().await;
        let (status, _, body) = local_call(port, get("/", true)).await;
        assert_eq!(status, 503);
        assert!(body_text(&body).contains("Mission Control is not running"), "{}", body_text(&body));
        let (status, headers, _) = local_call(port, get("/api/x", false)).await;
        assert_eq!(status, 502);
        assert_eq!(headers.get("x-mc-bridge-error").unwrap(), "server_down");
        let (_, _, body) = local_call(port, get("/__app/ping", false)).await;
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["state"], "server_down");

        proxy.stop().await;
        client.close().await;
        bridge.shutdown().await;
    })
    .await;
}
