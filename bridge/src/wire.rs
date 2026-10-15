//! What the two ends say to each other outside of HTTP: protocol names, close
//! codes and small length-prefixed JSON messages (used for pairing).

use serde::{de::DeserializeOwned, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Paired devices only. One bi-stream carries one HTTP/1.1 keep-alive connection.
pub const ALPN_HTTP: &[u8] = b"missioncontrol/http/1";
/// Open to anyone who holds a pairing code.
pub const ALPN_PAIR: &[u8] = b"missioncontrol/pair/1";

pub const CLOSE_NOT_PAIRED: u32 = 1;
pub const CLOSE_REVOKED: u32 = 2;
pub const CLOSE_STOPPING: u32 = 3;
pub const CLOSE_TOO_MANY: u32 = 4;

/// Largest JSON message accepted on the wire.
pub const MAX_JSON: usize = 4 * 1024;

/// First and only message a phone sends on the pairing ALPN.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PairRequest {
    Pair { code: String, device_name: String },
}

/// The bridge's answer on the pairing ALPN. `code` is `bad_code`, `rate_limited` or `bridge_error`.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PairReply {
    Paired { server_name: String },
    Error { code: String, message: String },
}

/// Pairing text shown as a QR code: `missioncontrol-pair:<endpoint id>:<code>`.
pub const PAIR_URI_PREFIX: &str = "missioncontrol-pair:";

/// Splits a pairing text into (endpoint id, code). The code is the part after the last colon.
pub fn parse_pair_uri(text: &str) -> Option<(&str, &str)> {
    let rest = text.trim().strip_prefix(PAIR_URI_PREFIX)?;
    let (id, code) = rest.rsplit_once(':')?;
    (!id.is_empty() && !code.is_empty()).then_some((id, code))
}

#[derive(Debug)]
pub enum WireError {
    Io(std::io::Error),
    Json(serde_json::Error),
    TooLarge(usize),
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireError::Io(e) => write!(f, "io: {e}"),
            WireError::Json(e) => write!(f, "json: {e}"),
            WireError::TooLarge(n) => write!(f, "message of {n} bytes is over the limit"),
        }
    }
}

impl std::error::Error for WireError {}

impl From<std::io::Error> for WireError {
    fn from(e: std::io::Error) -> Self {
        WireError::Io(e)
    }
}

impl From<serde_json::Error> for WireError {
    fn from(e: serde_json::Error) -> Self {
        WireError::Json(e)
    }
}

/// Writes a 4-byte little-endian length followed by the JSON body.
pub async fn write_json<W, T>(w: &mut W, msg: &T) -> Result<(), WireError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let body = serde_json::to_vec(msg)?;
    if body.len() > MAX_JSON {
        return Err(WireError::TooLarge(body.len()));
    }
    w.write_all(&(body.len() as u32).to_le_bytes()).await?;
    w.write_all(&body).await?;
    Ok(())
}

/// Reads one length-prefixed JSON message, refusing anything over `MAX_JSON`
/// before the body is read.
pub async fn read_json<R, T>(r: &mut R) -> Result<T, WireError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_JSON {
        return Err(WireError::TooLarge(len));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn round_trip_and_size_limit() {
        let (mut a, mut b) = tokio::io::duplex(16 * 1024);
        write_json(&mut a, &serde_json::json!({"type": "pair", "code": "K7P2-9QX4"})).await.unwrap();
        let v: serde_json::Value = read_json(&mut b).await.unwrap();
        assert_eq!(v["code"], "K7P2-9QX4");

        // A length prefix over the limit is refused before the body is read.
        a.write_all(&((MAX_JSON as u32) + 1).to_le_bytes()).await.unwrap();
        let err = read_json::<_, serde_json::Value>(&mut b).await.unwrap_err();
        assert!(matches!(err, WireError::TooLarge(_)));
        let big = "x".repeat(MAX_JSON);
        assert!(matches!(write_json(&mut a, &big).await, Err(WireError::TooLarge(_))));
    }
}
