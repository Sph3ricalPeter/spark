// The Spark client: runs inside the app being edited, in dev only.
//
// Everything lives in one Shadow DOM so the app's CSS and Spark's never mix.
// No React here on purpose: the app's React and ours would share a page.
//
// Alt+S opens or closes the panel. While "Pick" is on:
// - hover highlights, click selects (the app doesn't see the click),
//   Arrow Up selects the parent, Esc leaves the selection;
// - the selection has handles: drag them to resize (Shift keeps the ratio
//   on a corner, Alt for fine steps);
// - double-click text to edit it in place; Enter or Esc keeps the edit.
// The panel's fields scrub (drag the ↔ grip, Alt fine, Shift ×10), colors
// open token swatches and a picker, keyword properties are dropdowns.
//
// Edits are previewed live and recorded as changes (see changes.ts), which
// the dev server saves to .spark/changes.json.
import {
  allChanges,
  initChanges,
  load,
  record,
  renderInstances,
  revert,
  setCallResolver,
  type Change,
  type ChangeLog,
} from "./changes.ts";
import { authored, matchedRules, tokenRule, tokensUsed } from "./css.ts";
import { closePopover, colorField, colorTokens, h, numberField, selectField, textField, type OnValue } from "./fields.ts";

const PANEL_W = 340;
const ACCENT = "#4f8cff";

// ---------------------------------------------------------------------------
// What a selection knows

type Fiber = {
  return: Fiber | null;
  type: unknown;
  memoizedProps: Record<string, unknown> | null;
};

type Owner = { name: string; call: string | null };

type Field =
  | { prop: string; kind: "number"; step?: number; unit?: string; min?: number }
  | { prop: string; kind: "select"; options: string[] }
  | { prop: string; kind: "color" }
  | { prop: string; kind: "text" }
  | { prop: string; kind: "sides"; step?: number };

/** The properties the panel edits, grouped as they're shown. */
const FIELDS: { group: string; fields: Field[] }[] = [
  {
    group: "Layout",
    fields: [
      { prop: "display", kind: "select", options: ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "contents", "none"] },
      { prop: "flex-direction", kind: "select", options: ["row", "row-reverse", "column", "column-reverse"] },
      { prop: "flex-wrap", kind: "select", options: ["nowrap", "wrap", "wrap-reverse"] },
      { prop: "align-items", kind: "select", options: ["normal", "stretch", "flex-start", "center", "flex-end", "baseline", "start", "end"] },
      {
        prop: "justify-content",
        kind: "select",
        options: ["normal", "flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly", "start", "end"],
      },
      { prop: "gap", kind: "number", min: 0 },
      { prop: "position", kind: "select", options: ["static", "relative", "absolute", "fixed", "sticky"] },
      { prop: "overflow", kind: "select", options: ["visible", "hidden", "auto", "scroll", "clip"] },
    ],
  },
  {
    group: "Size and spacing",
    fields: [
      { prop: "width", kind: "number", min: 0 },
      { prop: "height", kind: "number", min: 0 },
      { prop: "padding", kind: "sides" },
      { prop: "margin", kind: "sides" },
    ],
  },
  {
    group: "Text",
    fields: [
      { prop: "color", kind: "color" },
      { prop: "font-size", kind: "number", min: 0 },
      { prop: "font-weight", kind: "select", options: ["100", "200", "300", "400", "500", "600", "700", "800", "900"] },
      { prop: "line-height", kind: "number", step: 0.1, unit: "", min: 0 },
      { prop: "letter-spacing", kind: "number", step: 0.1 },
      { prop: "text-align", kind: "select", options: ["start", "left", "center", "right", "end", "justify"] },
      { prop: "text-transform", kind: "select", options: ["none", "uppercase", "lowercase", "capitalize"] },
    ],
  },
  {
    group: "Fill and border",
    fields: [
      { prop: "background-color", kind: "color" },
      { prop: "border-width", kind: "number", min: 0 },
      { prop: "border-style", kind: "select", options: ["none", "solid", "dashed", "dotted", "double"] },
      { prop: "border-color", kind: "color" },
      { prop: "border-radius", kind: "number", min: 0 },
      { prop: "opacity", kind: "number", step: 0.01, unit: "", min: 0 },
      { prop: "box-shadow", kind: "text" },
    ],
  },
];

const SIDES = ["top", "right", "bottom", "left"] as const;

function fiberOf(el: Element): Fiber | null {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  return key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null;
}

function componentName(type: unknown): string | null {
  if (typeof type === "function") {
    const fn = type as { displayName?: string; name?: string };
    return fn.displayName || fn.name || null;
  }
  // memo() and forwardRef() wrap the real function.
  if (type && typeof type === "object") {
    const t = type as { displayName?: string; type?: unknown; render?: unknown };
    return t.displayName || componentName(t.type) || componentName(t.render);
  }
  return null;
}

/** The components that rendered this element, innermost first, each with its call site. */
function ownersOf(el: Element): Owner[] {
  const owners: Owner[] = [];
  for (let f = fiberOf(el); f && owners.length < 12; f = f.return) {
    const name = componentName(f.type);
    if (!name) continue;
    const call = f.memoizedProps?.["data-spark-call"];
    owners.push({ name, call: typeof call === "string" ? call : null });
  }
  return owners;
}

/** The line that renders the instance of `comp` this element belongs to. */
function instanceCall(el: Element, comp: string | null): string | null {
  const owners = ownersOf(el);
  return (comp ? owners.find((o) => o.name === comp) : owners[0])?.call ?? null;
}

const skip = (n: Node) => host.contains(n) || (n instanceof Element && n.hasAttribute("data-spark"));

// ---------------------------------------------------------------------------
// Paths

let root = "";
/** Project-relative path of a file Vite reports as absolute. */
function rel(file: string | null): string | null {
  if (!file) return null;
  const clean = file.split("?")[0];
  return root && clean.startsWith(root + "/") ? clean.slice(root.length + 1) : clean;
}

function shortFile(file: string | null): string {
  if (!file) return "inline";
  return (rel(file) ?? file).split("/").slice(-2).join("/");
}

function openInEditor(loc: string) {
  void fetch(`/__open-in-editor?file=${encodeURIComponent(loc)}`);
}


// ---------------------------------------------------------------------------
// Shadow root, overlay and panel

const host = document.createElement("spark-root");
host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
const shadow = host.attachShadow({ mode: "open" });
shadow.append(
  h(
    "style",
    {},
    `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .box { position: fixed; pointer-events: none; display: none; }
    .hover { outline: 1px dashed ${ACCENT}; background: ${ACCENT}14; }
    .selected { outline: 2px solid ${ACCENT}; }
    .tag {
      position: fixed; display: none; pointer-events: none;
      font: 600 11px/1 ui-sans-serif, system-ui, sans-serif;
      background: ${ACCENT}; color: #fff; padding: 3px 6px; border-radius: 3px; white-space: nowrap;
    }
    .panel {
      position: fixed; top: 0; right: 0; bottom: 0; width: ${PANEL_W}px;
      display: none; flex-direction: column; pointer-events: auto;
      background: #16171a; color: #d6d8dc; border-left: 1px solid #2a2c31;
      font: 12px/1.45 ui-sans-serif, system-ui, sans-serif;
    }
    .panel.open { display: flex; }
    header {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      border-bottom: 1px solid #2a2c31; font-weight: 600; color: #fff;
    }
    header .grow { flex: 1; color: #8a8f98; font-weight: 400; }
    button, select, input {
      font: inherit; color: inherit; background: #23252a; border: 1px solid #33363c;
      border-radius: 4px; padding: 3px 8px;
    }
    button { cursor: pointer; }
    button.on { background: ${ACCENT}; border-color: ${ACCENT}; color: #fff; }
    select { width: 100%; padding: 4px 6px; }
    input { width: 100%; font: 11px ui-monospace, monospace; padding: 3px 6px; }
    input:focus, select:focus { outline: 1px solid ${ACCENT}; border-color: ${ACCENT}; }
    input.changed { border-color: #d9a441; }
    input.bad { border-color: #e5534b; }
    .body { flex: 1; overflow: auto; padding: 12px; }
    .footer { border-top: 1px solid #2a2c31; padding: 10px 12px; max-height: 40%; overflow: auto; }
    .empty { color: #8a8f98; }
    h3 { margin: 16px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8a8f98; }
    h3:first-child { margin-top: 0; }
    .title { font: 600 13px ui-monospace, monospace; color: #fff; word-break: break-all; }
    .link { color: #8fb4ff; cursor: pointer; font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
    .link:hover { text-decoration: underline; }
    .row { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
    .row .k { color: #8a8f98; width: 112px; flex: none; }
    .row .v { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
    .hint { color: #8a8f98; font-size: 11px; margin-top: 4px; }
    .owner { padding: 3px 0; }
    .owner b { color: #fff; font-weight: 600; margin-right: 6px; }
    details { margin-top: 12px; }
    summary { cursor: pointer; color: #8a8f98; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    .rule { margin: 6px 0; padding: 6px 8px; background: #1d1f23; border-radius: 4px; }
    .rule .sel { font: 600 11px ui-monospace, monospace; color: #fff; }
    .rule .file { color: #8a8f98; font-size: 11px; }
    .rule pre { margin: 4px 0 0; white-space: pre-wrap; font: 11px/1.5 ui-monospace, monospace; color: #b9bdc5; }
    .change { display: flex; gap: 8px; align-items: flex-start; padding: 5px 0; border-bottom: 1px solid #23252a; }
    .change .what { flex: 1; min-width: 0; }
    .change .lvl { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #d9a441; }
    .change .where { color: #8a8f98; font-size: 11px; word-break: break-all; }
    .change code { font: 11px ui-monospace, monospace; color: #fff; word-break: break-all; }
    .change button { padding: 0 6px; }
    .fab {
      position: fixed; right: 12px; bottom: 12px; pointer-events: auto;
      background: ${ACCENT}; border-color: ${ACCENT}; color: #fff; font-weight: 600;
    }
    .fab.hidden { display: none; }
    .handle {
      position: fixed; width: 8px; height: 8px; margin: -4px 0 0 -4px; display: none;
      background: #fff; border: 1px solid ${ACCENT}; pointer-events: auto;
    }
    .handle[data-dir="n"], .handle[data-dir="s"] { cursor: ns-resize; }
    .handle[data-dir="e"], .handle[data-dir="w"] { cursor: ew-resize; }
    .handle[data-dir="ne"], .handle[data-dir="sw"] { cursor: nesw-resize; }
    .handle[data-dir="nw"], .handle[data-dir="se"] { cursor: nwse-resize; }
    .box.editing { outline: 2px solid #d9a441; }
    .row .field { flex: 1; min-width: 0; }
    .num {
      display: flex; align-items: center; min-width: 0;
      background: #23252a; border: 1px solid #33363c; border-radius: 4px;
    }
    .num:focus-within { border-color: ${ACCENT}; }
    .num.changed, select.changed, input.changed { border-color: #d9a441; }
    .num .grip {
      flex: none; padding: 0 5px; color: #8a8f98; font-size: 10px; cursor: ew-resize; user-select: none;
    }
    .num .grip:hover { color: #fff; }
    .num input { border: none; background: transparent; padding-left: 0; min-width: 0; }
    .num input:focus { outline: none; }
    .quad { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
    .color { display: flex; gap: 6px; position: relative; }
    .swatch {
      width: 22px; height: 22px; padding: 0; flex: none; cursor: pointer;
      border: 1px solid #44474e; border-radius: 4px;
    }
    .swatch.on { outline: 2px solid ${ACCENT}; outline-offset: 1px; }
    .popover {
      position: absolute; top: 28px; right: 0; z-index: 5; width: 236px; padding: 8px;
      background: #1d1f23; border: 1px solid #33363c; border-radius: 6px; box-shadow: 0 8px 24px #0009;
    }
    .pop-title { color: #8a8f98; font-size: 11px; margin: 0 0 6px; }
    .swatches { display: grid; grid-template-columns: repeat(8, 22px); gap: 5px; margin-bottom: 10px; max-height: 160px; overflow: auto; }
    input[type="color"] { width: 100%; height: 28px; padding: 2px; cursor: pointer; }
    .toast { color: #d9a441; font-size: 11px; margin-top: 6px; }
    `,
  ),
);


const hoverBox = h("div", { class: "box hover" });
const selectBox = h("div", { class: "box selected" });
const tagLabel = h("div", { class: "tag" });
const DIRS = ["n", "e", "s", "w", "ne", "nw", "se", "sw"] as const;
type Dir = (typeof DIRS)[number];
const handles = DIRS.map((dir) => h("div", { class: "handle", "data-dir": dir }));
const pickBtn = h("button", { title: "Pick an element (click in the app)" }, "Pick");
const status = h("span", { class: "grow" });
const body = h("div", { class: "body" });
const footer = h("div", { class: "footer" });
const panel = h(
  "div",
  { class: "panel" },
  h("header", {}, "Spark", status, pickBtn, h("button", { title: "Close (Alt+S)", click: () => setOpen(false) }, "×")),
  body,
  footer,
);
panel.addEventListener("click", () => closePopover());
const fab = h("button", { class: "fab", title: "Open Spark (Alt+S)", click: () => setOpen(true) }, "Spark");
shadow.append(hoverBox, selectBox, ...handles, tagLabel, panel, fab);

// Docking: the app gives up room on the right while the panel is open.
const dockStyle = document.createElement("style");
dockStyle.setAttribute("data-spark", "dock");
dockStyle.textContent = `html.spark-docked body { margin-right: ${PANEL_W}px !important; }`;

let open = false;
let picking = false;
let hovered: Element | null = null;
let selected: Element | null = null;
/** The element whose text is being edited in place. */
let editing: HTMLElement | null = null;
let editFrom = "";
/** True while a resize handle is being dragged. */
let resizing = false;
/** What edits apply to: "instance", or the index of a matched rule. */
let target: "instance" | number = "instance";

function setOpen(v: boolean) {
  open = v;
  panel.classList.toggle("open", v);
  fab.classList.toggle("hidden", v);
  document.documentElement.classList.toggle("spark-docked", v);
  setPicking(v);
  if (!v) select(null);
  try {
    localStorage.setItem("spark:open", v ? "1" : "0");
  } catch {
    // Storage may be off; the panel just starts closed next time.
  }
}

function setPicking(v: boolean) {
  picking = v;
  pickBtn.classList.toggle("on", v);
  if (!v) hover(null);
  placeHandles();
}
pickBtn.addEventListener("click", () => setPicking(!picking));

/** The nearest element we know the source of. */
function pickable(node: EventTarget | null): Element | null {
  if (!(node instanceof Element) || host.contains(node)) return null;
  return node.closest("[data-spark-src]");
}

function place(box: HTMLElement, el: Element | null) {
  if (!el || !el.isConnected) {
    box.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  Object.assign(box.style, {
    display: "block",
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
}

function placeHandles() {
  const show = !!selected && selected.isConnected && picking && !editing;
  const r = show ? selected!.getBoundingClientRect() : null;
  for (const el of handles) {
    if (!r) {
      el.style.display = "none";
      continue;
    }
    const dir = el.dataset.dir as Dir;
    const x = dir.includes("w") ? r.left : dir.includes("e") ? r.right : r.left + r.width / 2;
    const y = dir.includes("n") ? r.top : dir.includes("s") ? r.bottom : r.top + r.height / 2;
    Object.assign(el.style, { display: "block", left: `${x}px`, top: `${y}px` });
  }
}

function label(el: Element | null) {
  if (!el) {
    tagLabel.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  const comp = el.getAttribute("data-spark-comp");
  tagLabel.textContent = `${comp ? comp + " · " : ""}${el.tagName.toLowerCase()}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  tagLabel.style.display = "block";
  // Keep it on screen and out from under the panel.
  const maxLeft = window.innerWidth - (open ? PANEL_W : 0) - tagLabel.offsetWidth - 4;
  tagLabel.style.left = `${Math.max(0, Math.min(r.left, maxLeft))}px`;
  tagLabel.style.top = `${r.top > 22 ? r.top - 20 : r.bottom + 4}px`;
}

function hover(el: Element | null) {
  hovered = el;
  place(hoverBox, el);
  label(el ?? selected);
}

function select(el: Element | null) {
  if (editing) stopTextEdit(true);
  if (el !== selected) target = "instance";
  selected = el;
  place(selectBox, el);
  placeHandles();
  label(el);
  render();
  if (el) import.meta.hot?.send("spark:select", snapshot(el));
}

/** The selection as the MCP server will see it. */
function snapshot(el: Element) {
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    classes: Array.from(el.classList),
    src: el.getAttribute("data-spark-src"),
    comp: el.getAttribute("data-spark-comp"),
    owners: ownersOf(el),
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    rules: matchedRules(el, skip).map((m) => ({ selector: m.selector, file: rel(m.file), css: m.rule.style.cssText })),
  };
}

// Keep the boxes on their elements through scrolling, layout and hot reloads,
// and instance previews on elements React re-created.
let frame = 0;
function follow() {
  if (open) {
    place(hoverBox, hovered);
    place(selectBox, selected);
    placeHandles();
    if (resizing && selected) label(selected);
    if (selected && !selected.isConnected) select(null);
  }
  if (++frame % 30 === 0) renderInstances();
  requestAnimationFrame(follow);
}

// ---------------------------------------------------------------------------
// Editing

function elementInfo(el: Element) {
  return {
    src: el.getAttribute("data-spark-src"),
    comp: el.getAttribute("data-spark-comp"),
    tag: el.tagName.toLowerCase(),
    classes: Array.from(el.classList),
  };
}

/** Preview `prop: value` at the current level; `final` saves it and refreshes the panel. */
function edit(el: Element, prop: string, value: string, final: boolean): boolean {
  value = value.trim();
  if (value && !CSS.supports(prop, value)) return false;
  const rules = matchedRules(el, skip);
  const element = elementInfo(el);

  if (target === "instance") {
    const call = instanceCall(el, element.comp);
    const prev = allChanges().find(
      (c) => c.status === "pending" && c.level === "instance" && c.property === prop && c.element.src === element.src && c.instance?.call === call,
    );
    const from = prev?.from ?? authored(el, rules, prop) ?? getComputedStyle(el).getPropertyValue(prop);
    record({
      level: "instance",
      property: prop,
      from,
      to: value || from,
      file: null,
      selector: null,
      element,
      instance: { component: element.comp ?? "?", call },
    });
  } else {
    const ref = rules[target];
    if (!ref) return false;
    const prev = allChanges().find(
      (c) => c.status === "pending" && c.level === "component" && c.property === prop && c.selector === ref.selector && c.file === rel(ref.file),
    );
    const from = prev?.from ?? ref.rule.style.getPropertyValue(prop);
    record({ level: "component", property: prop, from, to: value, file: rel(ref.file), selector: ref.selector, element, instance: null });
  }
  if (final) changed();
  return true;
}

function editToken(el: Element, name: string, value: string, final: boolean): boolean {
  value = value.trim();
  const ref = tokenRule(name, skip);
  if (!ref || !value) return false;
  const prev = allChanges().find((c) => c.status === "pending" && c.level === "token" && c.property === name);
  const from = prev?.from ?? ref.rule.style.getPropertyValue(name).trim();
  record({ level: "token", property: name, from, to: value, file: rel(ref.file), selector: ref.selector, element: elementInfo(el), instance: null });
  if (final) changed();
  return true;
}

function changed() {
  const log: ChangeLog = { version: 1, changes: [...allChanges()] };
  import.meta.hot?.send("spark:changes", log);
  render();
}

// --- Resize handles --------------------------------------------------------

for (const handle of handles) {
  handle.addEventListener("pointerdown", (e) => {
    const p = e as PointerEvent;
    const el = selected;
    if (!el) return;
    p.preventDefault();
    p.stopPropagation();
    handle.setPointerCapture(p.pointerId);
    const dir = handle.dataset.dir as Dir;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // width/height mean the content box unless box-sizing says otherwise.
    const px = (v: string) => parseFloat(v) || 0;
    const extraW = cs.boxSizing === "border-box" ? 0 : px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
    const extraH = cs.boxSizing === "border-box" ? 0 : px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    const w0 = r.width - extraW;
    const h0 = r.height - extraH;
    const x0 = p.clientX;
    const y0 = p.clientY;
    let w = w0;
    let hh = h0;
    resizing = true;

    const move = (ev: PointerEvent) => {
      const k = ev.altKey ? 0.25 : 1;
      let dx = (ev.clientX - x0) * k;
      let dy = (ev.clientY - y0) * k;
      if (dir.includes("w")) dx = -dx;
      if (dir.includes("n")) dy = -dy;
      w = dir.includes("e") || dir.includes("w") ? Math.max(0, Math.round(w0 + dx)) : w0;
      hh = dir.includes("n") || dir.includes("s") ? Math.max(0, Math.round(h0 + dy)) : h0;
      if (ev.shiftKey && dir.length === 2 && w0 > 0 && h0 > 0) hh = Math.round((w / w0) * h0);
      if (w !== w0) edit(el, "width", `${w}px`, false);
      if (hh !== h0) edit(el, "height", `${hh}px`, false);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move as EventListener);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      resizing = false;
      if (w !== w0 || hh !== h0) changed();
    };
    handle.addEventListener("pointermove", move as EventListener);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

// --- Text, edited in place ---------------------------------------------------

/** The element holding the text under the pointer, if it holds only text. */
function textElementAt(x: number, y: number, fallback: Element | null): HTMLElement | null {
  const range = document.caretRangeFromPoint?.(x, y);
  const node = range?.startContainer;
  const el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : fallback;
  if (!el || host.contains(el) || !el.closest("[data-spark-src]")) return null;
  const onlyText = Array.from(el.childNodes).every((n) => n.nodeType === Node.TEXT_NODE) && !!el.textContent?.trim();
  return onlyText ? (el as HTMLElement) : null;
}

function startTextEdit(el: HTMLElement) {
  if (selected !== el) select(el);
  editing = el;
  // Text already changed in Spark keeps its original "from".
  const call = instanceCall(el, el.getAttribute("data-spark-comp"));
  const prev = allChanges().find(
    (c) => c.status === "pending" && c.property === "text" && c.element.src === el.getAttribute("data-spark-src") && c.instance?.call === call,
  );
  editFrom = prev?.from ?? el.textContent ?? "";
  el.setAttribute("contenteditable", "plaintext-only");
  if (el.contentEditable !== "plaintext-only") el.setAttribute("contenteditable", "true");
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
  selectBox.classList.add("editing");
  placeHandles();
}

function stopTextEdit(keep: boolean) {
  const el = editing;
  if (!el) return;
  editing = null;
  el.removeAttribute("contenteditable");
  window.getSelection()?.removeAllRanges();
  selectBox.classList.remove("editing");
  const text = el.textContent ?? "";
  if (!keep) {
    el.textContent = editFrom;
    return;
  }
  const element = elementInfo(el);
  record({
    level: "instance",
    property: "text",
    from: editFrom,
    to: text,
    file: null,
    selector: null,
    element,
    instance: { component: element.comp ?? "?", call: instanceCall(el, element.comp) },
  });
  changed();
  placeHandles();
}

// ---------------------------------------------------------------------------
// The panel's contents

function locLink(loc: string | null) {
  if (!loc) return h("span", { class: "empty" }, "unknown");
  return h("span", { class: "link", title: "Open in editor", click: () => openInEditor(loc) }, loc);
}

function row(name: string, field: HTMLElement) {
  return h("div", { class: "row" }, h("span", { class: "k", title: name }, name), h("div", { class: "field" }, field));
}

function render() {
  renderChanges();
  closePopover();
  body.replaceChildren();
  if (!selected) {
    body.append(
      h(
        "div",
        { class: "empty" },
        "Click an element in the app to select it. Drag its handles to resize, double-click text to edit it, Arrow Up for the parent, Esc to leave.",
      ),
    );
    return;
  }
  const el = selected;
  const rules = matchedRules(el, skip);
  const owners = ownersOf(el);
  const comp = el.getAttribute("data-spark-comp");
  const call = instanceCall(el, comp);
  const classes = Array.from(el.classList);
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const pending = allChanges().filter((c) => c.status === "pending");
  const colors = colorTokens(skip);

  // Element
  body.append(
    h("div", { class: "title" }, `<${el.tagName.toLowerCase()}${classes.length ? "." + classes.join(".") : ""}>`),
    h("div", { class: "row" }, h("span", { class: "k" }, "Written in"), locLink(el.getAttribute("data-spark-src"))),
    h("div", { class: "row" }, h("span", { class: "k" }, "Size"), h("span", { class: "v" }, `${Math.round(r.width)} × ${Math.round(r.height)}`)),
  );

  // Where edits go
  const sel = h("select", {}) as HTMLSelectElement;
  sel.append(h("option", { value: "instance", selected: target === "instance" }, `This ${comp ?? "element"} only${call ? ` (${call})` : ""}`));
  // Most specific-looking first: later rules win ties.
  [...rules.entries()].reverse().forEach(([i, m]) =>
    sel.append(h("option", { value: String(i), selected: target === i }, `Every match of ${m.selector}  · ${shortFile(m.file)}`)),
  );
  sel.addEventListener("change", () => {
    target = sel.value === "instance" ? "instance" : Number(sel.value);
    render();
  });
  body.append(
    h("h3", {}, "Apply edits to"),
    sel,
    h("div", { class: "hint" }, target === "instance" ? "Changes this one instance, at the line that renders it." : "Changes the CSS rule, so every element it matches."),
  );

  /** What a field shows: the pending edit, else the source's value (instance: falling back to computed). */
  const valueOf = (prop: string): { value: string; changed: boolean } => {
    if (target === "instance") {
      const c = pending.find((x) => x.level === "instance" && x.property === prop && x.element.src === el.getAttribute("data-spark-src") && x.instance?.call === call);
      // Computed lengths come with long fractions (108.641px); two decimals is plenty.
      const computed = cs.getPropertyValue(prop).replace(/(\.\d\d)\d+/g, "$1");
      return { value: c?.to ?? authored(el, rules, prop) ?? computed, changed: !!c };
    }
    const ref = rules[target];
    const c = pending.find((x) => x.level === "component" && x.property === prop && x.selector === ref?.selector && x.file === rel(ref?.file ?? null));
    return { value: ref?.rule.style.getPropertyValue(prop) ?? "", changed: !!c };
  };
  const onValue = (prop: string): OnValue => (v, final) => {
    edit(el, prop, v, final);
  };

  for (const { group, fields } of FIELDS) {
    body.append(h("h3", {}, group));
    for (const f of fields) {
      if (f.kind === "sides") {
        const quad = h("div", { class: "quad" });
        for (const side of SIDES) {
          const prop = `${f.prop}-${side}`;
          const { value, changed } = valueOf(prop);
          quad.append(numberField(value, { computed: cs.getPropertyValue(prop), label: side[0].toUpperCase(), changed, min: f.prop === "padding" ? 0 : undefined }, onValue(prop)));
        }
        body.append(row(f.prop, quad));
        continue;
      }
      const { value, changed } = valueOf(f.prop);
      const computed = cs.getPropertyValue(f.prop);
      let field: HTMLElement;
      if (f.kind === "number") field = numberField(value, { computed, step: f.step, unit: f.unit, min: f.min, changed }, onValue(f.prop));
      else if (f.kind === "select") field = selectField(value || computed, f.options, changed, onValue(f.prop));
      else if (f.kind === "color") field = colorField(value, computed, colors, changed, onValue(f.prop));
      else field = textField(value, changed, onValue(f.prop));
      body.append(row(f.prop, field));
    }
  }

  // Tokens this element uses
  const tokens = tokensUsed(el, rules);
  if (tokens.length) {
    body.append(h("h3", {}, "Tokens"), h("div", { class: "hint" }, "Changing a token changes everything that uses it."));
    const rootCs = getComputedStyle(document.documentElement);
    for (const t of tokens) {
      const c = pending.find((x) => x.level === "token" && x.property === t);
      const value = c?.to ?? rootCs.getPropertyValue(t).trim();
      const onToken: OnValue = (v, final) => {
        editToken(el, t, v, final);
      };
      const isColor = CSS.supports("color", value) && !/^-?\d/.test(value);
      const isNum = /^-?\d*\.?\d+[a-z%]*$/i.test(value);
      const field = isColor
        ? colorField(value, value, colors.filter((x) => x.name !== t), !!c, onToken)
        : isNum
          ? numberField(value, { computed: value, unit: value.replace(/^-?\d*\.?\d+/, ""), changed: !!c, step: /^-?\d*\.\d/.test(value) ? 0.1 : 1 }, onToken)
          : textField(value, !!c, onToken);
      body.append(row(t, field));
    }
  }

  // Context
  const instances = h("details", {}, h("summary", {}, "Component instances"));
  if (owners.length === 0) instances.append(h("div", { class: "empty" }, "No React components found above this element."));
  for (const o of owners) {
    instances.append(h("div", { class: "owner" }, h("b", {}, o.name), o.call ? locLink(o.call) : h("span", { class: "empty" }, "root")));
  }
  const matched = h("details", {}, h("summary", {}, `Matched rules (${rules.length})`));
  for (const m of [...rules].reverse()) {
    matched.append(
      h("div", { class: "rule" }, h("div", { class: "sel" }, m.selector), h("div", { class: "file" }, shortFile(m.file)), h("pre", {}, m.rule.style.cssText.split("; ").join(";\n"))),
    );
  }
  body.append(instances, matched);
}

function describeChange(c: Change): string {
  if (c.level === "token") return `${c.file ?? "?"}`;
  if (c.level === "component") return `${c.selector} · ${c.file ?? "?"}`;
  return `${c.instance?.component ?? "?"} at ${c.instance?.call ?? c.element.src ?? "?"}`;
}

function renderChanges() {
  const pending = allChanges().filter((c) => c.status === "pending");
  footer.replaceChildren(h("h3", {}, `Changes (${pending.length})`));
  if (pending.length === 0) {
    footer.append(h("div", { class: "empty" }, "Edits you make show up here."));
    return;
  }
  for (const c of pending) {
    const what = c.property === "text" ? `text: "${c.from}" → "${c.to}"` : `${c.property}: ${c.from || "unset"} → ${c.to}`;
    footer.append(
      h(
        "div",
        { class: "change" },
        h("div", { class: "what" }, h("div", { class: "lvl" }, c.level), h("code", {}, what), h("div", { class: "where" }, describeChange(c))),
        h(
          "button",
          {
            title: "Revert",
            click: () => {
              revert(c.id);
              changed();
            },
          },
          "↺",
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Events. Capture phase, so picking happens before the app sees anything.

const swallow = (e: Event) => {
  if (editing && e.target instanceof Node && editing.contains(e.target)) return false;
  if (!picking || !pickable(e.target)) return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
};

document.addEventListener("pointermove", (e) => picking && !resizing && hover(pickable(e.target)), true);
document.addEventListener("pointerdown", swallow, true);
document.addEventListener("mousedown", swallow, true);
document.addEventListener("pointerup", swallow, true);
document.addEventListener("mouseup", swallow, true);
document.addEventListener(
  "click",
  (e) => {
    if (editing && e.target instanceof Node && editing.contains(e.target)) return;
    if (swallow(e)) select(pickable(e.target));
  },
  true,
);
document.addEventListener(
  "dblclick",
  (e) => {
    if (editing && e.target instanceof Node && editing.contains(e.target)) return;
    if (!swallow(e)) return;
    const me = e as MouseEvent;
    const el = textElementAt(me.clientX, me.clientY, pickable(e.target));
    if (el) startTextEdit(el);
  },
  true,
);

const keepFromApp = (e: Event) => {
  if (editing) e.stopPropagation();
};
document.addEventListener("keyup", keepFromApp, true);
document.addEventListener("keypress", keepFromApp, true);
document.addEventListener(
  "keydown",
  (e) => {
    if (editing) {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        stopTextEdit(true);
      }
      return;
    }
    if (e.altKey && e.code === "KeyS") {
      e.preventDefault();
      setOpen(!open);
      return;
    }
    // Typing in the panel: its fields handle their own keys.
    if (!open || e.composedPath().includes(host)) return;
    if (e.key === "Escape") {
      if (closePopover()) return;
      if (selected) {
        e.preventDefault();
        select(null);
      }
    } else if (e.key === "ArrowUp" && picking && selected) {
      const parent = selected.parentElement?.closest("[data-spark-src]");
      if (parent) {
        e.preventDefault();
        select(parent);
      }
    }
  },
  true,
);
// The panel's own keys never reach the app.
shadow.addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Escape") {
    (shadow.activeElement as HTMLElement | null)?.blur();
    closePopover();
  }
});

// ---------------------------------------------------------------------------
// Start

document.head.append(dockStyle);
document.documentElement.append(host);
initChanges(skip);
setCallResolver(instanceCall);
render();
let reopen = false;
try {
  reopen = localStorage.getItem("spark:open") === "1";
} catch {
  // Storage may be off.
}
if (reopen) setOpen(true);
requestAnimationFrame(follow);

import.meta.hot?.on("spark:ready", (info: { name: string; root: string; changes: ChangeLog | null }) => {
  root = info.root;
  status.textContent = info.name;
  if (info.changes) load(info.changes.changes);
  render();
});
import.meta.hot?.send("spark:hello", {});
