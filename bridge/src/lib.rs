//! Mission Control bridge: HTTP over iroh bi-streams.
//!
//! The PC runs a hyper server on every accepted stream and forwards each request
//! to the Mission Control server on loopback. The phone app uses the same
//! forwarder in front of its local proxy.

pub mod forward;
pub mod wire;

#[cfg(feature = "bridge")]
pub mod bridge;
#[cfg(feature = "client")]
pub mod client;
#[cfg(feature = "bridge")]
pub mod keyfile;
#[cfg(feature = "bridge")]
pub mod logfile;
#[cfg(feature = "bridge")]
pub mod server_link;

use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite, Join};

/// Joins the two halves of an iroh bi-stream into one hyper-ready IO object.
///
/// iroh 1.3 re-exports the noq stream types, and both `SendStream` and
/// `RecvStream` implement tokio's `AsyncWrite` and `AsyncRead` directly, so
/// `tokio::io::join` is the only glue needed.
pub fn stream_io<R, W>(recv: R, send: W) -> TokioIo<Join<R, W>>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    TokioIo::new(tokio::io::join(recv, send))
}
