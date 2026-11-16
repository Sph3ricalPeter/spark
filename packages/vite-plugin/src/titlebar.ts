// The window's title bar: the board's, with a project open, and the
// launcher's (src/components/TitleBar.tsx mounts `launcherTitleBar`), so
// both look and work the same.
//
// Spark's window has no native frame (decorations off, like dawg), so the
// board's bar is the title bar, and only that: the spark button goes home (back to the
// launcher, src-tauri/src/project.rs), the project's name and every empty bit
// of the bar drag the window (a double-click maximizes), and the window
// buttons sit at the right end, after the update button (updateButton). In a plain browser tab (`npm run fixture`)
// there's no window to drive, so none of this shows.
//
// The calls go straight to Tauri's IPC: this page is the project's dev server
// and doesn't import @tauri-apps/api (the project may not have it). Spark's
// capability for it (`capabilities/project.json`) allows these, and
// borrowTauri (mode.ts) keeps them from the app in the frames.
// The home event's name is in project.rs too (HOME_EVENT).
import { h } from "./fields.ts";
import { THEME } from "./theme.ts";

type Internals = {
  invoke(cmd: string, args?: unknown): Promise<unknown>;
  transformCallback(cb: (response: unknown) => void, once?: boolean): number;
  metadata?: { currentWindow?: { label?: string } };
};

/** What the board's home button emits; project.rs shows the launcher. */
export const HOME_EVENT = "spark://home";

const tauri = (window as unknown as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__;

/** The board is in Spark's window (not a browser tab): it's the title bar. */
export const inSpark = !!tauri && window === window.top;

/** Room the window buttons take at the bar's right end. */
export const WINCTL_W = 3 * 46;
/** The bar's height. */
export const BAR_H = 36;

const label = () => tauri?.metadata?.currentWindow?.label ?? "main";
const win = (cmd: string) => void tauri?.invoke(`plugin:window|${cmd}`, { label: label() }).catch(() => {});

export const TITLE_BAR_STYLE = `
  /* Just the title bar: the board's controls are in its toolbar and panels (shell.ts). */
  .bar {
    position: absolute; top: 0; left: 0; right: 0; height: ${BAR_H}px; z-index: 3;
    display: flex; align-items: center; gap: 6px; padding: 0 10px;
    background: var(--sp-bg); color: var(--sp-text); border-bottom: 1px solid var(--sp-line);
    font: var(--sp-fs-md)/1 var(--sp-font); user-select: none; overflow: hidden;
  }
  .bar button { font: inherit; height: 26px; border: 1px solid transparent; border-radius: var(--sp-r-sm); cursor: pointer; }
  .titled .bar { right: ${WINCTL_W}px; }
  .home {
    display: inline-flex; align-items: center; justify-content: center; flex: none; border-color: transparent; background: transparent;
    color: var(--sp-brand); padding: 0; width: 28px; height: 26px; margin-left: -4px; border-radius: var(--sp-r-sm);
  }
  button.home:hover { background: var(--sp-field); }
  .home svg { width: 15px; height: 15px; fill: currentColor; }
  .project {
    flex: none; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 600; color: var(--sp-text-strong); padding-right: 4px;
  }
  /* Updates: a quiet version tag, or "Restart to update" once one is downloaded (like the launcher's). */
  .upd {
    display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px; border-color: transparent; background: transparent;
    color: var(--sp-text-dim); font: var(--sp-fs-sm)/1 var(--sp-font); white-space: nowrap;
  }
  .upd:hover { background: var(--sp-field); color: var(--sp-text-strong); }
  .upd svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  .upd.busy svg { animation: upd-spin .9s linear infinite; }
  @keyframes upd-spin { to { transform: rotate(360deg); } }
  .upd.ready { background: var(--sp-accent); border-color: var(--sp-accent); color: var(--sp-text-strong); font-weight: 600; }
  .upd.ready:hover { filter: brightness(1.1); background: var(--sp-accent); }
  .upd.bad { color: var(--sp-warn); }
  .winctl {
    position: absolute; top: 0; right: 0; height: var(--sp-panel-top, 36px); display: flex; z-index: 3;
    background: var(--sp-bg); border-bottom: 1px solid var(--sp-line);
  }
  .winctl button {
    width: 46px; height: 100%; border: 0; border-radius: 0; background: transparent; padding: 0;
    display: grid; place-items: center; color: var(--sp-text-dim);
  }
  .winctl button:hover { background: var(--sp-field); color: var(--sp-text-strong); }
  .winctl button.close:hover { background: var(--sp-win-close); color: var(--sp-text-strong); }
  .winctl svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1; }
`;

function glyph(d: string, viewBox = "0 0 10 10"): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  svg.append(p);
  return svg;
}

/** The spark mark: a lightning bolt. */
const MARK = "M9.2 1 3.5 9.2h4l-.8 5.8L12.5 6.8h-4z";

/**
 * Make `bar` the window's title bar: the home button and the project's name
 * at its start, its empty parts dragging the window. Returns the window
 * buttons, to mount next to it (they stay put while the bar scrolls).
 * With no project (the launcher) the mark is just the mark: it's home already.
 */
export function titleBar(bar: HTMLElement, project: string | null): HTMLElement {
  const home = project
    ? h("button", { class: "home", title: "Home: open another project" }, glyph(MARK, "0 0 16 16"))
    : h("span", { class: "home", "data-drag": "", title: "Spark" }, glyph(MARK, "0 0 16 16"));
  if (project) home.addEventListener("click", () => void tauri?.invoke("plugin:event|emit", { event: HOME_EVENT, payload: null }).catch(() => {}));
  const title = project ?? "Home";
  const name = h("span", { class: "project", "data-drag": "", title }, title);
  bar.prepend(home, name);
  for (const el of bar.querySelectorAll(".grow")) el.setAttribute("data-drag", "");
  bar.append(updateButton());

  // Like Tauri's own drag regions: a press drags, a double press maximizes.
  bar.addEventListener("mousedown", (e) => {
    const t = e.target as Element;
    if (e.button !== 0 || (t !== bar && !t.hasAttribute("data-drag"))) return;
    e.preventDefault();
    if (e.detail === 2) win("toggle_maximize");
    else if (e.detail === 1) win("start_dragging");
  });

  const button = (cls: string, title: string, d: string, cmd: string) => {
    const b = h("button", { class: cls, "aria-label": title, title }, glyph(d));
    b.addEventListener("click", () => win(cmd));
    return b;
  };
  return h(
    "div",
    { class: "winctl" },
    button("", "Minimize", "M0 5h10", "minimize"),
    button("", "Maximize", "M.5.5h9v9h-9z", "toggle_maximize"),
    button("close", "Close", "M0 0l10 10M10 0 0 10", "close"),
  );
}

/**
 * The launcher's title bar (src/components/TitleBar.tsx): the same bar, in a
 * shadow root of its own with Spark's theme, and no project in it.
 */
export function launcherTitleBar(): HTMLElement {
  const host = document.createElement("spark-titlebar");
  host.style.cssText = `display: block; position: relative; flex: none; height: ${BAR_H}px;`;
  const root = host.attachShadow({ mode: "open" });
  const bar = h("div", { class: "bar" }, h("span", { class: "grow" }));
  const shell = h("div", { class: inSpark ? "titled" : "" }, bar);
  if (inSpark) shell.append(titleBar(bar, null));
  else bar.prepend(h("span", { class: "project" }, "spark"));
  root.append(h("style", {}, `${THEME}\n:host { all: initial; }\n* { box-sizing: border-box; }\n.grow { flex: 1; min-width: 8px; }\n${TITLE_BAR_STYLE}`), shell);
  // Its buttons never keep focus, as on the board.
  root.addEventListener("click", (e) => (e.composedPath()[0] as Element).closest?.("button")?.blur());
  return host;
}

// ---------------------------------------------------------------------------
// Updates, the same with a project open and in the launcher. The board can't
// use the updater's JS API or call Spark's commands, so both ask through
// events, like the home button (src-tauri/src/update.rs): a check downloads
// quietly and answers with the state, and only a click on "Restart to update"
// installs and relaunches.

type BoardUpdate = {
  enabled: boolean;
  channel: "release" | "dev";
  current: string;
  ready: { version: string; notes: string | null; commit: string | null } | null;
  error: string | null;
};
const emit = (event: string) => tauri!.invoke("plugin:event|emit", { event, payload: null });

/** How often the board checks: "spark dev" updates on every push to dev. */
const CHECK_MS = { release: 60 * 60 * 1000, dev: 10 * 60 * 1000 };

/** "0.0.1-dev.42" → "dev 42", "0.2.0" → "v0.2.0". */
function shortVersion(v: string): string {
  const run = /-dev\.(\d+)$/.exec(v)?.[1];
  return run ? `dev ${run}` : `v${v}`;
}

function updateGlyph(kind: "ok" | "busy" | "ready" | "bad"): SVGSVGElement {
  const d = {
    ok: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM5.3 8.2 7.2 10l3.5-3.8",
    busy: "M8 2a6 6 0 1 0 6 6",
    ready: "M8 2v7.5M5 6.7 8 9.6l3-2.9M2.5 10v3.5h11V10",
    bad: "M8 2 1.5 13.5h13zM8 6.5v3.5M8 11.5v.5",
  }[kind];
  return glyph(d, "0 0 16 16");
}

function updateButton(): HTMLElement {
  const btn = h("button", { class: "upd", style: "display: none" });
  let state: BoardUpdate | null = null;
  let busy = false;
  let error = "";
  let checked = 0;
  let timer = 0;

  function draw() {
    if (!state?.enabled) {
      btn.style.display = "none";
      return;
    }
    btn.style.display = "";
    btn.className = "upd";
    if (state.ready) {
      const r = state.ready;
      btn.classList.add("ready");
      btn.replaceChildren(updateGlyph("ready"), `Restart to update · ${shortVersion(r.version)}`);
      btn.title = [`${state.current} → ${r.version}${r.commit ? ` (${r.commit})` : ""}`, r.notes, "Installs it and restarts Spark."].filter(Boolean).join("\n\n");
    } else if (busy) {
      btn.classList.add("busy");
      btn.replaceChildren(updateGlyph("busy"), "Checking for updates…");
      btn.title = "";
    } else if (error) {
      btn.classList.add("bad");
      btn.replaceChildren(updateGlyph("bad"), "Update check failed");
      btn.title = `${error}\n\nClick to try again.`;
    } else {
      btn.replaceChildren(updateGlyph("ok"), shortVersion(state.current));
      const at = checked ? new Date(checked).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      btn.title = `Spark ${state.current} · up to date${at ? `, checked ${at}` : ""}. Click to check now.`;
    }
  }

  function check() {
    if (busy || state?.ready) return;
    busy = true;
    draw();
    emit("spark://update-check").catch((e) => answer({ ...(state ?? { enabled: true, channel: "release", current: "", ready: null }), error: String(e) }));
  }
  /** Spark's answer to a check (or a failed install). */
  function answer(s: BoardUpdate) {
    state = s;
    error = s.error ?? "";
    busy = false;
    checked = Date.now();
    draw();
    clearTimeout(timer);
    if (s.enabled && !s.ready) timer = window.setTimeout(check, CHECK_MS[s.channel] ?? CHECK_MS.release);
  }

  btn.addEventListener("click", () => {
    if (!state?.ready) return check();
    btn.replaceChildren(updateGlyph("busy"), "Restarting…");
    btn.classList.add("busy");
    void emit("spark://update-install");
  });
  if (typeof tauri?.transformCallback === "function") {
    const handler = tauri.transformCallback((e) => answer((e as { payload: BoardUpdate }).payload));
    tauri
      .invoke("plugin:event|listen", { event: "spark://update-state", target: { kind: "Any" }, handler })
      .then(check, () => {});
  }
  return btn;
}
