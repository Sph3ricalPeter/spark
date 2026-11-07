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
//   on a corner, Alt drags slower; sizes stay whole pixels);
// - double-click text to edit it in place; Enter or Esc keeps the edit.
// The panel's fields scrub (drag the ↔ grip, Alt slower, Shift ×10; whole px), colors
// open token swatches and a picker, keyword properties are dropdowns.
//
// Edits are previewed live and recorded as changes (see changes.ts), which
// the dev server saves to .spark/changes.json.
import { installFont } from "./fonts.ts";
import { icon as lucide, THEME } from "./theme.ts";
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
import { authored, findRule, matchedRules, tokenRule, tokensUsed } from "./css.ts";
import { closePopover, colorField, colorTokens, h, numberField, selectField, textField, type OnValue } from "./fields.ts";
import { frameGlue } from "./frame.ts";
import { shell } from "./mode.ts";
import { installReorder } from "./reorder.ts";
import { draftVariable, renderVariables, resolvedLine, varButton, VARIABLES_STYLE, type Variable, type VarKind, type VarTarget } from "./variables.ts";
import { INHERITED, PAGE_STYLE, inheritedFrom, isPageSelector, pageRules, renderPage } from "./page.ts";
import type { RuleRef } from "./css.ts";

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
  | { prop: string; kind: "number"; step?: number; unit?: string; min?: number; keywords?: string[] }
  | { prop: string; kind: "select"; options: string[] }
  | { prop: string; kind: "color" }
  | { prop: string; kind: "text" }
  | { prop: string; kind: "sides"; step?: number };

const SIZE_KEYWORDS = ["auto", "fit-content", "min-content", "max-content", "inherit"];

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
      { prop: "gap", kind: "number", min: 0, keywords: ["normal"] },
      { prop: "position", kind: "select", options: ["static", "relative", "absolute", "fixed", "sticky"] },
      { prop: "overflow", kind: "select", options: ["visible", "hidden", "auto", "scroll", "clip"] },
    ],
  },
  {
    group: "Size and spacing",
    fields: [
      { prop: "width", kind: "number", min: 0, keywords: SIZE_KEYWORDS },
      { prop: "height", kind: "number", min: 0, keywords: SIZE_KEYWORDS },
      { prop: "padding", kind: "sides" },
      { prop: "margin", kind: "sides" },
    ],
  },
  {
    group: "Text",
    fields: [
      { prop: "color", kind: "color" },
      { prop: "font-family", kind: "text" },
      { prop: "font-size", kind: "number", min: 0, keywords: ["inherit", "smaller", "larger"] },
      { prop: "font-weight", kind: "select", options: ["100", "200", "300", "400", "500", "600", "700", "800", "900"] },
      { prop: "line-height", kind: "number", step: 0.1, unit: "", min: 0, keywords: ["normal", "inherit"] },
      { prop: "letter-spacing", kind: "number", keywords: ["normal", "inherit"] },
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
    // The Components view's own wrappers (gallery.ts) aren't part of the app.
    if ((f.type as { sparkInternal?: boolean } | null)?.sparkInternal) break;
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
const STYLE = `${THEME}
    :host { all: initial; }
    * { box-sizing: border-box; }
    .box { position: fixed; pointer-events: none; display: none; }
    .hover { outline: 1px dashed var(--sp-accent); background: ${ACCENT}14; }
    .selected { outline: 2px solid var(--sp-accent); }
    .tag {
      position: fixed; display: none; pointer-events: none;
      font: 600 var(--sp-fs-sm)/1 var(--sp-font);
      background: var(--sp-accent); color: var(--sp-text-strong); padding: 3px 6px; border-radius: var(--sp-r-sm); white-space: nowrap;
    }
    .panel {
      position: fixed; top: 0; right: 0; bottom: 0; width: ${PANEL_W}px;
      display: none; flex-direction: column; pointer-events: auto;
      background: var(--sp-bg); color: var(--sp-text); border-left: 1px solid var(--sp-line);
      font: var(--sp-fs-md)/1.45 var(--sp-font);
    }
    .panel.open { display: flex; }
    header {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      border-bottom: 1px solid var(--sp-line); font-weight: 600; color: var(--sp-text-strong);
    }
    header .grow { flex: 1; color: var(--sp-text-dim); font-weight: 400; }
    button, select, input {
      font: inherit; color: inherit; background: var(--sp-field); border: 1px solid var(--sp-line-strong);
      border-radius: var(--sp-r-sm); padding: 3px 8px;
    }
    button { cursor: pointer; }
    button.on { background: var(--sp-accent); border-color: var(--sp-accent); color: var(--sp-text-strong); }
    .seg { display: inline-flex; }
    .grow { flex: 1; }
    .changes-head { display: flex; align-items: center; gap: 8px; }
    .changes-head h3 { margin: 0; }
    button:disabled { opacity: 0.5; cursor: default; }
    .run { display: none; padding: 10px 12px; border-top: 1px solid var(--sp-line); }
    .run-head { display: flex; align-items: center; gap: 8px; color: var(--sp-text-strong); font-weight: 600; }
    .run-sum { margin-top: 6px; white-space: pre-wrap; }
    .run-err { margin-top: 6px; color: #ff8a80; white-space: pre-wrap; }
    .run-log { margin-top: 6px; color: var(--sp-text-dim); font-family: var(--sp-mono); font-size: var(--sp-fs-sm); }
    .run-log div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .spin {
      width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--sp-line-strong); border-top-color: var(--sp-accent);
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .ask {
      position: fixed; display: none; align-items: center; gap: 2px; width: 360px; box-sizing: border-box;
      pointer-events: auto; padding: 3px;
      background: #1b1c20; border: 1px solid var(--sp-line-strong); border-radius: var(--sp-r-lg); box-shadow: 0 6px 24px rgba(0,0,0,.4);
      color: var(--sp-text); font: var(--sp-fs-md)/1.4 var(--sp-font);
    }
    .ask:focus-within { border-color: var(--sp-accent); }
    .ask-tag {
      flex: none; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      margin-right: var(--sp-1); padding: 2px 6px; border-radius: var(--sp-r-sm);
      background: var(--sp-accent); color: var(--sp-text-strong); font: 600 var(--sp-fs-sm)/1.4 var(--sp-font);
    }
    .ask input { flex: 1; min-width: 0; border: none; background: none; padding: 4px 0; outline: none; font-family: var(--sp-font); }
    .ask .ib {
      display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0;
      border: none; background: none; color: var(--sp-text-dim); border-radius: 5px;
    }
    .ask .ib:hover { background: var(--sp-line); color: var(--sp-text-strong); }
    .ask .ib.send { background: var(--sp-accent); color: var(--sp-text-strong); }
    .seg button { border-radius: 0; }
    .seg button:first-child { border-radius: var(--sp-r-sm) 0 0 4px; }
    .seg button:last-child { border-radius: 0 4px 4px 0; border-left: none; }
    select { width: 100%; padding: 4px 6px; }
    input { width: 100%; font: var(--sp-fs-sm) var(--sp-mono); padding: 3px 6px; }
    input:focus, select:focus { outline: 1px solid var(--sp-accent); border-color: var(--sp-accent); }
    input.changed { border-color: var(--sp-warn); }
    input.bad { border-color: var(--sp-danger); }
    .body { flex: 1; overflow: auto; padding: 12px; }
    .footer { border-top: 1px solid var(--sp-line); padding: 10px 12px; max-height: 40%; overflow: auto; }
    .empty { color: var(--sp-text-dim); }
    h3 { margin: 16px 0 6px; font-size: var(--sp-fs-sm); text-transform: uppercase; letter-spacing: .06em; color: var(--sp-text-dim); }
    h3:first-child { margin-top: 0; }
    .title { font: 600 var(--sp-fs-lg) var(--sp-mono); color: var(--sp-text-strong); word-break: break-all; }
    .link { color: var(--sp-link); cursor: pointer; font-family: var(--sp-mono); font-size: var(--sp-fs-sm); word-break: break-all; }
    .link:hover { text-decoration: underline; }
    .row { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
    .row .k { color: var(--sp-text-dim); width: 112px; flex: none; }
    .row .v { font-family: var(--sp-mono); font-size: var(--sp-fs-sm); word-break: break-all; }
    .hint { color: var(--sp-text-dim); font-size: var(--sp-fs-sm); margin-top: 4px; }
    .owner { padding: 3px 0; }
    .owner b { color: var(--sp-text-strong); font-weight: 600; margin-right: 6px; }
    details { margin-top: 12px; }
    summary { cursor: pointer; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); text-transform: uppercase; letter-spacing: .06em; }
    .rule { margin: 6px 0; padding: 6px 8px; background: var(--sp-surface); border-radius: var(--sp-r-sm); }
    .rule .sel { font: 600 var(--sp-fs-sm) var(--sp-mono); color: var(--sp-text-strong); }
    .rule .file { color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
    .rule pre { margin: 4px 0 0; white-space: pre-wrap; font: var(--sp-fs-sm)/1.5 var(--sp-mono); color: var(--sp-text); }
    .change { display: flex; gap: 8px; align-items: flex-start; padding: 5px 0; border-bottom: 1px solid var(--sp-field); }
    .change .what { flex: 1; min-width: 0; }
    .change .lvl { font-size: var(--sp-fs-xs); text-transform: uppercase; letter-spacing: .05em; color: var(--sp-warn); }
    .change .where { color: var(--sp-text-dim); font-size: var(--sp-fs-sm); word-break: break-word; margin-bottom: 4px; }
    .change.here { background: ${ACCENT}14; margin: 0 -12px; padding: 5px 12px; }
    .change code { font: var(--sp-fs-sm) var(--sp-mono); color: var(--sp-text-strong); word-break: break-all; }
    .change button { padding: 0 6px; }
    .fab {
      position: fixed; right: 12px; bottom: 12px; pointer-events: auto;
      background: var(--sp-accent); border-color: var(--sp-accent); color: var(--sp-text-strong); font-weight: 600;
    }
    .fab.hidden { display: none; }
    .handle {
      position: fixed; width: 8px; height: 8px; margin: -4px 0 0 -4px; display: none;
      background: var(--sp-text-strong); border: 1px solid var(--sp-accent); pointer-events: auto;
    }
    .handle[data-dir="n"], .handle[data-dir="s"] { cursor: ns-resize; }
    .handle[data-dir="e"], .handle[data-dir="w"] { cursor: ew-resize; }
    .handle[data-dir="ne"], .handle[data-dir="sw"] { cursor: nesw-resize; }
    .handle[data-dir="nw"], .handle[data-dir="se"] { cursor: nwse-resize; }
    .box.editing { outline: 2px solid var(--sp-warn); }
    .row .field { flex: 1; min-width: 0; }
    .num {
      display: flex; align-items: center; min-width: 0;
      background: var(--sp-field); border: 1px solid var(--sp-line-strong); border-radius: var(--sp-r-sm);
    }
    .num:focus-within { border-color: var(--sp-accent); }
    .num.changed, select.changed, input.changed { border-color: var(--sp-warn); }
    .num .grip {
      flex: none; padding: 0 5px; color: var(--sp-text-dim); font-size: var(--sp-fs-xs); cursor: ew-resize; user-select: none;
    }
    .num .grip:hover { color: var(--sp-text-strong); }
    .num input { border: none; background: transparent; padding-left: 0; min-width: 0; }
    .num input:focus { outline: none; }
    .num select.unit {
      flex: none; width: auto; border: none; background: transparent; color: var(--sp-text-dim);
      padding: 0 4px 0 2px; font: var(--sp-fs-xs) var(--sp-mono); cursor: pointer;
      appearance: none; -webkit-appearance: none; text-align: right;
    }
    .num select.unit:hover { color: var(--sp-text-strong); }
    .num select.unit:focus { outline: none; color: var(--sp-text-strong); }
    /* A keyword stands in for the number. */
    .num.kw input { color: var(--sp-text); font-style: italic; }
    /* The keyword is already in the input: the dropdown shrinks to a caret. */
    .num.kw select.unit {
      width: 16px; color: transparent;
      background: no-repeat center / 8px url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 5'%3E%3Cpath d='M0 0h8L4 5z' fill='%238fb4ff'/%3E%3C/svg%3E");
    }
    .num.kw select.unit option, .num.kw select.unit optgroup { color: var(--sp-text); }
    /* Four sides share a row: their unit shows while you edit one. */
    .quad .num select.unit { display: none; }
    .quad .num:focus-within select.unit { display: block; }
    .num input { flex: 1; }
    .quad { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
    .color { display: flex; gap: 6px; position: relative; }
    .swatch {
      width: 22px; height: 22px; padding: 0; flex: none; cursor: pointer;
      border: 1px solid var(--sp-line-strong); border-radius: var(--sp-r-sm);
    }
    .swatch.on { outline: 2px solid var(--sp-accent); outline-offset: 1px; }
    .popover {
      position: absolute; top: 28px; right: 0; z-index: 5; width: 236px; padding: 8px;
      background: var(--sp-surface); border: 1px solid var(--sp-line-strong); border-radius: var(--sp-r-md); box-shadow: 0 8px 24px #0009;
    }
    .pop-title { color: var(--sp-text-dim); font-size: var(--sp-fs-sm); margin: 0 0 6px; }
    .swatches { display: grid; grid-template-columns: repeat(8, 22px); gap: 5px; margin-bottom: 10px; max-height: 160px; overflow: auto; }
    input[type="color"] { width: 100%; height: 28px; padding: 2px; cursor: pointer; }
    .toast { color: var(--sp-warn); font-size: var(--sp-fs-sm); margin-top: 6px; }
    .row .k .link { font-size: inherit; }
    ${VARIABLES_STYLE}
    ${PAGE_STYLE}`;
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
/** What the body shows: the selection's inspector, the page's own styles, or the app's variables. */
type View = "inspect" | "page" | "variables";
let view: View = "inspect";
const tabs: Record<View, HTMLElement> = {
  inspect: h("button", { class: "on", click: () => setView("inspect") }, "Inspect"),
  page: h("button", { title: "Styles on html, body and :root", click: () => setView("page") }, "Page"),
  variables: h("button", { click: () => setView("variables") }, "Variables"),
};
function markTab() {
  for (const [k, b] of Object.entries(tabs)) b.classList.toggle("on", k === view);
}
const panel = h(
  "div",
  { class: "panel" },
  h("header", {}, "Spark", status, modeToggle, h("button", { title: "Close (Alt+S)", click: () => setOpen(false) }, lucide("x"))),
  h("nav", { class: "tabs" }, tabs.inspect, tabs.page, tabs.variables),
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
const makeBtn = h(
  "button",
  {
    class: "ib",
    title: "Make component: have Claude extract this into its own component",
    click: () => {
      askInput.value = "Extract this into its own component called ";
      askInput.focus();
    },
  },
  lucide("component"),
);
const sendBtn = h("button", { class: "ib send", title: "Ask Claude (Enter)", click: () => sendAsk() }, lucide("arrow-up"));
/** What's selected, as the start of the ask row (it replaces the floating tag label). */
const askTag = h("span", { class: "ask-tag" });
const askBox = h("div", { class: "ask" }, askTag, askInput, makeBtn, sendBtn);
shadow.append(hoverBox, selectBox, ...handles, tagLabel, askBox);
// In the viewport shell the panel lives outside the zoomed frame (mode.ts).
const panelHost = shell ? document.createElement("spark-panel") : host;
const panelRoot = shell ? panelHost.attachShadow({ mode: "open" }) : shadow;
if (shell) {
  panelHost.style.cssText = host.style.cssText;
  panelRoot.append(h("style", {}, STYLE));
}
panelRoot.append(panel, fab);

// Spark's own buttons and dropdowns never keep focus: Tab and Esc are Spark's
// shortcuts, not focus moves, and the first Esc mustn't go to a dropdown.
function dropFocus(r: ShadowRoot) {
  r.addEventListener("click", (e) => {
    const b = (e.composedPath()[0] as Element | undefined)?.closest?.("button");
    if (b && r.activeElement === b) b.blur();
  });
  r.addEventListener("change", (e) => {
    const t = e.composedPath()[0];
    if (t instanceof HTMLSelectElement) t.blur();
  });
}
dropFocus(shadow);
if (panelRoot !== shadow) dropFocus(panelRoot);
// A press in the app takes focus out of the panel (the overlay may keep the
// press from focusing anything itself).
document.addEventListener(
  "pointerdown",
  (e) => {
    const path = e.composedPath();
    if (path.includes(panelHost) || path.includes(host)) return;
    (panelRoot.activeElement as HTMLElement | null)?.blur();
  },
  true,
);

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
/**
 * Drop the app's keyboard focus. A button clicked in view mode keeps focus,
 * and the next key (Tab into edit mode, Esc) makes the browser draw its
 * focus ring on it, which looks like an edit border and Esc can't clear.
 */
function blurApp() {
  const a = document.activeElement;
  if (a instanceof HTMLElement && a !== document.body && !host.contains(a) && a !== editing) a.blur();
}

function setPicking(v: boolean) {
  picking = v;
  if (v) blurApp();
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
  blurApp();
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
  markTab();
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
  blurApp();
  if (editing) stopTextEdit(true);
  if (el) view = "inspect";
  markTab();
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

/** Edit a declaration of a CSS rule in place (page styles). `from` is "" for a property the rule didn't set. */
function editRule(ref: RuleRef, prop: string, from: string, value: string, final: boolean): boolean {
  value = value.trim();
  if (!value || !CSS.supports(prop, value)) return false;
  const file = rel(ref.file);
  const prev = allChanges().find((c) => c.status === "pending" && c.level === "component" && c.property === prop && c.file === file && c.selector === ref.selector);
  const element = selected ? elementInfo(selected) : { src: null, comp: null, tag: "", classes: [] };
  record({ level: "component", property: prop, from: prev?.from ?? from, to: value, file, selector: ref.selector, element, instance: null });
  if (final) changed();
  return true;
}

/** Add a new variable to a rule (recorded as a token change from ""). */
function createVariable(name: string, value: string, target: VarTarget): boolean {
  if (!CSS.supports(name, value)) return false;
  const file = rel(target.file);
  if (!findRule(file, target.selector, skip)) return false;
  const element = selected ? elementInfo(selected) : { src: null, comp: null, tag: "", classes: [] };
  record({ level: "token", property: name, from: "", to: value, file, selector: target.selector, element, instance: null });
  changed();
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
  // On the board the history is shared by every frame's client.
  if (shell) return shell.commit(now, window);
  if (JSON.stringify(now) === JSON.stringify(history[step])) return;
  history = [...history.slice(0, step + 1), now].slice(-MAX_STEPS);
  step = history.length - 1;
}

function resetHistory() {
  if (shell) return shell.resetHistory(snapshotChanges());
  history = [snapshotChanges()];
  step = 0;
}

function undoRedo(dir: -1 | 1) {
  if (shell) {
    const list = shell.step(dir, window);
    if (!list) return;
    if (editing) stopTextEdit(true);
    restore(list as Change[]);
    save();
    return;
  }
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

/**
 * The ask box sits above the selection (over its tag label), centered on it;
 * below it when there's no room. In the zoomed canvas it keeps its screen
 * size (frame.ts scales it by 1/zoom about the edge that touches the element).
 */
function placeAsk() {
  const show = open && picking && !!selected && selected.isConnected && !editing && !resizing && !isRunning();
  if (!show) {
    askBox.style.display = "none";
    return;
  }
  const el = selected!;
  const r = el.getBoundingClientRect();
  const comp = el.getAttribute("data-spark-comp");
  const tag = `${comp ? comp + " · " : ""}${el.tagName.toLowerCase()}`;
  if (askTag.textContent !== tag) askTag.textContent = tag;
  askTag.title = `${tag}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  // The row names the selection, so its floating label goes (unless something else is hovered).
  if (!hovered || hovered === el) tagLabel.style.display = "none";
  askBox.style.display = "flex";
  const z = parseFloat(getComputedStyle(askBox).getPropertyValue("--z")) || 1;
  const w = askBox.offsetWidth;
  const hgt = askBox.offsetHeight;
  const gap = 8 / z;
  const top = r.top;
  const right = window.innerWidth - (!shell ? PANEL_W : 0);
  const half = w / 2 / z;
  const cx = Math.max(half + 4, Math.min(r.left + r.width / 2, right - half - 4));
  askBox.style.left = `${cx - w / 2}px`;
  if (top - gap - hgt / z >= 4) {
    askBox.style.transformOrigin = "50% 100%";
    askBox.style.top = `${top - gap - hgt}px`;
  } else {
    askBox.style.transformOrigin = "50% 0";
    askBox.style.top = `${Math.min(r.bottom + gap, window.innerHeight - hgt / z - 4)}px`;
  }
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
        h("button", { title: "Dismiss", click: () => ((run = null), renderRun()) }, lucide("x")),
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

/** A field with the "{ }" button: bind it to a variable, make one from its value, or unlink. */
function withVar(field: HTMLElement, kind: VarKind | null, value: string, computed: string, set: (v: string) => void): HTMLElement {
  const pendingValue = (name: string) => allChanges().find((c) => c.status === "pending" && c.level === "token" && c.property === name)?.to;
  const el = selected;
  return varButton(field, {
    kind,
    value,
    skip,
    pendingValue,
    use: (name) => set(`var(${name})`),
    unbind: () => set(computed.trim().replace(/(\.\d\d)\d+/g, "$1")),
    create: () => {
      draftVariable(value.includes("var(") ? "" : value || computed.trim(), "", (name) => {
        if (el?.isConnected) select(el);
        set(`var(${name})`);
      });
      setView("variables");
    },
  });
}

function renderVariablesView() {
  const scroll = body.scrollTop;
  const pendingValue = (name: string) => allChanges().find((c) => c.status === "pending" && c.level === "token" && c.property === name)?.to;
  renderVariables(body, {
    skip,
    pendingValue,
    edit: (v: Variable, value: string, final: boolean) => editToken(selected, v.name, value, final),
    create: createVariable,
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

function renderPageView() {
  const scroll = body.scrollTop;
  const pending = allChanges().filter((c) => c.status === "pending" && c.level === "component");
  renderPage(body, pageRules(skip), {
    pendingValue: (file, selector, prop) => pending.find((c) => c.file === rel(file) && c.selector === selector && c.property === prop)?.to,
    edit: (ref, prop, from, value, final) => editRule(ref, prop, from, value, final),
    colors: colorTokens(skip),
    jumpToVariable,
    showVariables: () => setView("variables"),
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
  if (view === "page") {
    renderPageView();
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
  // Where an inherited value comes from, when this element doesn't set it.
  const ruleCache = new Map<Element, RuleRef[]>();
  const rulesOf = (x: Element) => {
    if (!ruleCache.has(x)) ruleCache.set(x, matchedRules(x, skip));
    return ruleCache.get(x)!;
  };
  const inheritLine = (prop: string, changed: boolean): HTMLElement | null => {
    if (!INHERITED.has(prop) || changed || authored(el, rules, prop) !== null) return null;
    const from = inheritedFrom(el, prop, rulesOf);
    if (!from) return null;
    const page = isPageSelector(from.rule.selector);
    const go = () => (page ? setView("page") : select(from.el.closest("[data-spark-src]") ?? from.el));
    return h(
      "div",
      { class: "inherited" },
      "inherited from ",
      h("span", { class: "link", title: page ? "Edit in Page" : "Select that element", click: go }, from.rule.selector),
      ` · ${shortFile(from.rule.file)}`,
    );
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
          quad.append(numberField(value, { computed: cs.getPropertyValue(prop), label: side[0].toUpperCase(), changed, min: f.prop === "padding" ? 0 : undefined, keywords: f.prop === "margin" ? ["auto"] : [] }, onValue(prop)));
        }
        const sideProps = SIDES.map((side) => `${f.prop}-${side}`);
        const same = values.every((v) => v === values[0]) ? values[0] : "";
        const quadVar = withVar(quad, "size", same, computeds[0], (v) => {
          sideProps.forEach((p, i) => edit(el, p, v, i === sideProps.length - 1));
        });
        body.append(row(f.prop, quadVar, resolvedLine(values.join(" "), computeds.join(" "), jumpToVariable)));
        continue;
      }
      const { value, changed } = valueOf(f.prop);
      const computed = cs.getPropertyValue(f.prop);
      let field: HTMLElement;
      if (f.kind === "number") field = numberField(value, { computed, step: f.step, unit: f.unit, min: f.min, keywords: f.keywords, changed }, onValue(f.prop));
      else if (f.kind === "select") field = selectField(value || computed, f.options, changed, onValue(f.prop));
      else if (f.kind === "color") field = colorField(value, computed, colors, changed, onValue(f.prop));
      else field = textField(value, changed, onValue(f.prop));
      if (f.kind !== "select") {
        const prop = f.prop;
        field = withVar(field, f.kind === "color" ? "color" : f.kind === "number" ? "size" : null, value, computed, (v) => edit(el, prop, v, true));
      }
      const notes = [resolvedLine(value, computed, jumpToVariable), inheritLine(f.prop, changed)].filter((x): x is HTMLElement => !!x);
      body.append(row(f.prop, field, notes.length ? h("div", {}, ...notes) : null));
    }
  }

  // Tokens this element uses
  const tokens = tokensUsed(el, rules);
  if (tokens.length) {
    body.append(h("h3", {}, "Variables used here"), h("div", { class: "hint" }, "Changing a variable changes everything that uses it. Click a name to see it in Variables."));
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
  if (c.level === "token") return `variable · ${c.file ?? "?"}`;
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
    const kind = c.level === "instance" ? (c.instance?.scope ?? null) === null ? "override" : "applied upstream" : c.level === "component" ? "css rule" : "variable";
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
          lucide("rotate-ccw", 13),
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
  // A dropdown isn't typed into: Tab and Esc stay Spark's there.
  if (t.isContentEditable || t.tagName === "TEXTAREA") return true;
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
    // View mode: the app gets Esc, then a clicked button or link lets go of
    // focus, so the browser's focus ring doesn't stay on it. Text fields keep it.
    if (e.key === "Escape" && !picking) {
      const a = document.activeElement;
      if (a instanceof HTMLElement && !a.isContentEditable && !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) setTimeout(blurApp);
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
  // On the board every frame has a client: only the selected frame's answers.
  if (shell && !shell.isActive(window)) return;
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
    // Esc while typing leaves the field; otherwise it steps out like in the app.
    if (t && textEntry(k)) {
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
installFont();
document.documentElement.append(host);
if (shell) {
  // Space-drag pans only in edit mode: in view mode Space belongs to the app.
  frameGlue(host, () => picking, () => setOpen(!open));
  window.addEventListener("pagehide", () => {
    keyTarget.removeEventListener("keydown", panelKeys, true);
    panelHost.remove();
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
if (shell) {
  // On the board the shell sends the panel state and the mode.
  shell.register({
    win: window,
    panel: panelHost,
    setOpen,
    setPicking,
    deselect: () => select(null),
    restore: (list) => {
      if (editing) stopTextEdit(true);
      restore(list as Change[]);
      render();
    },
  });
} else if (reopen) setOpen(true);
requestAnimationFrame(follow);

import.meta.hot?.on("spark:ready", (info: { name: string; root: string; changes: ChangeLog | null }) => {
  root = info.root;
  status.textContent = info.name;
  if (info.changes) load(info.changes.changes);
  resetHistory();
  render();
});
import.meta.hot?.send("spark:hello", {});
