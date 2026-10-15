//! The phone side: the device key, pairing, and a small local HTTP proxy that carries
//! the web view's traffic to the PC bridge over iroh.
//!
//! The Mission Control pages are served by the PC, so the web view on the phone loads
//! `http://127.0.0.1:<port>/`. That address is this proxy. It checks every request
//! (anything else on the phone can also reach a loopback port), forwards it over a
//! bi-stream on one shared iroh connection, and hands the answer back as it arrives.
//! The bridge on the PC does the same checks again from its side (`forward`).
//!
//! * Checks: `Host` must be exactly `127.0.0.1:<port>`, `Origin` (when present) exactly
//!   `http://127.0.0.1:<port>`, and a per-launch `HttpOnly` cookie must match. The cookie
//!   is set by `/__mc/enter?t=<token>`, a one-use address that only the app knows
//!   (`ProxyHandle::enter_url`). `Cookie` and every `X-MC-*` header are removed before a
//!   request leaves the phone. `/__mc/` and `/__app/` belong to the phone and are never
//!   forwarded.
//! * Streams: one iroh bi-stream per web view TCP connection, opened when the first
//!   request needs it. Bodies stream in both directions, so server-sent events arrive
//!   as they are produced and uploads are not held in memory. When the bridge closed an
//!   idle stream, the request goes out once more on a fresh one.
//! * Trouble: a page load that cannot reach the PC gets a plain page with a Retry
//!   button (it tries again by itself); any other request gets a short JSON error.
//!   Lost connections are dialed again in the background. A bridge that closes the
//!   connection with the "removed" code puts the proxy in the revoked state: the page
//!   says the phone is no longer paired.
//!
//! There is no Tauri code here. The app calls `Client::start`, `pair` and `start_proxy`.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::{Body as _, Incoming};
use hyper::client::conn::http1::SendRequest;
use hyper::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONNECTION, CONTENT_TYPE, COOKIE, HOST, ORIGIN, UPGRADE};
use hyper::server::conn::http1 as server_http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode, Uri, Version};
use hyper_util::rt::{TokioIo, TokioTimer};
use iroh::endpoint::{presets, Connection, ConnectionError};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey, TransportAddr};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::{watch, Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

use crate::forward::{Body, BoxError, BRIDGE_ERROR_HEADER};
use crate::stream_io;
use crate::wire::{self, PairReply, PairRequest, ALPN_HTTP, ALPN_PAIR, CLOSE_NOT_PAIRED, CLOSE_REVOKED, CLOSE_STOPPING, CLOSE_TOO_MANY};

/// Added to every HTML page that comes from the PC: no requests to other hosts, no forms that post
/// elsewhere, no framing. Inline scripts and the CDN scripts the pages load are not restricted.
pub const PAGE_CSP: &str = "connect-src 'self' blob: data:; form-action 'self'; base-uri 'self'; frame-ancestors 'none'";

/// Limits for the pages the proxy writes itself (offline, revoked, signed out).
const LOCAL_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// A dial that failed is not repeated for this long; requests that arrive meanwhile get the same answer.
const FAIL_MEMORY: Duration = Duration::from_secs(2);
/// After a new connection is made, how long to wait for the bridge to turn it away (not paired, revoked).
const TURN_AWAY_WAIT: Duration = Duration::from_millis(200);
/// After a stream fails, how long to wait for the reason the bridge closed the connection to arrive.
const CLOSE_GRACE: Duration = Duration::from_millis(250);
/// An unused `/__mc/enter` token stops working after this long.
const TOKEN_TTL: Duration = Duration::from_secs(60);
/// Most `/__mc/enter` tokens held at once; when full, the oldest one is dropped.
const MAX_TOKENS: usize = 32;
/// Header read limit of the loopback server once a connection has proven itself (a browser keeps idle connections open).
const LOCAL_HEADER_READ_TIMEOUT: Duration = Duration::from_secs(300);
/// A connection that has not sent an authenticated request (cookie or enter token) by now is closed.
const PRE_AUTH_TIMEOUT: Duration = Duration::from_secs(45);
/// Most local connections open at once; further ones are closed at once.
const MAX_LOCAL_CONNECTIONS: usize = 128;

// ---- Configuration and saved state ----

/// Receives status lines.
pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct ClientConfig {
    /// The 32 byte device key (created on first start). Its public half is this phone's id on the PC.
    pub key_file: PathBuf,
    /// `{id, name, revoked}` of the paired PC (written by `pair`).
    pub server_file: PathBuf,
    /// False: no relay and no address lookup (offline tests).
    pub relay: bool,
    /// Local UDP address for the endpoint (default: let iroh pick).
    pub bind: Option<SocketAddr>,
    /// Direct addresses of the PC, tried in addition to relay and lookup (tests, same network).
    pub addrs: Vec<SocketAddr>,
    /// Sent to the server as `X-MC-App`.
    pub app_version: String,
    /// Where the "pair again" link on the proxy's pages points (the app's own shell page).
    pub shell_url: Option<String>,
    /// Longest wait for the PC to answer a dial.
    pub connect_timeout: Duration,
    /// Receives short status lines (no secrets, no paths, no codes).
    pub log: Option<LogFn>,
}

impl ClientConfig {
    /// Key and server file as `device_key` and `server.json` in `dir`.
    pub fn new(dir: impl AsRef<Path>) -> ClientConfig {
        let dir = dir.as_ref();
        ClientConfig {
            key_file: dir.join("device_key"),
            server_file: dir.join("server.json"),
            relay: true,
            bind: None,
            addrs: Vec::new(),
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            shell_url: None,
            connect_timeout: Duration::from_secs(20),
            log: None,
        }
    }
}

/// The PC this phone is paired with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerInfo {
    pub id: String,
    pub name: String,
    /// The PC said this phone was removed. Cleared by pairing again, or by any connection that works.
    #[serde(default)]
    pub revoked: bool,
}

/// What the app shell shows before the proxy starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SavedState {
    Unpaired,
    Paired { name: String },
    Revoked { name: String },
}

/// The state of the link to the PC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    Unpaired,
    Connecting,
    Online,
    /// Cannot reach the PC right now (the text says why). The proxy keeps trying.
    Offline(String),
    /// The PC no longer accepts this phone.
    Revoked,
}

impl std::fmt::Display for Link {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Link::Unpaired => f.write_str("not paired"),
            Link::Connecting => f.write_str("connecting"),
            Link::Online => f.write_str("online"),
            Link::Offline(why) => write!(f, "offline: {why}"),
            Link::Revoked => f.write_str("no longer paired"),
        }
    }
}

#[derive(Debug)]
pub enum PairError {
    /// The text is not a `missioncontrol-pair:` text.
    BadText,
    /// The bridge could not be reached.
    Unreachable(String),
    /// The bridge answered no. `code` is `bad_code`, `rate_limited` or `bridge_error`.
    Refused { code: String, message: String },
    Failed(String),
}

impl std::fmt::Display for PairError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PairError::BadText => f.write_str("That is not a Mission Control pairing text"),
            PairError::Unreachable(why) => write!(f, "Could not reach your PC: {why}"),
            PairError::Refused { code, message } => match code.as_str() {
                "bad_code" => f.write_str("That code does not work, or it has expired. Make a new one on the PC."),
                "rate_limited" => f.write_str("Too many attempts. Wait a minute and try again."),
                _ => f.write_str(message),
            },
            PairError::Failed(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for PairError {}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn load_or_create_key(path: &Path, log: Option<&LogFn>) -> Result<SecretKey, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            if let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) {
                return Ok(SecretKey::from_bytes(&arr));
            }
            // An empty or cut-off file (a crash while saving) holds no usable key: make a new one.
            if let Some(f) = log {
                f("the device key file had the wrong size; made a new key");
            }
            create_key(path)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => create_key(path),
        Err(e) => Err(format!("cannot read the device key: {e}")),
    }
}

/// Makes a key and saves it: written to a temporary file that only the current user can read, then renamed.
fn create_key(path: &Path) -> Result<SecretKey, String> {
    use std::io::Write;
    let key = SecretKey::generate();
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create the key folder: {e}"))?;
    }
    let mut tmp_name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    let _ = std::fs::remove_file(&tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    // On Windows the file inherits the access rules of the app's private data folder. The `icacls` code in
    // `keyfile` is part of the PC program only, so it is not used here.
    let saved = opts
        .open(&tmp)
        .and_then(|mut f| {
            f.write_all(&key.to_bytes())?;
            f.sync_all()
        })
        .and_then(|_| std::fs::rename(&tmp, path));
    if let Err(e) = saved {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("cannot save the device key: {e}"));
    }
    Ok(key)
}

fn read_server(path: &Path) -> Option<ServerInfo> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn write_server(path: &Path, info: &ServerInfo) -> Result<(), String> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(info).map_err(|e| e.to_string())?;
    // Written next to the real file and renamed over it, so a crash never leaves half a file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn random_hex(bytes: usize) -> String {
    SecretKey::generate().to_bytes().iter().take(bytes.min(32)).map(|b| format!("{b:02x}")).collect()
}

/// The port picked for the web view's address, and whether it differs from the one saved before.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortChoice {
    pub port: u16,
    /// A port had been saved but was taken, so a new one was picked and saved. The web view's
    /// address changed, which means the pages' saved settings (kept per address) start over.
    pub changed: bool,
}

/// Reads the saved loopback port, or picks a random free one and saves it. The same port on every launch
/// keeps the pages' `localStorage` (it is stored per address, port included).
pub fn load_or_pick_port(file: &Path) -> Result<PortChoice, String> {
    let free = |p: u16| std::net::TcpListener::bind(("127.0.0.1", p)).is_ok();
    let saved: Option<u16> = std::fs::read_to_string(file).ok().and_then(|s| s.trim().parse().ok()).filter(|p| *p >= 1024);
    if let Some(p) = saved.filter(|p| free(*p)) {
        return Ok(PortChoice { port: p, changed: false });
    }
    for _ in 0..64 {
        let b = SecretKey::generate().to_bytes();
        let p = 20000 + u16::from_le_bytes([b[0], b[1]]) % 20000;
        if free(p) {
            if let Some(dir) = file.parent().filter(|d| !d.as_os_str().is_empty()) {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(file, p.to_string()).map_err(|e| format!("cannot save the port: {e}"))?;
            return Ok(PortChoice { port: p, changed: saved.is_some() });
        }
    }
    Err("no free local port found".to_owned())
}

// ---- Failures ----

/// Why a request could not be carried.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Fail {
    Offline(String),
    /// The PC does not accept this phone. `true`: it said so with the "removed" code, which is final.
    Revoked(bool),
}

fn fail_from_close(reason: &ConnectionError) -> Fail {
    match reason {
        ConnectionError::ApplicationClosed(c) => match u64::from(c.error_code) {
            x if x == u64::from(CLOSE_NOT_PAIRED) => Fail::Revoked(false),
            x if x == u64::from(CLOSE_REVOKED) => Fail::Revoked(true),
            x if x == u64::from(CLOSE_STOPPING) => Fail::Offline("The bridge on your PC is restarting.".to_owned()),
            x if x == u64::from(CLOSE_TOO_MANY) => Fail::Offline("Too many phones are connected to your PC.".to_owned()),
            other => Fail::Offline(format!("Your PC closed the connection (code {other}).")),
        },
        ConnectionError::TimedOut => Fail::Offline("Your PC stopped answering.".to_owned()),
        ConnectionError::LocallyClosed => Fail::Offline("The connection was closed on this phone.".to_owned()),
        _ => Fail::Offline("The connection to your PC was lost.".to_owned()),
    }
}

/// Request line and headers of a request that has no body, kept so it can be sent again.
struct Head {
    method: Method,
    uri: Uri,
    headers: HeaderMap,
}

impl Head {
    fn rebuild(&self) -> Request<Body> {
        let mut r = Request::new(empty_body());
        *r.method_mut() = self.method.clone();
        *r.uri_mut() = self.uri.clone();
        *r.headers_mut() = self.headers.clone();
        r
    }
}

fn empty_body() -> Body {
    Empty::<Bytes>::new().map_err(|never| match never {}).boxed()
}

// ---- The client ----

struct Inner {
    cfg: ClientConfig,
    endpoint: Endpoint,
    server: Mutex<Option<ServerInfo>>,
    /// The connection in use, if any.
    current: Mutex<Option<Connection>>,
    /// Held while dialing: one dial at a time.
    dial: AsyncMutex<()>,
    last_fail: Mutex<Option<(Instant, Fail)>>,
    link: watch::Sender<Link>,
}

/// The phone's identity and its link to the PC. Cheap to clone.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

impl Client {
    /// Loads or makes the device key and starts the network endpoint.
    pub async fn start(cfg: ClientConfig) -> Result<Client, String> {
        let key = load_or_create_key(&cfg.key_file, cfg.log.as_ref())?;
        let builder = if cfg.relay { Endpoint::builder(presets::N0) } else { Endpoint::builder(presets::Minimal) };
        let mut builder = builder.secret_key(key);
        if let Some(addr) = cfg.bind {
            builder = builder.bind_addr(addr).map_err(|e| format!("cannot use bind address {addr}: {e}"))?;
        }
        let endpoint = builder.bind().await.map_err(|e| format!("could not start the network endpoint: {e}"))?;
        let server = read_server(&cfg.server_file);
        let first = match &server {
            None => Link::Unpaired,
            Some(s) if s.revoked => Link::Revoked,
            Some(_) => Link::Connecting,
        };
        let (link, _) = watch::channel(first);
        Ok(Client {
            inner: Arc::new(Inner {
                cfg,
                endpoint,
                server: Mutex::new(server),
                current: Mutex::new(None),
                dial: AsyncMutex::new(()),
                last_fail: Mutex::new(None),
                link,
            }),
        })
    }

    /// This phone's id, as the PC lists it.
    pub fn device_id(&self) -> String {
        self.inner.endpoint.id().to_string()
    }

    pub fn saved(&self) -> Option<ServerInfo> {
        lock(&self.inner.server).clone()
    }

    pub fn state(&self) -> SavedState {
        match self.saved() {
            None => SavedState::Unpaired,
            Some(s) if s.revoked => SavedState::Revoked { name: s.name },
            Some(s) => SavedState::Paired { name: s.name },
        }
    }

    pub fn link(&self) -> Link {
        self.inner.link.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<Link> {
        self.inner.link.subscribe()
    }

    /// Pairs with the PC named in a `missioncontrol-pair:<id>:<code>` text and saves it.
    pub async fn pair(&self, text: &str, device_name: &str) -> Result<ServerInfo, PairError> {
        let inner = &self.inner;
        let (id_text, code) = wire::parse_pair_uri(text).ok_or(PairError::BadText)?;
        let id: EndpointId = id_text.parse().map_err(|_| PairError::BadText)?;
        let addr = EndpointAddr::from_parts(id, inner.cfg.addrs.iter().copied().map(TransportAddr::Ip));
        let unreachable = |why: String| PairError::Unreachable(why);
        let conn = tokio::time::timeout(inner.cfg.connect_timeout, inner.endpoint.connect(addr, ALPN_PAIR))
            .await
            .map_err(|_| unreachable("it did not answer".to_owned()))?
            .map_err(|e| unreachable(e.to_string()))?;
        let exchange = async {
            let (mut send, mut recv) = conn.open_bi().await.map_err(|e| PairError::Failed(e.to_string()))?;
            let name: String = device_name.chars().filter(|c| !c.is_control()).take(40).collect();
            wire::write_json(&mut send, &PairRequest::Pair { code: code.to_owned(), device_name: name }).await.map_err(|e| PairError::Failed(e.to_string()))?;
            wire::read_json::<_, PairReply>(&mut recv).await.map_err(|e| PairError::Failed(e.to_string()))
        };
        let reply = tokio::time::timeout(inner.cfg.connect_timeout, exchange).await.unwrap_or_else(|_| Err(PairError::Failed("the PC did not answer in time".to_owned())));
        conn.close(0u32.into(), b"done");
        match reply? {
            PairReply::Paired { server_name } => {
                let info = ServerInfo { id: id.to_string(), name: server_name, revoked: false };
                write_server(&inner.cfg.server_file, &info).map_err(|e| PairError::Failed(format!("paired, but the result could not be saved: {e}")))?;
                *lock(&inner.server) = Some(info.clone());
                inner.drop_connection("paired again");
                *lock(&inner.last_fail) = None;
                inner.set_link(Link::Connecting);
                inner.log("paired");
                Ok(info)
            }
            PairReply::Error { code, message } => Err(PairError::Refused { code, message }),
        }
    }

    /// Forgets the PC (the key stays, so this phone keeps its id).
    pub fn forget(&self) -> Result<(), String> {
        match std::fs::remove_file(&self.inner.cfg.server_file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        *lock(&self.inner.server) = None;
        self.inner.drop_connection("forgotten");
        self.inner.set_link(Link::Unpaired);
        Ok(())
    }

    /// Starts the local proxy on `127.0.0.1:port` (0 picks a free port). Needs a paired PC.
    pub async fn start_proxy(&self, port: u16) -> Result<ProxyHandle, String> {
        self.start_proxy_with(port, MAX_LOCAL_CONNECTIONS, PRE_AUTH_TIMEOUT).await
    }

    async fn start_proxy_with(&self, port: u16, max_conns: usize, pre_auth: Duration) -> Result<ProxyHandle, String> {
        if self.saved().is_none() {
            return Err("this phone is not paired with a PC".to_owned());
        }
        let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("cannot listen on 127.0.0.1:{port}: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let proxy = Arc::new(Proxy {
            inner: self.inner.clone(),
            port,
            host: format!("127.0.0.1:{port}"),
            origin: format!("http://127.0.0.1:{port}"),
            cookie_name: format!("mcs-{port}"),
            secret: random_hex(32),
            tokens: Mutex::new(HashMap::new()),
        });
        let accept = tokio::spawn(accept_loop(listener, proxy.clone(), Arc::new(Semaphore::new(max_conns)), pre_auth));
        let reconnect = tokio::spawn(reconnect_loop(self.inner.clone()));
        self.inner.log(&format!("proxy listening on port {port}"));
        Ok(ProxyHandle { proxy, tasks: vec![accept, reconnect] })
    }

    /// Closes the connection and the network endpoint.
    pub async fn close(&self) {
        self.inner.endpoint.close().await;
    }
}

impl Inner {
    fn log(&self, line: &str) {
        if let Some(f) = &self.cfg.log {
            f(line);
        }
    }

    fn set_link(&self, next: Link) {
        self.link.send_if_modified(|cur| {
            if *cur == next {
                false
            } else {
                *cur = next;
                true
            }
        });
    }

    fn saved(&self) -> Option<ServerInfo> {
        lock(&self.server).clone()
    }

    fn live_connection(&self) -> Option<Connection> {
        lock(&self.current).as_ref().filter(|c| c.close_reason().is_none()).cloned()
    }

    /// Closes and forgets the connection in use.
    fn drop_connection(&self, why: &'static str) {
        if let Some(c) = lock(&self.current).take() {
            c.close(0u32.into(), why.as_bytes());
        }
    }

    /// Records what a failure means for the link, and for the saved state when the PC said "removed".
    fn apply_fail(&self, f: &Fail) {
        match f {
            Fail::Offline(why) => self.set_link(Link::Offline(why.clone())),
            Fail::Revoked(removed) => {
                if *removed {
                    let mut server = lock(&self.server);
                    if let Some(info) = server.as_mut().filter(|i| !i.revoked) {
                        info.revoked = true;
                        if let Err(e) = write_server(&self.cfg.server_file, info) {
                            self.log(&format!("could not save the revoked state: {e}"));
                        }
                    }
                }
                self.set_link(Link::Revoked);
            }
        }
    }

    /// A working connection clears an old "revoked" mark (the PC had only been starting up).
    fn clear_revoked_mark(&self) {
        let mut server = lock(&self.server);
        if let Some(info) = server.as_mut().filter(|i| i.revoked) {
            info.revoked = false;
            let _ = write_server(&self.cfg.server_file, info);
        }
    }

    /// The shared connection to the bridge: reused while it lives, dialed (once, for everyone) when it does not.
    async fn connection(self: &Arc<Self>) -> Result<Connection, Fail> {
        if let Some(c) = self.live_connection() {
            return Ok(c);
        }
        let _turn = self.dial.lock().await;
        if let Some(c) = self.live_connection() {
            return Ok(c);
        }
        if let Some((at, fail)) = lock(&self.last_fail).clone() {
            if at.elapsed() < FAIL_MEMORY {
                return Err(fail);
            }
        }
        let Some(server) = self.saved() else {
            return Err(Fail::Offline("This phone is not paired with a PC.".to_owned()));
        };
        let Ok(id) = server.id.parse::<EndpointId>() else {
            return Err(Fail::Offline("The saved PC id is damaged. Pair again.".to_owned()));
        };
        self.set_link(Link::Connecting);
        let addr = EndpointAddr::from_parts(id, self.cfg.addrs.iter().copied().map(TransportAddr::Ip));
        let outcome = match tokio::time::timeout(self.cfg.connect_timeout, self.endpoint.connect(addr, ALPN_HTTP)).await {
            Err(_) => Err(Fail::Offline("Your PC did not answer. It may be off, asleep or without internet.".to_owned())),
            Ok(Err(e)) => Err(Fail::Offline(format!("Could not reach your PC ({e})."))),
            // A connection the bridge does not want is closed at once, before any stream.
            Ok(Ok(conn)) => match tokio::time::timeout(TURN_AWAY_WAIT, conn.closed()).await {
                Ok(reason) => Err(fail_from_close(&reason)),
                Err(_) => Ok(conn),
            },
        };
        match outcome {
            Ok(conn) => {
                *lock(&self.current) = Some(conn.clone());
                *lock(&self.last_fail) = None;
                self.clear_revoked_mark();
                self.set_link(Link::Online);
                self.log("connected");
                self.watch_connection(conn.clone());
                Ok(conn)
            }
            Err(fail) => {
                self.log(&format!("connect failed: {fail:?}"));
                *lock(&self.last_fail) = Some((Instant::now(), fail.clone()));
                self.apply_fail(&fail);
                Err(fail)
            }
        }
    }

    /// Notices the moment the connection closes (a removed phone must see it at once, not at its next request).
    fn watch_connection(self: &Arc<Self>, conn: Connection) {
        let me = self.clone();
        tokio::spawn(async move {
            let reason = conn.closed().await;
            let ours = {
                let mut cur = lock(&me.current);
                let ours = cur.as_ref().is_some_and(|c| c.stable_id() == conn.stable_id());
                if ours {
                    *cur = None;
                }
                ours
            };
            if ours {
                let fail = fail_from_close(&reason);
                me.log(&format!("connection closed: {fail:?}"));
                me.apply_fail(&fail);
            }
        });
    }

    /// A stream failed. If the whole connection is gone, say why; otherwise it was only this stream.
    async fn stream_failed(&self, fallback: String) -> Fail {
        let conn = lock(&self.current).clone();
        if let Some(conn) = conn {
            if conn.close_reason().is_none() {
                let _ = tokio::time::timeout(CLOSE_GRACE, conn.closed()).await;
            }
            if let Some(reason) = conn.close_reason() {
                // The watcher task does the same; doing it here too keeps the answer to this request exact.
                let fail = fail_from_close(&reason);
                let mut cur = lock(&self.current);
                if cur.as_ref().is_some_and(|c| c.stable_id() == conn.stable_id()) {
                    *cur = None;
                }
                drop(cur);
                self.apply_fail(&fail);
                return fail;
            }
        }
        Fail::Offline(fallback)
    }

    /// A fresh bi-stream with an HTTP client on it. Dials again once if the connection turned out to be dead.
    async fn open_stream(self: &Arc<Self>) -> Result<SendRequest<Body>, Fail> {
        let mut last = Fail::Offline("Could not open a stream to your PC.".to_owned());
        for _ in 0..2 {
            let conn = self.connection().await?;
            match conn.open_bi().await {
                Ok((send, recv)) => {
                    let (sender, driver) = hyper::client::conn::http1::handshake::<_, Body>(stream_io(recv, send))
                        .await
                        .map_err(|e| Fail::Offline(format!("Could not talk to your PC ({e}).")))?;
                    tokio::spawn(async move {
                        let _ = driver.await;
                    });
                    return Ok(sender);
                }
                Err(e) => {
                    last = self.stream_failed(format!("Could not open a stream to your PC ({e}).")).await;
                    if matches!(last, Fail::Revoked(_)) {
                        return Err(last);
                    }
                }
            }
        }
        Err(last)
    }

    /// A sender that is ready for a request: the lane's own if it still works, else a new stream.
    async fn sender(self: &Arc<Self>, lane: &Lane) -> Result<(SendRequest<Body>, bool), Fail> {
        let held = lock(&lane.sender).take();
        if let Some(mut s) = held {
            if s.ready().await.is_ok() {
                return Ok((s, true));
            }
        }
        let mut s = self.open_stream().await?;
        s.ready().await.map_err(|e| Fail::Offline(format!("Could not talk to your PC ({e}).")))?;
        Ok((s, false))
    }

    /// Sends one request. A request that never reached the stream (the bridge had closed it while it sat idle)
    /// goes out again on a fresh one, and so does a body-less read that failed on a reused stream.
    async fn send(self: &Arc<Self>, lane: &Lane, mut req: Request<Body>, head: Option<Head>) -> Result<Response<Incoming>, Fail> {
        let mut attempts = 0;
        loop {
            attempts += 1;
            let (mut sender, reused) = self.sender(lane).await?;
            match sender.try_send_request(req).await {
                Ok(resp) => {
                    *lock(&lane.sender) = Some(sender);
                    return Ok(resp);
                }
                Err(mut e) => {
                    let back = e.take_message();
                    let err = e.into_error();
                    let may_retry = reused && attempts < 2;
                    if may_retry {
                        if let Some(r) = back {
                            req = r;
                            continue;
                        }
                        if let Some(h) = &head {
                            req = h.rebuild();
                            continue;
                        }
                    }
                    return Err(self.stream_failed(format!("The request did not reach your PC ({err}).")).await);
                }
            }
        }
    }
}

/// While the link is down, dials again in the background: at once, then every few seconds.
async fn reconnect_loop(inner: Arc<Inner>) {
    let mut rx = inner.link.subscribe();
    let _ = inner.connection().await;
    let mut wait = Duration::from_secs(2);
    loop {
        let link = rx.borrow_and_update().clone();
        match link {
            Link::Offline(_) => {
                tokio::time::sleep(wait).await;
                wait = (wait + wait / 2).min(Duration::from_secs(10));
                let _ = inner.connection().await;
            }
            Link::Connecting => {
                if rx.changed().await.is_err() {
                    return;
                }
            }
            // Online: nothing to do until it drops. Revoked and unpaired: dialing again would change nothing,
            // a request or the app starts it again when it wants to.
            Link::Online | Link::Revoked | Link::Unpaired => {
                wait = Duration::from_secs(2);
                if rx.changed().await.is_err() {
                    return;
                }
            }
        }
    }
}

// ---- The local proxy ----

/// What the app holds while the proxy runs.
pub struct ProxyHandle {
    proxy: Arc<Proxy>,
    tasks: Vec<JoinHandle<()>>,
}

impl ProxyHandle {
    pub fn port(&self) -> u16 {
        self.proxy.port
    }

    /// `http://127.0.0.1:<port>`: what the pages see as their own origin.
    pub fn origin(&self) -> &str {
        &self.proxy.origin
    }

    /// A new one-use address that sets the session cookie and redirects to the home page. Load it in the web view.
    pub fn enter_url(&self) -> String {
        let token = random_hex(16);
        let mut tokens = lock(&self.proxy.tokens);
        add_token(&mut tokens, token.clone(), Instant::now());
        format!("{}/__mc/enter?t={token}", self.proxy.origin)
    }

    pub fn link(&self) -> Link {
        self.proxy.inner.link.borrow().clone()
    }

    /// True once the PC is reachable; false if `within` runs out first.
    pub async fn wait_online(&self, within: Duration) -> bool {
        let mut rx = self.proxy.inner.link.subscribe();
        tokio::time::timeout(within, async {
            loop {
                if *rx.borrow_and_update() == Link::Online {
                    return;
                }
                if rx.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
        })
        .await
        .is_ok()
    }

    /// Stops listening and drops every open web view connection. The port is free again when this returns.
    pub async fn stop(mut self) {
        for t in &self.tasks {
            t.abort();
        }
        for t in std::mem::take(&mut self.tasks) {
            let _ = t.await;
        }
    }
}

impl Drop for ProxyHandle {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

struct Proxy {
    inner: Arc<Inner>,
    port: u16,
    host: String,
    origin: String,
    cookie_name: String,
    secret: String,
    tokens: Mutex<HashMap<String, Instant>>,
}

/// Stores a new enter token. Expired tokens go first; when the map is still full, only the oldest one is dropped.
fn add_token(tokens: &mut HashMap<String, Instant>, token: String, now: Instant) {
    tokens.retain(|_, at| now.saturating_duration_since(*at) < TOKEN_TTL);
    if tokens.len() >= MAX_TOKENS {
        if let Some(oldest) = tokens.iter().min_by_key(|(_, at)| **at).map(|(k, _)| k.clone()) {
            tokens.remove(&oldest);
        }
    }
    tokens.insert(token, now);
}

/// The stream that belongs to one web view TCP connection.
#[derive(Default)]
struct Lane {
    sender: Mutex<Option<SendRequest<Body>>>,
    /// Set once a request on this connection passed the cookie check (or used a valid enter token).
    authed: AtomicBool,
}

async fn accept_loop(listener: TcpListener, proxy: Arc<Proxy>, slots: Arc<Semaphore>, pre_auth: Duration) {
    // Dropping the set (when this task is aborted) ends every open web view connection.
    let mut conns: JoinSet<()> = JoinSet::new();
    loop {
        let tcp = match listener.accept().await {
            Ok((tcp, _)) => tcp,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        while conns.try_join_next().is_some() {}
        // Over the cap the connection is closed at once (dropping it).
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            drop(tcp);
            continue;
        };
        let _ = tcp.set_nodelay(true);
        let proxy = proxy.clone();
        let lane = Arc::new(Lane::default());
        conns.spawn(serve_local(tcp, proxy, lane, permit, pre_auth));
    }
}

/// One loopback connection. Before the first authenticated request it lives at most `pre_auth`; after that
/// the longer keep-alive idle limit applies.
async fn serve_local(tcp: tokio::net::TcpStream, proxy: Arc<Proxy>, lane: Arc<Lane>, _permit: OwnedSemaphorePermit, pre_auth: Duration) {
    let watch_lane = lane.clone();
    let svc = service_fn(move |req: Request<Incoming>| {
        let proxy = proxy.clone();
        let lane = lane.clone();
        async move { Ok::<_, Infallible>(proxy.handle(&lane, req).await) }
    });
    let serve = server_http1::Builder::new()
        .timer(TokioTimer::new())
        .max_headers(100)
        .header_read_timeout(LOCAL_HEADER_READ_TIMEOUT)
        .keep_alive(true)
        .serve_connection(TokioIo::new(tcp), svc);
    let deadline = async {
        tokio::time::sleep(pre_auth).await;
        if watch_lane.authed.load(Ordering::Relaxed) {
            std::future::pending::<()>().await;
        }
    };
    tokio::select! {
        _ = serve => {}
        _ = deadline => {}
    }
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%').then(|| b.get(i + 1..i + 3)).flatten().and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match hex {
            Some(v) => {
                out.push(v);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    out
}

/// Compares without stopping at the first difference.
fn same_secret(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// True for a page load (as opposed to a script's fetch).
fn is_navigation(req: &Request<Incoming>) -> bool {
    let h = req.headers();
    match h.get("sec-fetch-mode").and_then(|v| v.to_str().ok()) {
        Some(mode) => mode == "navigate",
        None => req.method() == Method::GET && h.get(ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("text/html")),
    }
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(name, "connection" | "keep-alive" | "te" | "trailer" | "transfer-encoding" | "upgrade") || name.starts_with("proxy-")
}

/// Removes what must not go to the PC: the web view's cookie, anything that claims to be a Mission Control
/// internal header, hop-by-hop headers (and those the `Connection` header names) and `Expect`.
fn clean_request_headers(headers: &mut HeaderMap) {
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
    let doomed: Vec<HeaderName> = headers
        .keys()
        .filter(|k| {
            let k = k.as_str();
            is_hop_by_hop(k) || k == "cookie" || k == "expect" || k.starts_with("x-mc-")
        })
        .cloned()
        .collect();
    for n in doomed {
        headers.remove(n);
    }
    headers.remove(COOKIE);
}

fn wants_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key(UPGRADE)
        || headers
            .get_all(CONNECTION)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .any(|s| s.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")))
}

fn plain(status: StatusCode, text: &str) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from(text.to_owned())).map_err(|never| match never {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    r.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    r
}

fn json(status: StatusCode, body: serde_json::Value, state: Option<&'static str>) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from(body.to_string())).map_err(|never| match never {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    if let Some(s) = state {
        r.headers_mut().insert("x-mc-phone", HeaderValue::from_static(s));
    }
    r
}

fn html(status: StatusCode, page: String, state: &'static str) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from(page)).map_err(|never| match never {}).boxed());
    *r.status_mut() = status;
    let h = r.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    h.insert("cache-control", HeaderValue::from_static("no-store"));
    h.insert("content-security-policy", HeaderValue::from_static(LOCAL_CSP));
    h.insert("x-mc-phone", HeaderValue::from_static(state));
    r
}

/// The proxy's own pages: dark, plain, no color-only meaning.
fn local_page(title: &str, heading: &str, message: &str, shell: Option<&str>, retry: bool, poll: bool) -> String {
    let shell_link = shell.map(|u| format!("<a class=\"btn\" href=\"{}\">Pair again</a>", html_escape(u))).unwrap_or_default();
    let retry_button = if retry { "<button id=\"retry\" type=\"button\">Retry</button>" } else { "" };
    let script = if retry || poll {
        "<script>(function(){var b=document.getElementById('retry');\
function check(){fetch('/__app/ping',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(j.state==='online'){location.reload()}}).catch(function(){})}\
if(b){b.onclick=function(){b.disabled=true;check();setTimeout(function(){b.disabled=false},1500)}}\
setInterval(check,5000)})()</script>"
    } else {
        ""
    };
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title>\
<style>:root{{color-scheme:dark}}body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#14161a;color:#e8eaee;font:16px/1.5 system-ui,sans-serif}}\
main{{max-width:30rem;padding:24px}}h1{{font-size:1.4rem;margin:0 0 .5rem}}p{{margin:.4rem 0}}.why{{color:#aeb4bf}}\
button,.btn{{display:inline-block;margin:16px 12px 0 0;padding:10px 18px;border:2px solid #e8eaee;border-radius:8px;background:transparent;color:#e8eaee;font:inherit;text-decoration:none}}\
button:disabled{{opacity:.5}}</style></head><body><main><h1>{heading}</h1><p class=\"why\">{message}</p>{retry_button}{shell_link}</main>{script}</body></html>",
        title = html_escape(title),
        heading = html_escape(heading),
        message = html_escape(message),
    )
}

impl Proxy {
    fn offline_page(&self, reason: &str) -> Response<Body> {
        let page = local_page("Cannot reach your PC", "Cannot reach your PC", reason, self.inner.cfg.shell_url.as_deref(), true, true);
        html(StatusCode::SERVICE_UNAVAILABLE, page, "offline")
    }

    fn revoked_page(&self) -> Response<Body> {
        let page = local_page(
            "No longer paired",
            "This phone is no longer paired",
            "Your PC removed this phone. Make a new pairing code on the PC (Connections page) and pair again.",
            self.inner.cfg.shell_url.as_deref(),
            false,
            false,
        );
        html(StatusCode::FORBIDDEN, page, "revoked")
    }

    fn signed_out_page(&self) -> Response<Body> {
        let page = local_page("Open the app", "Open Mission Control from the app", "This page was not opened by the app, so it is not allowed to show your PC.", self.inner.cfg.shell_url.as_deref(), false, false);
        let mut r = html(StatusCode::UNAUTHORIZED, page, "signed_out");
        r.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
        r
    }

    fn fail_response(&self, fail: &Fail, nav: bool) -> Response<Body> {
        match fail {
            Fail::Offline(why) if nav => self.offline_page(why),
            Fail::Offline(why) => json(StatusCode::SERVICE_UNAVAILABLE, serde_json::json!({ "error": "pc_unreachable", "reason": why }), Some("offline")),
            Fail::Revoked(_) if nav => self.revoked_page(),
            Fail::Revoked(_) => json(StatusCode::FORBIDDEN, serde_json::json!({ "error": "not_paired" }), Some("revoked")),
        }
    }

    fn cookie_ok(&self, headers: &HeaderMap) -> bool {
        headers.get_all(COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|s| s.split(';')).any(|pair| {
            let Some((name, value)) = pair.trim().split_once('=') else { return false };
            name == self.cookie_name && same_secret(value.as_bytes(), self.secret.as_bytes())
        })
    }

    async fn handle(&self, lane: &Lane, req: Request<Incoming>) -> Response<Body> {
        let nav = is_navigation(&req);
        // 1. Host: only the proxy's own address. This is what stops a web page elsewhere from pointing a
        //    name of its choice at this port.
        let mut hosts = req.headers().get_all(HOST).iter();
        if hosts.next().map(HeaderValue::as_bytes) != Some(self.host.as_bytes()) || hosts.next().is_some() {
            return plain(StatusCode::FORBIDDEN, "forbidden host");
        }
        // 2. Origin: absent, or exactly this address.
        let mut origins = req.headers().get_all(ORIGIN).iter();
        if let Some(first) = origins.next() {
            if first.as_bytes() != self.origin.as_bytes() || origins.next().is_some() {
                return plain(StatusCode::FORBIDDEN, "forbidden origin");
            }
        }
        if req.uri().scheme().is_some() || req.uri().authority().is_some() {
            return plain(StatusCode::BAD_REQUEST, "bad request target");
        }
        // 3. The one address that needs no cookie.
        if req.uri().path() == "/__mc/enter" {
            let r = self.enter(&req);
            if r.status() == StatusCode::FOUND {
                lane.authed.store(true, Ordering::Relaxed);
            }
            return r;
        }
        // 4. The cookie.
        if !self.cookie_ok(req.headers()) {
            return if nav { self.signed_out_page() } else { plain(StatusCode::UNAUTHORIZED, "unauthorized") };
        }
        lane.authed.store(true, Ordering::Relaxed);
        // 5. The phone's own namespaces. Never forwarded, whatever spelling is used.
        let decoded = String::from_utf8_lossy(&percent_decode(req.uri().path())).to_ascii_lowercase();
        if decoded.starts_with("/__") {
            if req.uri().path() == "/__app/ping" && req.method() == Method::GET {
                return self.ping().await;
            }
            return plain(StatusCode::NOT_FOUND, "not found");
        }
        self.forward(lane, req, nav).await
    }

    /// `/__mc/enter?t=<token>`: swaps a one-use token for the session cookie.
    fn enter(&self, req: &Request<Incoming>) -> Response<Body> {
        let token = req.uri().query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("t="))).unwrap_or("");
        let fresh = req.method() == Method::GET && lock(&self.tokens).remove(token).is_some_and(|at| at.elapsed() < TOKEN_TTL);
        if !fresh {
            return self.signed_out_page();
        }
        let mut r = Response::new(empty_body());
        *r.status_mut() = StatusCode::FOUND;
        let h = r.headers_mut();
        h.insert("location", HeaderValue::from_static("/"));
        h.insert("cache-control", HeaderValue::from_static("no-store"));
        if let Ok(c) = HeaderValue::from_str(&format!("{}={}; HttpOnly; SameSite=Strict; Path=/", self.cookie_name, self.secret)) {
            h.insert("set-cookie", c);
        }
        r
    }

    /// `/__app/ping`: tries to make the link work and reports how it stands, including whether the server answers.
    async fn ping(&self) -> Response<Body> {
        let inner = &self.inner;
        if inner.link.borrow().clone() != Link::Online {
            let _ = tokio::time::timeout(Duration::from_secs(8), inner.connection()).await;
        }
        let link = inner.link.borrow().clone();
        let (state, reason): (&'static str, String) = match &link {
            Link::Online => {
                // The server itself: any cheap route will do.
                let lane = Lane::default();
                let mut probe = Request::new(empty_body());
                *probe.uri_mut() = Uri::from_static("/api/health");
                probe.headers_mut().insert(HOST, HeaderValue::from_str(&self.host).unwrap_or_else(|_| HeaderValue::from_static("127.0.0.1")));
                let answer = tokio::time::timeout(Duration::from_secs(6), inner.send(&lane, probe, None)).await;
                match answer {
                    // The bridge marks its own 502 and 504 answers; any other answer came from the server itself.
                    Ok(Ok(resp)) if resp.headers().contains_key(BRIDGE_ERROR_HEADER) => ("server_down", "Mission Control is not running on your PC.".to_owned()),
                    Ok(Ok(_)) => ("online", String::new()),
                    Ok(Err(Fail::Revoked(_))) => ("revoked", String::new()),
                    Ok(Err(Fail::Offline(why))) => ("offline", why),
                    Err(_) => ("server_down", "Mission Control did not answer.".to_owned()),
                }
            }
            Link::Revoked => ("revoked", String::new()),
            Link::Offline(why) => ("offline", why.clone()),
            Link::Connecting => ("connecting", String::new()),
            Link::Unpaired => ("unpaired", String::new()),
        };
        json(StatusCode::OK, serde_json::json!({ "state": state, "reason": reason }), None)
    }

    async fn forward(&self, lane: &Lane, req: Request<Incoming>, nav: bool) -> Response<Body> {
        if req.method() == Method::CONNECT || wants_upgrade(req.headers()) {
            return plain(StatusCode::NOT_IMPLEMENTED, "not supported");
        }
        let (mut parts, body) = req.into_parts();
        clean_request_headers(&mut parts.headers);
        if let Ok(v) = HeaderValue::from_str(&self.inner.cfg.app_version) {
            parts.headers.insert("x-mc-app", v);
        }
        parts.version = Version::HTTP_11;
        // A read without a body can safely be sent a second time.
        let head = (matches!(parts.method, Method::GET | Method::HEAD | Method::OPTIONS) && body.is_end_stream())
            .then(|| Head { method: parts.method.clone(), uri: parts.uri.clone(), headers: parts.headers.clone() });
        let body: Body = body.map_err(|e| -> BoxError { Box::new(e) }).boxed();
        match self.inner.send(lane, Request::from_parts(parts, body), head).await {
            Ok(resp) => self.finish(resp, nav),
            Err(fail) => {
                self.inner.log(&format!("request failed: {fail:?}"));
                self.fail_response(&fail, nav)
            }
        }
    }

    /// The PC's answer on its way to the web view.
    fn finish(&self, resp: Response<Incoming>, nav: bool) -> Response<Body> {
        let (mut parts, body) = resp.into_parts();
        if nav && parts.status == StatusCode::BAD_GATEWAY {
            if let Some(kind) = parts.headers.get(BRIDGE_ERROR_HEADER).and_then(|v| v.to_str().ok()) {
                let why = if kind == "server_down" { "Mission Control is not running on your PC." } else { "Mission Control on your PC took too long to answer." };
                return self.offline_page(why);
            }
        }
        let named: Vec<HeaderName> = parts
            .headers
            .get_all(CONNECTION)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|s| s.split(','))
            .filter_map(|t| HeaderName::from_bytes(t.trim().as_bytes()).ok())
            .collect();
        for n in named {
            parts.headers.remove(n);
        }
        let doomed: Vec<HeaderName> = parts.headers.keys().filter(|k| is_hop_by_hop(k.as_str()) || k.as_str() == "set-cookie").cloned().collect();
        for n in doomed {
            parts.headers.remove(n);
        }
        let is_html = parts.headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.trim_start().to_ascii_lowercase().starts_with("text/html"));
        if is_html {
            parts.headers.append("content-security-policy", HeaderValue::from_static(PAGE_CSP));
        }
        Response::from_parts(parts, body.map_err(|e| -> BoxError { Box::new(e) }).boxed())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_compare_exactly() {
        assert!(same_secret(b"abc", b"abc"));
        assert!(!same_secret(b"abc", b"abd"));
        assert!(!same_secret(b"abc", b"abcd"));
        assert!(!same_secret(b"", b"a"));
    }

    #[test]
    fn percent_decoding_is_forgiving() {
        assert_eq!(percent_decode("/%5f%5Fmc"), b"/__mc");
        assert_eq!(percent_decode("/100%"), b"/100%");
        assert_eq!(percent_decode("/%zz"), b"/%zz");
    }

    #[test]
    fn request_headers_lose_cookie_and_internal_names() {
        let mut h = HeaderMap::new();
        for (k, v) in [
            ("cookie", "mcs-1=x"),
            ("x-mc-device", "evil"),
            ("x-mc-bridge", "evil"),
            ("x-mc-app", "evil"),
            ("x-mc", "1"),
            ("connection", "keep-alive, x-extra"),
            ("x-extra", "1"),
            ("keep-alive", "timeout=5"),
            ("expect", "100-continue"),
            ("accept", "*/*"),
        ] {
            h.append(HeaderName::from_static(k), HeaderValue::from_static(v));
        }
        clean_request_headers(&mut h);
        let mut left: Vec<&str> = h.keys().map(HeaderName::as_str).collect();
        left.sort_unstable();
        assert_eq!(left, ["accept", "x-mc"]);
    }

    #[test]
    fn pages_escape_the_reason() {
        let page = local_page("t", "h", "<script>alert(1)</script>", None, true, true);
        assert!(!page.contains("<script>alert"));
        assert!(page.contains("Retry"));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mcb-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_full_token_map_drops_only_the_oldest() {
        let t0 = Instant::now();
        let mut m = HashMap::new();
        for i in 0..MAX_TOKENS {
            add_token(&mut m, format!("t{i}"), t0 + Duration::from_millis(i as u64));
        }
        assert_eq!(m.len(), MAX_TOKENS);
        add_token(&mut m, "new".into(), t0 + Duration::from_secs(1));
        assert_eq!(m.len(), MAX_TOKENS);
        assert!(!m.contains_key("t0") && m.contains_key("t1") && m.contains_key("new"));
        // After the lifetime has passed, everything old is gone.
        add_token(&mut m, "late".into(), t0 + Duration::from_secs(1) + TOKEN_TTL);
        assert_eq!(m.len(), 1);
        assert_eq!(TOKEN_TTL, Duration::from_secs(60));
    }

    #[test]
    fn a_missing_or_damaged_key_file_is_replaced() {
        let dir = scratch("key");
        let path = dir.join("sub").join("device_key");
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = lines.clone();
        let log: LogFn = Arc::new(move |l: &str| sink.lock().unwrap().push(l.to_owned()));
        let first = load_or_create_key(&path, Some(&log)).unwrap();
        assert_eq!(std::fs::read(&path).unwrap().len(), 32);
        assert!(!path.with_file_name("device_key.tmp").exists());
        assert_eq!(load_or_create_key(&path, Some(&log)).unwrap().to_bytes(), first.to_bytes());
        assert!(lines.lock().unwrap().is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        for bad in [Vec::new(), vec![7u8; 31], vec![7u8; 40]] {
            std::fs::write(&path, &bad).unwrap();
            let made = load_or_create_key(&path, Some(&log)).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), made.to_bytes());
        }
        assert_eq!(lines.lock().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A client with a saved pairing and no reachable PC: enough to run the local proxy.
    async fn offline_client(dir: &Path) -> Client {
        let mut cfg = ClientConfig::new(dir);
        cfg.relay = false;
        cfg.bind = Some("127.0.0.1:0".parse().unwrap());
        let id = SecretKey::generate().public().to_string();
        write_server(&cfg.server_file, &ServerInfo { id, name: "PC".into(), revoked: false }).unwrap();
        Client::start(cfg).await.unwrap()
    }

    async fn closed_within(s: &mut tokio::net::TcpStream, limit: Duration) -> bool {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 16];
        matches!(tokio::time::timeout(limit, s.read(&mut buf)).await, Ok(Ok(0)) | Ok(Err(_)))
    }

    #[tokio::test]
    async fn local_connections_are_capped_and_silent_ones_cut() {
        let dir = scratch("proxy");
        let client = offline_client(&dir).await;
        let proxy = client.start_proxy_with(0, 2, Duration::from_millis(400)).await.unwrap();
        let addr = ("127.0.0.1", proxy.port());
        let mut a = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut b = tokio::net::TcpStream::connect(addr).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        // The third is over the cap and is closed at once.
        let mut c = tokio::net::TcpStream::connect(addr).await.unwrap();
        assert!(closed_within(&mut c, Duration::from_millis(200)).await, "over the cap: closed at once");
        // The first two are silent, so they are cut at the header deadline, which frees their places.
        assert!(closed_within(&mut a, Duration::from_secs(3)).await);
        assert!(closed_within(&mut b, Duration::from_secs(3)).await);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut d = tokio::net::TcpStream::connect(addr).await.unwrap();
        assert!(!closed_within(&mut d, Duration::from_millis(200)).await, "a place is free again");
        proxy.stop().await;
        client.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_authenticated_connection_outlives_the_header_deadline() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir = scratch("proxy-auth");
        let client = offline_client(&dir).await;
        let proxy = client.start_proxy_with(0, 4, Duration::from_millis(400)).await.unwrap();
        let url = proxy.enter_url();
        let path = url.strip_prefix(proxy.origin()).unwrap().to_owned();
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", proxy.port())).await.unwrap();
        let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", proxy.port());
        s.write_all(req.as_bytes()).await.unwrap();
        let mut buf = [0u8; 512];
        let n = tokio::time::timeout(Duration::from_secs(2), s.read(&mut buf)).await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 302"));
        // Idle well past the deadline: the connection stays open.
        assert!(!closed_within(&mut s, Duration::from_millis(900)).await);
        proxy.stop().await;
        client.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_saved_port_is_reused_and_replaced_only_when_taken() {
        let dir = std::env::temp_dir().join(format!("mcb-port-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("port");
        let first = load_or_pick_port(&file).unwrap();
        assert!(!first.changed);
        let again = load_or_pick_port(&file).unwrap();
        assert_eq!(again, first);
        // While something holds the port, a different one is chosen and saved.
        let held = std::net::TcpListener::bind(("127.0.0.1", first.port)).unwrap();
        let other = load_or_pick_port(&file).unwrap();
        assert!(other.changed && other.port != first.port);
        drop(held);
        assert_eq!(load_or_pick_port(&file).unwrap().port, other.port);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
