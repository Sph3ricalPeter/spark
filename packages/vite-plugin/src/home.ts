// Spark's home: the start screen, where a project is picked (src/main.ts
// starts it in Spark's own page; a project then replaces it in the window,
// project.rs, and the board's home button comes back).
//
// Home is a page of its own, not the project's dev server, but it's built
// exactly like the board: from this package, in a shadow root with THEME,
// the board's title bar (launcherTitleBar, with Settings and the update
// button) and the same settings (settings.ts, which home reads through
// Spark's commands, settings.rs, before anything shows). There is no home-only
// stylesheet or design system, so whatever changes on the board's side
// (a theme, a variable, a button) is home's too. Keep it that way: style home
// here, with theme.ts's variables and .sp-btn, never in src/.
//
// What it does in Spark (pick a folder, start and show a project, the recent
// ones) comes in as a HomeBackend from src/main.ts, which has Tauri's APIs.
import { h } from "./fields.ts";
import { THEME, icon } from "./theme.ts";
import { connectSettings } from "./settings.ts";
import { launcherTitleBar } from "./titlebar.ts";
import { blockFileDrops } from "./menu.ts";

export type Recent = { folder: string; name: string; openedAt: string };

export type HomeBackend = {
  /** The recent projects, newest first. */
  recent(): Recent[];
  /** Take one off the list. */
  forget(folder: string): void;
  /** The system folder picker; null when cancelled. */
  pick(): Promise<string | null>;
  /** Start the project and show it in the window (remembering it); rejects with why it couldn't. */
  open(folder: string): Promise<void>;
  /** What Spark is doing while a project starts (installing, starting…). */
  onProgress(fn: (p: { folder: string; step: string }) => void): void;
  /** Spark's settings (settings.rs): home has no dev server to keep them. */
  settings: { load(): Promise<Record<string, unknown>>; save(key: string, value: unknown): void };
};

/** The folder's last path segment, either slash. */
export function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
}

/** "now", "5m ago", "3h ago", "2d ago", then the date: as the Chats list says it. */
function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}

const HOME_STYLE = `
  :host { all: initial; position: fixed; inset: 0; display: flex; flex-direction: column; }
  * { box-sizing: border-box; }
  button { font: inherit; color: inherit; }
  /* The board's canvas, dot grid and all, with the picker floating on it like one of its panels. */
  .canvas {
    flex: 1; min-height: 0; overflow: auto; display: grid; place-items: center; padding: var(--sp-4);
    background-color: var(--sp-canvas);
    background-image: radial-gradient(var(--sp-canvas-dot) 1px, transparent 1px);
    background-size: 16px 16px;
    color: var(--sp-text); font: var(--sp-fs-md)/1.45 var(--sp-font); user-select: none; -webkit-font-smoothing: antialiased;
  }
  .picker {
    width: min(480px, 100%); display: flex; flex-direction: column; overflow: hidden;
    background: var(--sp-bg); border: 1px solid var(--sp-line-strong); border-radius: var(--sp-r-lg); box-shadow: 0 12px 40px #0008;
  }
  .head { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border-bottom: 1px solid var(--sp-line); }
  .title { display: flex; align-items: center; gap: 6px; color: var(--sp-text-strong); font-size: var(--sp-fs-lg); font-weight: 600; }
  .title .icon { color: var(--sp-accent); }
  .head p { margin: 0 0 var(--sp-1); color: var(--sp-text-dim); }
  /* Opening: a spinner like a chat's while Claude works. */
  .status { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--sp-line); background: var(--sp-surface); }
  .status span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status b { color: var(--sp-text-strong); }
  .spin { width: 12px; height: 12px; flex: none; border-radius: 50%; border: 2px solid var(--sp-line-strong); border-top-color: var(--sp-accent); animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error { padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--sp-line); box-shadow: inset 2px 0 0 var(--sp-danger); }
  .error-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); color: var(--sp-danger); }
  .error pre { margin: var(--sp-1) 0 0; max-height: 240px; overflow: auto; white-space: pre-wrap; color: var(--sp-text-dim); font: var(--sp-fs-sm)/1.5 var(--sp-mono); user-select: text; }
  /* Recent projects: rows like the Chats list's. */
  .label { padding: var(--sp-2) var(--sp-3) var(--sp-1); color: var(--sp-text-dim); font-size: var(--sp-fs-sm); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
  ul { margin: 0; padding: 0; list-style: none; max-height: min(420px, calc(100vh - 260px)); overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--sp-line-strong) transparent; }
  li { position: relative; border-top: 1px solid var(--sp-line); }
  li:hover { background: var(--sp-surface); }
  .row { width: 100%; display: flex; align-items: flex-start; gap: var(--sp-2); padding: 9px var(--sp-3); border: none; background: none; text-align: left; cursor: pointer; }
  .row:disabled { cursor: default; opacity: .5; }
  .row > .icon { margin-top: 1px; color: var(--sp-text-dim); }
  li:hover .row > .icon { color: var(--sp-accent); }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .top { display: flex; align-items: baseline; gap: 6px; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--sp-text-strong); }
  .when { flex: none; color: var(--sp-text-dim); font-size: var(--sp-fs-xs); }
  li:hover .when { visibility: hidden; }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sp-text-dim); font: var(--sp-fs-xs) var(--sp-mono); }
  /* Remove from recent: on hover, where the time was, like a chat row's Resolve. */
  .forget {
    position: absolute; top: 7px; right: var(--sp-2); display: inline-flex; visibility: hidden; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0;
    border: none; border-radius: var(--sp-r-sm); background: var(--sp-field); color: var(--sp-text-dim); cursor: pointer;
  }
  li:hover .forget { visibility: visible; }
  .forget:hover { background: var(--sp-line-strong); color: var(--sp-text-strong); }
`;

/**
 * Show home in this page. Spark's settings are read first, so it never shows
 * in the default theme for a moment; `launch` is a folder to open at once
 * (`spark <folder>`).
 */
export async function startHome(backend: HomeBackend, launch?: string | null) {
  await connectSettings(backend.settings);

  const host = document.createElement("spark-home");
  const root = host.attachShadow({ mode: "open" });
  const picker = h("div", { class: "picker" });
  root.append(h("style", {}, `${THEME}\n${HOME_STYLE}`), launcherTitleBar(), h("div", { class: "canvas" }, picker));
  document.body.append(host);
  // No browser (WebView2) context menu, as on the board: only in text fields and on selected text.
  window.addEventListener("contextmenu", (e) => {
    const t = e.composedPath()[0] as HTMLElement | undefined;
    const field = !!t && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "INPUT");
    if (!e.defaultPrevented && !field && !window.getSelection()?.toString()) e.preventDefault();
  });
  // A file dropped on the window doesn't open in place of the start screen.
  blockFileDrops(window);
  // Buttons never keep focus, as on the board.
  root.addEventListener("click", (e) => (e.composedPath()[0] as Element).closest?.("button")?.blur());

  let opening: { folder: string; step: string } | null = null;
  let error: { folder: string; message: string } | null = null;

  async function open(folder: string) {
    if (opening) return;
    opening = { folder, step: "Opening…" };
    error = null;
    render();
    try {
      // The window is on its way to the project; "opening" stays until it's there.
      await backend.open(folder);
    } catch (err) {
      opening = null;
      error = { folder, message: err instanceof Error ? err.message : String(err) };
      render();
    }
  }

  function render() {
    const busy = opening !== null;
    const openBtn = h("button", { class: "sp-btn primary wide" }, icon("folder-open", 13), h("span", {}, "Open folder…")) as HTMLButtonElement;
    openBtn.disabled = busy;
    openBtn.addEventListener("click", () => void backend.pick().then((f) => (f ? open(f) : undefined)));
    const parts: HTMLElement[] = [
      h(
        "div",
        { class: "head" },
        h("div", { class: "title" }, icon("folder-open", 14), "Open a project"),
        h("p", {}, "A folder with a Vite + React app. Spark runs its dev server and opens it here, ready to edit; the spark button in its title bar comes back to this list."),
        openBtn,
      ),
    ];
    if (opening) parts.push(h("div", { class: "status" }, h("span", { class: "spin" }), h("span", {}, h("b", {}, folderName(opening.folder)), ` · ${opening.step}`)));
    if (error) {
      const dismiss = h("button", { class: "sp-btn ghost small", title: "Dismiss", "aria-label": "Dismiss" }, icon("x", 12));
      dismiss.addEventListener("click", () => {
        error = null;
        render();
      });
      parts.push(h("div", { class: "error" }, h("div", { class: "error-head" }, h("b", {}, `Couldn't open ${folderName(error.folder)}`), dismiss), h("pre", {}, error.message)));
    }
    const recent = backend.recent();
    if (recent.length) {
      const rows = recent.map((r) => {
        const row = h(
          "button",
          { class: "row", title: `Open ${r.folder}` },
          icon("folder", 14),
          h("span", { class: "main" }, h("span", { class: "top" }, h("span", { class: "name" }, r.name), h("span", { class: "when" }, ago(r.openedAt))), h("span", { class: "path" }, r.folder)),
        ) as HTMLButtonElement;
        row.disabled = busy;
        row.addEventListener("click", () => void open(r.folder));
        const forget = h("button", { class: "forget", title: "Remove from recent", "aria-label": `Remove ${r.name} from recent` }, icon("x", 12));
        forget.addEventListener("click", () => {
          backend.forget(r.folder);
          render();
        });
        return h("li", {}, row, forget);
      });
      parts.push(h("div", { class: "recent" }, h("div", { class: "label" }, "Recent"), h("ul", {}, ...rows)));
    }
    picker.replaceChildren(...parts);
  }

  backend.onProgress((p) => {
    if (opening?.folder !== p.folder) return;
    opening = p;
    render();
  });
  render();
  // Keep "2h ago" fresh.
  setInterval(render, 60_000);
  if (launch) void open(launch);
}
