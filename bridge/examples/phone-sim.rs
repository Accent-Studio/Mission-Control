//! Command line stand-in for the phone app, for testing the PC bridge without a phone.
//!
//!   phone-sim [--state DIR] [--relay off] [--addr IP:PORT]... pair <missioncontrol-pair:ID:CODE> [--name NAME]
//!   phone-sim [--state DIR] [--relay off] [--addr IP:PORT]... get <PATH>
//!   phone-sim [--state DIR] [--relay off] [--addr IP:PORT]... post <PATH> [JSON]
//!   phone-sim [--state DIR] [--relay off] [--addr IP:PORT]... serve [--port N] [--enter-file FILE]
//!
//! `pair` generates this device's key on first use, dials the bridge on the pairing
//! protocol and, when the code is accepted, remembers the PC in `server.json`.
//! `serve` runs the phone's local proxy (the same code the phone app uses) so a desktop
//! browser can use Mission Control through the whole chain: browser, proxy, iroh, bridge,
//! server. It prints the one-use `/__mc/enter` address to open first (and writes it to
//! `--enter-file`); every line `enter` on stdin prints a fresh one. Without `--port` the
//! port saved in `<state>/proxy_port` is used, or picked and saved.
//! `get` then sends one request through the paired tunnel and prints the answer;
//! `post` does the same with a JSON body, the `X-MC` marker and a loopback `Origin`,
//! the way the phone's pages send them.
//! Exit codes: 0 done, 1 failed, 2 bad command line.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use iroh::endpoint::{presets, Connection, ConnectionError};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey, TransportAddr};
use mc_bridge::client::{self, Client, ClientConfig};
use mc_bridge::stream_io;
use mc_bridge::wire::ALPN_HTTP;
use serde::{Deserialize, Serialize};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize, Deserialize)]
struct ServerInfo {
    id: String,
    name: String,
}

struct Opts {
    state: PathBuf,
    relay: bool,
    addrs: Vec<SocketAddr>,
}

fn secret_key(state: &Path) -> Result<SecretKey, String> {
    let path = state.join("device_key");
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Ok(SecretKey::from_bytes(&arr));
        }
    }
    let key = SecretKey::generate();
    std::fs::create_dir_all(state).map_err(|e| e.to_string())?;
    std::fs::write(&path, key.to_bytes()).map_err(|e| e.to_string())?;
    Ok(key)
}

async fn dial(opts: &Opts, server: &str, alpn: &[u8]) -> Result<(Endpoint, Connection), String> {
    let id: EndpointId = server.parse().map_err(|_| "the PC's endpoint id is not valid".to_owned())?;
    let builder = if opts.relay { Endpoint::builder(presets::N0) } else { Endpoint::builder(presets::Minimal) };
    let endpoint = builder.secret_key(secret_key(&opts.state)?).bind().await.map_err(|e| format!("network start failed: {e}"))?;
    let addr = EndpointAddr::from_parts(id, opts.addrs.iter().copied().map(TransportAddr::Ip));
    let conn = tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect(addr, alpn))
        .await
        .map_err(|_| "the PC did not answer".to_owned())?
        .map_err(|e| format!("could not connect: {e}"))?;
    Ok((endpoint, conn))
}

async fn start_client(opts: &Opts) -> Result<Client, String> {
    let mut cfg = ClientConfig::new(&opts.state);
    cfg.relay = opts.relay;
    cfg.addrs = opts.addrs.clone();
    cfg.log = Some(std::sync::Arc::new(|line: &str| eprintln!("[proxy] {line}")));
    Client::start(cfg).await
}

async fn pair(opts: &Opts, text: &str, name: &str) -> Result<(), String> {
    let client = start_client(opts).await?;
    let result = client.pair(text, name).await;
    client.close().await;
    match result {
        Ok(info) => {
            println!("paired with {}", info.name);
            Ok(())
        }
        Err(e) => Err(format!("pairing refused: {e}")),
    }
}

async fn serve(opts: &Opts, port: Option<u16>, enter_file: Option<PathBuf>) -> Result<(), String> {
    let client = start_client(opts).await?;
    let port = match port {
        Some(p) => p,
        None => client::load_or_pick_port(&opts.state.join("proxy_port"))?.port,
    };
    let proxy = client.start_proxy(port).await?;
    println!("listening {}", proxy.origin());
    let print_enter = |proxy: &client::ProxyHandle| {
        let url = proxy.enter_url();
        println!("enter {url}");
        url
    };
    let first = print_enter(&proxy);
    if let Some(f) = &enter_file {
        std::fs::write(f, &first).map_err(|e| format!("cannot write {}: {e}", f.display()))?;
    }
    let mut link = client.subscribe();
    let (lines_tx, mut lines) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let mut line = String::new();
        while std::io::stdin().read_line(&mut line).is_ok_and(|n| n > 0) {
            let _ = lines_tx.send(line.trim().to_owned());
            line.clear();
        }
    });
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            changed = link.changed() => {
                if changed.is_err() { break; }
                println!("link {}", *link.borrow_and_update());
            }
            Some(cmd) = lines.recv() => {
                if cmd == "enter" {
                    print_enter(&proxy);
                }
            }
        }
    }
    proxy.stop().await;
    client.close().await;
    Ok(())
}

async fn get(opts: &Opts, path: &str, post_body: Option<&str>) -> Result<(), String> {
    let info: ServerInfo = std::fs::read_to_string(opts.state.join("server.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or("not paired yet: run pair first")?;
    let (endpoint, conn) = dial(opts, &info.id, ALPN_HTTP).await?;
    let result = async {
        let (send, recv) = conn.open_bi().await.map_err(|e| closed_reason(&conn, e.to_string()))?;
        let (mut sender, driver) = hyper::client::conn::http1::handshake(stream_io(recv, send)).await.map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            let _ = driver.await;
        });
        let req = match post_body {
            None => Request::get(path).header("host", "127.0.0.1").body(Full::new(Bytes::new())),
            Some(body) => Request::post(path)
                .header("host", "127.0.0.1:5555")
                .header("origin", "http://127.0.0.1:5555")
                .header("x-mc", "1")
                .header("content-type", "application/json")
                .body(Full::new(Bytes::from(body.to_owned()))),
        }
        .map_err(|e| e.to_string())?;
        let resp = sender.send_request(req).await.map_err(|e| closed_reason(&conn, e.to_string()))?;
        let status = resp.status();
        let body = resp.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
        println!("{status}");
        println!("{}", String::from_utf8_lossy(&body));
        Ok(())
    }
    .await;
    conn.close(0u32.into(), b"done");
    endpoint.close().await;
    result
}

/// A closed connection says why (not paired, revoked, ...); a plain stream error does not.
fn closed_reason(conn: &Connection, fallback: String) -> String {
    match conn.close_reason() {
        Some(ConnectionError::ApplicationClosed(c)) => format!("the PC closed the connection with code {}", u64::from(c.error_code)),
        _ => fallback,
    }
}

fn usage() -> ExitCode {
    eprintln!("usage: phone-sim [--state DIR] [--relay off] [--addr IP:PORT]... pair <missioncontrol-pair:ID:CODE> [--name NAME]\n       phone-sim [--state DIR] [--relay off] [--addr IP:PORT]... get <PATH>
       phone-sim [--state DIR] [--relay off] [--addr IP:PORT]... post <PATH> [JSON]
       phone-sim [--state DIR] [--relay off] [--addr IP:PORT]... serve [--port N] [--enter-file FILE]");
    ExitCode::from(2)
}

#[tokio::main]
async fn main() -> ExitCode {
    let mut opts = Opts { state: PathBuf::from("phone-sim-state"), relay: true, addrs: Vec::new() };
    let mut rest: Vec<String> = Vec::new();
    let mut name = "Phone simulator".to_owned();
    let mut port: Option<u16> = None;
    let mut enter_file: Option<PathBuf> = None;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--state" => match it.next() {
                Some(v) => opts.state = PathBuf::from(v),
                None => return usage(),
            },
            "--relay" => match it.next().as_deref() {
                Some("off") => opts.relay = false,
                Some("default") => opts.relay = true,
                _ => return usage(),
            },
            "--addr" => match it.next().and_then(|v| v.parse().ok()) {
                Some(v) => opts.addrs.push(v),
                None => return usage(),
            },
            "--port" => match it.next().and_then(|v| v.parse().ok()) {
                Some(v) => port = Some(v),
                None => return usage(),
            },
            "--enter-file" => match it.next() {
                Some(v) => enter_file = Some(PathBuf::from(v)),
                None => return usage(),
            },
            "--name" => match it.next() {
                Some(v) => name = v,
                None => return usage(),
            },
            _ => rest.push(a),
        }
    }
    let result = match rest.as_slice() {
        [cmd, text] if cmd == "pair" => pair(&opts, text, &name).await,
        [cmd] if cmd == "serve" => serve(&opts, port, enter_file).await,
        [cmd, path] if cmd == "get" => get(&opts, path, None).await,
        [cmd, path] if cmd == "post" => get(&opts, path, Some("{}")).await,
        [cmd, path, body] if cmd == "post" => get(&opts, path, Some(body)).await,
        _ => return usage(),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::from(1)
        }
    }
}
