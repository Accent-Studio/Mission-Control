//! Mission Control on the phone.
//!
//! The app is a small shell. It pairs this phone with the PC, starts the local proxy (the
//! `mc_bridge` client) and then moves the web view to the proxy's address, so the pages that
//! the PC serves take over the whole window. Those pages are not part of the app and have no
//! way to call it: the capabilities list no remote URL, every command here also checks that it
//! was called from the shell's own page, and the web view may only navigate to the shell or to
//! the proxy (anything else opens in the system browser).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use mc_bridge::client::{self, Client, ClientConfig, ProxyHandle, SavedState};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, Url, Webview, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// Where the shell page lives in a release build (the app's own origin).
#[cfg(any(windows, target_os = "android"))]
const SHELL_ORIGIN: &str = "http://tauri.localhost/";
#[cfg(not(any(windows, target_os = "android")))]
const SHELL_ORIGIN: &str = "tauri://localhost/";

struct App {
    dir: PathBuf,
    /// The proxy's port: the same on every launch, so the pages' saved settings stay.
    port: u16,
    /// The port that had been saved was taken, so the pages' saved settings start over. Reported once.
    settings_reset: AtomicBool,
    /// The shell page's address (the dev server while developing).
    shell: Url,
    client: tokio::sync::OnceCell<Client>,
    proxy: tokio::sync::Mutex<Option<ProxyHandle>>,
}

impl App {
    /// The network client, started the first time it is needed.
    async fn client(&self) -> Result<&Client, String> {
        self.client
            .get_or_try_init(|| async {
                let mut cfg = ClientConfig::new(&self.dir);
                cfg.app_version = env!("CARGO_PKG_VERSION").to_owned();
                // The "Pair again" link on the proxy's own pages comes back here.
                let mut back = self.shell.clone();
                back.set_fragment(Some("repair"));
                cfg.shell_url = Some(back.to_string());
                cfg.log = Some(Arc::new(|line: &str| log::info!("link: {line}")));
                Client::start(cfg).await
            })
            .await
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// Commands only answer the shell page. A page that came from the PC (or anywhere else) is refused
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
struct StateInfo {
    /// `unpaired`, `paired` or `revoked`.
    state: &'static str,
    name: Option<String>,
    /// True once after the pages' address had to change (their saved settings start over).
    settings_reset: bool,
}

#[derive(Serialize)]
struct PairedInfo {
    name: String,
}

#[tauri::command]
async fn get_state(webview: Webview, app: State<'_, App>) -> Result<StateInfo, String> {
    from_shell(&webview, &app)?;
    let (state, name) = match app.client().await?.state() {
        SavedState::Unpaired => ("unpaired", None),
        SavedState::Paired { name } => ("paired", Some(name)),
        SavedState::Revoked { name } => ("revoked", Some(name)),
    };
    Ok(StateInfo { state, name, settings_reset: app.settings_reset.swap(false, Ordering::Relaxed) })
}

#[tauri::command]
async fn pair(webview: Webview, app: State<'_, App>, text: String, name: String) -> Result<PairedInfo, String> {
    from_shell(&webview, &app)?;
    let client = app.client().await?;
    // Pairing again never replaces a PC silently: the shell has to call `unpair` first.
    if matches!(client.state(), SavedState::Paired { .. }) {
        return Err("already_paired".to_owned());
    }
    let info = client.pair(&text, &name).await.map_err(|e| e.to_string())?;
    Ok(PairedInfo { name: info.name })
}

/// Forgets the PC. The phone keeps its key, so pairing again gives the same device id.
#[tauri::command]
async fn unpair(webview: Webview, app: State<'_, App>) -> Result<(), String> {
    from_shell(&webview, &app)?;
    let client = app.client().await?;
    if let Some(proxy) = app.proxy.lock().await.take() {
        proxy.stop().await;
    }
    client.forget()
}

/// Makes sure the proxy runs, then moves this window to the PC's pages through the one-use entry address.
///
/// The move is made from here, not by a script in the shell page: a navigation that starts from
/// the shell's origin counts as coming from another site, and the session cookie that the entry
/// address sets would then not be sent with the redirect that follows.
#[tauri::command]
async fn open_pc(webview: Webview, app: State<'_, App>) -> Result<(), String> {
    from_shell(&webview, &app)?;
    let client = app.client().await?;
    let mut slot = app.proxy.lock().await;
    if slot.is_none() {
        *slot = Some(client.start_proxy(app.port).await?);
    }
    let Some(proxy) = slot.as_ref() else {
        return Err("the local proxy did not start".to_owned());
    };
    let url = Url::parse(&proxy.enter_url()).map_err(|e| e.to_string())?;
    drop(slot);
    webview.navigate(url).map_err(|e| e.to_string())
}

/// Where the web view may go: the shell, the proxy's loopback address, and a blank page.
fn navigation_allowed(url: &Url, shell: &Url, port: u16) -> bool {
    same_origin(url, shell)
        || (url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(port))
        || url.as_str() == "about:blank"
}

fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
        if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
            log::warn!("could not open a link in the system browser: {e}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let config = app.config();
            let shell: Url = match (tauri::is_dev(), config.build.dev_url.clone()) {
                (true, Some(dev)) => dev,
                _ => Url::parse(SHELL_ORIGIN)?,
            };
            let port = client::load_or_pick_port(&dir.join("proxy_port"))?;
            app.manage(App {
                dir,
                port: port.port,
                settings_reset: AtomicBool::new(port.changed),
                shell: shell.clone(),
                client: tokio::sync::OnceCell::new(),
                proxy: tokio::sync::Mutex::new(None),
            });
            let handle = app.handle().clone();
            let window = config.app.windows.first().ok_or("the window is missing from the configuration")?;
            WebviewWindowBuilder::from_config(app.handle(), window)?
                .on_navigation(move |url| {
                    let ok = navigation_allowed(url, &shell, port.port);
                    if !ok {
                        open_outside(&handle, url);
                    }
                    ok
                })
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_state, pair, unpair, open_pc])
        .run(tauri::generate_context!())
        .expect("error while running Mission Control");
}
