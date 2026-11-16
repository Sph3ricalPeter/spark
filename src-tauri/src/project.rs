//! Opening a project: a folder with a Vite app in it.
//!
//! Spark runs the project's own Vite dev server with the Spark plugin added,
//! and shows it in Spark's one window, where the page is the viewport shell
//! with the app, the overlay and the panel (`packages/vite-plugin`). The
//! window goes back and forth between the launcher (Spark's own page, "home")
//! and the open project's dev server.
//!
//! The project doesn't need to list the plugin. Spark ships the plugin's
//! source as a resource and copies it into `<project>/.spark/plugin`, so its
//! `vite` import resolves from the project's own `node_modules`, then starts
//! Vite with a config in `.spark/` that loads the project's config and adds
//! the plugin. `.spark/` ignores itself in git. TypeScript, the JSX tagger's
//! parser, is the one thing it never takes from the project (TypeScript 7 has
//! no JS API, a JS app has none): it comes along as `plugin/vendor`.
//!
//! One project runs at a time: opening another stops the one before, going
//! home keeps it running (reopening it is instant), quitting Spark stops it.
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager, Url};

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

/// The one window: the launcher and the open project take turns in it.
pub const MAIN: &str = "main";
/// What the board's home button emits (shell.ts): show the launcher again.
pub const HOME_EVENT: &str = "spark://home";

struct Running {
    child: Child,
    url: String,
}

/// The project Spark runs, and where the window goes home to.
#[derive(Default)]
pub struct Projects {
    /// The running dev server(s), by project folder (one at a time, see `start_project`).
    running: Mutex<HashMap<PathBuf, Running>>,
    /// The launcher's URL, as the window had it before showing a project.
    home: Mutex<Option<Url>>,
    /// The window's title on the launcher ("spark" or "spark dev").
    title: Mutex<String>,
    /// A folder to open once the launcher loads (`spark <folder>`); taken once.
    pending: Mutex<Option<String>>,
}

impl Projects {
    fn stop(&self, folder: &Path) {
        if let Some(mut r) = self.running.lock().unwrap().remove(folder) {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }

    /// Quitting Spark: stop every dev server.
    pub fn stop_all(&self) {
        for (_, mut r) in self.running.lock().unwrap().drain() {
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
    // Spark's own settings (the plugin's settings.ts), the same for every project.
    let settings = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let mut child = command("node", false)
        .env("SPARK_SETTINGS_DIR", &settings)
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

fn name_of(folder: &Path) -> String {
    folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.to_string_lossy().into_owned())
}

/// The window's title with a project open: "dawg — spark".
pub fn project_title(name: &str, base: &str) -> String {
    format!("{name} — {base}")
}

/// Start a project's dev server, or find it running. Any other project's
/// server stops once this one is up. The launcher remembers the project, then
/// shows it (`show_project`).
#[tauri::command]
pub async fn start_project(app: AppHandle, folder: String) -> Result<Opened, String> {
    let path = PathBuf::from(&folder);
    let name = name_of(&path);
    let projects = app.state::<Projects>();
    let running = {
        let mut map = projects.running.lock().unwrap();
        // A server that stopped by itself is started again.
        let alive = match map.get_mut(&path) {
            Some(r) => matches!(r.child.try_wait(), Ok(None)),
            None => true,
        };
        if !alive {
            map.remove(&path);
        }
        map.get(&path).map(|r| r.url.clone())
    };
    if let Some(url) = running {
        return Ok(Opened { folder, name, url });
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

    // One project at a time: the others' servers stop.
    let others: Vec<PathBuf> = projects
        .running
        .lock()
        .unwrap()
        .keys()
        .filter(|f| **f != path)
        .cloned()
        .collect();
    for other in others {
        projects.stop(&other);
    }
    projects.running.lock().unwrap().insert(
        path,
        Running {
            child,
            url: url.clone(),
        },
    );
    Ok(Opened { folder, name, url })
}

/// Show a started project in the window, in place of the launcher.
#[tauri::command]
pub async fn show_project(app: AppHandle, folder: String) -> Result<(), String> {
    let path = PathBuf::from(&folder);
    let projects = app.state::<Projects>();
    let url = projects
        .running
        .lock()
        .unwrap()
        .get(&path)
        .map(|r| r.url.clone())
        .ok_or_else(|| format!("{} isn't running. Open it again.", name_of(&path)))?;
    let window = app
        .get_webview_window(MAIN)
        .ok_or("Spark's window is gone.")?;
    // Where home is, read off the launcher while it's showing.
    if let Some(here) = window.url().ok().filter(is_launcher) {
        *projects.home.lock().unwrap() = Some(here);
    }
    let base = projects.title.lock().unwrap().clone();
    let _ = window.set_title(&project_title(&name_of(&path), &base));
    window
        .navigate(url.parse().map_err(|e| format!("{e}"))?)
        .map_err(|e| format!("Couldn't show the project: {e}"))
}

/// Back to the launcher. The project keeps running, so reopening it is instant.
pub fn go_home(app: &AppHandle) {
    let projects = app.state::<Projects>();
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let home = projects.home.lock().unwrap().clone().unwrap_or_else(|| {
        let https = app
            .config()
            .app
            .windows
            .first()
            .is_some_and(|w| w.use_https_scheme);
        app_url(app.config().build.dev_url.as_ref(), tauri::is_dev(), https)
    });
    let _ = window.set_title(&projects.title.lock().unwrap());
    let _ = window.navigate(home);
}

/// Is this the launcher's page? Not a project's dev server (127.0.0.1), and
/// not the blank page a webview has before it loads anything.
fn is_launcher(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "tauri") && url.host_str() != Some("127.0.0.1")
}

/// Spark's own page, as Tauri serves it: the dev server under `tauri dev`,
/// otherwise its custom protocol (`http://tauri.localhost/` on Windows).
fn app_url(dev_url: Option<&Url>, dev: bool, https: bool) -> Url {
    if let Some(url) = dev_url.filter(|_| dev) {
        return url.clone();
    }
    let url = if cfg!(windows) {
        if https {
            "https://tauri.localhost/"
        } else {
            "http://tauri.localhost/"
        }
    } else {
        "tauri://localhost/"
    };
    Url::parse(url).unwrap()
}

/// At startup: the launcher's title, the folder Spark was launched with, and
/// the board's home button. Not where home is: the window may not have
/// loaded the launcher yet (its URL is still `about:blank`), and going "home"
/// there left a blank window. `show_project` reads it off the launcher.
pub fn init(app: &AppHandle) {
    let projects = app.state::<Projects>();
    if let Some(window) = app.get_webview_window(MAIN) {
        *projects.title.lock().unwrap() = window.title().unwrap_or_else(|_| "spark".into());
    }
    *projects.pending.lock().unwrap() = folder_arg(&std::env::args().collect::<Vec<_>>());
    let handle = app.clone();
    app.listen_any(HOME_EVENT, move |_| go_home(&handle));
}

/// The project folder given on the command line (`spark <folder>`), if any.
pub fn folder_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_dir())
        .cloned()
}

/// The folder to open as the launcher loads (`spark <folder>`), once.
#[tauri::command]
pub fn launch_folder(app: AppHandle) -> Option<String> {
    app.state::<Projects>().pending.lock().unwrap().take()
}

/// `spark <folder>` while Spark runs: the launcher comes back and opens it,
/// so it's remembered and its progress and errors show there.
pub fn open_later(app: &AppHandle, folder: String) {
    *app.state::<Projects>().pending.lock().unwrap() = Some(folder);
    go_home(app);
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
    fn home_is_the_launcher_never_a_blank_page() {
        let url = |u: &str| Url::parse(u).unwrap();
        assert!(is_launcher(&url("http://tauri.localhost/")));
        assert!(is_launcher(&url("tauri://localhost/")));
        assert!(is_launcher(&url("http://localhost:5178/")));
        assert!(!is_launcher(&url("about:blank")));
        assert!(!is_launcher(&url("http://127.0.0.1:54321/")));
        let dev = url("http://localhost:5178/");
        assert_eq!(app_url(Some(&dev), true, false), dev);
        let built = app_url(Some(&dev), false, false);
        assert!(is_launcher(&built) && built != dev);
        assert!(is_launcher(&app_url(None, true, false)));
    }

    #[test]
    fn a_project_is_named_in_the_title() {
        assert_eq!(project_title("dawg", "spark dev"), "dawg — spark dev");
    }

    #[test]
    fn an_open_project_gets_the_dialogs_and_the_title_bar() {
        use std::str::FromStr;
        use tauri::utils::acl::RemoteUrlPattern;
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/project.json")).unwrap();
        // Spark's one window, with a project open in it.
        assert_eq!(cap["windows"], serde_json::json!([MAIN]));
        // The dev server on any port, and nothing else.
        let pattern =
            RemoteUrlPattern::from_str(cap["remote"]["urls"][0].as_str().unwrap()).unwrap();
        let url = |u: &str| tauri::Url::parse(u).unwrap();
        assert!(pattern.test(&url("http://127.0.0.1:54321/")));
        assert!(pattern.test(&url(
            "http://127.0.0.1:5179/?spark=components&file=/src/a.tsx"
        )));
        assert!(!pattern.test(&url("https://example.com/")));
        let permissions: Vec<&str> = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        assert!(permissions.contains(&"dialog:default"));
        // Beyond the defaults, only the board's title bar: move, minimize,
        // maximize, close (borrowTauri keeps these from the app in a frame).
        // Never retitling it, menus or the tray.
        let title_bar = [
            "core:window:allow-minimize",
            "core:window:allow-toggle-maximize",
            "core:window:allow-close",
            "core:window:allow-start-dragging",
        ];
        assert!(permissions
            .iter()
            .all(|p| (p.ends_with(":default") || title_bar.contains(p))
                && !p.starts_with("core:menu")
                && !p.starts_with("core:tray")));
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
