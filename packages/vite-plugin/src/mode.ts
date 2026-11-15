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

/**
 * One row of the board's Layers tab (layers.ts): an element of a frame's
 * tree as the client names it. The tree is the frame's tagged elements
 * (`data-spark-src`), each under the nearest tagged ancestor; a component
 * frame groups them by case.
 */
export type Layer = {
  el: Element;
  name: string;
  /** Said dimmer after the name: an instance's variant, a layout's direction. */
  hint?: string;
  /** "case": a component frame's case, not an element of its own. */
  role: "plain" | "definition" | "instance" | "case";
  /** A Lucide icon name from theme.ts. */
  icon: string;
  /** The root of a component instance (or of the frame's own component). */
  root: boolean;
  hasKids: boolean;
  /** Not drawn: display none, or no size. */
  hidden: boolean;
};

/** What a client in one of the shell's frames hands the shell. */
export type ClientHooks = {
  win: Window;
  /** The client's panel host, mounted in the shell; only the active frame's shows. */
  panel: HTMLElement;
  /** The client's change list (with Implement changes), mounted in the sidebar's Changes tab; only the active frame's shows. */
  changes?: HTMLElement;
  setOpen(open: boolean): void;
  setPicking(edit: boolean): void;
  /** Another frame became active: drop the selection here. */
  deselect(): void;
  /** Another frame took the hover: drop the hover box here. */
  unhover?(): void;
  /** The frame's title was clicked in edit mode: select the frame itself (to Ask Claude about all of it). */
  selectFrame?(): void;
  /** Another frame changed the change list (an edit, undo, redo): show this one. */
  restore(changes: unknown[]): void;
  /** The Chats list: is the element this chat key names in this frame? */
  findChat?(key: string): boolean;
  /** Select that element and open its chat; its box in the frame, or null when it's not here. */
  openChat?(key: string): { x: number; y: number; w: number; h: number } | null;
  /** The Layers tab: the layers under `of` (null: the frame's top level). */
  layers?(of: Element | null): Layer[];
  /** The layers from the top level down to the one showing `el` (an element in an svg shows as its svg). */
  layerChain?(el: Element): Element[];
  /** A layer was clicked: select its element (a case: drop the selection); its box in the frame, or null. */
  selectLayer?(el: Element): { x: number; y: number; w: number; h: number } | null;
  /** The pointer is over a layer's row (null: it left). */
  hoverLayer?(el: Element | null): void;
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
  /** This frame's selection came or went (the chat pins hide while another frame has one). */
  setSelected?(win: Window, has: boolean, el?: Element | null): void;
  /** The element under the pointer in this frame: the shell drops the hover in every other frame (one hover on the board) and the Layers tab marks its row. */
  setHovered?(win: Window, el: Element | null): void;
  /** This frame's tree changed (the Layers tab redraws). */
  layersChanged?(win: Window): void;
  /** The frame's name on the board ("App 2", "Meter"), for what the popup and its chat call it. */
  frameTitle?(win: Window): string;
  /** How many changes are pending (the bar's Changes button shows it). */
  setChangeCount?(n: number): void;
  /** Is an element selected in a frame other than this one? */
  selectedElsewhere?(win: Window): boolean;
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

// The page itself never zooms inside the board: Ctrl+wheel, pinches and
// Ctrl +/-/0 belong to the canvas (the shell zooms it, see shell.ts
// guardFrames). This runs with the frame's first module, before the app and
// before the shell's guard has found the new window, so a gesture in that
// gap can't zoom the whole tab either.
if (mode === "frame") {
  const zoomKey = (e: KeyboardEvent) =>
    (e.ctrlKey || e.metaKey) && !e.altKey && /^(Equal|Minus|Digit0|NumpadAdd|NumpadSubtract|Numpad0)$/.test(e.code);
  window.addEventListener("wheel", (e) => (e.ctrlKey || e.metaKey) && e.preventDefault(), { passive: false, capture: true });
  window.addEventListener("keydown", (e) => zoomKey(e) && e.preventDefault(), true);
  for (const t of ["gesturestart", "gesturechange", "gestureend"]) window.addEventListener(t, (e) => e.preventDefault(), { passive: false, capture: true });
}

/** The shell, when the app runs in its iframe. */
export const shell: ShellApi | null = mode === "frame" ? window.parent.__sparkShell! : null;

type TauriInternals = {
  invoke(cmd: string, args?: unknown, options?: unknown): Promise<unknown>;
  transformCallback(cb?: (response: unknown) => void, once?: boolean): number;
  unregisterCallback?(id: number): void;
};

/** Fakes for the app's own Tauri commands, by name (spark.setup's `tauri`, see gallery.ts). */
export type TauriFakes = Record<string, (args: unknown) => unknown>;

declare global {
  interface Window {
    __sparkTauriFakes?: TauriFakes;
  }
}

/**
 * What the board's title bar does to Spark's window (titlebar.ts), which the
 * app in a frame may not: an app with a title bar of its own (dawg's) would
 * otherwise close or move Spark. Spark's own events (going home) are the
 * board's too.
 */
const TITLE_BAR_COMMANDS = new Set([
  "plugin:window|minimize",
  "plugin:window|toggle_maximize",
  "plugin:window|internal_toggle_maximize",
  "plugin:window|close",
  "plugin:window|start_dragging",
]);

/** Is this a call only the board makes? */
export function boardOnly(cmd: string, args: unknown): boolean {
  if (TITLE_BAR_COMMANDS.has(cmd)) return true;
  const event = (args as { event?: unknown } | null | undefined)?.event;
  return cmd === "plugin:event|emit" && typeof event === "string" && event.startsWith("spark://");
}

/**
 * Tauri injects its IPC into the top window only: Spark's window with the project open,
 * which runs the shell. Lend it to the frame, so the app's Tauri calls work
 * there, the system Open and Save dialogs above all.
 *
 * - `isTauri` and `__TAURI_INTERNALS__` are non-enumerable on the parent,
 *   so they're named here, not found by walking its keys.
 * - Plugin commands (`plugin:dialog|open`, events, window getters) go to
 *   Spark's window, which allows what `src-tauri/capabilities/project.json`
 *   lists: dialogs and read-only calls. The title bar's calls are in that
 *   list too, for the board; the app is refused them (`boardOnly`), so it
 *   never closes, moves or resizes Spark.
 * - The app's own commands (`invoke("open_file")`) belong to its Rust side,
 *   which doesn't run inside Spark. spark.setup's fakes answer them when
 *   there are some; otherwise they fail and say why. They're never sent to
 *   Spark, whose own commands can share their names (`app_info`).
 */
export function borrowTauri() {
  if (mode !== "frame") return;
  const parent = window.parent as unknown as Record<string, unknown>;
  const host = parent.__TAURI_INTERNALS__ as TauriInternals | undefined;
  if (!host || "__TAURI_INTERNALS__" in window) return;
  // Callbacks this page registers live in the parent; drop them with the page.
  const callbacks = new Set<number>();
  const internals = Object.create(host as object, {
    invoke: {
      value: (cmd: string, args?: unknown, options?: unknown) => {
        const fake = window.__sparkTauriFakes?.[cmd];
        if (fake) return Promise.resolve().then(() => fake(args));
        if (boardOnly(cmd, args)) return Promise.reject(new Error(`Spark's window belongs to Spark: "${cmd}" isn't available to the app inside it.`));
        if (cmd.startsWith("plugin:")) return host.invoke(cmd, args, options);
        return Promise.reject(new Error(`Spark runs this app's frontend only, so "${cmd}", a command of the app's own Rust side, isn't available here.`));
      },
    },
    transformCallback: {
      value: (cb?: (response: unknown) => void, once?: boolean) => {
        const id = host.transformCallback(cb, once);
        callbacks.add(id);
        return id;
      },
    },
  });
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: internals, configurable: true });
  Object.defineProperty(window, "isTauri", { value: true, configurable: true });
  // Plugins' own globals (`__TAURI_EVENT_PLUGIN_INTERNALS__` and the like).
  const self = window as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(parent)) {
    if (key.startsWith("__TAURI") && !(key in self)) self[key] = parent[key];
  }
  window.addEventListener("pagehide", () => {
    for (const id of callbacks) host.unregisterCallback?.(id);
    callbacks.clear();
  });
}
