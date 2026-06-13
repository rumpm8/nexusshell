//! Odysseus engine manager — runs the self-hosted Odysseus AI workspace
//! (FastAPI/uvicorn on 127.0.0.1:7000) as a managed child process so the
//! whole thing lives inside Nexus Shell: no terminal, no browser.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

static CHILD: Mutex<Option<Child>> = Mutex::new(None);

const HOST: &str = "127.0.0.1";
const PORT: u16 = 7000;

fn base_url() -> String {
    format!("http://{HOST}:{PORT}")
}

/// Is the Odysseus server answering? (ours or one the user started themselves)
#[tauri::command]
pub async fn odysseus_status() -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;
    let running = client.get(base_url()).send().await
        .map(|r| r.status().is_success() || r.status().is_redirection())
        .unwrap_or(false);
    let owned = CHILD.lock().map(|c| c.is_some()).unwrap_or(false);
    Ok(json!({ "running": running, "owned": owned, "url": base_url() }))
}

/// Launch Odysseus from its install directory using its own venv.
#[tauri::command]
pub fn odysseus_start(path: String) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    if !dir.join("app.py").exists() {
        return Err(format!("No Odysseus install at {path} (app.py not found)"));
    }
    let py = dir.join("venv/bin/python");
    if !py.exists() {
        return Err(format!(
            "Odysseus venv missing at {path}/venv — run its ./start-macos.sh once \
             in Terminal to finish first-time setup, then come back here."
        ));
    }

    let mut guard = CHILD.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
            return Ok("already running (managed)".into());
        }
        *guard = None;
    }

    // engine output goes to its own log so crashes are diagnosable
    let log = std::fs::OpenOptions::new()
        .create(true).append(true)
        .open(dir.join("logs").join("nexus-shell.log"))
        .or_else(|_| {
            std::fs::create_dir_all(dir.join("logs")).ok();
            std::fs::OpenOptions::new().create(true).append(true)
                .open(dir.join("logs").join("nexus-shell.log"))
        })
        .map_err(|e| format!("cannot open log: {e}"))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let child = Command::new(py)
        .args(["-m", "uvicorn", "app:app", "--host", HOST, "--port", &PORT.to_string()])
        .current_dir(&dir)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .spawn()
        .map_err(|e| format!("failed to launch: {e}"))?;

    *guard = Some(child);
    Ok("starting".into())
}

/// Stop the engine — ours if we own it, otherwise any uvicorn on the port.
#[tauri::command]
pub fn odysseus_stop() -> Result<String, String> {
    let mut guard = CHILD.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        return Ok("stopped (managed)".into());
    }
    // not ours — stop a self-started instance politely by port
    let out = Command::new("/bin/sh")
        .args(["-c", &format!("lsof -ti tcp:{PORT} | xargs kill 2>/dev/null")])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok("stopped (external)".into())
    } else {
        Ok("nothing to stop".into())
    }
}

/// Open the workspace in the system browser (escape hatch / second screen).
#[tauri::command]
pub fn odysseus_open_external() -> Result<(), String> {
    open::that(base_url()).map_err(|e| e.to_string())
}

/* ── native embed: a child webview mounted INSIDE the main window ────────
   An iframe can't host Odysseus properly (frame-blocking headers, cookie
   partitioning kill its login session). A child webview is a first-class
   browser surface — full capabilities — positioned exactly over the
   module's content area. ─────────────────────────────────────────────── */

const EMBED_LABEL: &str = "odysseus";

fn find_embed(window: &tauri::Window) -> Option<tauri::Webview> {
    window.webviews().into_iter().find(|w| w.label() == EMBED_LABEL)
}

/// Create (or reposition + show) the embedded Odysseus webview.
/// x/y/w/h are CSS pixels of the module's content area in the main window.
#[tauri::command]
pub fn odysseus_embed(window: tauri::Window, x: f64, y: f64, w: f64, h: f64)
    -> Result<(), String> {
    if let Some(wv) = find_embed(&window) {
        wv.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(tauri::LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = base_url().parse::<tauri::Url>().map_err(|e| format!("{e}"))?;
    let builder = tauri::webview::WebviewBuilder::new(
        EMBED_LABEL, tauri::WebviewUrl::External(url));
    window
        .add_child(builder,
                   tauri::LogicalPosition::new(x, y),
                   tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Hide the embed (view switched away / overlay opened). Keeps session alive.
#[tauri::command]
pub fn odysseus_embed_hide(window: tauri::Window) -> Result<(), String> {
    if let Some(wv) = find_embed(&window) {
        wv.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Reload the embedded workspace.
#[tauri::command]
pub fn odysseus_embed_reload(window: tauri::Window) -> Result<(), String> {
    if let Some(wv) = find_embed(&window) {
        wv.eval("location.reload()").map_err(|e| e.to_string())?;
    }
    Ok(())
}
