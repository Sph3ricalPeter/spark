mod project;

use serde::Serialize;
use tauri::Manager;

/// The installed app. "spark dev" (`tauri.dev.conf.json`) has its own id so
/// the two install side by side.
const RELEASE_IDENTIFIER: &str = "com.sph3ricalpeter.spark";
const DEV_IDENTIFIER: &str = "com.sph3ricalpeter.spark.dev";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    /// "release" for the installed app, "dev" for "spark dev" and `tauri dev`.
    channel: &'static str,
    updates_enabled: bool,
}

fn is_release(app: &tauri::AppHandle) -> bool {
    !cfg!(debug_assertions) && app.config().identifier == RELEASE_IDENTIFIER
}

/// Whether this build may self-update: the released app from GitHub
/// Releases, and "spark dev" builds CI made from `dev` (stamped
/// `x.y.z-dev.<run>`) from the rolling `dev-build` prerelease. Local
/// `npm run build:dev` and `tauri dev` builds never update.
fn updates_enabled(app: &tauri::AppHandle) -> bool {
    is_release(app)
        || (!cfg!(debug_assertions)
            && app.config().identifier == DEV_IDENTIFIER
            && app.package_info().version.pre.as_str().starts_with("dev."))
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        channel: if is_release(&app) { "release" } else { "dev" },
        updates_enabled: updates_enabled(&app),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First, so a second launch focuses the open window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // `spark <folder>` while Spark runs opens that project here.
            if let Some(folder) = project::folder_arg(&args) {
                project::open_in_background(app.clone(), folder);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(project::Projects::default())
        .setup(|app| {
            if updates_enabled(app.handle()) {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            if let Some(window) = app.get_webview_window("main") {
                if !is_release(app.handle()) {
                    window.set_title("spark dev")?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            project::open_project,
            project::check_project,
            project::launch_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building spark")
        .run(|app, event| {
            // Projects' dev servers don't outlive Spark.
            if let tauri::RunEvent::Exit = event {
                app.state::<project::Projects>().stop_all();
            }
        });
}
