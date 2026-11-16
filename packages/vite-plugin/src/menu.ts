// Spark's right-click menus, Figma style, and no browser menu anywhere else.
//
// The browser's (WebView2's) own context menu never shows in Spark: not on
// the board, not in its frames, not in the panel. Only where it still helps,
// in text you type into or text you selected, does it stay (cut, copy, paste,
// spelling). `blockNativeMenu` does that for a window; it listens last
// (bubble phase on the window), so an app's own right-click menu still works
// in view mode.
//
// `openMenu` shows Spark's menu at a point of a document: on the board always
// the board's own (the shell), so a menu opened in a small zoomed frame is
// drawn at screen size over the canvas, never clipped by its frame. One menu
// is open at a time, whichever frame opened it (the state lives on the
// document, not in a module: each frame has its own copy of this one).
// Arrow keys move, Enter picks, Esc or a click outside closes; a right-click
// outside opens the menu of what's there instead.
import { THEME } from "./theme.ts";

export type MenuItem = {
  label: string;
  /** Said dimmer on the right: the shortcut. */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
};
/** "-" is a separator; null and false are left out (for `cond && item`). */
export type MenuEntry = MenuItem | "-" | null | false | undefined;

const STYLE = `${THEME}
  :host { all: initial; }
  .backdrop { position: fixed; inset: 0; z-index: 2147483646; }
  .menu {
    position: fixed; z-index: 2147483647; min-width: 200px; max-width: 320px; padding: 4px; box-sizing: border-box;
    background: var(--sp-bg); color: var(--sp-text); border: 1px solid var(--sp-line-strong); border-radius: var(--sp-r-lg);
    box-shadow: 0 8px 28px #000a; font: var(--sp-fs-md)/1 var(--sp-font); user-select: none; outline: none;
  }
  .item {
    display: flex; align-items: center; gap: 16px; width: 100%; height: 26px; padding: 0 10px; box-sizing: border-box; border: none;
    border-radius: var(--sp-r-sm); background: none; color: inherit; font: inherit; text-align: left; white-space: nowrap; cursor: default;
  }
  .item .label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .item .hint { flex: none; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
  .item.active { background: var(--sp-accent); color: var(--sp-text-strong); }
  .item.active .hint { color: #ffffffbb; }
  .item.danger.active { background: var(--sp-danger); }
  .item:disabled { color: var(--sp-text-dim); opacity: .55; }
  .sep { height: 1px; margin: 4px 6px; background: var(--sp-line-strong); }
`;

type Open = { close(): void };
const OPEN = "__sparkMenu";
type MenuDoc = Document & { [OPEN]?: Open };

/** Close the open menu in `doc` (the board's, on the board), if any. */
export function closeMenu(doc: Document = document) {
  (doc as MenuDoc)[OPEN]?.close();
}

/** Is a menu open in `doc`? */
export function menuOpen(doc: Document = document) {
  return !!(doc as MenuDoc)[OPEN];
}

/**
 * Show a menu at (x, y), in `doc`'s viewport coordinates. Empty groups and
 * doubled separators fold away; with nothing to show, nothing opens.
 */
export function openMenu(x: number, y: number, entries: MenuEntry[], doc: Document = document) {
  closeMenu(doc);
  // Separators only between items.
  const list: (MenuItem | "-")[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (e === "-" && (!list.length || list.at(-1) === "-")) continue;
    list.push(e);
  }
  while (list.at(-1) === "-") list.pop();
  if (!list.length) return;

  const win = doc.defaultView ?? window;
  const host = doc.createElement("spark-menu");
  host.setAttribute("data-spark", "menu");
  const root = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = STYLE;
  const backdrop = doc.createElement("div");
  backdrop.className = "backdrop";
  const menu = doc.createElement("div");
  menu.className = "menu";
  menu.tabIndex = -1;
  menu.setAttribute("role", "menu");
  root.append(style, backdrop, menu);

  const items: { el: HTMLButtonElement; item: MenuItem }[] = [];
  let active = -1;
  const setActive = (i: number) => {
    if (items[active]) items[active].el.classList.remove("active");
    active = i;
    if (items[active]) items[active].el.classList.add("active");
  };
  const pick = (item: MenuItem) => {
    if (item.disabled) return;
    close();
    item.run();
  };
  for (const it of list) {
    if (it === "-") {
      const sep = doc.createElement("div");
      sep.className = "sep";
      menu.append(sep);
      continue;
    }
    const b = doc.createElement("button");
    b.type = "button";
    b.className = `item${it.danger ? " danger" : ""}`;
    b.disabled = !!it.disabled;
    b.setAttribute("role", "menuitem");
    const label = doc.createElement("span");
    label.className = "label";
    label.textContent = it.label;
    b.append(label);
    if (it.hint) {
      const hint = doc.createElement("span");
      hint.className = "hint";
      hint.textContent = it.hint;
      b.append(hint);
    }
    const i = items.length;
    items.push({ el: b, item: it });
    b.addEventListener("pointerenter", () => setActive(it.disabled ? -1 : i));
    b.addEventListener("pointerleave", () => active === i && setActive(-1));
    // Picks on release, so a press-drag-release from the right-click works like a native menu.
    b.addEventListener("pointerup", (e) => e.button !== 1 && pick(it));
    menu.append(b);
  }

  const onKey = (e: KeyboardEvent) => {
    const enabled = items.map((x, i) => (x.item.disabled ? -1 : i)).filter((i) => i >= 0);
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!enabled.length) return;
      const at = enabled.indexOf(active);
      const next = e.key === "ArrowDown" ? enabled[(at + 1) % enabled.length] : enabled[(at <= 0 ? enabled.length : at) - 1];
      setActive(next);
    } else if (e.key === "Enter" || e.key === " ") {
      if (items[active]) pick(items[active].item);
    } else if (e.key !== "Tab") return;
    // The menu has the keys while it's open: none reach the board, a frame or the app.
    e.preventDefault();
    e.stopPropagation();
  };
  // A press outside closes (and does nothing else, like Figma); a right-click opens what's there.
  backdrop.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (e.button !== 2) close();
  });
  backdrop.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    close();
    reopenAt(doc, e.clientX, e.clientY);
  });
  backdrop.addEventListener("wheel", () => close(), { passive: true });
  menu.addEventListener("contextmenu", (e) => e.preventDefault());

  function close() {
    if ((doc as MenuDoc)[OPEN] !== state) return;
    delete (doc as MenuDoc)[OPEN];
    host.remove();
    win.removeEventListener("keydown", onKey, true);
    win.removeEventListener("blur", close);
    win.removeEventListener("resize", close);
  }
  const state: Open = { close };
  (doc as MenuDoc)[OPEN] = state;
  win.addEventListener("keydown", onKey, true);
  win.addEventListener("blur", close);
  win.addEventListener("resize", close);
  doc.documentElement.append(host);

  // Inside the window: flip left or up at the edges, like a native menu.
  const r = menu.getBoundingClientRect();
  const vw = doc.documentElement.clientWidth;
  const vh = doc.documentElement.clientHeight;
  const left = x + r.width > vw - 4 ? Math.max(4, x - r.width) : x;
  const top = y + r.height > vh - 4 ? Math.max(4, Math.min(y - r.height, vh - 4 - r.height)) : y;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  // Keys go to the menu, not to the frame the right-click was in.
  menu.focus({ preventScroll: true });
}

/**
 * The element at a point, through shadow roots and into same-origin frames
 * (which may be zoomed on the board); with the point in that element's own
 * window.
 */
function deepAt(doc: Document, x: number, y: number): { el: Element; x: number; y: number } | null {
  let el: Element | null = doc.elementFromPoint(x, y);
  while (el?.shadowRoot) {
    const inner: Element | null = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (!el) return null;
  if (el instanceof HTMLIFrameElement) {
    try {
      const inner = el.contentDocument;
      if (inner) {
        const r = el.getBoundingClientRect();
        const z = el.offsetWidth ? r.width / el.offsetWidth : 1;
        return deepAt(inner, (x - r.left) / z, (y - r.top) / z) ?? { el, x, y };
      }
    } catch {
      // Off-origin frame.
    }
  }
  return { el, x, y };
}

/** A right-click on the backdrop of an open menu: open the menu of what's under it. */
function reopenAt(doc: Document, x: number, y: number) {
  const at = deepAt(doc, x, y);
  if (!at) return;
  const view = at.el.ownerDocument.defaultView;
  const Ev = (view as (Window & typeof globalThis) | null)?.MouseEvent ?? MouseEvent;
  for (const type of ["pointerdown", "mousedown"] as const) {
    at.el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, composed: true, button: 2, buttons: 2, clientX: at.x, clientY: at.y }));
  }
  at.el.dispatchEvent(new Ev("contextmenu", { bubbles: true, cancelable: true, composed: true, button: 2, clientX: at.x, clientY: at.y }));
}

/** Text you type into, where the native menu (cut, copy, paste, spelling) still helps. */
export function isTextEntry(t: EventTarget | null | undefined): boolean {
  if (!(t instanceof Element) && !(t && typeof (t as Element).tagName === "string")) return false;
  const el = t as HTMLElement;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return !/^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/.test((el as HTMLInputElement).type);
}

/** Is the right-click on text that's selected (Copy is still worth having there)? */
function onSelectedText(e: MouseEvent): boolean {
  const t = e.composedPath()[0];
  if (!(t instanceof Node) && !(t && typeof (t as Node).nodeType === "number")) return false;
  const node = t as Node;
  const root = node.getRootNode() as (ShadowRoot & { getSelection?: () => Selection | null }) | Document;
  const sel = ("getSelection" in root && root.getSelection?.()) || node.ownerDocument?.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  return sel.containsNode(node, true);
}

/** Would the native menu help here (a text field, selected text)? */
export function nativeMenuHelps(e: MouseEvent): boolean {
  return isTextEntry(e.composedPath()[0]) || onSelectedText(e);
}

const NO_DROPS = "__sparkNoFileDrops";

/**
 * A file dropped anywhere that isn't a drop zone (the chat box is one) would
 * open in place of the page, since Spark's window leaves drops to the page
 * (tauri.conf.json `dragDropEnabled: false`). Drop zones, Spark's or the
 * app's, prevent the default themselves; everywhere else nothing happens.
 */
export function blockFileDrops(win: Window) {
  const w = win as Window & { [NO_DROPS]?: boolean };
  if (w[NO_DROPS]) return;
  w[NO_DROPS] = true;
  const files = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  w.addEventListener("dragover", (e) => {
    if (e.defaultPrevented || !files(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  });
  w.addEventListener("drop", (e) => {
    if (!e.defaultPrevented && files(e)) e.preventDefault();
  });
}

const BLOCKED = "__sparkNoNativeMenu";

/** No browser context menu in `win`, except in text fields and on selected text. Once per window. */
export function blockNativeMenu(win: Window) {
  const w = win as Window & { [BLOCKED]?: boolean };
  if (w[BLOCKED]) return;
  w[BLOCKED] = true;
  w.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented || nativeMenuHelps(e)) return;
    e.preventDefault();
  });
}
