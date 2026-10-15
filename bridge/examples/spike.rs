//! Spike: a hyper client over an iroh bi-stream reaches a hyper server through
//! `forward`. Two endpoints in one process, `presets::Minimal` (no relay, no
//! discovery), so nothing here needs the internet.
//!
//! `cargo run --example spike` runs the scenarios once and prints timings;
//! `cargo test` runs the same scenarios as tests.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::body::{Body, Frame, Incoming};
use hyper::client::conn::http1::SendRequest;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use iroh::endpoint::{presets, Connection};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointAddr, TransportAddr};
use mc_bridge::forward::{serve, ForwardConfig};
use mc_bridge::stream_io;
use mc_bridge::wire::ALPN_HTTP;
use tokio::net::TcpListener;
use tokio::sync::mpsc;

type B = BoxBody<Bytes, Infallible>;

/// A body fed by a channel, so a scenario controls exactly when each chunk is sent.
struct ChanBody(mpsc::Receiver<Bytes>);

impl Body for ChanBody {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.0.poll_recv(cx).map(|o| o.map(|b| Ok(Frame::data(b))))
    }
}

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

fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i.wrapping_mul(31) % 251) as u8).collect()
}

/// Stand-in for the Mission Control bridge listener.
async fn fake_upstream() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { return };
            tokio::spawn(async move {
                let svc = service_fn(|req: Request<Incoming>| async move {
                    let path = req.uri().path().to_owned();
                    let resp = match path.as_str() {
                        "/echo" => {
                            let h = |n: &str| req.headers().get(n).and_then(|v| v.to_str().ok()).unwrap_or("-").to_owned();
                            let text = format!(
                                "host={} device={} secret={} forged={}",
                                h("host"),
                                h("x-mc-device"),
                                h("x-mc-bridge"),
                                h("x-mc-evil")
                            );
                            Response::new(full(text))
                        }
                        "/upload" => {
                            let mut body = req.into_body();
                            let (mut n, mut sum) = (0usize, FNV_START);
                            while let Some(frame) = body.frame().await {
                                if let Some(d) = frame.unwrap().data_ref() {
                                    n += d.len();
                                    sum = fnv(sum, d);
                                }
                            }
                            Response::new(full(format!("len={n} sum={sum:x}")))
                        }
                        "/sse" => {
                            let (tx, rx) = mpsc::channel(1);
                            tokio::spawn(async move {
                                for i in 0..5 {
                                    if tx.send(Bytes::from(format!("data: {i}\n\n"))).await.is_err() {
                                        return;
                                    }
                                    tokio::time::sleep(Duration::from_millis(150)).await;
                                }
                            });
                            Response::builder()
                                .header("content-type", "text/event-stream")
                                .header("cache-control", "no-store")
                                .body(ChanBody(rx).boxed())
                                .unwrap()
                        }
                        _ => Response::builder().status(404).body(full("")).unwrap(),
                    };
                    Ok::<_, Infallible>(resp)
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tcp), svc).await;
            });
        }
    });
    addr
}

/// What the bridge does with an accepted connection: one forwarder per bi-stream.
#[derive(Debug, Clone)]
struct HttpHandler {
    upstream: SocketAddr,
}

impl ProtocolHandler for HttpHandler {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let mut cfg = ForwardConfig::new(self.upstream, conn.remote_id().to_string());
        cfg.inject.push(("x-mc-bridge".parse().unwrap(), "test-secret".parse().unwrap()));
        while let Ok((send, recv)) = conn.accept_bi().await {
            let cfg = cfg.clone();
            tokio::spawn(async move {
                let _ = serve(stream_io(recv, send), cfg).await;
            });
        }
        Ok(())
    }
}

struct Rig {
    router: Router,
    client: Endpoint,
    conn: Connection,
}

impl Rig {
    async fn new() -> Rig {
        let upstream = fake_upstream().await;
        let server = Endpoint::builder(presets::Minimal)
            .alpns(vec![ALPN_HTTP.to_vec()])
            .bind_addr("127.0.0.1:0")
            .unwrap()
            .bind()
            .await
            .unwrap();
        let addr = EndpointAddr::from_parts(server.id(), server.bound_sockets().into_iter().map(TransportAddr::Ip));
        let router = Router::builder(server).accept(ALPN_HTTP, HttpHandler { upstream }).spawn();
        let client = Endpoint::builder(presets::Minimal).bind_addr("127.0.0.1:0").unwrap().bind().await.unwrap();
        let conn = client.connect(addr, ALPN_HTTP).await.unwrap();
        Rig { router, client, conn }
    }

    /// A hyper client on a fresh bi-stream (the phone opens one per WebView connection).
    async fn http(&self) -> SendRequest<B> {
        let (send, recv) = self.conn.open_bi().await.unwrap();
        let (sender, driver) = hyper::client::conn::http1::handshake(stream_io(recv, send)).await.unwrap();
        tokio::spawn(async move {
            let _ = driver.await;
        });
        sender
    }

    async fn close(self) {
        self.conn.close(0u32.into(), b"done");
        self.client.close().await;
        self.router.shutdown().await.unwrap();
    }
}

async fn text(resp: Response<Incoming>) -> String {
    String::from_utf8(resp.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
}

fn get(path: &str) -> Request<B> {
    Request::get(path).header("host", "phone.invalid").body(full(Bytes::new())).unwrap()
}

async fn scenario_get(rig: &Rig) -> String {
    let mut http = rig.http().await;
    let req = Request::get("/echo")
        .header("host", "phone.invalid")
        .header("x-mc-evil", "1")
        .header("x-mc-bridge", "forged")
        .header("x-mc-device", "forged")
        .body(full(Bytes::new()))
        .unwrap();
    let resp = http.send_request(req).await.unwrap();
    assert_eq!(resp.status(), 200);
    let body = text(resp).await;
    // Same stream, second request: keep-alive works end to end.
    let again = http.send_request(get("/echo")).await.unwrap();
    assert_eq!(again.status(), 200);
    text(again).await;
    let blocked = http.send_request(get("/api/bridge/x")).await.unwrap();
    assert_eq!(blocked.status(), 404);
    text(blocked).await;
    body
}

/// Returns (what the server saw, what it should have seen).
async fn scenario_post(rig: &Rig, chunked: bool) -> (String, String) {
    const SIZE: usize = 5 * 1024 * 1024;
    let data = pattern(SIZE);
    let expect = format!("len={SIZE} sum={:x}", fnv(FNV_START, &data));
    let mut http = rig.http().await;
    let body: B = if chunked {
        // No Content-Length, so hyper sends Transfer-Encoding: chunked.
        let (tx, rx) = mpsc::channel(4);
        let data = Bytes::from(data);
        tokio::spawn(async move {
            for piece in data.chunks(64 * 1024) {
                if tx.send(data.slice_ref(piece)).await.is_err() {
                    return;
                }
            }
        });
        ChanBody(rx).boxed()
    } else {
        full(data)
    };
    let req = Request::post("/upload").header("host", "x").body(body).unwrap();
    let resp = http.send_request(req).await.unwrap();
    assert_eq!(resp.status(), 200);
    (text(resp).await, expect)
}

/// Returns (time of first event, time of last event, all text) since the request started.
async fn scenario_sse(rig: &Rig) -> (Duration, Duration, String) {
    let mut http = rig.http().await;
    let start = Instant::now();
    let resp = http.send_request(get("/sse")).await.unwrap();
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
    (first.unwrap(), last, all)
}

#[tokio::main]
async fn main() {
    let rig = Rig::new().await;
    println!("get: {}", scenario_get(&rig).await);
    for chunked in [false, true] {
        let t = Instant::now();
        let (got, want) = scenario_post(&rig, chunked).await;
        println!("post 5 MiB chunked={chunked}: {got} (want {want}) in {:?}", t.elapsed());
    }
    let (first, last, _) = scenario_sse(&rig).await;
    println!("sse: first event at {first:?}, last at {last:?}");
    rig.close().await;
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    async fn within<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(30), f).await.expect("timed out")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_through_forward_rewrites_headers() {
        within(async {
            let rig = Rig::new().await;
            let body = scenario_get(&rig).await;
            let device = rig.client.id().to_string();
            assert!(body.contains(&format!("device={device}")), "{body}");
            assert!(body.contains("secret=test-secret"), "{body}");
            assert!(body.contains("forged=-"), "{body}");
            assert!(body.starts_with("host=127.0.0.1:"), "{body}");
            rig.close().await;
        })
        .await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn post_5mb_arrives_intact() {
        within(async {
            let rig = Rig::new().await;
            for chunked in [false, true] {
                let (got, want) = scenario_post(&rig, chunked).await;
                assert_eq!(got, want, "chunked={chunked}");
            }
            rig.close().await;
        })
        .await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sse_arrives_in_chunks() {
        within(async {
            let rig = Rig::new().await;
            let (first, last, all) = scenario_sse(&rig).await;
            assert_eq!(all, "data: 0\n\ndata: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\n");
            // The fake sends the last event 600 ms after the first; the first must
            // not wait for it.
            assert!(first < Duration::from_millis(300), "first event took {first:?}");
            assert!(last >= first + Duration::from_millis(500), "events were buffered: {first:?} then {last:?}");
            rig.close().await;
        })
        .await;
    }

    /// No network involved: an in-memory pipe stands in for the iroh stream.
    #[tokio::test(flavor = "multi_thread")]
    async fn dead_upstream_gives_502_and_recovers() {
        within(async {
            let free = {
                let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
                l.local_addr().unwrap()
            };
            let (a, b) = tokio::io::duplex(64 * 1024);
            tokio::spawn(serve(TokioIo::new(b), ForwardConfig::new(free, "test-device")));
            let (mut s, drv) = hyper::client::conn::http1::handshake::<_, B>(TokioIo::new(a)).await.unwrap();
            tokio::spawn(drv);
            let resp = s.send_request(get("/echo")).await.unwrap();
            assert_eq!(resp.status(), 502);
            assert_eq!(resp.headers().get("x-mc-bridge-error").unwrap(), "server_down");
            text(resp).await;
            // Something starts listening on that port: the next request on the same stream works.
            let l = TcpListener::bind(free).await.unwrap();
            tokio::spawn(async move {
                let (tcp, _) = l.accept().await.unwrap();
                let svc = service_fn(|_r: Request<Incoming>| async { Ok::<_, Infallible>(Response::new(full("up"))) });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tcp), svc).await;
            });
            let resp = s.send_request(get("/echo")).await.unwrap();
            assert_eq!(resp.status(), 200);
            assert_eq!(text(resp).await, "up");
        })
        .await;
    }

    #[test]
    fn debug_output_hides_the_secret() {
        let mut cfg = ForwardConfig::new("127.0.0.1:1".parse().unwrap(), "dev1");
        cfg.inject.push(("x-mc-bridge".parse().unwrap(), "s3cret-value".parse().unwrap()));
        let shown = format!("{cfg:?} {cfg:#?}");
        assert!(!shown.contains("s3cret-value"), "{shown}");
        assert!(shown.contains("redacted"), "{shown}");
    }

    type Devices = Arc<std::sync::Mutex<Vec<Option<String>>>>;

    /// Upstream that counts every request it receives and records the device header.
    async fn counting_upstream() -> (SocketAddr, Arc<AtomicUsize>, Devices) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let devices: Devices = Arc::default();
        let (h, d) = (hits.clone(), devices.clone());
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else { return };
                let (h, d) = (h.clone(), d.clone());
                tokio::spawn(async move {
                    let svc = service_fn(move |req: Request<Incoming>| {
                        let (h, d) = (h.clone(), d.clone());
                        async move {
                            h.fetch_add(1, Ordering::SeqCst);
                            let dev = req.headers().get("x-mc-device").and_then(|v| v.to_str().ok()).map(str::to_owned);
                            d.lock().unwrap().push(dev);
                            Ok::<_, Infallible>(Response::new(full("ok")))
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tcp), svc).await;
                });
            }
        });
        (addr, hits, devices)
    }

    /// Sends raw request bytes through `serve` and returns the response status line.
    async fn raw_status(upstream: SocketAddr, request: &[u8]) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut a, b) = tokio::io::duplex(64 * 1024);
        tokio::spawn(serve(TokioIo::new(b), ForwardConfig::new(upstream, "dev1")));
        a.write_all(request).await.unwrap();
        let mut buf = vec![0u8; 4096];
        let n = tokio::time::timeout(Duration::from_secs(5), a.read(&mut buf)).await.unwrap().unwrap();
        String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_owned()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bad_targets_get_400_and_never_reach_upstream() {
        within(async {
            let (addr, hits, _) = counting_upstream().await;
            let bad = [
                "/api/x/../bridge/y",
                "/api/./bridge/y",
                "/api/%2e%2e/bridge/y",
                "/api/%2E/bridge/y",
                "/api//bridge/y",
                "/api/a%2fb",
                "/api/a%2Fb",
                "/api/a%5cb",
                "/api/a%5Cb",
                "/api/a\\b",
                "/api/a%00b",
                "/api/a%0ab",
                "http://evil.example/api/x",
                "*",
            ];
            for t in bad {
                let req = format!("GET {t} HTTP/1.1\r\nHost: x\r\n\r\n");
                let line = raw_status(addr, req.as_bytes()).await;
                assert!(line.contains(" 400 "), "{t}: {line}");
            }
            let line = raw_status(addr, b"GET /api/a\x00b HTTP/1.1\r\nHost: x\r\n\r\n").await;
            assert!(!line.contains(" 200 "), "raw NUL: {line}");
            let line = raw_status(addr, b"CONNECT example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n").await;
            assert!(!line.contains(" 200 "), "authority form: {line}");
            assert_eq!(hits.load(Ordering::SeqCst), 0, "a bad target reached the upstream");
        })
        .await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bridge_prefix_is_blocked_in_any_case() {
        within(async {
            let (addr, hits, _) = counting_upstream().await;
            for t in ["/api/bridge", "/api/bridge/", "/api/bridge/x", "/API/Bridge", "/api/BRIDGE/x", "/api/%62ridge/x", "/__debug"] {
                let req = format!("GET {t} HTTP/1.1\r\nHost: x\r\n\r\n");
                let line = raw_status(addr, req.as_bytes()).await;
                assert!(line.contains(" 404 "), "{t}: {line}");
            }
            let line = raw_status(addr, b"GET /api/bridgeish HTTP/1.1\r\nHost: x\r\n\r\n").await;
            assert!(line.contains(" 200 "), "{line}");
            assert_eq!(hits.load(Ordering::SeqCst), 1);
        })
        .await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn device_header_is_always_present_upstream() {
        within(async {
            let (addr, _, devices) = counting_upstream().await;
            let (a, b) = tokio::io::duplex(64 * 1024);
            tokio::spawn(serve(TokioIo::new(b), ForwardConfig::new(addr, "dev-42")));
            let (mut s, drv) = hyper::client::conn::http1::handshake::<_, B>(TokioIo::new(a)).await.unwrap();
            tokio::spawn(drv);
            for p in ["/a", "/b?x=1"] {
                let req = Request::get(p).header("host", "x").header("x-mc-device", "forged").body(full(Bytes::new())).unwrap();
                let resp = s.send_request(req).await.unwrap();
                assert_eq!(resp.status(), 200);
                text(resp).await;
            }
            let seen = devices.lock().unwrap().clone();
            assert_eq!(seen, vec![Some("dev-42".to_owned()), Some("dev-42".to_owned())]);
        })
        .await;
    }
}
