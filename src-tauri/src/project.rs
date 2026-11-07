//! Opening a project: a folder with a Vite app in it.
//!
//! Spark runs the project's own Vite dev server with the Spark plugin added,
//! and opens it in a window of its own, where the page is the viewport shell
//! with the app, the overlay and the panel (`packages/vite-plugin`).
//!
//! The project doesn't need to list the plugin. Spark ships the plugin's
//! source as a resource and copies it into `<project>/.spark/plugin`, so its
//! imports (`vite`, `typescript`) resolve from the project's own
//! `node_modules`, then starts Vite with a config in `.spark/` that loads the
//! project's config and adds the plugin. `.spark/` ignores itself in git.
//!
//! One dev server per project; closing the project's window stops it, and so
//! does quitting Spark.
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// How long a dev server gets to start listening.
const START_TIMEOUT: Duration = Duration::from_secs(90);
/// Lines of dev server output kept for error messages.
const LOG_LINES: usize = 200;
/// Vite's config file names, in the order Vite looks for them.
const VITE_CONFIGS: [&str; 6] = [
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.ts",
    "vite.config.cjs",
    "vite.config.mts",
    "vite.config.cts",
];

/// The Vite config Spark starts the project with (written to `.spark/`).
const WRAPPER_CONFIG: &str = r#"// Written by Spark every time it opens this project; edits are replaced.
// Loads the project's own Vite config and adds the Spark plugin to it.
import { loadConfigFromFile, mergeConfig } from "vite";
import spark from "./plugin/src/index.ts";

const ROOT = __ROOT__;

export default async (env) => {
  const loaded = await loadConfigFromFile(env, undefined, ROOT);
  const user = loaded?.config ?? {};
  const listed = [user.plugins ?? []].flat(Infinity).some((p) => p && p.name === "spark");
  return mergeConfig({ ...user, root: user.root ?? ROOT }, listed ? {} : { plugins: [spark()] });
};
"#;

struct Running {
    child: Child,
    window: String,
}

/// Dev servers Spark started, by project folder.
#[derive(Default)]
pub struct Projects(Mutex<HashMap<PathBuf, Running>>);

impl Projects {
    fn stop(&self, folder: &Path) {
        if let Some(mut r) = self.0.lock().unwrap().remove(folder) {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }

    /// Quitting Spark: stop every dev server.
    pub fn stop_all(&self) {
        for (_, mut r) in self.0.lock().unwrap().drain() {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub folder: String,
    pub name: String,
    pub url: String,
}

#[derive(Serialize, Clone)]
struct Progress<'a> {
    folder: &'a str,
    /// What Spark is doing, for the launcher: "Installing dependencies…" etc.
    step: &'a str,
}

/// What's wrong with a folder as a Spark project, if anything.
pub fn check_folder(folder: &Path) -> Result<(), String> {
    if !folder.join("package.json").is_file() {
        return Err("This folder has no package.json. Open the folder of a JavaScript app.".into());
    }
    if !VITE_CONFIGS.iter().any(|c| folder.join(c).is_file()) {
        return Err("Spark works with Vite apps, and this folder has no vite.config file.".into());
    }
    Ok(())
}

/// The package manager the project uses, from its lockfile.
pub fn package_manager(folder: &Path) -> &'static str {
    if folder.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if folder.join("yarn.lock").is_file() {
        "yarn"
    } else if folder.join("bun.lockb").is_file() || folder.join("bun.lock").is_file() {
        "bun"
    } else {
        "npm"
    }
}

/// The wrapper config for a project root.
pub fn wrapper_config(root: &Path) -> String {
    let root = root.to_string_lossy().replace('\\', "/");
    WRAPPER_CONFIG.replace("__ROOT__", &serde_json::to_string(&root).unwrap())
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

/// A command that doesn't flash a console window on Windows. `.cmd` shims
/// (npm, pnpm, yarn) need cmd.exe there.
fn command(program: &str, shim: bool) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = if shim {
            let mut c = Command::new("cmd");
            c.args(["/C", program]);
            c
        } else {
            Command::new(program)
        };
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }
    #[cfg(not(windows))]
    {
        let _ = shim;
        Command::new(program)
    }
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("No free port: {e}"))?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

type Log = Arc<Mutex<VecDeque<String>>>;

fn collect(stream: impl Read + Send + 'static, log: Log) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let mut log = log.lock().unwrap();
            if log.len() == LOG_LINES {
                log.pop_front();
            }
            log.push_back(strip_ansi(&line));
        }
    });
}

/// Terminal colors out of a line of output.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn tail(log: &Log, n: usize) -> String {
    let log = log.lock().unwrap();
    let skip = log.len().saturating_sub(n);
    log.iter()
        .skip(skip)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

fn install(folder: &Path) -> Result<(), String> {
    let pm = package_manager(folder);
    let out = command(pm, pm != "bun")
        .arg("install")
        .current_dir(folder)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Couldn't run `{pm} install` ({e}). Is Node.js installed?"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = strip_ansi(&String::from_utf8_lossy(&out.stderr));
    let lines: Vec<&str> = err.lines().collect();
    Err(format!(
        "`{pm} install` failed:\n{}",
        lines[lines.len().saturating_sub(20)..].join("\n")
    ))
}

/// Install if needed, set up `.spark/`, start Vite and wait for it to listen.
fn start(app: &AppHandle, folder: &Path, report: &dyn Fn(&str)) -> Result<(Child, String), String> {
    check_folder(folder)?;
    if !folder.join("node_modules").join("vite").is_dir() {
        report("Installing dependencies…");
        install(folder)?;
    }
    let vite = folder
        .join("node_modules")
        .join("vite")
        .join("bin")
        .join("vite.js");
    if !vite.is_file() {
        return Err("Vite isn't in this project's node_modules after installing.".into());
    }

    report("Setting up Spark…");
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("plugin");
    let dot = folder.join(".spark");
    let plugin = dot.join("plugin");
    let _ = std::fs::remove_dir_all(&plugin);
    copy_dir(&resources, &plugin).map_err(|e| format!("Couldn't copy the Spark plugin: {e}"))?;
    std::fs::write(dot.join(".gitignore"), "*\n").map_err(|e| e.to_string())?;
    let config = dot.join("vite.config.mjs");
    std::fs::write(&config, wrapper_config(folder)).map_err(|e| e.to_string())?;

    report("Starting the dev server…");
    let port = free_port()?;
    let mut child = command("node", false)
        .arg(&vite)
        .arg("--config")
        .arg(&config)
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--strictPort",
        ])
        .current_dir(folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Node.js isn't installed or isn't on PATH.".to_string()
            } else {
                format!("Couldn't start the dev server: {e}")
            }
        })?;
    let log: Log = Arc::default();
    collect(child.stdout.take().unwrap(), log.clone());
    collect(child.stderr.take().unwrap(), log.clone());

    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let began = Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            std::thread::sleep(Duration::from_millis(200));
            return Err(format!(
                "The dev server stopped ({status}):\n{}",
                tail(&log, 30)
            ));
        }
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return Ok((child, format!("http://127.0.0.1:{port}/")));
        }
        if began.elapsed() > START_TIMEOUT {
            let _ = child.kill();
            return Err(format!(
                "The dev server didn't start within {} seconds:\n{}",
                START_TIMEOUT.as_secs(),
                tail(&log, 30)
            ));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// A window label for a project folder: stable across launches (the window-state
/// plugin keys saved size and position by label), and only characters labels allow.
pub fn window_label(folder: &Path) -> String {
    // FNV-1a over the path.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in folder.to_string_lossy().to_lowercase().bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("project-{h:016x}")
}

fn name_of(folder: &Path) -> String {
    folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.to_string_lossy().into_owned())
}

/// Open a project folder in its own window, starting its dev server first.
/// An open project's window is focused instead.
#[tauri::command]
pub async fn open_project(app: AppHandle, folder: String) -> Result<Opened, String> {
    let path = PathBuf::from(&folder);
    let name = name_of(&path);
    let projects = app.state::<Projects>();
    let open = projects
        .0
        .lock()
        .unwrap()
        .get(&path)
        .map(|r| r.window.clone());
    if let Some(label) = open {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.unminimize();
            let _ = w.set_focus();
            let url = w.url().map(|u| u.to_string()).unwrap_or_default();
            return Ok(Opened { folder, name, url });
        }
        projects.stop(&path);
    }

    let (child, url) = {
        let app = app.clone();
        let path = path.clone();
        let folder = folder.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let report = |step: &str| {
                let _ = app.emit(
                    "project-progress",
                    Progress {
                        folder: &folder,
                        step,
                    },
                );
            };
            start(&app, &path, &report)
        })
        .await
        .map_err(|e| e.to_string())??
    };

    // The same folder gets the same label, so the window comes back where it was.
    let label = window_label(&path);
    let parsed = url.parse().map_err(|e| format!("{e}"))?;
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(format!("{name} — spark"))
        .inner_size(1440.0, 900.0)
        .min_inner_size(800.0, 500.0)
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::window::Color(13, 13, 13, 255))
        // The board zooms its own canvas; the webview's page zoom (Ctrl+wheel,
        // Ctrl +/-) would scale Spark's panel and bar too. Off is Tauri's
        // default; said here so it stays that way.
        .zoom_hotkeys_enabled(false)
        .build();
    let window = match window {
        Ok(w) => w,
        Err(e) => {
            let mut child = child;
            let _ = child.kill();
            return Err(format!("Couldn't open the project window: {e}"));
        }
    };
    projects.0.lock().unwrap().insert(
        path.clone(),
        Running {
            child,
            window: label,
        },
    );
    let handle = app.clone();
    window.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            handle.state::<Projects>().stop(&path);
        }
    });
    Ok(Opened { folder, name, url })
}

/// The project folder given on the command line (`spark <folder>`), if any.
pub fn folder_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_dir())
        .cloned()
}

/// The folder Spark was launched with (`spark <folder>`); the launcher opens it.
#[tauri::command]
pub fn launch_folder() -> Option<String> {
    folder_arg(&std::env::args().collect::<Vec<_>>())
}

/// Open a project without a caller waiting: errors go to the launcher.
pub fn open_in_background(app: AppHandle, folder: String) {
    tauri::async_runtime::spawn(async move {
        let _ = app.emit("project-opening", &folder);
        let result = open_project(app.clone(), folder.clone()).await;
        let _ = app.emit(
            "project-opened",
            match result {
                Ok(o) => serde_json::json!({ "folder": folder, "name": o.name }),
                Err(e) => serde_json::json!({ "folder": folder, "error": e }),
            },
        );
    });
}

/// Whether a folder can be opened, before trying (for the launcher's list).
#[tauri::command]
pub fn check_project(folder: String) -> Result<(), String> {
    check_folder(Path::new(&folder))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrapper_points_at_the_project() {
        let c = wrapper_config(Path::new(r"C:\Users\me\dawg"));
        assert!(c.contains(r#"const ROOT = "C:/Users/me/dawg";"#));
        assert!(c.contains(r#"import spark from "./plugin/src/index.ts";"#));
    }

    #[test]
    fn window_labels_are_stable_per_folder() {
        let a = window_label(Path::new(r"C:\Users\me\dawg"));
        assert_eq!(a, window_label(Path::new(r"c:\users\me\dawg")));
        assert_ne!(a, window_label(Path::new(r"C:\Users\me\other")));
        assert!(a.starts_with("project-") && a.len() == 24);
    }

    #[test]
    fn strips_terminal_colors() {
        assert_eq!(
            strip_ansi("\u{1b}[32m➜\u{1b}[39m  Local: \u{1b}[1mhttp://x\u{1b}[22m"),
            "➜  Local: http://x"
        );
    }

    #[test]
    fn picks_the_package_manager_from_the_lockfile() {
        let dir = std::env::temp_dir().join(format!("spark-pm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(package_manager(&dir), "npm");
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(package_manager(&dir), "pnpm");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_needs_package_json_and_vite_config() {
        let dir = std::env::temp_dir().join(format!("spark-check-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(check_folder(&dir).is_err());
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        assert!(check_folder(&dir).is_err());
        std::fs::write(dir.join("vite.config.ts"), "").unwrap();
        assert!(check_folder(&dir).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
