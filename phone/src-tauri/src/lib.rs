//! Mission Control on the phone.
//!
//! The app is a small shell. It pairs this phone with up to two places (a PC, and the hub: the
//! always-on server that runs the chats when every PC is off), starts a local proxy (the
//! `mc_bridge` client) for each, and then moves the web view to a proxy's address, so the pages
//! that the place serves take over the whole window. Opening the app tries the first place; when it
//! does not answer within a few seconds, the second one opens instead.
//!
//! Those pages are not part of the app and have no way to call it: the capabilities list no remote
//! URL, every command here also checks that it was called from the shell's own page, and the web
//! view may only navigate to the shell or to a proxy (anything else opens in the system browser).
//! A page can only come back to the shell, with `#open=main`, `#open=second` or `#repair`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use mc_bridge::client::{self, Client, ClientConfig, ProxyHandle, SavedState};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, Url, Webview, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// Where the shell page lives in a release build (the app's own origin).
#[cfg(any(windows, target_os = "android"))]
const SHELL_ORIGIN: &str = "http://tauri.localhost/";
#[cfg(not(any(windows, target_os = "android")))]
const SHELL_ORIGIN: &str = "tauri://localhost/";

/// How long the first place has to answer before the second one opens.
const FIRST_WAIT: Duration = Duration::from_millis(3500);

/// One place this phone may pair with. `main` keeps the files of the app's first versions (the PC
/// it was paired with then stays paired); `second` lives in a folder of its own.
struct Place {
    slot: &'static str,
    dir: PathBuf,
    /// The proxy's port: the same on every launch, so the pages' saved settings stay.
    port: u16,
    client: tokio::sync::OnceCell<Client>,
    proxy: tokio::sync::Mutex<Option<ProxyHandle>>,
}

struct App {
    places: [Place; 2],
    /// A saved port was taken, so the pages' saved settings start over. Reported once.
    settings_reset: AtomicBool,
    /// The shell page's address (the dev server while developing).
    shell: Url,
}

impl App {
    fn place(&self, slot: &str) -> Result<&Place, String> {
        self.places.iter().find(|p| p.slot == slot).ok_or_else(|| "no such place".to_owned())
    }

    fn other(&self, slot: &str) -> &Place {
        if slot == "main" {
            &self.places[1]
        } else {
            &self.places[0]
        }
    }

    fn shell_with(&self, fragment: &str) -> String {
        let mut u = self.shell.clone();
        u.set_fragment(Some(fragment));
        u.to_string()
    }

    /// The network client of a place, started the first time it is needed.
    async fn client<'a>(&self, place: &'a Place) -> Result<&'a Client, String> {
        let shell = self.shell_with("repair");
        let other = self.shell_with(&format!("open={}", self.other(place.slot).slot));
        place
            .client
            .get_or_try_init(|| async {
                let mut cfg = ClientConfig::new(&place.dir);
                cfg.app_version = env!("CARGO_PKG_VERSION").to_owned();
                // The "Pair again" link on the proxy's own pages comes back here, and so does the link to the other place.
                cfg.shell_url = Some(shell);
                cfg.alt_link = Some(("Open the other place".to_owned(), other));
                let slot = place.slot;
                cfg.log = Some(Arc::new(move |line: &str| log::info!("link {slot}: {line}")));
                Client::start(cfg).await
            })
            .await
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// Commands only answer the shell page. A page that came from a place (or anywhere else) is refused
/// here even if something ever let its call through the permission layer.
fn from_shell(webview: &Webview, app: &App) -> Result<(), String> {
    let url = webview.url().map_err(|e| e.to_string())?;
    if same_origin(&url, &app.shell) {
        Ok(())
    } else {
        Err("not allowed".to_owned())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaceInfo {
    slot: &'static str,
    /// `unpaired`, `paired` or `revoked`.
    state: &'static str,
    name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateInfo {
    places: Vec<PlaceInfo>,
    /// True once after the pages' address had to change (their saved settings start over).
    settings_reset: bool,
}

#[derive(Serialize)]
struct PairedInfo {
    slot: &'static str,
    name: String,
}

async fn info_of(app: &App, place: &Place) -> Result<PlaceInfo, String> {
    let (state, name) = match app.client(place).await?.state() {
        SavedState::Unpaired => ("unpaired", None),
        SavedState::Paired { name } => ("paired", Some(name)),
        SavedState::Revoked { name } => ("revoked", Some(name)),
    };
    Ok(PlaceInfo { slot: place.slot, state, name })
}

#[tauri::command]
async fn get_state(webview: Webview, app: State<'_, App>) -> Result<StateInfo, String> {
    from_shell(&webview, &app)?;
    let mut places = Vec::new();
    for p in &app.places {
        places.push(info_of(&app, p).await?);
    }
    Ok(StateInfo { places, settings_reset: app.settings_reset.swap(false, Ordering::Relaxed) })
}

/// Pairs a place. `slot`: the one to use; none picks the first that is free. Pairing never replaces
/// a place silently: the shell has to call `unpair` first (`both_paired` when none is free).
#[tauri::command]
async fn pair(webview: Webview, app: State<'_, App>, text: String, name: String, slot: Option<String>) -> Result<PairedInfo, String> {
    from_shell(&webview, &app)?;
    let mut target = None;
    for p in &app.places {
        if slot.as_deref().is_some_and(|s| s != p.slot) {
            continue;
        }
        if !matches!(app.client(p).await?.state(), SavedState::Paired { .. }) {
            target = Some(p);
            break;
        }
    }
    let Some(place) = target else {
        return Err(if slot.is_some() { "already_paired".to_owned() } else { "both_paired".to_owned() });
    };
    let info = app.client(place).await?.pair(&text, &name).await.map_err(|e| e.to_string())?;
    Ok(PairedInfo { slot: place.slot, name: info.name })
}

/// Forgets a place. The phone keeps its key, so pairing again gives the same device id.
#[tauri::command]
async fn unpair(webview: Webview, app: State<'_, App>, slot: String) -> Result<(), String> {
    from_shell(&webview, &app)?;
    let place = app.place(&slot)?;
    let client = app.client(place).await?;
    if let Some(proxy) = place.proxy.lock().await.take() {
        proxy.stop().await;
    }
    client.forget()
}

/// Makes sure a place's proxy runs, and gives the one-use entry address of its pages.
async fn entry(app: &App, place: &Place) -> Result<(String, bool), String> {
    let client = app.client(place).await?;
    let mut slot = place.proxy.lock().await;
    if slot.is_none() {
        *slot = Some(client.start_proxy(place.port).await?);
    }
    let Some(proxy) = slot.as_ref() else {
        return Err("the local proxy did not start".to_owned());
    };
    Ok((proxy.enter_url(), proxy.wait_online(Duration::ZERO).await))
}

async fn online_within(place: &Place, within: Duration) -> bool {
    let slot = place.proxy.lock().await;
    match slot.as_ref() {
        Some(p) => p.wait_online(within).await,
        None => false,
    }
}

/// Moves this window to a place's pages. `slot`: the place to open. `fallback`: when it does not
/// answer within a few seconds and the other place is paired, the other place opens instead.
/// Answers the slot that opened.
///
/// The move is made from here, not by a script in the shell page: a navigation that starts from
/// the shell's origin counts as coming from another site, and the session cookie that the entry
/// address sets would then not be sent with the redirect that follows.
#[tauri::command]
async fn open_place(webview: Webview, app: State<'_, App>, slot: String, fallback: bool) -> Result<&'static str, String> {
    from_shell(&webview, &app)?;
    let place = app.place(&slot)?;
    let (mut url, mut online) = entry(&app, place).await?;
    let mut opened = place.slot;
    if fallback && !online {
        online = online_within(place, FIRST_WAIT).await;
        let other = app.other(&slot);
        if !online && matches!(app.client(other).await?.state(), SavedState::Paired { .. }) {
            (url, _) = entry(&app, other).await?;
            opened = other.slot;
        }
    }
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    webview.navigate(url).map_err(|e| e.to_string())?;
    Ok(opened)
}

/// Where the web view may go: the shell, a proxy's loopback address, and a blank page.
fn navigation_allowed(url: &Url, shell: &Url, ports: &[u16]) -> bool {
    same_origin(url, shell)
        || (url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some_and(|p| ports.contains(&p)))
        || url.as_str() == "about:blank"
}

fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
        if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
            log::warn!("could not open a link in the system browser: {e}");
        }
    }
}

/// The saved port of a place; a port the other place already has is picked again.
fn port_for(file: &Path, taken: Option<u16>) -> Result<client::PortChoice, String> {
    let first = client::load_or_pick_port(file)?;
    if Some(first.port) != taken {
        return Ok(first);
    }
    let _ = std::fs::remove_file(file);
    client::load_or_pick_port(file)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let second = dir.join("second");
            std::fs::create_dir_all(&second)?;
            let config = app.config();
            let shell: Url = match (tauri::is_dev(), config.build.dev_url.clone()) {
                (true, Some(dev)) => dev,
                _ => Url::parse(SHELL_ORIGIN)?,
            };
            let main_port = port_for(&dir.join("proxy_port"), None)?;
            let second_port = port_for(&second.join("proxy_port"), Some(main_port.port))?;
            let ports = [main_port.port, second_port.port];
            let place = |slot, dir, port| Place { slot, dir, port, client: tokio::sync::OnceCell::new(), proxy: tokio::sync::Mutex::new(None) };
            app.manage(App {
                places: [place("main", dir, main_port.port), place("second", second, second_port.port)],
                settings_reset: AtomicBool::new(main_port.changed),
                shell: shell.clone(),
            });
            let handle = app.handle().clone();
            let window = config.app.windows.first().ok_or("the window is missing from the configuration")?;
            WebviewWindowBuilder::from_config(app.handle(), window)?
                .on_navigation(move |url| {
                    let ok = navigation_allowed(url, &shell, &ports);
                    if !ok {
                        open_outside(&handle, url);
                    }
                    ok
                })
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_state, pair, unpair, open_place])
        .run(tauri::generate_context!())
        .expect("error while running Mission Control");
}
