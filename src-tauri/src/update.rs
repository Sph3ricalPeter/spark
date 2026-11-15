//! Updates while a project is open.
//!
//! The launcher checks and downloads through the updater's JS API
//! (`src/stores/updater-store.ts`), but once a project opens the window shows
//! the project's dev server instead, which can't import it, nor call Spark's
//! own commands (it's a remote origin). The board's title bar
//! (`packages/vite-plugin/src/titlebar.ts`) talks to this through events, like
//! its home button: `spark://update-check` checks and downloads quietly and
//! answers with `spark://update-state`; `spark://update-install` installs and
//! relaunches, only ever from a click on "Restart to update" (the updater
//! never restarts the app on its own).
//!
//! Only the board can send them: the app in the board's frames is refused
//! `spark://` events (mode.ts `boardOnly`).
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update downloaded and waiting for a click, and whether a check runs now.
#[derive(Default)]
pub struct Pending {
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    checking: AtomicBool,
}

pub const CHECK_EVENT: &str = "spark://update-check";
pub const STATE_EVENT: &str = "spark://update-state";
pub const INSTALL_EVENT: &str = "spark://update-install";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardUpdate {
    /// This build may self-update (`updates_enabled`).
    enabled: bool,
    /// "release" or "dev": the board checks dev builds more often.
    channel: &'static str,
    /// The version running now.
    current: String,
    /// The downloaded update, when there is one.
    ready: Option<Ready>,
    /// Why the last check failed, if it did.
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    version: String,
    notes: Option<String>,
    /// The short commit a "spark dev" build came from, when its feed says.
    commit: Option<String>,
}

fn ready_of(update: &Update) -> Ready {
    Ready {
        version: update.version.clone(),
        notes: update
            .body
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from),
        commit: update
            .raw_json
            .get("commit")
            .and_then(|v| v.as_str())
            .map(String::from),
    }
}

/// Answer the board's events (see the top of this file).
pub fn init(app: &AppHandle) {
    let handle = app.clone();
    app.listen_any(CHECK_EVENT, move |_| {
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(state) = check(&handle).await {
                let _ = handle.emit(STATE_EVENT, state);
            }
        });
    });
    let handle = app.clone();
    app.listen_any(INSTALL_EVENT, move |_| {
        if let Err(error) = install(&handle) {
            let _ = handle.emit(
                STATE_EVENT,
                BoardUpdate {
                    error: Some(error),
                    ..base(&handle)
                },
            );
        }
    });
}

fn base(app: &AppHandle) -> BoardUpdate {
    BoardUpdate {
        enabled: crate::updates_enabled(app),
        channel: if crate::is_release(app) {
            "release"
        } else {
            "dev"
        },
        current: app.package_info().version.to_string(),
        ready: None,
        error: None,
    }
}

/// Where updates stand: checks and downloads first when nothing is waiting.
/// None while another check is running (that one answers).
async fn check(app: &AppHandle) -> Option<BoardUpdate> {
    let mut out = base(app);
    if !out.enabled {
        return Some(out);
    }
    let pending = app.state::<Pending>();
    if let Some((update, _)) = pending.ready.lock().ok()?.as_ref() {
        out.ready = Some(ready_of(update));
        return Some(out);
    }
    if pending.checking.swap(true, Ordering::SeqCst) {
        return None;
    }
    let result = check_and_download(app).await;
    pending.checking.store(false, Ordering::SeqCst);
    match result {
        Ok(Some((update, bytes))) => {
            out.ready = Some(ready_of(&update));
            *pending.ready.lock().ok()? = Some((update, bytes));
        }
        Ok(None) => {}
        Err(error) => out.error = Some(error),
    }
    Some(out)
}

async fn check_and_download(app: &AppHandle) -> Result<Option<(Update, Vec<u8>)>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return Ok(None),
        // A release whose Windows asset hasn't uploaded yet: not an error.
        Err(e) if e.to_string().contains("fallback platforms") => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some((update, bytes)))
}

/// Install the downloaded update and relaunch. Only ever from a user's click.
fn install(app: &AppHandle) -> Result<(), String> {
    let pending = app.state::<Pending>();
    let Some((update, bytes)) = pending.ready.lock().map_err(|e| e.to_string())?.take() else {
        return Err("No update is ready".into());
    };
    // On Windows the installer takes over and the process exits here, so the
    // projects' dev servers stop first.
    app.state::<crate::project::Projects>().stop_all();
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}
