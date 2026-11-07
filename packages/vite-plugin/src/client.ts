// The Spark client: runs inside the app being edited, in dev only.
//
// Everything lives in one Shadow DOM so the app's CSS and Spark's never mix.
// No React here on purpose: the app's React and ours would share a page.
//
// Alt+S opens or closes the panel. View mode (the default) leaves the app
// alone. Edit mode (the Edit toggle, Tab, or Alt+E):
// - hover highlights, click selects (the app doesn't see the click),
//   Arrow Up selects the parent; Esc steps out one level at a time
//   (popover, text edit, selection), and from nothing selected back to view;
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
  applyTo,
  applyToRule,
  coveredElements,
  overridesOn,
  pathFor,
  renderOverrides,
  restore,
  revert,
  snapshot as snapshotChanges,
  type Change,
  type ChangeLog,
  type PathEntry,
} from "./changes.ts";
import { authored, matchedRules, tokenRule, tokensUsed } from "./css.ts";
import { closePopover, colorField, colorTokens, h, numberField, selectField, textField, type OnValue } from "./fields.ts";
import { frameGlue } from "./frame.ts";
import { shell } from "./mode.ts";
import { installReorder } from "./reorder.ts";
import { renderVariables, resolvedLine, VARIABLES_STYLE, type Variable } from "./variables.ts";

const PANEL_W = 340;
const ACCENT = "#4f8cff";

// ---------------------------------------------------------------------------
// What a selection knows

type Fiber = {
  return: Fiber | null;
  key: string | null;
  type: unknown;
  memoizedProps: Record<string, unknown> | null;
};

type Owner = PathEntry;

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
    owners.push({ name, call: typeof call === "string" ? call : null, key: f.key ?? null });
  }
  return owners;
}

/** The element's owners from the component it's written in up to the root.
 * (Owners further in are only where it was passed as children, not its own.) */
function instancePath(el: Element): PathEntry[] {
  const owners = ownersOf(el);
  const comp = el.getAttribute("data-spark-comp");
  const i = comp ? owners.findIndex((o) => o.name === comp) : 0;
  return i < 0 ? owners : owners.slice(i);
}

/** What an override's scope means, in words (stored with the change for whoever applies it). */
function scopeWords(path: PathEntry[], scope: number | null): string {
  const comp = path[0]?.name ?? "?";
  const at = (e: PathEntry) => `${e.name}${e.key !== null ? ` (key ${e.key})` : ""} at ${e.call ?? "root"}`;
  if (scope === null) return `only this instance: ${path.map(at).join(", inside ")}`;
  if (scope === 0) return `the ${comp} component itself: every ${comp} everywhere`;
  const via = path.slice(0, scope).map((e) => e.call ?? "?").join(" → ");
  return `in ${path[scope].name}: every ${comp} it renders through ${via}`;
}

/** The choices for where an override lives, narrowest first. */
function scopeChoices(path: PathEntry[]): { scope: number | null; label: string }[] {
  const comp = path[0]?.name ?? "?";
  const out: { scope: number | null; label: string }[] = [{ scope: null, label: "Only this instance" }];
  for (let k = path.length - 1; k >= 1; k--) out.push({ scope: k, label: `Apply to ${path[k].name} (every ${comp} it renders here)` });
  out.push({ scope: 0, label: `Apply to ${comp} (original: every ${comp})` });
  return out;
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
const STYLE = `
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
    .seg { display: inline-flex; }
    .grow { flex: 1; }
    .changes-head { display: flex; align-items: center; gap: 8px; }
    .changes-head h3 { margin: 0; }
    button:disabled { opacity: 0.5; cursor: default; }
    .run { display: none; padding: 10px 12px; border-top: 1px solid #2a2c31; }
    .run-head { display: flex; align-items: center; gap: 8px; color: #fff; font-weight: 600; }
    .run-sum { margin-top: 6px; white-space: pre-wrap; }
    .run-err { margin-top: 6px; color: #ff8a80; white-space: pre-wrap; }
    .run-log { margin-top: 6px; color: #8a8f98; font-family: ui-monospace, monospace; font-size: 11px; }
    .run-log div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .spin {
      width: 10px; height: 10px; border-radius: 50%; border: 2px solid #33363c; border-top-color: ${ACCENT};
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .ask {
      position: fixed; display: none; width: 300px; pointer-events: auto; padding: 8px;
      background: #1b1c20; border: 1px solid #33363c; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.4);
      color: #d6d8dc; font: 12px/1.4 system-ui, sans-serif;
    }
    .ask input { width: 100%; box-sizing: border-box; padding: 6px 8px; }
    .ask-row { display: flex; gap: 6px; margin-top: 6px; }
    .seg button { border-radius: 0; }
    .seg button:first-child { border-radius: 4px 0 0 4px; }
    .seg button:last-child { border-radius: 0 4px 4px 0; border-left: none; }
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
    .change .where { color: #8a8f98; font-size: 11px; word-break: break-word; margin-bottom: 4px; }
    .change.here { background: ${ACCENT}14; margin: 0 -12px; padding: 5px 12px; }
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
    .row .k .link { font-size: inherit; }
    ${VARIABLES_STYLE}`;
shadow.append(h("style", {}, STYLE));


const hoverBox = h("div", { class: "box hover" });
const selectBox = h("div", { class: "box selected" });
const tagLabel = h("div", { class: "tag" });
const DIRS = ["n", "e", "s", "w", "ne", "nw", "se", "sw"] as const;
type Dir = (typeof DIRS)[number];
const handles = DIRS.map((dir) => h("div", { class: "handle", "data-dir": dir }));
// View: the app works as normal. Edit: hover highlights, clicks select (Tab or Alt+E).
const viewBtn = h("button", { title: "Use the app normally (Esc out of everything)" }, "View");
const editBtn = h("button", { title: "Select and edit elements (Tab or Alt+E)" }, "Edit");
const modeToggle = h("span", { class: "seg" }, viewBtn, editBtn);
const status = h("span", { class: "grow" });
const body = h("div", { class: "body" });
const footer = h("div", { class: "footer" });
/** Claude's current or last run: progress, then its summary. */
const runBox = h("div", { class: "run" });
/** What the body shows: the selection's inspector, or the app's variables. */
type View = "inspect" | "variables";
let view: View = "inspect";
const tabs = { inspect: h("button", { class: "on", click: () => setView("inspect") }, "Inspect"), variables: h("button", { click: () => setView("variables") }, "Variables") };
const panel = h(
  "div",
  { class: "panel" },
  h("header", {}, "Spark", status, modeToggle, h("button", { title: "Close (Alt+S)", click: () => setOpen(false) }, "×")),
  h("nav", { class: "tabs" }, tabs.inspect, tabs.variables),
  body,
  runBox,
  footer,
);
panel.addEventListener("click", () => closePopover());
const fab = h("button", { class: "fab", title: "Open Spark (Alt+S)", click: () => setOpen(true) }, "Spark");
// Ask Claude, right on the selection.
const askInput = h("input", { placeholder: "Ask Claude about this…" }) as HTMLInputElement;
const stopKeys = (e: Event) => e.stopPropagation();
askInput.addEventListener("keyup", stopKeys);
askInput.addEventListener("keypress", stopKeys);
askInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    sendAsk();
  } else if (e.key === "Escape") askInput.blur();
});
const askBox = h(
  "div",
  { class: "ask" },
  askInput,
  h(
    "div",
    { class: "ask-row" },
    h(
      "button",
      {
        title: "Have Claude extract the selection into its own component",
        click: () => {
          askInput.value = "Extract this into its own component called ";
          askInput.focus();
        },
      },
      "Make component",
    ),
    h("span", { class: "grow" }),
    h("button", { class: "on", click: () => sendAsk() }, "Ask"),
  ),
);
shadow.append(hoverBox, selectBox, ...handles, tagLabel, askBox);
// In the viewport shell the panel lives outside the zoomed frame (mode.ts).
const panelHost = shell ? document.createElement("spark-panel") : host;
const panelRoot = shell ? panelHost.attachShadow({ mode: "open" }) : shadow;
if (shell) {
  panelHost.style.cssText = host.style.cssText;
  panelRoot.append(h("style", {}, STYLE));
}
panelRoot.append(panel, fab);

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

function setOpen(v: boolean) {
  open = v;
  panel.classList.toggle("open", v);
  fab.classList.toggle("hidden", v);
  if (shell) shell.setDocked(v);
  else document.documentElement.classList.toggle("spark-docked", v);
  if (!v) {
    select(null);
    setPicking(false);
  }
  try {
    localStorage.setItem("spark:open", v ? "1" : "0");
  } catch {
    // Storage may be off; the panel just starts closed next time.
  }
}

/** Edit mode (true) or view mode (false). Entering edit mode opens the panel; view mode drops the selection. */
function setPicking(v: boolean) {
  picking = v;
  editBtn.classList.toggle("on", v);
  viewBtn.classList.toggle("on", !v);
  if (v && !open) setOpen(true);
  if (!v) {
    hover(null);
    if (selected) select(null);
  }
  placeHandles();
  render();
  shell?.setMode(v, setPicking);
}
viewBtn.addEventListener("click", () => setPicking(false));
editBtn.addEventListener("click", () => setPicking(true));

/** One step out on Esc: popover, then selection, then edit mode. True when something closed. */
function escapeStep(): boolean {
  if (closePopover()) return true;
  if (selected) {
    select(null);
    return true;
  }
  if (picking) {
    setPicking(false);
    return true;
  }
  return false;
}

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
  const maxLeft = window.innerWidth - (open && !shell ? PANEL_W : 0) - tagLabel.offsetWidth - 4;
  tagLabel.style.left = `${Math.max(0, Math.min(r.left, maxLeft))}px`;
  tagLabel.style.top = `${r.top > 22 ? r.top - 20 : r.bottom + 4}px`;
}

function hover(el: Element | null) {
  hovered = el;
  place(hoverBox, el);
  label(el ?? selected);
}

function setView(v: View) {
  if (view === v) return;
  view = v;
  tabs.inspect.classList.toggle("on", v === "inspect");
  tabs.variables.classList.toggle("on", v === "variables");
  body.scrollTop = 0;
  render();
}

/** Show a variable in the Variables view. */
function jumpToVariable(name: string) {
  setView("variables");
  const row = body.querySelector(`[data-var="${CSS.escape(name)}"]`) as HTMLElement | null;
  if (!row) return;
  row.scrollIntoView({ block: "center" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 900);
}

function select(el: Element | null) {
  if (editing) stopTextEdit(true);
  if (el) view = "inspect";
  tabs.inspect.classList.toggle("on", view === "inspect");
  tabs.variables.classList.toggle("on", view === "variables");
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
    label(hovered ?? selected);
    if (selected && !selected.isConnected) select(null);
  }
  placeAsk();
  if (++frame % 30 === 0) renderOverrides();
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

/** Preview `prop: value` as an override on exactly this instance; `final` saves it and refreshes the panel. */
function edit(el: Element, prop: string, value: string, final: boolean): boolean {
  value = value.trim();
  if (value && !CSS.supports(prop, value)) return false;
  const element = elementInfo(el);
  const path = instancePath(el);
  // Like a prefab: editing an instance adds an override on it, on top of anything applied upstream.
  const mine = overridesOn(el).filter((c) => c.property === prop);
  const existing = mine.filter((c) => (c.instance?.scope ?? null) === null).at(-1);
  if (existing) {
    record({ ...existing, to: value || existing.from });
  } else {
    const upstream = mine.at(-1);
    const from = upstream?.to ?? authored(el, matchedRules(el, skip), prop) ?? getComputedStyle(el).getPropertyValue(prop);
    record({
      level: "instance",
      property: prop,
      from,
      to: value || from,
      file: null,
      selector: null,
      element,
      instance: { component: path[0]?.name ?? element.comp ?? "?", call: path[0]?.call ?? null, path, scope: null, appliesTo: scopeWords(path, null) },
    });
  }
  if (final) changed();
  return true;
}

/** Edit a variable where it's defined. `el` is the selection the edit was made from, if any. */
function editToken(el: Element | null, name: string, value: string, final: boolean): boolean {
  value = value.trim();
  const ref = tokenRule(name, skip);
  if (!ref || !value) return false;
  const prev = allChanges().find((c) => c.status === "pending" && c.level === "token" && c.property === name);
  const from = prev?.from ?? ref.rule.style.getPropertyValue(name).trim();
  const element = el ? elementInfo(el) : { src: null, comp: null, tag: "", classes: [] };
  record({ level: "token", property: name, from, to: value, file: rel(ref.file), selector: ref.selector, element, instance: null });
  if (final) changed();
  return true;
}

function changed() {
  remember();
  save();
}

function save() {
  const log: ChangeLog = { version: 1, changes: [...allChanges()] };
  import.meta.hot?.send("spark:changes", log);
  render();
}

// --- Undo and redo -----------------------------------------------------------
// Every saved edit is a step: style, text, resize, reorder, delete, variables,
// scope changes and reverts. Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y in edit mode (in
// view mode the keys belong to the app). The history starts over when the
// list is loaded or Claude applies changes, so undo never brings back an
// edit that's already in the code.

const MAX_STEPS = 200;
let history: Change[][] = [snapshotChanges()];
let step = 0;

function remember() {
  const now = snapshotChanges();
  if (JSON.stringify(now) === JSON.stringify(history[step])) return;
  history = [...history.slice(0, step + 1), now].slice(-MAX_STEPS);
  step = history.length - 1;
}

function resetHistory() {
  history = [snapshotChanges()];
  step = 0;
}

function undoRedo(dir: -1 | 1) {
  const to = step + dir;
  if (to < 0 || to >= history.length) return;
  if (editing) stopTextEdit(true);
  step = to;
  restore(history[step]);
  save();
}

/** Ctrl+Z → -1; Ctrl+Shift+Z or Ctrl+Y → 1. */
function undoKey(e: KeyboardEvent): -1 | 1 | 0 {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return 0;
  if (e.code === "KeyZ") return e.shiftKey ? 1 : -1;
  if (e.code === "KeyY" && !e.shiftKey) return 1;
  return 0;
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
  const prev = overridesOn(el).filter((c) => c.property === "text").at(-1);
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
  const existing = overridesOn(el).filter((c) => c.property === "text" && (c.instance?.scope ?? null) === null).at(-1);
  if (existing) record({ ...existing, to: text });
  else {
    const path = instancePath(el);
    record({
      level: "instance",
      property: "text",
      from: editFrom,
      to: text,
      file: null,
      selector: null,
      element: elementInfo(el),
      instance: { component: path[0]?.name ?? "?", call: path[0]?.call ?? null, path, scope: null, appliesTo: scopeWords(path, null) },
    });
  }
  changed();
  placeHandles();
}

/**
 * Delete (or Backspace) in edit mode: remove the selection from the design.
 * Like any override it starts on this instance only; the Changes list can
 * apply it upstream (every instance) or revert it. The selection moves to
 * the parent.
 */
function removeSelected() {
  const el = selected;
  if (!el) return;
  const path = instancePath(el);
  record({
    level: "instance",
    property: "removed",
    from: "",
    to: "removed",
    file: null,
    selector: null,
    element: elementInfo(el),
    instance: { component: path[0]?.name ?? "?", call: path[0]?.call ?? null, path, scope: null, appliesTo: scopeWords(path, null) },
  });
  select(el.parentElement?.closest("[data-spark-src]") ?? null);
  changed();
}

const isDelete = (e: KeyboardEvent) => (e.key === "Delete" || e.key === "Backspace") && !e.altKey && !e.ctrlKey && !e.metaKey;

// ---------------------------------------------------------------------------
// Claude: "Implement changes" and "Ask Claude" run the local claude CLI on the
// dev server (runner.ts); progress comes back as spark:run events.

type RunEvent =
  | { type: "start"; kind: "implement" | "ask"; ids: string[] }
  | { type: "log"; text: string }
  | { type: "done"; ok: boolean; applied: string[]; skipped: { id: string; why: string }[]; summary: string; cost?: number }
  | { type: "error"; text: string };

let run: { kind: "implement" | "ask"; lines: string[]; done?: Extract<RunEvent, { type: "done" }>; error?: string } | null = null;
const isRunning = () => !!run && !run.done && !run.error;

function implement() {
  if (isRunning()) return;
  import.meta.hot?.send("spark:implement", {});
}

function sendAsk() {
  const request = askInput.value.trim();
  if (!request || isRunning()) return;
  const el = selected;
  const selection = el ? { ...snapshot(el), owners: instancePath(el), text: (el.textContent ?? "").trim().slice(0, 200) } : null;
  import.meta.hot?.send("spark:ask", { request, selection });
  askInput.value = "";
  askInput.blur();
}

/** The ask box sits just under the selection (or above it near the bottom). */
function placeAsk() {
  const show = open && picking && !!selected && selected.isConnected && !editing && !resizing && !isRunning();
  if (!show) {
    askBox.style.display = "none";
    return;
  }
  const r = selected!.getBoundingClientRect();
  askBox.style.display = "block";
  const w = askBox.offsetWidth;
  const hgt = askBox.offsetHeight;
  const maxLeft = window.innerWidth - (!shell ? PANEL_W : 0) - w - 8;
  askBox.style.left = `${Math.max(4, Math.min(r.left, maxLeft))}px`;
  const below = r.bottom + 8;
  askBox.style.top = `${below + hgt < window.innerHeight ? below : Math.max(4, r.top - hgt - 28)}px`;
}

function renderRun() {
  if (!run) {
    runBox.replaceChildren();
    runBox.style.display = "none";
    return;
  }
  runBox.style.display = "block";
  const what = run.kind === "implement" ? "Implementing changes" : "Claude is working";
  const head = isRunning()
    ? h("div", { class: "run-head" }, h("span", { class: "spin" }), h("span", { class: "grow" }, `${what}…`), h("button", { click: () => import.meta.hot?.send("spark:stop", {}) }, "Stop"))
    : h(
        "div",
        { class: "run-head" },
        h("span", { class: "grow" }, run.error ? "Couldn't run Claude" : run.done?.ok ? "Done" : "Claude stopped"),
        h("button", { title: "Dismiss", click: () => ((run = null), renderRun()) }, "×"),
      );
  const parts: (HTMLElement | false)[] = [head];
  if (run.error) parts.push(h("div", { class: "run-err" }, run.error));
  if (run.done) {
    const d = run.done;
    if (d.summary) parts.push(h("div", { class: d.ok ? "run-sum" : "run-err" }, d.summary));
    if (d.applied.length || d.skipped.length || d.cost !== undefined) {
      const bits = [];
      if (d.applied.length || d.skipped.length) bits.push(`${d.applied.length} applied · ${d.skipped.length} skipped`);
      if (d.cost !== undefined) bits.push(`$${d.cost.toFixed(2)}`);
      parts.push(h("div", { class: "hint" }, bits.join(" · ")));
    }
    for (const s of d.skipped) parts.push(h("div", { class: "run-err" }, `Skipped: ${s.why}`));
  }
  if (isRunning()) parts.push(h("div", { class: "run-log" }, ...run.lines.slice(-6).map((l) => h("div", {}, l))));
  runBox.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
}

import.meta.hot?.on("spark:run", (e: RunEvent) => {
  if (e.type === "start") run = { kind: e.kind, lines: [] };
  else if (!run) run = { kind: "implement", lines: [] };
  if (e.type === "log") run.lines.push(e.text);
  if (e.type === "done") run.done = e;
  if (e.type === "error") run.error = e.text;
  renderRun();
  renderChanges();
});
// Claude marked changes applied: their previews give way to the real code.
import.meta.hot?.on("spark:log", (log: ChangeLog) => {
  load(log.changes);
  renderOverrides();
  resetHistory();
  render();
});
import.meta.hot?.on("spark:run-state", (s: { running: boolean }) => {
  if (s.running && !run) {
    run = { kind: "implement", lines: [] };
    renderRun();
  }
});
import.meta.hot?.send("spark:run-state", {});

// ---------------------------------------------------------------------------
// The panel's contents

function locLink(loc: string | null) {
  if (!loc) return h("span", { class: "empty" }, "unknown");
  return h("span", { class: "link", title: "Open in editor", click: () => openInEditor(loc) }, loc);
}

function row(name: string | HTMLElement, field: HTMLElement, below?: HTMLElement | null) {
  const k = typeof name === "string" ? h("span", { class: "k", title: name }, name) : h("span", { class: "k" }, name);
  return h("div", { class: "row" }, k, h("div", { class: "field" }, field, below));
}

function renderVariablesView() {
  const scroll = body.scrollTop;
  const pendingValue = (name: string) => allChanges().find((c) => c.status === "pending" && c.level === "token" && c.property === name)?.to;
  renderVariables(body, {
    skip,
    pendingValue,
    edit: (v: Variable, value: string, final: boolean) => editToken(selected, v.name, value, final),
    selectRule: (selector) => {
      let el: Element | undefined;
      try {
        el = Array.from(document.querySelectorAll(selector)).find((x) => !skip(x));
      } catch {
        return false;
      }
      if (!el) return false;
      // Selecting is an edit-mode thing.
      if (!picking) setPicking(true);
      select(el.closest("[data-spark-src]") ?? el);
      return true;
    },
    shortFile,
  });
  body.scrollTop = scroll;
}

function render() {
  renderChanges();
  closePopover();
  body.replaceChildren();
  if (view === "variables") {
    renderVariablesView();
    return;
  }
  if (!selected) {
    body.append(
      h(
        "div",
        { class: "empty" },
        picking
          ? "Click an element to select it. Drag its handles to resize, double-click text to edit it, Arrow Up for the parent. Esc steps out: selection, then back to View."
          : "View mode: use the app as normal. Switch to Edit (Tab) to select and change elements.",
      ),
    );
    return;
  }
  const el = selected;
  const rules = matchedRules(el, skip);
  const owners = ownersOf(el);
  const classes = Array.from(el.classList);
  const path = instancePath(el);
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

  body.append(
    h(
      "div",
      { class: "hint" },
      `Edits are overrides on this instance${path.length ? ` (${path.map((e) => e.name + (e.key !== null ? `[${e.key}]` : "")).join(" in ")})` : ""}. Apply them upstream from the list below.`,
    ),
  );

  /** What a field shows: the pending edit, else the source's value (instance: falling back to computed). */
  const overrides = overridesOn(el);
  const valueOf = (prop: string): { value: string; changed: boolean } => {
    const c = overrides.filter((x) => x.property === prop).at(-1);
    // Computed lengths come with long fractions (108.641px); two decimals is plenty.
    const computed = cs.getPropertyValue(prop).replace(/(\.\d\d)\d+/g, "$1");
    return { value: c?.to ?? authored(el, rules, prop) ?? computed, changed: !!c };
  };
  const onValue = (prop: string): OnValue => (v, final) => {
    edit(el, prop, v, final);
  };

  for (const { group, fields } of FIELDS) {
    body.append(h("h3", {}, group));
    for (const f of fields) {
      if (f.kind === "sides") {
        const quad = h("div", { class: "quad" });
        const values: string[] = [];
        const computeds: string[] = [];
        for (const side of SIDES) {
          const prop = `${f.prop}-${side}`;
          const { value, changed } = valueOf(prop);
          values.push(value);
          computeds.push(cs.getPropertyValue(prop).trim());
          quad.append(numberField(value, { computed: cs.getPropertyValue(prop), label: side[0].toUpperCase(), changed, min: f.prop === "padding" ? 0 : undefined }, onValue(prop)));
        }
        body.append(row(f.prop, quad, resolvedLine(values.join(" "), computeds.join(" "), jumpToVariable)));
        continue;
      }
      const { value, changed } = valueOf(f.prop);
      const computed = cs.getPropertyValue(f.prop);
      let field: HTMLElement;
      if (f.kind === "number") field = numberField(value, { computed, step: f.step, unit: f.unit, min: f.min, changed }, onValue(f.prop));
      else if (f.kind === "select") field = selectField(value || computed, f.options, changed, onValue(f.prop));
      else if (f.kind === "color") field = colorField(value, computed, colors, changed, onValue(f.prop));
      else field = textField(value, changed, onValue(f.prop));
      body.append(row(f.prop, field, resolvedLine(value, computed, jumpToVariable)));
    }
  }

  // Tokens this element uses
  const tokens = tokensUsed(el, rules);
  if (tokens.length) {
    body.append(h("h3", {}, "Tokens"), h("div", { class: "hint" }, "Changing a token changes everything that uses it. Click a name to see all variables."));
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
      body.append(row(h("span", { class: "link", title: `${t}: show in Variables`, click: () => jumpToVariable(t) }, t), field));
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
  if (c.level === "token") return `token · ${c.file ?? "?"}`;
  if (c.level === "component") return `CSS rule ${c.selector} · ${c.file ?? "?"}`;
  const n = coveredElements(c).length;
  return `${c.instance?.appliesTo ?? c.instance?.component ?? "?"} · ${n} on screen`;
}

/** Where an override lives: its scope, or (style overrides) one of the CSS rules that match it. */
function scopeSelect(c: Change): HTMLElement {
  const path = pathFor(c);
  const sel = h("select", { title: "Where this change lives" }) as HTMLSelectElement;
  for (const o of scopeChoices(path)) sel.append(h("option", { value: String(o.scope), selected: o.scope === (c.instance?.scope ?? null) }, o.label));
  const el = coveredElements(c)[0];
  const rules = el && !["text", "children-order", "removed"].includes(c.property) ? matchedRules(el, skip) : [];
  for (const [i, m] of [...rules.entries()].reverse()) sel.append(h("option", { value: `rule:${i}` }, `Move to CSS rule ${m.selector} · ${shortFile(m.file)}`));
  sel.addEventListener("change", () => {
    if (sel.value.startsWith("rule:")) {
      const m = rules[Number(sel.value.slice(5))];
      applyToRule(c.id, rel(m.file), m.selector, m.rule.style.getPropertyValue(c.property));
    } else {
      const scope = sel.value === "null" ? null : Number(sel.value);
      applyTo(c.id, scope, scopeWords(path, scope));
    }
    changed();
  });
  return sel;
}

function renderChanges() {
  const pending = allChanges().filter((c) => c.status === "pending");
  const implementBtn = h(
    "button",
    { class: "on", title: "Have Claude apply these changes to the code", click: () => implement() },
    "Implement changes",
  ) as HTMLButtonElement;
  implementBtn.disabled = pending.length === 0 || isRunning();
  footer.replaceChildren(h("div", { class: "changes-head" }, h("h3", {}, `Changes (${pending.length})`), h("span", { class: "grow" }), implementBtn));
  if (pending.length === 0) {
    footer.append(h("div", { class: "empty" }, "Edits you make show up here."));
    return;
  }
  const here = new Set(selected ? overridesOn(selected).map((c) => c.id) : []);
  // Newest first: the change you just made is at the top.
  for (const c of [...pending].sort((a, b) => b.at.localeCompare(a.at))) {
    const what =
      c.property === "text"
        ? `text: "${c.from}" → "${c.to}"`
        : c.property === "removed"
          ? `removed <${c.element.tag}>${c.element.comp ? ` in ${c.element.comp}${pathFor(c)[0]?.key != null ? `[${pathFor(c)[0].key}]` : ""}` : ""}`
          : `${c.property}: ${c.from || "unset"} → ${c.to}`;
    const kind = c.level === "instance" ? (c.instance?.scope ?? null) === null ? "override" : "applied upstream" : c.level === "component" ? "css rule" : "token";
    footer.append(
      h(
        "div",
        { class: `change${here.has(c.id) ? " here" : ""}` },
        h(
          "div",
          { class: "what" },
          h("div", { class: "lvl" }, kind),
          h("code", {}, what),
          h("div", { class: "where" }, describeChange(c)),
          c.level === "instance" && scopeSelect(c),
        ),
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
/** Tab alone switches view/edit; Shift+Tab still walks the app's focus order backwards. */
function plainTab(e: KeyboardEvent) {
  return e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
}

/** Focus is in something you type into: there Tab keeps moving to the next field. */
function textEntry(e: Event): boolean {
  const t = e.composedPath()[0] as HTMLElement | undefined;
  if (!t || !t.tagName) return false;
  if (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  if (t.tagName !== "INPUT") return false;
  return !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/.test((t as HTMLInputElement).type);
}

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
    if ((e.altKey && e.code === "KeyE") || (plainTab(e) && !textEntry(e))) {
      e.preventDefault();
      e.stopPropagation();
      setPicking(!picking);
      return;
    }
    // Typing in the panel: its fields handle their own keys.
    if (!open || e.composedPath().includes(host) || e.composedPath().includes(panelHost)) return;
    if (e.key === "Escape") {
      // In view mode Esc belongs to the app.
      if (picking && escapeStep()) {
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (undoKey(e) && picking && !textEntry(e)) {
      // In a field, Ctrl+Z undoes its own typing.
      e.preventDefault();
      e.stopPropagation();
      undoRedo(undoKey(e) as -1 | 1);
    } else if (isDelete(e) && picking && selected && !textEntry(e)) {
      e.preventDefault();
      e.stopPropagation();
      removeSelected();
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
// Keys with focus outside the app: in the panel, or (viewport shell) anywhere
// in the shell page. Capture phase, so fields that keep their keys still let
// Esc and Alt+E through.
const panelKeys = (e: Event) => {
  const k = e as KeyboardEvent;
  if ((k.altKey && k.code === "KeyE") || (plainTab(k) && !textEntry(k))) {
    k.preventDefault();
    setPicking(!picking);
  } else if (undoKey(k) && !textEntry(k)) {
    // Outside the app (panel, bar) undo is always Spark's.
    k.preventDefault();
    k.stopPropagation();
    undoRedo(undoKey(k) as -1 | 1);
  } else if (isDelete(k) && picking && selected && !textEntry(k)) {
    k.preventDefault();
    k.stopPropagation();
    removeSelected();
  } else if (k.key === "Escape") {
    const t = k.composedPath()[0] as HTMLElement | undefined;
    // Esc in a field leaves the field; otherwise it steps out like in the app.
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName ?? "")) {
      t.blur();
      closePopover();
    } else {
      (panelRoot.activeElement as HTMLElement | null)?.blur();
      escapeStep();
    }
  }
};
const keyTarget: EventTarget = shell ? window.parent.document : panelRoot;
keyTarget.addEventListener("keydown", panelKeys, true);

// ---------------------------------------------------------------------------
// Start

document.head.append(dockStyle);
document.documentElement.append(host);
if (shell) {
  shell.mount(panelHost);
  // Space-drag pans only in edit mode: in view mode Space belongs to the app.
  frameGlue(host, () => picking, () => setOpen(!open));
  const sh = shell;
  window.addEventListener("pagehide", () => {
    keyTarget.removeEventListener("keydown", panelKeys, true);
    panelHost.remove();
    sh.setDocked(false);
  });
}
initChanges(skip, instancePath);
installReorder({
  overlay: shadow,
  active: () => picking && !editing && !resizing,
  selected: () => selected,
  pickable,
  select,
  instancePath,
  elementInfo,
  scopeWords,
  changed,
});
render();
let reopen = false;
try {
  reopen = localStorage.getItem("spark:open") === "1";
} catch {
  // Storage may be off.
}
if (reopen) setOpen(true);
shell?.setMode(picking, setPicking);
requestAnimationFrame(follow);

import.meta.hot?.on("spark:ready", (info: { name: string; root: string; changes: ChangeLog | null }) => {
  root = info.root;
  status.textContent = info.name;
  if (info.changes) load(info.changes.changes);
  resetHistory();
  render();
});
import.meta.hot?.send("spark:hello", {});
