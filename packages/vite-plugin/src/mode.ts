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

import type { MenuEntry } from "./menu.ts";

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
  /** The client's panel host, mounted in the shell (the inspector and, on the board, the chat column); only the active frame's shows. */
  panel: HTMLElement;
  /** The client's change list (with Implement changes), mounted in the sidebar's Changes tab; only the active frame's shows. */
  changes?: HTMLElement;
  setOpen(open: boolean): void;
  setPicking(edit: boolean): void;
  /** Another frame became active: drop the selection here. */
  deselect(): void;
  /** This frame became the selected one: draw the inspector again (it shows the frame's properties, frameProps). */
  refresh?(): void;
  /** The chats changed, or the chat column switched between the list and a conversation (chatsOpen). */
  chatsChanged?(): void;
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
  /** Open a chat with no element (an Implement changes run, a task) in this frame's chat column, by id. */
  showChat?(id: string): void;
  /** The Layers tab: the layers under `of` (null: the frame's top level). */
  layers?(of: Element | null): Layer[];
  /** The layers from the top level down to the one showing `el` (an element in an svg shows as its svg). */
  layerChain?(el: Element): Element[];
  /** A layer was clicked: select its element (a case: drop the selection); its box in the frame, or null. */
  selectLayer?(el: Element): { x: number; y: number; w: number; h: number } | null;
  /** The pointer is over a layer's row (null: it left). */
  hoverLayer?(el: Element | null): void;
  /** Right-click on a layer's row or the frame's title: select `el` (null: the frame itself) and open its menu at (x, y) on the board. */
  contextMenu?(el: Element | null, x: number, y: number): void;
  /** Is the element written at `src` ("src/ui/Button.tsx:12:5") on this frame (a component frame: its main component)? */
  hasSource?(src: string): boolean;
  /** Select that element; its box in the frame, or null when it's not here. */
  selectSource?(src: string): { x: number; y: number; w: number; h: number } | null;
  /** The whole frame as a Break down target (components-tab.ts BreakdownTarget). */
  breakdownTarget?(): unknown;
  /** Scan the app's styles for the System tab (system.ts SystemScan), with what the other app frames render. */
  scanSystem?(others?: Document[]): unknown;
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
  /** The panel was opened or closed (in the active frame). On the board the panels are always open, so it does nothing. */
  setDocked(docked: boolean): void;
  /**
   * This frame's properties on the board (an app frame's device, size and
   * ratio; a component frame's layout), for the inspector to show when the
   * frame itself or nothing is selected. One element, moved between the
   * panels: only the selected frame's gets it, null for the others.
   */
  frameProps?(win: Window): HTMLElement | null;
  /** The list of every chat (sidebar.ts chatsTab, in its own shadow root), for the selected frame's chat column. */
  chatList?(): HTMLElement;
  /** The chat column shows that list rather than the selection's conversation; board-wide, remembered. */
  chatsOpen?(): boolean;
  setChatsOpen?(open: boolean): void;
  /** How many chats are open (the column's Chats button shows it). */
  chatCount?(): number;
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
  /** The frame's own items for its right-click menu (zoom to it, add or remove it, its cases' layout). */
  frameMenu?(win: Window): MenuEntry[];
  /** Does a component frame (other than `from`'s) show the element written at `src`: the main component of an instance? */
  hasSource?(src: string, from: Window): boolean;
  /** Go there: select that frame and the element, in view. */
  goToSource?(src: string, from: Window): void;
  /** Break down into components: the board's Components tab, on this target (components-tab.ts BreakdownTarget). */
  breakdown?(target: unknown): void;
  /** A component frame's content size, so the frame hugs it; `stacked`: its cases are in a column. */
  contentSize(win: Window, w: number, h: number, stacked?: boolean): void;
  /** An app frame loaded: spark.setup's sample data (sample.ts) and the one it runs on (null: none). */
  samples?(win: Window, names: string[], current: string | null): void;
  /** The app's own commands this frame called that no fake answered, so far (sample.ts noAnswer). */
  missing?(win: Window, commands: string[]): void;
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

/** The app's own commands this page called that nothing answered: the board lists them (ShellApi.missing). */
const unanswered = new Set<string>();
/** A call to the app's own backend got no answer: tell the board, once per command. */
export function noAnswer(cmd: string) {
  if (unanswered.has(cmd)) return;
  unanswered.add(cmd);
  if (mode === "frame") shell?.missing?.(window, [...unanswered]);
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
 * Events on Spark's window the app in a frame never hears. While any page
 * listens for `tauri://close-requested`, Tauri keeps the window open and
 * waits for that page to close it (`onCloseRequested` then calls destroy).
 * The app in a frame may not destroy Spark's window, and a frame that
 * reloaded never answers at all, so a listening app (dawg saves on close)
 * left Spark unclosable. The app gets a listener that never fires.
 */
const DEAF_EVENTS = new Set(["tauri://close-requested"]);

/** The app's event listeners in Spark's window, by id: unlistened when the page goes. */
const listeners = new Map<number, string>();
let deafIds = 0;

/** What becomes of one of the app's Tauri calls in a frame. */
type Route =
  | { kind: "answer"; run: () => unknown }
  | { kind: "refuse"; message: string }
  /** Spark's Tauri handles it; `then` sees the result. */
  | { kind: "pass"; then?: (result: unknown) => void };

/**
 * The rules for the app's Tauri calls in a frame, whichever way they arrive
 * (borrowTauri):
 * - spark.setup's fakes and the frame's sample data (sample.ts) answer first.
 * - The title bar's calls are refused (`boardOnly`), so the app never
 *   closes, moves or resizes Spark; `DEAF_EVENTS` get a listener that never fires.
 * - Other plugin commands (`plugin:dialog|open`, events, window getters) go
 *   to Spark's window, which allows what `src-tauri/capabilities/project.json`
 *   lists: dialogs and read-only calls.
 * - The app's own commands (`invoke("open_file")`) belong to its Rust side,
 *   which doesn't run inside Spark: they fail, say why and are listed on the
 *   board (`noAnswer`). They're never sent to Spark, whose own commands can
 *   share their names (`app_info`).
 */
function route(cmd: string, args: unknown): Route {
  const fake = window.__sparkTauriFakes?.[cmd];
  if (fake) return { kind: "answer", run: () => fake(args) };
  if (boardOnly(cmd, args)) return { kind: "refuse", message: `Spark's window belongs to Spark: "${cmd}" isn't available to the app inside it.` };
  const a = (args ?? {}) as { event?: unknown; eventId?: unknown };
  if (cmd === "plugin:event|listen" && typeof a.event === "string") {
    if (DEAF_EVENTS.has(a.event)) return { kind: "answer", run: () => --deafIds };
    const event = a.event;
    return { kind: "pass", then: (id) => typeof id === "number" && listeners.set(id, event) };
  }
  if (cmd === "plugin:event|unlisten" && typeof a.eventId === "number") {
    if (a.eventId < 0) return { kind: "answer", run: () => undefined };
    listeners.delete(a.eventId);
  }
  if (cmd.startsWith("plugin:")) return { kind: "pass" };
  noAnswer(cmd);
  return {
    kind: "refuse",
    message: `Spark runs this app's frontend only, so "${cmd}", a command of the app's own Rust side, has no answer here. Give the frame sample data (its inspector, or spark.setup.tsx's samples).`,
  };
}

/**
 * Give the app's frame Tauri that follows `route`. Two cases:
 * - WebView2 (Windows) runs Tauri's scripts in every frame, so the frame has
 *   Tauri of its own, talking to Spark's Rust as Spark's window. Its
 *   `__TAURI_INTERNALS__` can't be replaced (Tauri defines it read-only), but
 *   every call goes out as a `fetch` to the IPC protocol: catch it there
 *   (`interceptIpc`).
 * - Elsewhere Tauri is only in the top window (Spark's, running the shell):
 *   lend it to the frame through a wrapper.
 */
export function borrowTauri() {
  if (mode !== "frame") return;
  if ("__TAURI_INTERNALS__" in window) {
    interceptIpc();
    window.addEventListener("pagehide", () => {
      const own = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
      for (const [eventId, event] of listeners) void own.invoke("plugin:event|unlisten", { event, eventId }).catch(() => {});
      listeners.clear();
    });
    return;
  }
  const parent = window.parent as unknown as Record<string, unknown>;
  const host = parent.__TAURI_INTERNALS__ as TauriInternals | undefined;
  if (!host) return;
  // Callbacks and event listeners this page registers live in the parent and
  // in Spark; drop them with the page.
  const callbacks = new Set<number>();
  const internals = Object.create(host as object, {
    invoke: {
      value: async (cmd: string, args?: unknown, options?: unknown) => {
        const r = route(cmd, args);
        if (r.kind === "answer") return r.run();
        if (r.kind === "refuse") throw new Error(r.message);
        const out = await host.invoke(cmd, args, options);
        r.then?.(out);
        return out;
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
  // `isTauri` and `__TAURI_INTERNALS__` are non-enumerable on the parent, so they're named here.
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: internals, configurable: true });
  Object.defineProperty(window, "isTauri", { value: true, configurable: true });
  // Plugins' own globals (`__TAURI_EVENT_PLUGIN_INTERNALS__` and the like).
  const self = window as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(parent)) {
    if (key.startsWith("__TAURI") && !(key in self)) self[key] = parent[key];
  }
  window.addEventListener("pagehide", () => {
    for (const [eventId, event] of listeners) void host.invoke("plugin:event|unlisten", { event, eventId }).catch(() => {});
    listeners.clear();
    for (const id of callbacks) host.unregisterCallback?.(id);
    callbacks.clear();
  });
}

/** The command an IPC request is for (`http://ipc.localhost/open_file` on Windows, `ipc://localhost/…` elsewhere), or null. */
export function ipcCommand(url: string): string | null {
  const m = /^(?:https?:\/\/ipc\.localhost|ipc:\/\/localhost)\/([^?#]+)/.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** An IPC request's arguments: Tauri sends JSON, or raw bytes for a binary payload. */
function ipcArgs(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return body ?? {};
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** A reply as Tauri's IPC protocol sends it (ipc-protocol.js reads `Tauri-Response` and the content type). */
export function ipcResponse(ok: boolean, value: unknown): Response {
  const status = { "Tauri-Response": ok ? "ok" : "error" };
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return new Response(value as BodyInit, { headers: { ...status, "Content-Type": "application/octet-stream" } });
  }
  return new Response(JSON.stringify(value === undefined ? null : value), { headers: { ...status, "Content-Type": "application/json" } });
}

/** The frame's own Tauri (WebView2): answer its IPC requests by `route`, before they reach Spark's Rust. */
function interceptIpc() {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const cmd = ipcCommand(url);
    if (cmd === null) return realFetch(input, init);
    const r = route(cmd, ipcArgs(init?.body));
    if (r.kind === "pass") {
      const res = realFetch(input, init);
      const then = r.then;
      if (then) void res.then((x) => (x.headers.get("Tauri-Response") === "ok" ? x.clone().json().then(then) : undefined)).catch(() => {});
      return res;
    }
    if (r.kind === "refuse") return Promise.resolve(ipcResponse(false, r.message));
    return Promise.resolve()
      .then(r.run)
      .then(
        (v) => ipcResponse(true, v),
        (e) => ipcResponse(false, e instanceof Error ? e.message : e),
      );
  };
}
