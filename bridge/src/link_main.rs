//! mc-link: a PC's link to the hub (the always-on server the PCs share, see design notes). The same encrypted
//! peer-to-peer link as the phone (iroh), the same pairing, and the same local proxy: Mission Control's server on this
//! PC calls the hub at `http://127.0.0.1:<port>`, with the link secret in `X-MC-Link` instead of the phone's cookie.
//!
//!   mc-link --state DIR [--relay off] [--addr IP:PORT]... pair <missioncontrol-pair:ID:CODE> [--name NAME]
//!   mc-link --state DIR [--relay off] [--addr IP:PORT]... serve --port N --secret-file FILE
//!   mc-link --state DIR [--relay off] [--addr IP:PORT]... serve --port N --browser
//!   mc-link --state DIR id
//!
//! `pair` makes this PC's key on first use and pairs with the hub, which then lists this PC as a paired device.
//! `serve` runs the proxy until stdin closes (the server that started it is gone) or Ctrl+C. It prints
//! `listening <origin>` once, then `link <state>` on every change.
//! `--browser` is for a browser on this computer instead of Mission Control's server (a Mac paired with Home, as a
//! phone is): it prints `enter <address>` at once and again for each line on stdin, a one-use address that gives the
//! browser the proxy's cookie. A secret file is then optional.
//! `id` prints this PC's id on the hub.
//! Exit codes: 0 done, 1 failed, 2 bad command line.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use mc_bridge::client::{Client, ClientConfig};

struct Opts {
    state: PathBuf,
    relay: bool,
    addrs: Vec<SocketAddr>,
}

async fn start_client(opts: &Opts, secret: Option<String>) -> Result<Client, String> {
    let mut cfg = ClientConfig::new(&opts.state);
    cfg.relay = opts.relay;
    cfg.addrs = opts.addrs.clone();
    cfg.link_secret = secret;
    cfg.log = Some(Arc::new(|line: &str| eprintln!("[link] {line}")));
    Client::start(cfg).await
}

async fn pair(opts: &Opts, text: &str, name: &str) -> Result<(), String> {
    let client = start_client(opts, None).await?;
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

async fn serve(opts: &Opts, port: u16, secret_file: Option<PathBuf>, browser: bool) -> Result<(), String> {
    let secret = match secret_file {
        Some(f) => {
            let s = std::fs::read_to_string(&f).map_err(|e| format!("cannot read the link secret: {e}"))?.trim().to_owned();
            if s.len() < 32 {
                return Err("the link secret is too short".to_owned());
            }
            Some(s)
        }
        None => None,
    };
    let client = start_client(opts, secret).await?;
    let proxy = client.start_proxy(port).await?;
    println!("listening {}", proxy.origin());
    if browser {
        println!("enter {}", proxy.enter_url());
    }
    let mut link = client.subscribe();
    // The server that started this program holds its stdin: when that closes, the server is gone, and so is the link.
    // With --browser, each line on stdin asks for a new enter address.
    let (line_tx, mut lines) = tokio::sync::mpsc::unbounded_channel::<()>();
    std::thread::spawn(move || {
        let mut sink = String::new();
        while std::io::stdin().read_line(&mut sink).is_ok_and(|n| n > 0) {
            sink.clear();
            if line_tx.send(()).is_err() {
                return;
            }
        }
    });
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            line = lines.recv() => {
                if line.is_none() { break; }
                if browser { println!("enter {}", proxy.enter_url()); }
            }
            changed = link.changed() => {
                if changed.is_err() { break; }
                println!("link {}", *link.borrow_and_update());
            }
        }
    }
    proxy.stop().await;
    client.close().await;
    Ok(())
}

async fn id(opts: &Opts) -> Result<(), String> {
    let client = start_client(opts, None).await?;
    println!("{}", client.device_id());
    client.close().await;
    Ok(())
}

fn usage() -> ExitCode {
    eprintln!(
        "usage: mc-link --state DIR [--relay off] [--addr IP:PORT]... pair <missioncontrol-pair:ID:CODE> [--name NAME]
       mc-link --state DIR [--relay off] [--addr IP:PORT]... serve --port N (--secret-file FILE | --browser)
       mc-link --state DIR id"
    );
    ExitCode::from(2)
}

#[tokio::main]
async fn main() -> ExitCode {
    let mut opts = Opts { state: PathBuf::new(), relay: true, addrs: Vec::new() };
    let mut rest: Vec<String> = Vec::new();
    let mut name = "PC".to_owned();
    let mut port: Option<u16> = None;
    let mut secret_file: Option<PathBuf> = None;
    let mut browser = false;
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
            "--secret-file" => match it.next() {
                Some(v) => secret_file = Some(PathBuf::from(v)),
                None => return usage(),
            },
            "--browser" => browser = true,
            "--name" => match it.next() {
                Some(v) => name = v,
                None => return usage(),
            },
            _ => rest.push(a),
        }
    }
    if opts.state.as_os_str().is_empty() {
        return usage();
    }
    let result = match rest.as_slice() {
        [cmd, text] if cmd == "pair" => pair(&opts, text, &name).await,
        [cmd] if cmd == "serve" => match port {
            Some(p) if browser || secret_file.is_some() => serve(&opts, p, secret_file, browser).await,
            _ => return usage(),
        },
        [cmd] if cmd == "id" => id(&opts).await,
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
