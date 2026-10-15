//! mc-bridge: the PC end of Mission Control on the phone.
//!
//! mc-bridge [--data-dir D] [--server 127.0.0.1:1701] [--relay default|off]
//!           [--orphan-secs N] [--log-dir D] [--key-file F] [--bind ADDR]
//!
//! Exit codes (run-bridge.bat reads them):
//!   0  clean stop, or the server has been gone for --orphan-secs
//!   1  cannot start (secret or key unreadable, key folder not private, network endpoint failed),
//!      or the server link task died
//!   2  bad command line, or no data folder could be found
//!  73  another bridge already runs on this data folder
//!  75  the server asked for a restart (a new build is ready), or it keeps refusing the bridge secret

use std::fs::{File, OpenOptions, TryLockError};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

use mc_bridge::bridge::{Bridge, Exit, Options, VERSION};
use mc_bridge::logfile::LogFile;
use mc_bridge::server_link::parse_secret;

const EXIT_FAILED: u8 = 1;
const EXIT_USAGE: u8 = 2;
const EXIT_LOCKED: u8 = 73;
const EXIT_RESTART: u8 = 75;

const HELP: &str = "mc-bridge: carries Mission Control to a paired phone over iroh.

  --data-dir D       data folder (default: MC_DATA_DIR, else the .data folder of this checkout)
  --server ADDR      the server's bridge listener (default 127.0.0.1:1701)
  --relay MODE       default: n0 relays and discovery, off: no relay (tests)
  --orphan-secs N    exit after the server has been gone this long (default 300)
  --log-dir D        where bridge.log goes (default: <data-dir>/logs)
  --key-file F       endpoint key (default: <data-dir>/bridge/endpoint.key)
  --bind ADDR        local UDP address for the endpoint (default: any)
";

struct Args {
    data_dir: PathBuf,
    server: SocketAddr,
    relay: bool,
    orphan: Duration,
    log_dir: Option<PathBuf>,
    key_file: Option<PathBuf>,
    bind: Option<SocketAddr>,
}

fn parse_args() -> Result<Args, String> {
    let mut data_dir = None;
    let mut server: SocketAddr = "127.0.0.1:1701".parse().expect("static address");
    let mut relay = true;
    let mut orphan = 300u64;
    let (mut log_dir, mut key_file, mut bind) = (None, None, None);
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        if flag == "--help" || flag == "-h" {
            print!("{HELP}");
            std::process::exit(0);
        }
        if flag == "--version" {
            println!("mc-bridge {VERSION}");
            std::process::exit(0);
        }
        let mut value = || it.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--data-dir" => data_dir = Some(PathBuf::from(value()?)),
            "--server" => server = value()?.parse().map_err(|_| "--server must look like 127.0.0.1:1701".to_owned())?,
            "--relay" => {
                relay = match value()?.as_str() {
                    "default" => true,
                    "off" => false,
                    _ => return Err("--relay is default or off".to_owned()),
                }
            }
            "--orphan-secs" => orphan = value()?.parse().map_err(|_| "--orphan-secs must be a number".to_owned())?,
            "--log-dir" => log_dir = Some(PathBuf::from(value()?)),
            "--key-file" => key_file = Some(PathBuf::from(value()?)),
            "--bind" => bind = Some(value()?.parse().map_err(|_| "--bind must look like 127.0.0.1:0".to_owned())?),
            other => return Err(format!("unknown option {other}")),
        }
    }
    if !server.ip().is_loopback() {
        return Err("--server must be a loopback address".to_owned());
    }
    let data_dir = match data_dir {
        Some(d) => d,
        None => default_data_dir()?,
    };
    Ok(Args {
        data_dir,
        server,
        relay,
        orphan: Duration::from_secs(orphan),
        log_dir,
        key_file,
        bind,
    })
}

/// MC_DATA_DIR if set (the server honors the same variable), else the `.data` folder of the
/// checkout this program belongs to (it runs as `bridge\run\mc-bridge.exe`). There is no guess beyond that:
/// a bridge that fell back to the current folder could end up with the key and secret of the wrong checkout.
fn default_data_dir() -> Result<PathBuf, String> {
    if let Some(d) = std::env::var_os("MC_DATA_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(d));
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().nth(3).map(Path::to_path_buf))
        .filter(|root| root.join("server").join("config.js").is_file())
        .map(|root| root.join(".data"))
        .ok_or_else(|| "cannot tell where the data folder is: this program is not inside a Mission Control checkout. Pass --data-dir or set MC_DATA_DIR.".to_owned())
}

/// Waits for the server to write the bridge secret (it makes one on its first start).
fn read_secret(path: &Path, log: &LogFile) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut told = false;
    loop {
        match std::fs::read_to_string(path) {
            Ok(text) => return parse_secret(&text).ok_or_else(|| format!("{} is not a 64 character hex secret", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && Instant::now() < deadline => {
                if !told {
                    log.line("waiting for the server to create the bridge secret");
                    told = true;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(e) => return Err(format!("cannot read the bridge secret ({}): {e}", e.kind())),
        }
    }
}

/// One bridge per data folder. The lock lives as long as the returned file.
fn take_lock(path: &Path) -> Result<File, ExitCode> {
    let file = OpenOptions::new().create(true).truncate(false).write(true).open(path).map_err(|e| {
        eprintln!("cannot open the lock file {}: {e}", path.display());
        ExitCode::from(EXIT_FAILED)
    })?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => {
            eprintln!("another mc-bridge is already running on this data folder");
            Err(ExitCode::from(EXIT_LOCKED))
        }
        Err(TryLockError::Error(e)) => {
            eprintln!("cannot lock {}: {e}", path.display());
            Err(ExitCode::from(EXIT_FAILED))
        }
    }
}

/// Resolves when Ctrl+C arrives. If the signal handler cannot be installed this never resolves, so that
/// failure is not mistaken for a stop request (and an exit code of 0).
async fn console_stop(log: &LogFile) {
    match tokio::signal::ctrl_c().await {
        Ok(()) => {}
        Err(e) => {
            log.line(&format!("Ctrl+C is not available: {e}"));
            std::future::pending::<()>().await;
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}\n\n{HELP}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    let bridge_dir = args.data_dir.join("bridge");
    if let Err(e) = std::fs::create_dir_all(&bridge_dir) {
        eprintln!("cannot create {}: {e}", bridge_dir.display());
        return ExitCode::from(EXIT_FAILED);
    }
    let _lock = match take_lock(&bridge_dir.join("lock")) {
        Ok(f) => f,
        Err(code) => return code,
    };

    let log_dir = args.log_dir.clone().unwrap_or_else(|| args.data_dir.join("logs"));
    let log = match LogFile::open(&log_dir, "bridge.log", 2 * 1024 * 1024, 3, true) {
        Ok(l) => Arc::new(l),
        Err(e) => {
            eprintln!("cannot open the log file in {}: {e}", log_dir.display());
            Arc::new(LogFile::console())
        }
    };

    let secret_file = bridge_dir.join("secret");
    let secret = match read_secret(&secret_file, &log) {
        Ok(s) => s,
        Err(e) => {
            log.line(&format!("cannot start: {e}"));
            return ExitCode::from(EXIT_FAILED);
        }
    };

    // The folder around a key file given on the command line is not ours to lock down.
    let default_key = args.key_file.is_none();
    let mut opts = Options::new(args.key_file.unwrap_or_else(|| bridge_dir.join("endpoint.key")), args.server, secret, log.clone());
    opts.secret_file = Some(secret_file);
    opts.restrict_key_dir = default_key;
    opts.relay = args.relay;
    opts.bind = args.bind;
    opts.orphan = args.orphan;
    let mut bridge = match Bridge::start(opts).await {
        Ok(b) => b,
        Err(e) => {
            log.line(&format!("cannot start: {e}"));
            return ExitCode::from(EXIT_FAILED);
        }
    };
    if !bridge.uses_relay() {
        let addr = bridge.direct_addr();
        let direct: Vec<String> = addr.ip_addrs().map(ToString::to_string).collect();
        log.line(&format!("direct addresses {}", direct.join(" ")));
    }

    let code = tokio::select! {
        exit = bridge.wait_exit() => match exit {
            Exit::Restart | Exit::SecretRejected => EXIT_RESTART,
            Exit::Orphan => 0,
            Exit::LinkLost => EXIT_FAILED,
        },
        () = console_stop(&log) => {
            log.line("stop requested from the console");
            0
        }
    };
    bridge.shutdown().await;
    ExitCode::from(code)
}
