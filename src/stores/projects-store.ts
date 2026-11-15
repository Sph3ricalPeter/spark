// Projects: folders with a Vite app that Spark opens in its window, in place
// of the launcher (src-tauri/src/project.rs starts the dev server with the
// Spark plugin; the board's home button comes back here). The launcher keeps
// the recent ones.
import { create } from "zustand";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { errorMessage } from "@/lib/app-info";

export interface Recent {
  folder: string;
  name: string;
  openedAt: string;
}

interface Opened {
  folder: string;
  name: string;
  url: string;
}

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

/** The folder's last path segment, either slash. */
export function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
}

function remember(folder: string, name: string) {
  const recent = [
    { folder, name, openedAt: new Date().toISOString() },
    ...useProjectsStore.getState().recent.filter((r) => r.folder !== folder),
  ].slice(0, MAX_RECENT);
  saveRecent(recent);
  useProjectsStore.setState({ recent });
}

interface ProjectsState {
  recent: Recent[];
  /** The folder being opened, and what Spark is doing for it. */
  opening: { folder: string; step: string } | null;
  error: { folder: string; message: string } | null;
  pick: () => Promise<void>;
  open: (folder: string) => Promise<void>;
  forget: (folder: string) => void;
  dismissError: () => void;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  recent: loadRecent(),
  opening: null,
  error: null,

  async pick() {
    if (!isTauri()) return;
    const folder = await openDialog({ directory: true, title: "Open a project folder" });
    if (typeof folder === "string") await get().open(folder);
  },

  async open(folder) {
    if (get().opening) return;
    set({ opening: { folder, step: "Opening…" }, error: null });
    try {
      const opened = await invoke<Opened>("start_project", { folder });
      // Remembered before the window leaves this page for the project.
      remember(opened.folder, opened.name);
      await invoke("show_project", { folder: opened.folder });
      // The window is on its way to the project; "opening" stays until it's there.
    } catch (err) {
      set({ opening: null, error: { folder, message: errorMessage(err) } });
    }
  },

  forget(folder) {
    const recent = get().recent.filter((r) => r.folder !== folder);
    saveRecent(recent);
    set({ recent });
  },

  dismissError() {
    set({ error: null });
  },
}));

// Progress from the backend while a project starts (installing, starting…).
if (isTauri()) {
  // Launched as `spark <folder>` (or given one while running): open it.
  void invoke<string | null>("launch_folder").then((folder) => {
    if (folder) void useProjectsStore.getState().open(folder);
  });
  void listen<{ folder: string; step: string }>("project-progress", (e) => {
    const { opening } = useProjectsStore.getState();
    if (opening?.folder === e.payload.folder) useProjectsStore.setState({ opening: e.payload });
  });
}
