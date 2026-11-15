// The window's title bar, when the board is open in Spark's own window.
//
// Spark's window has no native frame (decorations off, like dawg), so the
// board's bar is the title bar, and only that: the spark button goes home (back to the
// launcher, src-tauri/src/project.rs), the project's name and every empty bit
// of the bar drag the window (a double-click maximizes), and the window
// buttons sit at the right end. In a plain browser tab (`npm run fixture`)
// there's no window to drive, so none of this shows.
//
// The calls go straight to Tauri's IPC: this page is the project's dev server
// and doesn't import @tauri-apps/api (the project may not have it). Spark's
// capability for it (`capabilities/project.json`) allows these, and
// borrowTauri (mode.ts) keeps them from the app in the frames.
// The home event's name is in project.rs too (HOME_EVENT).
import { h } from "./fields.ts";

type Internals = {
  invoke(cmd: string, args?: unknown): Promise<unknown>;
  metadata?: { currentWindow?: { label?: string } };
};

/** What the board's home button emits; project.rs shows the launcher. */
export const HOME_EVENT = "spark://home";

const tauri = (window as unknown as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__;

/** The board is in Spark's window (not a browser tab): it's the title bar. */
export const inSpark = !!tauri && window === window.top;

/** Room the window buttons take at the bar's right end. */
export const WINCTL_W = 3 * 46;

const label = () => tauri?.metadata?.currentWindow?.label ?? "main";
const win = (cmd: string) => void tauri?.invoke(`plugin:window|${cmd}`, { label: label() }).catch(() => {});

export const TITLE_BAR_STYLE = `
  /* Just the title bar: the board's controls are in its toolbar and panels (shell.ts). */
  .titled .bar { right: ${WINCTL_W}px; }
  .home {
    display: inline-flex; align-items: center; justify-content: center; border-color: transparent; background: transparent;
    color: #ffd23f; padding: 0; width: 28px; margin-left: -4px;
  }
  .home:hover { background: var(--sp-field); }
  .home svg { width: 15px; height: 15px; fill: currentColor; }
  .project {
    flex: none; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 600; color: var(--sp-text-strong); padding-right: 4px;
  }
  .winctl {
    position: absolute; top: 0; right: 0; height: var(--sp-panel-top, 36px); display: flex; z-index: 3;
    background: var(--sp-bg); border-bottom: 1px solid var(--sp-line);
  }
  .winctl button {
    width: 46px; height: 100%; border: 0; border-radius: 0; background: transparent; padding: 0;
    display: grid; place-items: center; color: var(--sp-text-dim);
  }
  .winctl button:hover { background: var(--sp-field); color: var(--sp-text-strong); }
  .winctl button.close:hover { background: #c42b1c; color: #fff; }
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

/**
 * Make `bar` the window's title bar: the home button and the project's name
 * at its start, its empty parts dragging the window. Returns the window
 * buttons, to mount next to it (they stay put while the bar scrolls).
 */
export function titleBar(bar: HTMLElement, project: string): HTMLElement {
  const home = h("button", { class: "home", title: "Home: open another project" }, glyph("M9.2 1 3.5 9.2h4l-.8 5.8L12.5 6.8h-4z", "0 0 16 16"));
  home.addEventListener("click", () => void tauri?.invoke("plugin:event|emit", { event: HOME_EVENT, payload: null }).catch(() => {}));
  const name = h("span", { class: "project", "data-drag": "", title: project }, project);
  bar.prepend(home, name);
  for (const el of bar.querySelectorAll(".grow")) el.setAttribute("data-drag", "");

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
