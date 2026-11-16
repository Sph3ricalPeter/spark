//! Spark's own settings (theme, accent, fonts, text size, zoom speeds…), the
//! same in every project: `settings.json` in Spark's config folder,
//! `{ "version": 1, "values": { key: value } }`. An open project's dev server
//! reads and writes the same file (the plugin's `settings.ts`, told where by
//! `SPARK_SETTINGS_DIR`, see project.rs); the launcher uses these commands.
//! Both read the file before every write, so neither undoes the other's.
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const FILE: &str = "settings.json";

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join(FILE))
}

/// Every value; nothing (or a broken file) is no settings.
fn read(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("values").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

#[tauri::command]
pub fn settings_read(app: AppHandle) -> Result<Map<String, Value>, String> {
    Ok(read(&path(&app)?))
}

/// Set one key; null removes it.
#[tauri::command]
pub fn settings_write(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    let path = path(&app)?;
    let mut values = read(&path);
    if value.is_null() {
        values.remove(&key);
    } else {
        values.insert(key, value);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&json!({ "version": 1, "values": values }))
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, text + "\n").map_err(|e| e.to_string())
}
