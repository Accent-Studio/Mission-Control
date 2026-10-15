//! The PC program's core: an iroh endpoint with two protocols, the allowed-device
//! set, and the link to the Mission Control server.
//!
//! * `missioncontrol/http/1`: only endpoint ids in the allowed set keep their
//!   connection; every other connection is closed with code 1 before a stream is
//!   read. Each bi-stream carries one HTTP/1.1 keep-alive connection that is
//!   forwarded to the server (see `forward`).
//! * `missioncontrol/pair/1`: anyone may open it. One stream, one JSON request,
//!   rate limited, forwarded to the server which checks the code.
//!
//! The allowed set is not stored here. The server owns the device list and keeps
//! this process current over the control stream; a revoke closes that device's
//! open connections at once.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use iroh::endpoint::{presets, Connection, ConnectionError, QuicTransportConfig, VarInt};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointAddr, EndpointId, TransportAddr};
use tokio::sync::{mpsc, oneshot, watch, Mutex as AsyncMutex, Semaphore};

use crate::forward::{serve, serve_busy, ForwardConfig, RequestLog, RequestRecord, Timeouts, MAX_REQUEST_BODY};
use crate::keyfile::{self, Protection};
use crate::logfile::{iso_utc, LogFile};
use crate::server_link::{ControlEvent, LinkError, ServerLink, CONTROL_SILENCE};
use crate::stream_io;
use crate::wire::{self, PairReply, PairRequest, ALPN_HTTP, ALPN_PAIR, CLOSE_NOT_PAIRED, CLOSE_REVOKED, CLOSE_STOPPING, CLOSE_TOO_MANY};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// How many times in a row the server may refuse the bridge secret before the bridge stops and asks to be started again.
const MAX_AUTH_TRIES: u32 = 3;

/// Why the bridge stopped on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    /// The server has been gone longer than `--orphan-secs`.
    Orphan,
    /// The server asked for a restart (picks up a new build).
    Restart,
    /// The server keeps refusing the bridge secret even after the secret file was read again.
    /// The program exits with the restart code, so the supervisor starts it again with a fresh read.
    SecretRejected,
    /// The task that keeps the server link going ended or panicked. Something is badly wrong.
    LinkLost,
}

#[derive(Debug, Clone)]
pub struct Limits {
    /// Open requests per device connection; the next one gets a 503.
    pub streams_per_connection: usize,
    /// Live connections per device; the next one is closed with code 4.
    pub connections_per_device: usize,
    /// Wrong pairing codes allowed per window, across all callers.
    pub pair_attempts: usize,
    /// Wrong pairing codes allowed per window from one endpoint id.
    pub pair_attempts_per_endpoint: usize,
    pub pair_window: Duration,
    /// Time a pairing connection has to open its stream and send the whole request.
    pub pair_read_timeout: Duration,
    /// Pairing connections open at once, counted from the moment they arrive. Large on purpose: a connection
    /// that has not sent its request yet costs one task and at most `pair_read_timeout`, so a stranger holding
    /// many silent connections cannot shut real pairings out.
    pub pair_connections: usize,
    /// Pairing connections open at once from one endpoint id.
    pub pair_connections_per_endpoint: usize,
    /// Refused connections are written to the log as one summary line per this long.
    pub denied_log_interval: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            streams_per_connection: 64,
            connections_per_device: 8,
            pair_attempts: 6,
            pair_attempts_per_endpoint: 3,
            pair_window: Duration::from_secs(60),
            pair_read_timeout: Duration::from_secs(3),
            pair_connections: 256,
            pair_connections_per_endpoint: 2,
            denied_log_interval: Duration::from_secs(10),
        }
    }
}

pub struct Options {
    /// Where the key is read from or created.
    pub key_file: PathBuf,
    /// The server's bridge listener.
    pub server: SocketAddr,
    pub secret: String,
    /// Where `secret` came from. It is read again when the server answers 401.
    pub secret_file: Option<PathBuf>,
    /// False: no relay and no address lookup (offline tests).
    pub relay: bool,
    /// Local UDP address for the endpoint (default: let iroh pick).
    pub bind: Option<SocketAddr>,
    pub orphan: Duration,
    pub log: Arc<LogFile>,
    pub limits: Limits,
    pub timeouts: Timeouts,
    pub max_body: u64,
    /// Lock the key file down to the current user, check it, and refuse to start if that fails (Windows `icacls`).
    pub restrict_key_acl: bool,
    /// Also lock the folder that holds the key. Off when the key file sits in a folder the bridge does not own.
    pub restrict_key_dir: bool,
    /// How long to wait for the relay before saying hello anyway.
    pub online_wait: Duration,
}

impl Options {
    pub fn new(key_file: PathBuf, server: SocketAddr, secret: String, log: Arc<LogFile>) -> Options {
        Options {
            key_file,
            server,
            secret,
            secret_file: None,
            relay: true,
            bind: None,
            orphan: Duration::from_secs(300),
            log,
            limits: Limits::default(),
            timeouts: Timeouts::default(),
            max_body: MAX_REQUEST_BODY,
            restrict_key_acl: true,
            restrict_key_dir: true,
            online_wait: Duration::from_secs(20),
        }
    }
}

/// First eight characters of an id, as written in the log.
pub fn short(id: &impl std::fmt::Display) -> String {
    id.to_string().chars().take(8).collect()
}

/// Wrong pairing codes seen lately: all together and per endpoint. A right code is never recorded.
#[derive(Default)]
struct PairLimiter {
    all: VecDeque<Instant>,
    by_endpoint: HashMap<EndpointId, VecDeque<Instant>>,
}

/// Connections and pairing requests turned away since the last summary line.
#[derive(Default)]
struct Denied {
    not_paired: u64,
    too_many: u64,
    pair_limited: u64,
    last: Option<String>,
}

/// Work for the one task that talks to the server on behalf of the connection handlers.
/// A single queue keeps the messages in the order they happened.
enum LinkMsg {
    Presence { id: EndpointId, online: bool },
    Hello { body: serde_json::Value, reply: oneshot::Sender<Result<(), LinkError>> },
}

struct Shared {
    log: Arc<LogFile>,
    link: ServerLink,
    endpoint_id: EndpointId,
    upstream: SocketAddr,
    limits: Limits,
    timeouts: Timeouts,
    max_body: u64,
    allowed: Mutex<HashSet<EndpointId>>,
    conns: Mutex<HashMap<EndpointId, Vec<Connection>>>,
    limiter: Mutex<PairLimiter>,
    /// Held while a pairing request is checked with the server: one at a time.
    pairing: AsyncMutex<()>,
    pair_conns: Semaphore,
    pair_by_endpoint: Mutex<HashMap<EndpointId, usize>>,
    denied: Mutex<Denied>,
    to_server: mpsc::UnboundedSender<LinkMsg>,
    stopping: AtomicBool,
    /// True once the server sent its first device list. Before that, a phone is told to try again, never "not paired".
    listed: AtomicBool,
    exit: watch::Sender<Option<Exit>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn close_code(err: &ConnectionError) -> String {
    match err {
        ConnectionError::ApplicationClosed(c) => format!("app:{}", u64::from(c.error_code)),
        ConnectionError::ConnectionClosed(_) => "transport".to_owned(),
        ConnectionError::LocallyClosed => "local".to_owned(),
        ConnectionError::TimedOut => "timeout".to_owned(),
        ConnectionError::Reset => "reset".to_owned(),
        _ => "other".to_owned(),
    }
}

fn via(conn: &Connection) -> &'static str {
    let paths = conn.paths();
    match paths.iter().find(|p| p.is_selected()) {
        Some(p) if p.is_ip() => "direct",
        Some(_) => "relay",
        None => "unknown",
    }
}

#[derive(Clone, Copy)]
enum Turned {
    NotPaired,
    TooMany,
    PairLimited,
}

impl Shared {
    fn is_allowed(&self, id: &EndpointId) -> bool {
        lock(&self.allowed).contains(id)
    }

    /// Counts a refusal. It reaches the log in the next summary line, so a flood of refused
    /// connections from strangers cannot fill the log or slow the bridge down.
    fn note_turned_away(&self, id: &EndpointId, why: Turned) {
        let mut d = lock(&self.denied);
        match why {
            Turned::NotPaired => d.not_paired += 1,
            Turned::TooMany => d.too_many += 1,
            Turned::PairLimited => d.pair_limited += 1,
        }
        d.last = Some(short(id));
    }

    /// Writes the summary line if anything was refused since the last one.
    fn flush_denied(&self) {
        let d = std::mem::take(&mut *lock(&self.denied));
        let total = d.not_paired + d.too_many + d.pair_limited;
        if total > 0 {
            self.log.line(&format!(
                "refused count={total} in {}s: not_paired={} too_many={} pair_limited={} last={}",
                self.limits.denied_log_interval.as_secs(),
                d.not_paired,
                d.too_many,
                d.pair_limited,
                d.last.as_deref().unwrap_or("-")
            ));
        }
    }

    /// Records a new device connection. Refused (and closed) when the id is not allowed or has too many.
    /// The allowed check happens under the connection lock, so a revoke cannot slip between check and insert.
    fn register(&self, conn: &Connection) -> bool {
        let id = conn.remote_id();
        let mut conns = lock(&self.conns);
        // No list from the server yet (the bridge just started, or the server could not read it): the phone would take
        // "not paired" for a removal and stop trying, so it is told the bridge is restarting and dials again.
        if !self.listed.load(Ordering::SeqCst) {
            drop(conns);
            conn.close(VarInt::from_u32(CLOSE_STOPPING), b"no device list yet");
            return false;
        }
        if !self.is_allowed(&id) {
            drop(conns);
            self.note_turned_away(&id, Turned::NotPaired);
            conn.close(VarInt::from_u32(CLOSE_NOT_PAIRED), b"not paired");
            return false;
        }
        let list = conns.entry(id).or_default();
        list.retain(|c| c.close_reason().is_none());
        if list.len() >= self.limits.connections_per_device {
            drop(conns);
            self.note_turned_away(&id, Turned::TooMany);
            conn.close(VarInt::from_u32(CLOSE_TOO_MANY), b"too many connections");
            return false;
        }
        let first = list.is_empty();
        list.push(conn.clone());
        // Queued while the lock is held: an "offline" from another connection of this device cannot be
        // queued between this insert and this report, so the server never hears the two out of order.
        if first {
            self.report_presence(id, true);
        }
        drop(conns);
        self.log.line(&format!("conn accepted dev={} via={}", short(&id), via(conn)));
        true
    }

    fn unregister(&self, conn: &Connection) {
        let id = conn.remote_id();
        let mut conns = lock(&self.conns);
        if let Some(list) = conns.get_mut(&id) {
            list.retain(|c| c.stable_id() != conn.stable_id() && c.close_reason().is_none());
            if list.is_empty() {
                conns.remove(&id);
                // Queued while the lock is held, for the same reason as in `register`.
                if !self.stopping.load(Ordering::SeqCst) {
                    self.report_presence(id, false);
                }
            }
        }
    }

    /// Queues the change for the one task that talks to the server, so reports arrive in the order they happened.
    fn report_presence(&self, id: EndpointId, online: bool) {
        let _ = self.to_server.send(LinkMsg::Presence { id, online });
    }

    fn connected_ids(&self) -> Vec<EndpointId> {
        lock(&self.conns).iter().filter(|(_, v)| v.iter().any(|c| c.close_reason().is_none())).map(|(k, _)| *k).collect()
    }

    fn allow(&self, id: EndpointId) {
        lock(&self.allowed).insert(id);
    }

    /// Takes the id out of the allowed set first, then closes its connections.
    fn revoke(&self, id: &EndpointId) {
        lock(&self.allowed).remove(id);
        let doomed = lock(&self.conns).remove(id).unwrap_or_default();
        let n = doomed.len();
        for c in doomed {
            c.close(VarInt::from_u32(CLOSE_REVOKED), b"revoked");
        }
        self.log.line(&format!("revoked dev={} closed_connections={n}", short(id)));
    }

    /// Replaces the allowed set; connections of ids that are no longer in it are closed.
    fn replace_allowed(&self, ids: &[String]) {
        let mut next = HashSet::new();
        for s in ids {
            match s.parse::<EndpointId>() {
                Ok(id) => {
                    next.insert(id);
                }
                Err(_) => self.log.line("device list holds an id that is not an endpoint id; skipped"),
            }
        }
        let gone: Vec<EndpointId> = {
            let mut allowed = lock(&self.allowed);
            let gone = allowed.difference(&next).copied().collect();
            *allowed = next.clone();
            gone
        };
        // A device that had a connection but is not in the list (revoked while the link was down).
        let stale: Vec<EndpointId> = lock(&self.conns).keys().filter(|k| !next.contains(*k)).copied().collect();
        for id in gone.iter().chain(stale.iter()).collect::<HashSet<_>>() {
            self.revoke(id);
        }
        self.listed.store(true, Ordering::SeqCst);
        self.log.line(&format!("device list received count={}", next.len()));
    }

    fn request_log(&self) -> RequestLog {
        let log = self.log.clone();
        Arc::new(move |r: &RequestRecord| {
            log.line(&format!("req dev={} {} {} {} {}B {}ms", short(&r.device), r.method, r.path, r.status, r.bytes, r.millis));
        })
    }

    fn forward_config(&self, device: &EndpointId) -> ForwardConfig {
        let mut cfg = ForwardConfig::new(self.upstream, device.to_string());
        // Looked up for every request, so a secret read again after a 401 reaches streams that are already open.
        let link = self.link.clone();
        cfg.inject_fn = Some(Arc::new(move || vec![(hyper::header::HeaderName::from_static("x-mc-bridge"), link.current_secret())]));
        cfg.max_body = self.max_body;
        cfg.timeouts = self.timeouts;
        cfg.on_request = Some(self.request_log());
        cfg
    }

    /// True when `id` may try a code now: neither it nor the whole bridge has used up its wrong codes for this window.
    /// Asking does not use anything up; only `pair_failed` does.
    fn pair_attempt_allowed(&self, id: &EndpointId) -> bool {
        let mut l = lock(&self.limiter);
        let now = Instant::now();
        let window = self.limits.pair_window;
        while l.all.front().is_some_and(|t| now.duration_since(*t) >= window) {
            l.all.pop_front();
        }
        l.by_endpoint.retain(|_, q| {
            while q.front().is_some_and(|t| now.duration_since(*t) >= window) {
                q.pop_front();
            }
            !q.is_empty()
        });
        l.all.len() < self.limits.pair_attempts && l.by_endpoint.get(id).is_none_or(|q| q.len() < self.limits.pair_attempts_per_endpoint)
    }

    /// Records one wrong code. The table stays small: at most `pair_attempts` entries live at a time.
    fn pair_failed(&self, id: &EndpointId) {
        let mut l = lock(&self.limiter);
        let now = Instant::now();
        l.all.push_back(now);
        l.by_endpoint.entry(*id).or_default().push_back(now);
    }
}

#[derive(Clone)]
struct HttpHandler(Arc<Shared>);

impl std::fmt::Debug for HttpHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HttpHandler")
    }
}

impl ProtocolHandler for HttpHandler {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let shared = &self.0;
        if shared.stopping.load(Ordering::SeqCst) {
            conn.close(VarInt::from_u32(CLOSE_STOPPING), b"bridge stopping");
            return Ok(());
        }
        if !shared.register(&conn) {
            return Ok(());
        }
        let cfg = shared.forward_config(&conn.remote_id());
        let slots = Arc::new(Semaphore::new(shared.limits.streams_per_connection));
        let reason = loop {
            match conn.accept_bi().await {
                Ok((send, recv)) => {
                    let io = stream_io(recv, send);
                    match slots.clone().try_acquire_owned() {
                        Ok(permit) => {
                            let cfg = cfg.clone();
                            tokio::spawn(async move {
                                let _ = serve(io, cfg).await;
                                drop(permit);
                            });
                        }
                        Err(_) => {
                            shared.log.line(&format!("stream refused dev={} reason=too_many_streams", short(&conn.remote_id())));
                            tokio::spawn(async move {
                                let _ = serve_busy(io).await;
                            });
                        }
                    }
                }
                Err(e) => break e,
            }
        };
        shared.unregister(&conn);
        shared.log.line(&format!("conn closed dev={} reason={}", short(&conn.remote_id()), close_code(&reason)));
        Ok(())
    }
}

#[derive(Clone)]
struct PairHandler(Arc<Shared>);

impl std::fmt::Debug for PairHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PairHandler")
    }
}

/// One pairing connection of one endpoint id; gives the place back when dropped.
struct EndpointSlot<'a> {
    shared: &'a Shared,
    id: EndpointId,
}

impl<'a> EndpointSlot<'a> {
    fn take(shared: &'a Shared, id: EndpointId) -> Option<EndpointSlot<'a>> {
        let mut m = lock(&shared.pair_by_endpoint);
        let n = m.entry(id).or_insert(0);
        if *n >= shared.limits.pair_connections_per_endpoint {
            return None;
        }
        *n += 1;
        Some(EndpointSlot { shared, id })
    }
}

impl Drop for EndpointSlot<'_> {
    fn drop(&mut self) {
        let mut m = lock(&self.shared.pair_by_endpoint);
        if let Some(n) = m.get_mut(&self.id) {
            *n -= 1;
            if *n == 0 {
                m.remove(&self.id);
            }
        }
    }
}

/// How long a request waits for its turn while another pairing is being checked with the server.
const PAIRING_TURN: Duration = Duration::from_secs(5);

impl ProtocolHandler for PairHandler {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let shared = &self.0;
        let remote = conn.remote_id();
        // Taken on arrival, before anything is read, so the caps are generous: a silent peer is cut after
        // `pair_read_timeout`. Each endpoint id gets only a couple, so one stranger cannot use up the rest.
        let Ok(_slot) = shared.pair_conns.try_acquire() else {
            conn.close(VarInt::from_u32(CLOSE_TOO_MANY), b"busy");
            return Ok(());
        };
        let Some(_mine) = EndpointSlot::take(shared, remote) else {
            conn.close(VarInt::from_u32(CLOSE_TOO_MANY), b"busy");
            return Ok(());
        };
        // The whole request has to arrive within one deadline. Nothing else is held while waiting for it:
        // no turn, no limiter slot. A silent peer costs this connection and nothing more.
        let deadline = tokio::time::Instant::now() + shared.limits.pair_read_timeout;
        let Ok(Ok((mut send, mut recv))) = tokio::time::timeout_at(deadline, conn.accept_bi()).await else {
            return Ok(());
        };
        let request = tokio::time::timeout_at(deadline, wire::read_json::<_, PairRequest>(&mut recv)).await;

        let reply = match request {
            Ok(Ok(PairRequest::Pair { code, device_name })) => attempt(shared, &remote, &code, &device_name).await,
            Ok(Err(e)) => {
                shared.log.line(&format!("pair rejected dev={} reason=bad_request ({})", short(&remote), wire_reason(&e)));
                error_reply("bridge_error", "The pairing request was not understood")
            }
            Err(_) => {
                shared.log.line(&format!("pair rejected dev={} reason=timeout", short(&remote)));
                error_reply("bridge_error", "The pairing request did not arrive in time")
            }
        };

        let _ = wire::write_json(&mut send, &reply).await;
        let _ = send.finish();
        // Give the phone time to read the answer before the connection goes away.
        let _ = tokio::time::timeout(Duration::from_secs(5), conn.closed()).await;
        Ok(())
    }
}

/// One complete pairing request: waits for its turn, checks the limits, asks the server. Only a wrong code
/// uses up the limits.
async fn attempt(shared: &Shared, remote: &EndpointId, code: &str, device_name: &str) -> PairReply {
    let Ok(_turn) = tokio::time::timeout(PAIRING_TURN, shared.pairing.lock()).await else {
        shared.note_turned_away(remote, Turned::PairLimited);
        return error_reply("rate_limited", "Another pairing is in progress");
    };
    if !shared.pair_attempt_allowed(remote) {
        shared.note_turned_away(remote, Turned::PairLimited);
        return error_reply("rate_limited", "Too many attempts, wait a minute");
    }
    let reply = pair(shared, remote, code, device_name).await;
    if matches!(&reply, PairReply::Error { code, .. } if code == "bad_code") {
        shared.pair_failed(remote);
    }
    reply
}

fn wire_reason(e: &wire::WireError) -> &'static str {
    match e {
        wire::WireError::Io(_) => "io",
        wire::WireError::Json(_) => "json",
        wire::WireError::TooLarge(_) => "too large",
    }
}

fn error_reply(code: &str, message: &str) -> PairReply {
    PairReply::Error { code: code.to_owned(), message: message.to_owned() }
}

/// Asks the server whether the code is good. On success the phone is allowed at once.
async fn pair(shared: &Shared, remote: &EndpointId, code: &str, device_name: &str) -> PairReply {
    let name: String = device_name.chars().filter(|c| !c.is_control()).take(40).collect();
    let log_name: String = name.chars().take(30).collect();
    if code.is_empty() || code.len() > 64 {
        shared.log.line(&format!("pair failed dev={} reason=bad_code", short(remote)));
        return error_reply("bad_code", "That code does not work");
    }
    let body = serde_json::json!({ "endpointId": remote.to_string(), "code": code, "deviceName": name });
    match shared.link.post("/api/bridge/pair", &body).await {
        Ok((status, answer)) if status.is_success() => {
            if answer.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                shared.allow(*remote);
                shared.log.line(&format!("pair ok dev={} name={log_name:?}", short(remote)));
                let server_name = answer.get("serverName").and_then(|v| v.as_str()).unwrap_or("Mission Control").to_owned();
                PairReply::Paired { server_name }
            } else {
                shared.log.line(&format!("pair failed dev={} reason=bad_code", short(remote)));
                error_reply("bad_code", "That code does not work")
            }
        }
        Ok((status, _)) => {
            shared.log.line(&format!("pair failed dev={} reason=server_status_{}", short(remote), status.as_u16()));
            error_reply("bridge_error", "Mission Control could not check the code")
        }
        Err(e) => {
            shared.log.line(&format!("pair failed dev={} reason=server_down ({e})", short(remote)));
            error_reply("bridge_error", "Mission Control is not running")
        }
    }
}

// ---- The running bridge ----

pub struct Bridge {
    shared: Arc<Shared>,
    router: Router,
    endpoint: Endpoint,
    link_task: tokio::task::JoinHandle<()>,
    /// Set once `link_task` has been seen finished (a JoinHandle must not be polled again after that).
    link_done: bool,
    worker_task: tokio::task::JoinHandle<()>,
    /// Same as `link_done`, for `worker_task`.
    worker_done: bool,
    denied_task: tokio::task::JoinHandle<()>,
    exit: watch::Receiver<Option<Exit>>,
    relay: bool,
}

impl Bridge {
    pub async fn start(opts: Options) -> Result<Bridge, String> {
        let acl = keyfile::system_acl();
        let protect = opts.restrict_key_acl.then_some(Protection { tool: &*acl, lock_dir: opts.restrict_key_dir });
        let key = keyfile::load_or_create_key(&opts.key_file, protect.as_ref(), &opts.log)?;
        let mut link = ServerLink::new(opts.server, &opts.secret)?;
        if let Some(file) = &opts.secret_file {
            link = link.with_secret_file(file.clone());
        }
        let transport = QuicTransportConfig::builder().max_concurrent_bidi_streams(VarInt::from_u32(128)).build();
        let builder = if opts.relay { Endpoint::builder(presets::N0) } else { Endpoint::builder(presets::Minimal) };
        let mut builder = builder.secret_key(key).transport_config(transport);
        if let Some(addr) = opts.bind {
            builder = builder.bind_addr(addr).map_err(|e| format!("cannot use bind address {addr}: {e}"))?;
        }
        let endpoint = builder.bind().await.map_err(|e| format!("could not start the network endpoint: {e}"))?;

        let (exit_tx, exit_rx) = watch::channel(None);
        let (to_server, from_handlers) = mpsc::unbounded_channel();
        let worker_task = tokio::spawn(server_worker(link.clone(), opts.log.clone(), from_handlers));
        let shared = Arc::new(Shared {
            log: opts.log.clone(),
            link,
            endpoint_id: endpoint.id(),
            upstream: opts.server,
            limits: opts.limits.clone(),
            timeouts: opts.timeouts,
            max_body: opts.max_body,
            allowed: Mutex::new(HashSet::new()),
            conns: Mutex::new(HashMap::new()),
            limiter: Mutex::new(PairLimiter::default()),
            pairing: AsyncMutex::new(()),
            pair_conns: Semaphore::new(opts.limits.pair_connections),
            pair_by_endpoint: Mutex::new(HashMap::new()),
            denied: Mutex::new(Denied::default()),
            to_server,
            stopping: AtomicBool::new(false),
            listed: AtomicBool::new(false),
            exit: exit_tx,
        });
        let router = Router::builder(endpoint.clone())
            .accept(ALPN_HTTP, HttpHandler(shared.clone()))
            .accept(ALPN_PAIR, PairHandler(shared.clone()))
            .spawn();
        let started_at = iso_utc(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()));
        opts.log.line(&format!("bridge started version={VERSION} id={} server={}", endpoint.id(), opts.server));
        let denied_task = tokio::spawn(denied_summaries(Arc::downgrade(&shared), opts.limits.denied_log_interval));
        let link_task = tokio::spawn(link_loop(shared.clone(), endpoint.clone(), opts.relay, opts.online_wait, opts.orphan, started_at));
        Ok(Bridge { shared, router, endpoint, link_task, link_done: false, worker_task, worker_done: false, denied_task, exit: exit_rx, relay: opts.relay })
    }

    pub fn id(&self) -> EndpointId {
        self.endpoint.id()
    }

    /// The endpoint's id plus its local sockets. Enough to dial it without a relay.
    pub fn direct_addr(&self) -> EndpointAddr {
        EndpointAddr::from_parts(self.endpoint.id(), self.endpoint.bound_sockets().into_iter().map(TransportAddr::Ip))
    }

    pub fn uses_relay(&self) -> bool {
        self.relay
    }

    /// Ids in the allowed set right now, sorted.
    pub fn allowed(&self) -> Vec<String> {
        let mut v: Vec<String> = lock(&self.shared.allowed).iter().map(ToString::to_string).collect();
        v.sort();
        v
    }

    /// Ids with at least one live connection, sorted.
    pub fn connected(&self) -> Vec<String> {
        let mut v: Vec<String> = self.shared.connected_ids().iter().map(ToString::to_string).collect();
        v.sort();
        v
    }

    /// Resolves when the bridge decides to stop by itself, or when the task that runs the server link has
    /// ended without saying why (a panic): the bridge must not carry on without it.
    pub async fn wait_exit(&mut self) -> Exit {
        loop {
            if let Some(e) = *self.exit.borrow_and_update() {
                return e;
            }
            if self.link_done || self.worker_done {
                return Exit::LinkLost;
            }
            tokio::select! {
                changed = self.exit.changed() => {
                    if changed.is_err() {
                        return Exit::LinkLost;
                    }
                }
                ended = &mut self.link_task => {
                    self.link_done = true;
                    // The task that sets the exit reason also ends right after; the reason wins.
                    if let Some(e) = *self.exit.borrow() {
                        return e;
                    }
                    match ended {
                        Err(e) if e.is_panic() => self.shared.log.line("the server link task panicked"),
                        Err(_) => self.shared.log.line("the server link task was cancelled"),
                        Ok(()) => self.shared.log.line("the server link task ended without a reason"),
                    }
                    return Exit::LinkLost;
                }
                ended = &mut self.worker_task => {
                    // It only ends when something went wrong: nobody else would send hello or presence again.
                    self.worker_done = true;
                    match ended {
                        Err(e) if e.is_panic() => self.shared.log.line("the server worker task panicked"),
                        Err(_) => self.shared.log.line("the server worker task was cancelled"),
                        Ok(()) => self.shared.log.line("the server worker task ended without a reason"),
                    }
                    return Exit::LinkLost;
                }
            }
        }
    }

    /// Stops the server link task, as if it had failed. For tests of `wait_exit`.
    #[doc(hidden)]
    pub fn abort_link_task(&self) {
        self.link_task.abort();
    }

    /// Stops the task that sends hello and presence, as if it had failed. For tests of `wait_exit`.
    #[doc(hidden)]
    pub fn abort_worker_task(&self) {
        self.worker_task.abort();
    }

    /// Tells every connected device the bridge is stopping, then shuts the endpoint down.
    pub async fn shutdown(self) {
        self.shared.stopping.store(true, Ordering::SeqCst);
        self.link_task.abort();
        self.worker_task.abort();
        self.denied_task.abort();
        self.shared.flush_denied();
        let all: Vec<Connection> = lock(&self.shared.conns).drain().flat_map(|(_, v)| v).collect();
        for c in all {
            c.close(VarInt::from_u32(CLOSE_STOPPING), b"bridge stopping");
        }
        let _ = tokio::time::timeout(Duration::from_secs(5), self.router.shutdown()).await;
        self.shared.log.line("bridge stopped");
    }
}

// ---- The server worker and the link loop ----

/// The one task that sends hello and presence reports. Messages are handled in the order they were queued.
/// Presence changes that pile up while a call is under way are merged: only the latest state of each device
/// is sent, so a slow server never receives "offline" before an older "online" has been told.
async fn server_worker(link: ServerLink, log: Arc<LogFile>, mut rx: mpsc::UnboundedReceiver<LinkMsg>) {
    let mut pending: Vec<(EndpointId, bool)> = Vec::new();
    while let Some(first) = rx.recv().await {
        let mut batch = vec![first];
        while let Ok(more) = rx.try_recv() {
            batch.push(more);
        }
        for msg in batch {
            match msg {
                LinkMsg::Presence { id, online } => match pending.iter_mut().find(|(known, _)| *known == id) {
                    Some(entry) => entry.1 = online,
                    None => pending.push((id, online)),
                },
                LinkMsg::Hello { body, reply } => {
                    // Everything reported before the hello is told first.
                    send_presence(&link, &log, &mut pending).await;
                    let result = match link.post("/api/bridge/hello", &body).await {
                        Ok((status, _)) if status.is_success() => Ok(()),
                        Ok((status, _)) => Err(LinkError::Status(status.as_u16())),
                        Err(e) => Err(e),
                    };
                    let _ = reply.send(result);
                }
            }
        }
        send_presence(&link, &log, &mut pending).await;
    }
}

async fn send_presence(link: &ServerLink, log: &LogFile, pending: &mut Vec<(EndpointId, bool)>) {
    for (id, online) in std::mem::take(pending) {
        let body = serde_json::json!({ "id": id.to_string(), "online": online });
        match link.post("/api/bridge/presence", &body).await {
            Ok((s, _)) if s.is_success() || s.as_u16() == 404 => {}
            Ok((s, _)) => log.line(&format!("presence report failed dev={} status={}", short(&id), s.as_u16())),
            Err(e) => log.line(&format!("presence report failed dev={}: {e}", short(&id))),
        }
    }
}

/// Writes the "refused" summary line every `every`. Ends when the bridge is gone.
async fn denied_summaries(shared: Weak<Shared>, every: Duration) {
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
    loop {
        tick.tick().await;
        let Some(shared) = shared.upgrade() else { return };
        shared.flush_denied();
    }
}

async fn link_loop(shared: Arc<Shared>, endpoint: Endpoint, relay: bool, online_wait: Duration, orphan: Duration, started_at: String) {
    if relay {
        match tokio::time::timeout(online_wait, endpoint.online()).await {
            Ok(()) => shared.log.line("relay connected"),
            Err(_) => shared.log.line("relay not reachable yet; carrying on"),
        }
    }
    let mut down_since = Some(Instant::now());
    let mut backoff = Duration::from_secs(1);
    let mut first_failure_logged = false;
    let mut refused = 0u32;
    loop {
        match run_session(&shared, &started_at, &mut down_since, &mut backoff).await {
            Ok(Some(exit)) => {
                shared.log.line(&format!("exiting: {exit:?}"));
                let _ = shared.exit.send(Some(exit));
                return;
            }
            Ok(None) => {
                shared.log.line("control stream down");
                first_failure_logged = true;
                refused = 0;
            }
            Err(LinkError::Status(401)) => {
                // The link has already read the secret file again and tried once more with a new value.
                refused += 1;
                shared.log.line(&format!("server refused the bridge secret (try {refused} of {MAX_AUTH_TRIES})"));
                if refused >= MAX_AUTH_TRIES {
                    shared.log.line("server keeps refusing the bridge secret; exiting so the supervisor starts the bridge again");
                    let _ = shared.exit.send(Some(Exit::SecretRejected));
                    return;
                }
                // The server answered, so it is not gone: the orphan clock starts again.
                down_since = Some(Instant::now());
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            Err(e) => {
                if !first_failure_logged {
                    shared.log.line(&format!("server link failed: {e}"));
                    first_failure_logged = true;
                }
            }
        }
        let since = *down_since.get_or_insert_with(Instant::now);
        if since.elapsed() >= orphan {
            shared.log.line(&format!("server gone for {} s; exiting", orphan.as_secs()));
            let _ = shared.exit.send(Some(Exit::Orphan));
            return;
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(5));
    }
}

/// One pass: hello, open the control stream, apply events until it ends.
/// Ok(Some(exit)) means stop the program; Ok(None) means the stream ended; Err means it never came up.
async fn run_session(shared: &Arc<Shared>, started_at: &str, down_since: &mut Option<Instant>, backoff: &mut Duration) -> Result<Option<Exit>, LinkError> {
    let online: Vec<String> = shared.connected_ids().iter().map(ToString::to_string).collect();
    let hello = serde_json::json!({
        "endpointId": shared.endpoint_id.to_string(),
        "version": VERSION,
        "startedAt": started_at,
        "online": online,
    });
    let (reply, answer) = oneshot::channel();
    let gone = || LinkError::Down("the server worker stopped".to_owned());
    shared.to_server.send(LinkMsg::Hello { body: hello, reply }).map_err(|_| gone())?;
    answer.await.map_err(|_| gone())??;
    let mut stream = shared.link.open_control().await?;
    shared.log.line("control stream up");
    *down_since = None;
    *backoff = Duration::from_secs(1);
    loop {
        let ev = match tokio::time::timeout(CONTROL_SILENCE, stream.next()).await {
            Ok(Ok(Some(ev))) => ev,
            Ok(Ok(None)) | Ok(Err(_)) | Err(_) => {
                *down_since = Some(Instant::now());
                return Ok(None);
            }
        };
        match ev {
            ControlEvent::Devices(ids) => shared.replace_allowed(&ids),
            ControlEvent::Add(id) => match id.parse::<EndpointId>() {
                Ok(id) => {
                    shared.allow(id);
                    shared.log.line(&format!("device added dev={}", short(&id)));
                }
                Err(_) => shared.log.line("add event with an id that is not an endpoint id; skipped"),
            },
            ControlEvent::Revoke(id) => match id.parse::<EndpointId>() {
                Ok(id) => shared.revoke(&id),
                Err(_) => shared.log.line("revoke event with an id that is not an endpoint id; skipped"),
            },
            ControlEvent::Restart => return Ok(Some(Exit::Restart)),
            ControlEvent::Ping => {}
        }
    }
}
