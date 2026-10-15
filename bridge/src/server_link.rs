//! The bridge's own conversation with the Mission Control server on its private
//! listener (127.0.0.1:1701): hello, presence, pairing, and the control stream
//! that keeps the allowed-device list current.
//!
//! Every call carries the bridge secret and no device header. The secret is
//! marked sensitive, so it never shows in a debug print. When the server answers
//! 401 the secret file is read again, and the call is repeated once if the file
//! holds a different secret (the server was started again with a new one).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{HeaderValue, ACCEPT, CONNECTION, CONTENT_TYPE, HOST};
use hyper::{Request, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// A control stream is pinged every 25 s; this much silence means it is dead.
pub const CONTROL_SILENCE: Duration = Duration::from_secs(75);
const MAX_EVENT_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub enum LinkError {
    /// Could not connect or the connection broke.
    Down(String),
    /// The server answered with a status we did not expect.
    Status(u16),
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LinkError::Down(why) => write!(f, "server not reachable ({why})"),
            LinkError::Status(401) => write!(f, "server refused the bridge secret (401)"),
            LinkError::Status(code) => write!(f, "server answered {code}"),
        }
    }
}

impl std::error::Error for LinkError {}

fn down(e: impl std::fmt::Display) -> LinkError {
    LinkError::Down(e.to_string())
}

/// What the server pushes on the control stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlEvent {
    /// The full list of allowed device ids; replaces what the bridge had.
    Devices(Vec<String>),
    Add(String),
    Revoke(String),
    Restart,
    Ping,
}

/// The secret as one shared value. The file it came from is read again when the server refuses it.
struct SecretCell {
    value: RwLock<HeaderValue>,
    file: Option<PathBuf>,
}

impl SecretCell {
    fn get(&self) -> HeaderValue {
        self.value.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Reads the secret file again. True when the file holds a secret different from `used`
    /// (the one the refused request carried); that secret is then the current value.
    fn reload(&self, used: &HeaderValue) -> bool {
        let Some(path) = &self.file else { return false };
        let Some(text) = std::fs::read_to_string(path).ok().and_then(|t| parse_secret(&t)) else { return false };
        let Ok(mut fresh) = HeaderValue::from_str(&text) else { return false };
        fresh.set_sensitive(true);
        let changed = fresh != *used;
        *self.value.write().unwrap_or_else(|e| e.into_inner()) = fresh;
        changed
    }
}

/// The secret as the server writes it: 64 hex characters, maybe followed by a line break.
pub fn parse_secret(text: &str) -> Option<String> {
    let text = text.trim();
    (text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())).then(|| text.to_owned())
}

#[derive(Clone)]
pub struct ServerLink {
    addr: SocketAddr,
    secret: Arc<SecretCell>,
}

impl std::fmt::Debug for ServerLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerLink").field("addr", &self.addr).field("secret", &"(redacted)").finish()
    }
}

impl ServerLink {
    pub fn new(addr: SocketAddr, secret: &str) -> Result<ServerLink, String> {
        let mut secret = HeaderValue::from_str(secret).map_err(|_| "the bridge secret has characters that cannot go in a header".to_owned())?;
        secret.set_sensitive(true);
        Ok(ServerLink { addr, secret: Arc::new(SecretCell { value: RwLock::new(secret), file: None }) })
    }

    /// After a 401 the secret is read again from this file and the call is tried once more.
    pub fn with_secret_file(mut self, file: PathBuf) -> ServerLink {
        let value = self.secret.get();
        self.secret = Arc::new(SecretCell { value: RwLock::new(value), file: Some(file) });
        self
    }

    /// The secret in use now (marked sensitive).
    pub fn current_secret(&self) -> HeaderValue {
        self.secret.get()
    }

    async fn send(&self, req: Request<Full<Bytes>>) -> Result<(hyper::http::response::Parts, Incoming), LinkError> {
        let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(self.addr))
            .await
            .map_err(|_| down("connect timed out"))?
            .map_err(down)?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tcp)).await.map_err(down)?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let resp = tokio::time::timeout(CALL_TIMEOUT, sender.send_request(req))
            .await
            .map_err(|_| down("no answer"))?
            .map_err(down)?;
        Ok(resp.into_parts())
    }

    fn request(&self, secret: &HeaderValue, method: &str, path: &str, body: Option<&serde_json::Value>) -> Result<Request<Full<Bytes>>, LinkError> {
        let mut b = Request::builder()
            .method(method)
            .uri(path)
            .header(HOST, self.addr.to_string())
            .header("x-mc-bridge", secret.clone())
            .header(CONNECTION, "close");
        let bytes = match body {
            Some(v) => {
                // The server asks for this marker on every POST.
                b = b.header("x-mc", "1").header(CONTENT_TYPE, "application/json");
                Bytes::from(serde_json::to_vec(v).map_err(down)?)
            }
            None => Bytes::new(),
        };
        b.body(Full::new(bytes)).map_err(down)
    }

    /// One POST. Also returns the secret the request carried, so a 401 can be compared with the file.
    async fn post_once(&self, path: &str, body: &serde_json::Value) -> Result<(StatusCode, serde_json::Value, HeaderValue), LinkError> {
        let used = self.secret.get();
        let (parts, resp_body) = self.send(self.request(&used, "POST", path, Some(body))?).await?;
        let bytes = tokio::time::timeout(CALL_TIMEOUT, resp_body.collect())
            .await
            .map_err(|_| down("answer cut off"))?
            .map_err(down)?
            .to_bytes();
        Ok((parts.status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null), used))
    }

    /// POSTs JSON and returns the status with the parsed JSON answer (Null when the answer is not JSON).
    /// A 401 makes the secret file be read again; when it holds a different secret the call is repeated once.
    pub async fn post(&self, path: &str, body: &serde_json::Value) -> Result<(StatusCode, serde_json::Value), LinkError> {
        let (status, answer, used) = self.post_once(path, body).await?;
        if status == StatusCode::UNAUTHORIZED && self.secret.reload(&used) {
            let (status, answer, _) = self.post_once(path, body).await?;
            return Ok((status, answer));
        }
        Ok((status, answer))
    }

    async fn open_control_once(&self) -> Result<ControlStream, (LinkError, HeaderValue)> {
        let used = self.secret.get();
        let mut req = self.request(&used, "GET", "/api/bridge/control", None).map_err(|e| (e, used.clone()))?;
        req.headers_mut().insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
        let (parts, body) = self.send(req).await.map_err(|e| (e, used.clone()))?;
        if parts.status != StatusCode::OK {
            return Err((LinkError::Status(parts.status.as_u16()), used));
        }
        Ok(ControlStream { body, buf: Vec::new() })
    }

    /// Opens `GET /api/bridge/control`. A 401 is handled like in `post`.
    pub async fn open_control(&self) -> Result<ControlStream, LinkError> {
        match self.open_control_once().await {
            Ok(stream) => Ok(stream),
            Err((LinkError::Status(401), used)) if self.secret.reload(&used) => self.open_control_once().await.map_err(|(e, _)| e),
            Err((e, _)) => Err(e),
        }
    }
}

/// The server-sent event stream. `next` waits for the next control event.
pub struct ControlStream {
    body: Incoming,
    buf: Vec<u8>,
}

impl ControlStream {
    /// The next event, or None when the server closed the stream.
    pub async fn next(&mut self) -> Result<Option<ControlEvent>, LinkError> {
        loop {
            if let Some(block) = take_block(&mut self.buf) {
                if let Some(ev) = parse_block(&block) {
                    return Ok(Some(ev));
                }
                continue;
            }
            if self.buf.len() > MAX_EVENT_BYTES {
                return Err(down("event too large"));
            }
            match self.body.frame().await {
                Some(Ok(frame)) => {
                    if let Some(data) = frame.data_ref() {
                        self.buf.extend_from_slice(data);
                    }
                }
                Some(Err(e)) => return Err(down(e)),
                None => return Ok(None),
            }
        }
    }
}

/// Removes and returns the first complete event block (up to a blank line).
fn take_block(buf: &mut Vec<u8>) -> Option<String> {
    let find = |sep: &[u8]| buf.windows(sep.len()).position(|w| w == sep);
    let (at, len) = match (find(b"\n\n"), find(b"\r\n\r\n")) {
        (Some(a), Some(b)) if b < a => (b, 4),
        (Some(a), _) => (a, 2),
        (None, Some(b)) => (b, 4),
        (None, None) => return None,
    };
    let block: Vec<u8> = buf.drain(..at + len).take(at).collect();
    Some(String::from_utf8_lossy(&block).into_owned())
}

/// Reads the `data:` lines of one block as JSON. Comments, `retry:` and unknown events give None.
fn parse_block(block: &str) -> Option<ControlEvent> {
    let data: Vec<&str> = block
        .lines()
        .filter_map(|l| l.strip_prefix("data:"))
        .map(|d| d.strip_prefix(' ').unwrap_or(d))
        .collect();
    if data.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&data.join("\n")).ok()?;
    let id = || v.get("id").and_then(|i| i.as_str()).map(str::to_owned);
    match v.get("type")?.as_str()? {
        "devices" => Some(ControlEvent::Devices(
            v.get("ids")?.as_array()?.iter().filter_map(|i| i.as_str().map(str::to_owned)).collect(),
        )),
        "add" => id().map(ControlEvent::Add),
        "revoke" => id().map(ControlEvent::Revoke),
        "restart" => Some(ControlEvent::Restart),
        "ping" => Some(ControlEvent::Ping),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_split_across_reads() {
        let mut buf = b"retry: 1000\n\ndata: {\"type\":\"devices\",\"ids\":[\"a\",\"b\"]}\n\ndata: {\"type\":\"rev".to_vec();
        let first = take_block(&mut buf).unwrap();
        assert_eq!(parse_block(&first), None);
        let second = take_block(&mut buf).unwrap();
        assert_eq!(parse_block(&second), Some(ControlEvent::Devices(vec!["a".into(), "b".into()])));
        assert!(take_block(&mut buf).is_none());
        buf.extend_from_slice(b"oke\",\"id\":\"a\"}\r\n\r\ndata: {\"type\":\"ping\"}\n\n");
        assert_eq!(parse_block(&take_block(&mut buf).unwrap()), Some(ControlEvent::Revoke("a".into())));
        assert_eq!(parse_block(&take_block(&mut buf).unwrap()), Some(ControlEvent::Ping));
    }

    #[test]
    fn unknown_events_are_ignored() {
        assert_eq!(parse_block("data: {\"type\":\"future\"}"), None);
        assert_eq!(parse_block("data: not json"), None);
        assert_eq!(parse_block("data: {\"type\":\"restart\"}"), Some(ControlEvent::Restart));
    }

    #[test]
    fn secrets_are_64_hex_characters() {
        let good = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        assert_eq!(parse_secret(&format!("{good}\r\n")).as_deref(), Some(good));
        assert_eq!(parse_secret(&good[1..]), None);
        assert_eq!(parse_secret(&format!("{}g", &good[1..])), None);
        assert_eq!(parse_secret(""), None);
    }

    #[test]
    fn the_secret_file_counts_only_when_it_holds_something_new() {
        let dir = std::env::temp_dir().join(format!("mcb-secret-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("secret");
        let (old, new) = ("a".repeat(64), "b".repeat(64));
        std::fs::write(&file, &old).unwrap();
        let link = ServerLink::new("127.0.0.1:1".parse().unwrap(), &old).unwrap().with_secret_file(file.clone());
        let used = link.current_secret();
        assert!(!link.secret.reload(&used), "same secret in the file: nothing to retry");
        std::fs::write(&file, &new).unwrap();
        assert!(link.secret.reload(&used));
        assert_eq!(link.current_secret().to_str().unwrap(), new);
        // A second caller that also used the old value still learns that the secret moved on.
        assert!(link.secret.reload(&used));
        std::fs::write(&file, "not a secret").unwrap();
        assert!(!link.secret.reload(&link.current_secret()));
        assert_eq!(link.current_secret().to_str().unwrap(), new);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_secret_stays_out_of_debug_output() {
        let link = ServerLink::new("127.0.0.1:1".parse().unwrap(), "topsecretvalue").unwrap();
        let req = link.request(&link.current_secret(), "POST", "/x", Some(&serde_json::json!({}))).unwrap();
        assert!(!format!("{link:?} {req:?}").contains("topsecretvalue"));
    }
}
