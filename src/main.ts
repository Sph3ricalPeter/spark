// Spark's own page: home, the start screen. packages/vite-plugin/src/home.ts
// draws it, exactly like the board; this file is only the glue to Spark
// itself: Tauri's APIs for the folder picker, opening a project
// (src-tauri/src/project.rs), the settings (settings.rs) and the font files.
// No UI or styles here: home's look lives with the board's, in the plugin.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { startHome, type Recent } from "../packages/vite-plugin/src/home.ts";
import { installFont } from "../packages/vite-plugin/src/fonts.ts";

// Spark's fonts (fonts.ts), from the app's own files: Vite copies every one into the build (the board gets them from the dev server).
const FONTS = Object.fromEntries(
  Object.entries(import.meta.glob<string>("../packages/vite-plugin/assets/fonts/*.woff2", { query: "?url", import: "default", eager: true })).map(([p, url]) => [
    p.split("/").pop()!,
    url,
  ]),
);
installFont(document, (file) => FONTS[file] ?? "");

// The recent projects: this page's origin never changes, so localStorage keeps them.
const STORE = "spark:recent-projects";
const MAX_RECENT = 12;

function loadRecent(): Recent[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORE) ?? "[]") as Recent[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveRecent(list: Recent[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    // Storage off: the list just isn't remembered.
  }
}

const tauri = isTauri();

void startHome(
  {
    recent: loadRecent,
    forget: (folder) => saveRecent(loadRecent().filter((r) => r.folder !== folder)),
    async pick() {
      if (!tauri) return null;
      const folder = await openDialog({ directory: true, title: "Open a project folder" });
      return typeof folder === "string" ? folder : null;
    },
    async open(folder) {
      const opened = await invoke<{ folder: string; name: string; url: string }>("start_project", { folder });
      // Remembered before the window leaves this page for the project.
      const rest = loadRecent().filter((r) => r.folder !== opened.folder);
      saveRecent([{ folder: opened.folder, name: opened.name, openedAt: new Date().toISOString() }, ...rest].slice(0, MAX_RECENT));
      await invoke("show_project", { folder: opened.folder });
    },
    onProgress(fn) {
      if (tauri) void listen<{ folder: string; step: string }>("project-progress", (e) => fn(e.payload));
    },
    settings: {
      load: () => (tauri ? invoke<Record<string, unknown>>("settings_read") : Promise.resolve({})),
      save: (key, value) => {
        if (tauri) invoke("settings_write", { key, value }).catch(() => {});
      },
    },
  },
  // Launched as `spark <folder>` (or given one while running): open it.
  tauri ? await invoke<string | null>("launch_folder").catch(() => null) : null,
);
