// Where this copy of the page runs, and how the two copies talk.
//
// With Spark on, the page the user opens is the viewport shell (shell.ts): a
// canvas with its own zoom and pan, holding the app in an iframe sized to a
// device or a custom resolution. The app, and the Spark client that edits it,
// run inside that iframe; the panel is mounted into the shell, so neither the
// panel nor the shell scale with the canvas.
//
// - "shell": the top-level page. Runs shell.ts only, never the app.
// - "frame": the app inside the shell's iframe.
// - "page": the app embedded somewhere else (another iframe): the old
//   behavior, client docked straight into the page.

export type Mode = "shell" | "frame" | "page";

/** What the shell offers the client running in its iframe. */
export type ShellApi = {
  /** The canvas zoom, read every frame by the client to keep handles a constant size. */
  readonly zoom: number;
  /** Where the client mounts its panel and the Spark button. */
  mount(el: HTMLElement): void;
  /** The panel is open: the canvas gives up room on the right. */
  setDocked(docked: boolean): void;
  /** Ctrl+wheel or a pinch over the app, at a point in the app's own coordinates. */
  wheelZoom(x: number, y: number, deltaY: number): void;
  /** Ctrl +, Ctrl -, Ctrl 0 pressed inside the app. */
  zoomKey(key: "in" | "out" | "reset"): void;
  /** Pan by screen pixels (a middle drag inside the app). */
  panBy(dx: number, dy: number): void;
  /** Space held inside the app: dragging pans the canvas. */
  space(down: boolean): void;
  /**
   * The client's view/edit mode, for the mode island over the canvas.
   * `toggle` is how the island's buttons switch it.
   */
  setMode(edit: boolean, toggle: (edit: boolean) => void): void;
};

declare global {
  interface Window {
    __sparkShell?: ShellApi;
  }
}

function detect(): Mode {
  if (window === window.top) return "shell";
  // frameElement is null when the parent is another origin.
  const fe = window.frameElement;
  if (fe?.hasAttribute("data-spark-frame") && window.parent.__sparkShell) return "frame";
  return "page";
}

export const mode: Mode = detect();

/** The shell, when the app runs in its iframe. */
export const shell: ShellApi | null = mode === "frame" ? window.parent.__sparkShell! : null;

/**
 * A Tauri app's IPC is injected into the top window only. Lend it to the
 * iframe so the app's own `invoke`, events and window controls still work.
 */
export function borrowTauri() {
  if (mode !== "frame") return;
  const parent = window.parent as unknown as Record<string, unknown>;
  const self = window as unknown as Record<string, unknown>;
  for (const key of Object.keys(parent)) {
    if (key.startsWith("__TAURI") && !(key in self)) self[key] = parent[key];
  }
}
