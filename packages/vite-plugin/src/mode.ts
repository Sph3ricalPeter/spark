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

/** What a client in one of the shell's frames hands the shell. */
export type ClientHooks = {
  win: Window;
  /** The client's panel host, mounted in the shell; only the active frame's shows. */
  panel: HTMLElement;
  setOpen(open: boolean): void;
  setPicking(edit: boolean): void;
  /** Another frame became active: drop the selection here. */
  deselect(): void;
  /** Another frame changed the change list (an edit, undo, redo): show this one. */
  restore(changes: unknown[]): void;
  /** The Chats list: is the element this chat key names in this frame? */
  findChat?(key: string): boolean;
  /** Select that element and open its chat; its box in the frame, or null when it's not here. */
  openChat?(key: string): { x: number; y: number; w: number; h: number } | null;
};

/**
 * What the shell offers the clients running in its frames. The board has
 * several frames (app viewports and component frames), each with its own
 * client; the shell keeps them in step: one mode, one open panel (the active
 * frame's), one change list and one undo history.
 */
export type ShellApi = {
  /** The canvas zoom, read every frame by the client to keep handles a constant size. */
  readonly zoom: number;
  /** A client loaded in a frame. The shell sends it the current mode and panel state. */
  register(hooks: ClientHooks): void;
  /** Is this frame the active one (its panel shows, the shell's keys go to it)? */
  isActive(win: Window): boolean;
  /** The panel was opened or closed (in the active frame): all frames follow, the canvas docks. */
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
   * The client's view/edit mode, for the mode island over the canvas; every
   * frame follows. `toggle` is kept for compatibility and unused.
   */
  setMode(edit: boolean, toggle?: (edit: boolean) => void): void;
  /** A saved edit: the shell records an undo step and sends the list to the other frames. */
  commit(changes: unknown[], from: Window): void;
  /** Undo (-1) or redo (1): the list to show, or null at the end of the history. Other frames get it too. */
  step(dir: -1 | 1, from: Window): unknown[] | null;
  /** The list was loaded or Claude applied changes: the history starts over from it. */
  resetHistory(changes: unknown[]): void;
  /** A component frame's content size, so the frame hugs it; `stacked`: its cases are in a column. */
  contentSize(win: Window, w: number, h: number, stacked?: boolean): void;
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
