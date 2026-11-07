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
import { icon as lucide, THEME, type IconName } from "./theme.ts";
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
  type Variant,
  breadth,
} from "./changes.ts";
import { authored, findRule, matchedRules, tokenRule, tokensUsed } from "./css.ts";
import { closePopover, colorField, colorTokens, h, numberField, selectField, textField, type OnValue } from "./fields.ts";
import { frameGlue } from "./frame.ts";
import { markdown, MARKDOWN_STYLE } from "./markdown.ts";
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

/** What kind of thing an element is, for which properties come first. */
type Kind = "text" | "button" | "input" | "media" | "stack" | "box";
const KIND_LABEL: Record<Kind, string> = { text: "Text", button: "Button", input: "Field", media: "Image", stack: "Layout", box: "Box" };
/** The properties people change most on each kind, first in the inspector and in the Ask popup. */
const ESSENTIALS: Record<Kind, string[]> = {
  text: ["color", "font-size", "font-weight", "line-height", "text-align", "margin"],
  button: ["background-color", "color", "border-radius", "font-size", "font-weight", "padding"],
  input: ["background-color", "color", "border-color", "border-radius", "font-size", "padding"],
  media: ["width", "height", "border-radius", "opacity"],
  stack: ["gap", "flex-direction", "align-items", "justify-content", "padding", "background-color", "border-radius"],
  box: ["background-color", "border-radius", "width", "height", "padding", "display"],
};
/** What font-weight numbers are called, shown next to them. */
const WEIGHTS: Record<string, string> = {
  "100": "Thin",
  "200": "Extra Light",
  "300": "Light",
  "400": "Regular",
  "500": "Medium",
  "600": "Semibold",
  "700": "Bold",
  "800": "Extra Bold",
  "900": "Black",
};
const KIND_ICON: Record<Kind, IconName> = {
  text: "type",
  button: "rectangle-horizontal",
  input: "text-cursor-input",
  media: "image",
  stack: "rows-2",
  box: "square",
};
const INLINE = /^(B|I|EM|STRONG|SMALL|CODE|BR|SPAN|A|SUB|SUP|MARK|ABBR|KBD|S|U)$/;

function kindOf(el: Element, cs: CSSStyleDeclaration): Kind {
  const tag = el.tagName;
  if (/^(IMG|SVG|VIDEO|CANVAS|PICTURE|IFRAME)$/i.test(tag)) return "media";
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return "input";
  if (tag === "BUTTON" || el.getAttribute("role") === "button") return "button";
  if (/flex|grid/.test(cs.display)) return "stack";
  const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
  if (ownText && Array.from(el.children).every((c) => INLINE.test(c.tagName))) return "text";
  return "box";
}

function fieldFor(prop: string): Field | undefined {
  for (const g of FIELDS) for (const f of g.fields) if (f.prop === prop) return f;
  return undefined;
}

let allOpen = false;
try {
  allOpen = localStorage.getItem("spark:all-props") === "1";
} catch {
  // Storage off: starts folded.
}

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

/** Props that hold content or wiring, not a look: never part of a variant. */
const NOT_VARIANT = new Set([
  "children", "className", "style", "id", "key", "ref", "value", "defaultValue", "label", "title", "name", "text",
  "placeholder", "alt", "href", "src", "htmlFor", "role", "tabIndex", "type", "autoComplete", "lang", "dir", "form",
  "target", "rel", "as", "to", "icon",
]);

/**
 * The props that pick a variant, in the order written: short lowercase
 * words (`variant="ghost"`, `size="sm"`) and flags that are on (`small`).
 * Content (labels, numbers, handlers, children) isn't a variant.
 */
function variantOf(props: Record<string, unknown> | null | undefined): Variant | undefined {
  if (!props) return undefined;
  const out: Variant = {};
  for (const [k, v] of Object.entries(props)) {
    if (NOT_VARIANT.has(k) || /^(on[A-Z]|data-|aria-)/.test(k)) continue;
    if (v === true) out[k] = true;
    else if (typeof v === "string" && /^[a-z][a-z0-9-]{0,15}$/.test(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
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
    const variant = variantOf(f.memoizedProps);
    owners.push({ name, call: typeof call === "string" ? call : null, key: f.key ?? null, ...(variant ? { variant } : {}) });
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

/** A variant as JSX props: `variant="ghost" small`. */
function variantJsx(v: Variant): string {
  return Object.entries(v)
    .map(([k, x]) => (x === true ? k : `${k}="${x}"`))
    .join(" ");
}

/** A variant in a word or two: "ghost small". */
function variantName(v: Variant): string {
  return Object.entries(v)
    .map(([k, x]) => (x === true ? k : x))
    .join(" ");
}

/** What an override's scope means, in words (stored with the change for whoever applies it). */
function scopeWords(path: PathEntry[], scope: number | null, variant?: Variant): string {
  const comp = path[0]?.name ?? "?";
  const at = (e: PathEntry) => `${e.name}${e.key !== null ? ` (key ${e.key})` : ""} at ${e.call ?? "root"}`;
  if (scope === null) return `only this instance: ${path.map(at).join(", inside ")}`;
  if (scope === 0 && variant && Object.keys(variant).length)
    return `the "${variantName(variant)}" variant of ${comp}: every <${comp} ${variantJsx(variant)}> (with any other props), wherever ${comp} styles that variant`;
  if (scope === 0) return `the ${comp} component itself: every ${comp} everywhere, variants included`;
  const via = path.slice(0, scope).map((e) => e.call ?? "?").join(" → ");
  return `in ${path[scope].name}: every ${comp} it renders through ${via}`;
}

/**
 * One step of the chain an edit can go to, widest first: the component
 * itself (base), each variant (`ghost`, then `ghost small`), this one.
 */
type Step = { key: string; scope: number | null; variant?: Variant; label: string; words: string };

/** The chain for an element with this owner path. */
function chainOf(path: PathEntry[]): Step[] {
  if (!path.length) return [];
  const comp = path[0].name;
  const steps: Step[] = [{ key: "base", scope: 0, label: comp, words: `every ${comp}, variants included` }];
  const entries = Object.entries(path[0].variant ?? {});
  for (let i = 1; i <= entries.length; i++) {
    const variant = Object.fromEntries(entries.slice(0, i)) as Variant;
    steps.push({ key: `v${i}`, scope: 0, variant, label: variantName(variant), words: `every <${comp} ${variantJsx(variant)}>` });
  }
  steps.push({ key: "one", scope: null, label: "This one", words: "only this instance" });
  return steps;
}

/** Where an override sits on its element's chain (or an owner scope from older lists). */
function stepKey(inst: Change["instance"]): string {
  const scope = inst?.scope ?? null;
  if (scope === null) return "one";
  if (scope > 0) return `in${scope}`;
  const n = Object.keys(inst?.variant ?? {}).length;
  return n ? `v${n}` : "base";
}

/** Same scope and the same variant. */
function sameStep(a: Change["instance"] | { scope: number | null; variant?: Variant }, b: { scope: number | null; variant?: Variant }): boolean {
  const key = (v: Variant | undefined) => JSON.stringify(Object.entries(v ?? {}).sort());
  return (a?.scope ?? null) === b.scope && key(a?.variant) === key(b.variant);
}

/** An override's step, named for the inspector: "Button", "ghost small", "this one", "every Button in Card". */
function stepLabel(c: Change): string {
  const path = pathFor(c);
  const key = stepKey(c.instance);
  if (key === "one") return "this one";
  if (key === "base") return path[0]?.name ?? "?";
  if (key.startsWith("v")) return variantName(c.instance?.variant ?? {});
  const k = c.instance?.scope ?? 0;
  return `every ${path[0]?.name ?? "?"} in ${path[k]?.name ?? "?"}`;
}

/** How many elements on screen a step of this element's chain reaches. */
function coverCount(path: PathEntry[], step: Step): number {
  if (step.scope === null) return 1;
  const comp = path[0]?.name;
  const src = selected?.getAttribute("data-spark-src");
  if (!src) return 1;
  let n = 0;
  for (const x of Array.from(document.querySelectorAll(`[data-spark-src="${CSS.escape(src)}"]`))) {
    if (skip(x)) continue;
    const p = instancePath(x);
    if (p[0]?.name === comp && Object.entries(step.variant ?? {}).every(([k, v]) => p[0].variant?.[k] === v)) n++;
  }
  return Math.max(n, 1);
}

/** The step new edits to `path` go to: the one picked, else the element's own variant (or the base). */
function targetStep(path: PathEntry[]): Step | null {
  const chain = chainOf(path);
  if (!chain.length) return null;
  return chain.find((s) => s.key === editTarget) ?? chain.at(-2)!;
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
/**
 * The Ask popup: a small chat with Claude about the selected element (one
 * Claude session per element), the prompt at the bottom naming the selection.
 */
const ASK_STYLE = `
    .ask {
      position: fixed; display: none; flex-direction: column; width: 340px; pointer-events: auto; padding: 6px;
      background: var(--sp-surface); border: 1px solid var(--sp-line-strong); border-radius: 10px;
      box-shadow: 0 12px 36px #0008, 0 2px 6px #0006;
      color: var(--sp-text); font: var(--sp-fs-md)/1.45 var(--sp-font);
    }
    .ask-top { display: none; align-items: center; gap: 6px; height: 22px; padding: 0 2px 0 6px; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
    .ask.has-chat .ask-top { display: flex; }
    .ask-top .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ask-top .model {
      margin-left: 6px; padding: 2px 6px; border-radius: var(--sp-r-sm); background: var(--sp-field);
      color: var(--sp-text); font: 500 var(--sp-fs-xs)/1 var(--sp-font);
    }
    .ask-top button {
      height: 20px; padding: 0 6px; border: none; background: none; color: var(--sp-text-dim); font: 500 var(--sp-fs-sm)/1 var(--sp-font); border-radius: var(--sp-r-sm);
    }
    .ask-top button:hover { background: var(--sp-field); color: var(--sp-text-strong); }
    .ask-thread {
      display: none; flex-direction: column; gap: 8px; max-height: 260px; overflow-y: auto; margin: 2px 0 6px; padding: 4px 4px 2px;
      scrollbar-width: thin; scrollbar-color: var(--sp-line-strong) transparent;
    }
    .ask.has-chat .ask-thread { display: flex; }
    /* No ligatures: replies are full of code, and the UI font may draw "--" as a dash. */
    .msg { max-width: 92%; overflow-wrap: anywhere; user-select: text; font-feature-settings: "liga" 0, "calt" 0; }
    .msg.user { white-space: pre-wrap; }
    .msg.user {
      align-self: flex-end; padding: 5px 9px; border-radius: 10px 10px 3px 10px;
      background: color-mix(in srgb, var(--sp-accent) 22%, var(--sp-field)); color: var(--sp-text-strong);
    }
    .msg.claude { align-self: flex-start; padding: 1px 2px; color: var(--sp-text); }
    .msg.claude.bad { color: var(--sp-danger); }
    .msg.work { display: flex; align-items: center; gap: 8px; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
    .msg.work .line { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--sp-mono); }
    .msg.work button { flex: none; height: 20px; padding: 0 6px; font-size: var(--sp-fs-sm); }
    .ask-main {
      display: flex; align-items: center; gap: 4px; height: 34px; padding: 0 4px 0 5px;
      background: var(--sp-bg); border: 1px solid var(--sp-line); border-radius: var(--sp-r-lg);
    }
    .ask-main:focus-within { border-color: var(--sp-accent); }
    .ask-tag {
      flex: none; display: inline-flex; align-items: center; gap: 5px; max-width: 150px; height: 22px; padding: 0 7px 0 6px;
      border-radius: var(--sp-r-sm); white-space: nowrap; cursor: default;
      /* --role: the selection's color (ROLE_COLOR), so the chip matches its box on the canvas. */
      background: color-mix(in srgb, var(--role, var(--sp-accent)) 18%, transparent); color: color-mix(in srgb, var(--role, var(--sp-accent)) 55%, #fff);
      font: 600 var(--sp-fs-sm)/1 var(--sp-font);
    }
    .ask-tag .nm { flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
    .ask-tag .in { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--sp-text-dim); font-weight: 500; }
    .ask-main input {
      flex: 1; min-width: 0; height: 100%; padding: 0 4px; border: none; background: none; outline: none;
      color: var(--sp-text-strong); font: var(--sp-fs-md) var(--sp-font);
    }
    .ask-main input::placeholder { color: var(--sp-text-dim); }
    .ask-main input:focus { outline: none; border: none; }
    .ask-main input:disabled { opacity: 1; }
    .ask .ib {
      flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0;
      border: none; background: none; color: var(--sp-text-dim); border-radius: var(--sp-r-md);
    }
    .ask .ib:hover { background: var(--sp-line); color: var(--sp-text-strong); }
    .ask .ib.send { background: var(--sp-line-strong); color: var(--sp-text-dim); }
    .ask .ib.send.ready { background: var(--sp-accent); color: var(--sp-text-strong); }
`;

const STYLE = `${THEME}
    :host { all: initial; }
    * { box-sizing: border-box; }
    .box { position: fixed; pointer-events: none; display: none; }
    .bm { position: fixed; pointer-events: none; display: none; box-sizing: border-box; border-style: solid; }
    .bm.margin { border-color: var(--sp-margin); }
    .bm.padding { border-color: var(--sp-padding); }
    .hover { outline: 1px dashed var(--hov, var(--sp-accent)); background: color-mix(in srgb, var(--hov, var(--sp-accent)) 8%, transparent); }
    .selected { outline: 2px solid var(--sel, var(--sp-accent)); }
    .tag {
      position: fixed; display: none; pointer-events: none;
      font: 600 var(--sp-fs-sm)/1 var(--sp-font);
      background: var(--tag, var(--sp-accent)); color: var(--sp-text-strong); padding: 3px 6px; border-radius: var(--sp-r-sm); white-space: nowrap;
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
    .run-line { display: flex; align-items: center; gap: 8px; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); min-width: 0; }
    .run-line .last { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--sp-mono); font-size: var(--sp-fs-xs); }
    .spin {
      width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--sp-line-strong); border-top-color: var(--sp-accent);
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    ${ASK_STYLE}
    /* A chat's pin: a speech-bubble badge on the element's top-right corner, like a comment. */
    .pin {
      position: fixed; display: none; width: 22px; height: 22px; padding: 0; pointer-events: auto; cursor: pointer;
      align-items: center; justify-content: center; border: 2px solid var(--sp-bg); border-radius: 50% 50% 50% 2px;
      background: var(--sp-accent); color: var(--sp-text-strong); box-shadow: 0 2px 8px #0008;
      transform-origin: 0 100%;
    }
    .pin:hover { filter: brightness(1.12); }
    .pin.busy::after {
      content: ""; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--sp-accent);
      animation: spin .8s linear infinite;
    }
    .all-head {
      display: flex; align-items: center; width: 100%; margin-top: var(--sp-4); padding: var(--sp-2) 0; border: none; border-top: 1px solid var(--sp-line);
      border-radius: 0; background: none; color: var(--sp-text-dim); font-weight: 600; text-align: left;
    }
    .all-head::before { content: "▸"; margin-right: 6px; }
    .all-head.open::before { content: "▾"; }
    .all-head:hover { color: var(--sp-text-strong); }
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
    .instance { margin: var(--sp-2) 0 var(--sp-1); padding: var(--sp-2); border-radius: var(--sp-r-md); background: var(--sp-surface); }
    .instance .crumbs { margin-bottom: var(--sp-2); line-height: 1.5; }
    .instance .crumbs b { color: var(--sp-text-strong); }
    .instance .inst, .instance .sep { color: var(--sp-text-dim); }
    .instance .chain-head { color: var(--sp-text-dim); font-size: var(--sp-fs-xs); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--sp-1); }
    .instance .chain { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
    .instance .chain .sep { color: var(--sp-text-dim); padding: 0 2px; }
    .instance .chain .step {
      display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: var(--sp-r-sm);
      border: 1px solid var(--sp-line); background: transparent; color: var(--sp-text); font: 500 var(--sp-fs-sm)/1.2 var(--sp-font); cursor: pointer;
    }
    .instance .chain .step:hover { border-color: var(--sp-line-strong); color: var(--sp-text-strong); }
    .instance .chain .step.base { color: var(--sp-component); }
    .instance .chain .step.on { background: var(--sp-accent); border-color: var(--sp-accent); color: #fff; }
    .instance .chain .step.one.on { background: var(--sp-warn); border-color: var(--sp-warn); }
    .instance .crumbs { margin-top: var(--sp-2); line-height: 1.5; font-size: var(--sp-fs-sm); }
    .instance .edits { margin-top: var(--sp-2); border-top: 1px solid var(--sp-line); padding-top: var(--sp-2); }
    .instance .edits-head { display: flex; align-items: center; gap: var(--sp-2); color: var(--sp-text-dim); font-size: var(--sp-fs-sm); margin-bottom: var(--sp-1); }
    .instance .edits-head span { flex: 1; }
    .instance .edits-head .push {
      padding: 2px 8px; border-radius: var(--sp-r-sm); border: 1px solid var(--sp-accent); background: transparent;
      color: var(--sp-accent); font: 500 var(--sp-fs-xs)/1.4 var(--sp-font); cursor: pointer;
    }
    .instance .edits-head .push:hover { background: var(--sp-accent); color: #fff; }
    .instance .edit-line { display: flex; align-items: center; gap: var(--sp-1); padding: 2px 0; }
    .instance .edit-line code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--sp-fs-xs) var(--sp-mono); color: var(--sp-text); }
    .instance .edit-line select { width: auto; max-width: 45%; padding: 1px 4px; font-size: var(--sp-fs-xs); }
    .instance .edit-line.one code { color: var(--sp-warn); }
    .instance .edit-line .tb { border: none; background: transparent; color: var(--sp-text-dim); cursor: pointer; padding: 2px; display: inline-flex; }
    .instance .edit-line .tb:hover { color: var(--sp-text-strong); }
    .row .k.ov { color: var(--sp-warn); }
    .row .k.ov::after { content: " •"; }
    .row .k.ov.up { color: var(--sp-component); }
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
      background: var(--sp-text-strong); border: 1px solid var(--sel, var(--sp-accent)); pointer-events: auto;
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
    .num { position: relative; }
    .num .unit {
      flex: none; align-self: stretch; display: inline-flex; align-items: center; justify-content: flex-end; min-width: 20px;
      border: none; background: transparent; color: var(--sp-text-dim); padding: 0 6px 0 2px; font: var(--sp-fs-xs) var(--sp-mono);
    }
    .num .unit:hover, .num .unit.open { color: var(--sp-text-strong); }
    .num .unit:focus-visible { outline: none; color: var(--sp-text-strong); }
    /* A keyword stands in for the number. */
    .num.kw input { color: var(--sp-text); font-style: italic; }
    /* Four sides share a row: their unit shows while you edit one. */
    .quad .num .unit { display: none; }
    .quad .num:focus-within .unit { display: inline-flex; }
    /* Dropdowns: Spark's own menu, not the native list. */
    .sel { position: relative; min-width: 0; }
    button.select {
      display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 24px; padding: 0 6px 0 8px; text-align: left;
    }
    button.select .sel-v { flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button.select .sel-h { flex: 1; min-width: 0; color: var(--sp-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button.select > .icon { margin-left: auto; color: var(--sp-text-dim); }
    button.select:hover > .icon, button.select.open > .icon { color: var(--sp-text-strong); }
    button.select.open, button.select:focus-visible { outline: none; border-color: var(--sp-accent); }
    button.select.changed { border-color: var(--sp-warn); }
    .popover.menu { top: calc(100% + 4px); width: max-content; min-width: 100%; max-width: 280px; max-height: 260px; overflow: auto; padding: 4px; z-index: 6; }
    .popover.menu.left { left: 0; right: auto; }
    .popover.menu.right { right: 0; left: auto; min-width: 112px; }
    .popover.menu:focus { outline: none; }
    .menu-group {
      padding: 6px 8px 3px 26px; color: var(--sp-text-dim); font: 600 var(--sp-fs-xs)/1 var(--sp-font); text-transform: uppercase; letter-spacing: .06em;
    }
    .menu-item {
      display: flex; align-items: center; gap: 6px; width: 100%; height: 24px; padding: 0 10px 0 4px; border: none; border-radius: var(--sp-r-sm);
      background: none; color: var(--sp-text); font: var(--sp-fs-md)/1 var(--sp-font); text-align: left; white-space: nowrap;
    }
    .menu-item.active { background: var(--sp-accent); color: var(--sp-text-strong); }
    .menu-check { flex: none; width: 16px; display: inline-flex; justify-content: center; }
    .menu-label { flex: 1; }
    .menu-hint { margin-left: 12px; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
    .menu-item.active .menu-hint { color: #ffffffbb; }
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
    .cp { display: flex; flex-direction: column; gap: 8px; }
    .cp-sv { position: relative; height: 140px; border-radius: var(--sp-r-sm); cursor: crosshair; touch-action: none; }
    .cp-knob {
      position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%;
      border: 2px solid #fff; box-shadow: 0 0 0 1px #0008; pointer-events: none;
    }
    .cp-bar { position: relative; height: 12px; border-radius: 6px; cursor: pointer; touch-action: none; }
    .cp-hue { background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); }
    .cp-alpha { background: repeating-conic-gradient(#808080 0 25%, #c8c8c8 0 50%) 0 0 / 8px 8px; }
    .cp-fill { position: absolute; inset: 0; border-radius: inherit; }
    .cp-thumb {
      position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
      border: 2px solid #fff; box-shadow: 0 0 0 1px #0008; pointer-events: none;
    }
    .cp-fields { display: grid; grid-template-columns: 1fr 56px; gap: 6px; }
    .cp-fields input { width: 100%; }
    .toast { color: var(--sp-warn); font-size: var(--sp-fs-sm); margin-top: 6px; }
    .row .k .link { font-size: inherit; }
    ${MARKDOWN_STYLE}
    ${VARIABLES_STYLE}
    ${PAGE_STYLE}`;
shadow.append(h("style", {}, STYLE));


const hoverBox = h("div", { class: "box hover" });
const selectBox = h("div", { class: "box selected" });
// The selection's margin and padding, tinted like devtools' box model.
const marginBox = h("div", { class: "bm margin" });
const paddingBox = h("div", { class: "bm padding" });
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
  footer,
);
panel.addEventListener("click", () => closePopover());
const fab = h("button", { class: "fab", title: "Open Spark (Alt+S)", click: () => setOpen(true) }, "Spark");
// Ask Claude, right on the selection.
const askInput = h("input", { placeholder: "Ask Claude to change this…", spellcheck: "false" }) as HTMLInputElement;
const stopKeys = (e: Event) => e.stopPropagation();
askInput.addEventListener("keyup", stopKeys);
askInput.addEventListener("keypress", stopKeys);
askInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    sendAsk();
  } else if (e.key === "Escape") askInput.blur();
  // Tab stays in the prompt: it neither moves focus to the buttons nor switches mode.
  else if (e.key === "Tab") e.preventDefault();
});
askInput.addEventListener("input", () => sendBtn.classList.toggle("ready", !!askInput.value.trim()));
const makeBtn = h(
  "button",
  {
    class: "ib",
    title: "Make component: have Claude extract this into its own component",
    click: () => {
      askInput.value = "Extract this into its own component called ";
      sendBtn.classList.add("ready");
      askInput.focus();
    },
  },
  lucide("component"),
);
const sendBtn = h("button", { class: "ib send", title: "Ask Claude (Enter)", click: () => sendAsk() }, lucide("arrow-up"));
/** What's selected, as the start of the prompt (it replaces the floating tag label). */
const askTag = h("span", { class: "ask-tag" });
/** The conversation with Claude about the selected element (renderChat fills it). */
const askThread = h("div", { class: "ask-thread" });
const askTitle = h("span", { class: "grow" }, "Claude");
const newChatBtn = h("button", { type: "button", title: "Start over with a new Claude session; this chat stays in Chats", click: () => resetChat() }, "New chat");
const askTop = h("div", { class: "ask-top" }, askTitle, newChatBtn);
const askBox = h("div", { class: "ask" }, askTop, askThread, h("div", { class: "ask-main" }, askTag, askInput, makeBtn, sendBtn));
askBox.addEventListener("click", () => closePopover());
/** Pins on the elements that have a chat with Claude (refreshPins/placePins). */
const pinLayer = h("div", { class: "pins" });
shadow.append(marginBox, paddingBox, hoverBox, selectBox, ...handles, tagLabel, pinLayer);
// In the viewport shell the panel lives outside the zoomed frame (mode.ts).
const panelHost = shell ? document.createElement("spark-panel") : host;
const panelRoot = shell ? panelHost.attachShadow({ mode: "open" }) : shadow;
if (shell) {
  panelHost.style.cssText = host.style.cssText;
  panelRoot.append(h("style", {}, STYLE));
}
panelRoot.append(panel, fab);
// On the board the popup lives in the shell too, so it can sit outside a small
// frame (over the canvas) instead of on top of the element it's about.
panelRoot.append(askBox);

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
/**
 * Where the next edit to the selection goes: a `Step` key on its chain
 * ("base", "v1"…, "one"), or null for its own level (see `targetStep`).
 * Back to null whenever the selection changes.
 */
let editTarget: string | null = null;
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

/** Alt is held: the selection shows its margin and padding. */
let altHeld = false;
{
  const track = (e: KeyboardEvent) => {
    if (e.altKey !== altHeld) {
      altHeld = e.altKey;
      placeBoxModel();
    }
  };
  const drop = () => {
    altHeld = false;
    placeBoxModel();
  };
  // Keys go to the app's document or, on the board, to the shell's.
  for (const doc of shell ? [document, window.parent.document] : [document]) {
    doc.addEventListener("keydown", track, true);
    doc.addEventListener("keyup", track, true);
  }
  window.addEventListener("blur", drop);
  // This page's functions die with it: don't leave them on the shell.
  if (shell)
    window.addEventListener("pagehide", () => {
      window.parent.document.removeEventListener("keydown", track, true);
      window.parent.document.removeEventListener("keyup", track, true);
    });
}

/** Tint the selection's margin (outside) and padding (inside) while Alt is held. */
function placeBoxModel() {
  const show = altHeld && !!selected && selected.isConnected && picking && !editing;
  if (!show) {
    marginBox.style.display = paddingBox.style.display = "none";
    return;
  }
  const r = selected!.getBoundingClientRect();
  const cs = getComputedStyle(selected!);
  const px = (v: string) => Math.max(0, parseFloat(v) || 0);
  const [mt, mr, mb, ml] = [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].map(px);
  const [bt, br, bb, bl] = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(px);
  const [pt, pr, pb, pl] = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px);
  Object.assign(marginBox.style, {
    display: mt || mr || mb || ml ? "block" : "none",
    left: `${r.left - ml}px`,
    top: `${r.top - mt}px`,
    width: `${r.width + ml + mr}px`,
    height: `${r.height + mt + mb}px`,
    borderWidth: `${mt}px ${mr}px ${mb}px ${ml}px`,
  });
  Object.assign(paddingBox.style, {
    display: pt || pr || pb || pl ? "block" : "none",
    left: `${r.left + bl}px`,
    top: `${r.top + bt}px`,
    width: `${Math.max(0, r.width - bl - br)}px`,
    height: `${Math.max(0, r.height - bt - bb)}px`,
    borderWidth: `${pt}px ${pr}px ${pb}px ${pl}px`,
  });
}

function placeHandles() {
  placeBoxModel();
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

// Selection colors say what an element is: blue for the page's own markup,
// purple for the component a component frame shows (its definition), pink
// for an instance of a component or anything inside one.
type Role = "plain" | "definition" | "instance";
const ROLE_COLOR: Record<Role, string> = { plain: "var(--sp-accent)", definition: "var(--sp-component)", instance: "var(--sp-instance)" };
/** The component a component frame shows ("/src/ui/Meter.spark.tsx" → "Meter"). */
const frameComponent = (() => {
  const q = new URLSearchParams(location.search);
  const file = q.get("spark") === "components" ? q.get("file") : null;
  return file ? file.split("/").pop()!.replace(/\.spark\.[jt]sx?$/, "") : null;
})();

function roleOf(el: Element): Role {
  const comp = el.getAttribute("data-spark-comp");
  if (comp && comp === frameComponent) return "definition";
  // The outermost tagged element is the page's own markup (App, or a case).
  let top = el;
  for (let p = el.parentElement?.closest("[data-spark-comp]"); p; p = p.parentElement?.closest("[data-spark-comp]")) top = p;
  return !comp || comp === top.getAttribute("data-spark-comp") ? "plain" : "instance";
}

/** Color the overlay part `prop` (--sel, --hov, --tag) for `el`. */
function roleColor(prop: string, el: Element | null) {
  if (el) host.style.setProperty(prop, ROLE_COLOR[roleOf(el)]);
  else host.style.removeProperty(prop);
}

function label(el: Element | null) {
  roleColor("--tag", el);
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
  roleColor("--hov", el);
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
  if (el !== selected) editTarget = null;
  if (editing) stopTextEdit(true);
  if (el) view = "inspect";
  markTab();
  selected = el;
  roleColor("--sel", el);
  rememberSelection(el);
  if (!el) restoreKey = null;
  place(selectBox, el);
  placeHandles();
  label(el);
  render();
  shell?.setSelected?.(window, !!el);
  placePins();
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
  }
  keepSelection(performance.now());
  placeAsk();
  if (++frame % 30 === 0) {
    renderOverrides();
    rekeySelection();
    refreshPins();
  } else placePins();
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
  // Like a prefab: the edit goes to a step of the element's chain (its own
  // variant unless the inspector picks another), on top of anything wider.
  const step = targetStep(path);
  const scope = step?.scope ?? null;
  const variant = step?.variant;
  const want = { scope, variant };
  let mine = overridesOn(el).filter((c) => c.property === prop);
  // A narrower override of this property on this element would hide the edit
  // here (it wins over a wider one): the edit replaces it, so what you change
  // is what you see. Narrower ones that don't cover this element stay.
  for (const c of mine.filter((c) => breadth(c.instance) > breadth(want))) revert(c.id);
  mine = mine.filter((c) => breadth(c.instance) <= breadth(want));
  const existing = mine.filter((c) => sameStep(c.instance, want)).at(-1);
  if (existing) {
    record({ ...existing, to: value || existing.from });
  } else {
    // Starts from what's applied further out, if anything.
    const upstream = mine.filter((c) => breadth(c.instance) < breadth(want)).at(-1);
    const from = upstream?.to ?? authored(el, matchedRules(el, skip), prop) ?? getComputedStyle(el).getPropertyValue(prop);
    record({
      level: "instance",
      property: prop,
      from,
      to: value || from,
      file: null,
      selector: null,
      element,
      instance: {
        component: path[0]?.name ?? element.comp ?? "?",
        call: path[0]?.call ?? null,
        path,
        scope,
        ...(variant ? { variant } : {}),
        appliesTo: scopeWords(path, scope, variant),
      },
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
  | { type: "start"; kind: "implement" | "ask"; ids: string[]; chat?: string }
  | { type: "log"; text: string }
  | { type: "session"; sessionId: string; model?: string; chat?: string }
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
  const selection = el ? { ...snapshot(el), owners: instancePath(el), text: (el.textContent ?? "").trim().slice(0, 200), label: askOn?.label } : null;
  import.meta.hot?.send("spark:ask", { request, selection, chat: el ? askOn?.key : undefined });
  askInput.value = "";
  sendBtn.classList.remove("ready");
  askInput.blur();
}

/** The selection's name for the popup: the component when it's an instance's root
 * element ("Button in Primary"), else the element ("h2 in Card"). */
function askName(el: Element, path: PathEntry[]): { name: string; owner: string | null; comp: boolean } {
  const parent = el.parentElement?.closest("[data-spark-src]");
  const pp = parent ? instancePath(parent) : [];
  const isRoot = path.length > 0 && (pp.length !== path.length || pp[0]?.name !== path[0].name);
  if (isRoot) return { name: path[0].name, owner: path[1]?.name ?? null, comp: true };
  const cls = el.classList[0];
  return { name: el.tagName.toLowerCase() + (cls ? `.${cls}` : ""), owner: path[0]?.name ?? null, comp: false };
}

/** The element the popup is on: its chat key and what it's called. */
let askOn: { key: string; label: string } | null = null;

/** An element's chat: where it's written plus the instance it is (owners, list keys), so a
 * conversation stays with one element across reloads, and each list item has its own. */
function chatKey(el: Element, path: PathEntry[]): string {
  const at = path.map((p) => `${p.name}@${p.call ?? "root"}${p.key !== null ? `#${p.key}` : ""}`).join(">");
  return `${el.tagName.toLowerCase()}@${el.getAttribute("data-spark-src") ?? ""}|${at}`;
}

// ---------------------------------------------------------------------------
// Finding an element again
//
// A key (chatKey) names an element by where it's written and which instance it
// is. When Claude edits a file, the lines in it shift and React may replace the
// element, so the selection and chats find it again by what doesn't change: the
// file and the components above it (with list keys), taking the candidate whose
// lines moved least.

function keyParts(key: string) {
  const bar = key.indexOf("|");
  const head = bar < 0 ? key : key.slice(0, bar);
  const at = bar < 0 ? "" : key.slice(bar + 1);
  // "h2@src/ui/Card.tsx:6:7" (keys from before the tag was in them have no "h2@").
  const tagged = head.match(/^([a-z][\w-]*)@(.*)$/i);
  const src = tagged ? tagged[2] : head;
  const m = src.match(/^(.*):(\d+):(\d+)$/);
  const entries = at ? at.split(">") : [];
  return {
    tag: tagged ? tagged[1].toLowerCase() : null,
    file: m ? m[1] : src,
    names: entries.map((e) => e.replace(/@[^#]*/, "")).join(">"),
    lines: [m ? Number(m[2]) : 0, ...entries.map((e) => Number(e.match(/:(\d+):\d+(?:#|$)/)?.[1] ?? 0))],
  };
}

/** How far an element's lines may have moved and still be the same one. */
const MAX_SHIFT = 60;

/** The element on the page that `key` names: that exact one, else the closest match. */
function findByKey(key: string): Element | null {
  const want = keyParts(key);
  let best: Element | null = null;
  let bestD = Infinity;
  for (const el of Array.from(document.querySelectorAll(`[data-spark-src^="${CSS.escape(want.file)}:"]`))) {
    const k = chatKey(el, instancePath(el));
    if (k === key) return el;
    const got = keyParts(k);
    if (got.file !== want.file || got.names !== want.names || got.lines.length !== want.lines.length) continue;
    if (want.tag && got.tag !== want.tag) continue;
    const d = got.lines.reduce((sum, l, i) => sum + Math.abs(l - want.lines[i]), 0);
    if (d <= MAX_SHIFT && d < bestD) {
      bestD = d;
      best = el;
    }
  }
  return best;
}

/** A chat saved under this element's old key (its lines moved): file it under the new one. */
function adoptChat(el: Element, key: string) {
  const file = keyParts(key).file;
  const moved = new Set<string>();
  for (const c of chats) {
    if (c.key === key || moved.has(c.key) || keyParts(c.key).file !== file || findByKey(c.key) !== el) continue;
    moved.add(c.key);
    import.meta.hot?.send("spark:chat-move", { from: c.key, to: key });
  }
  for (const c of chats) if (moved.has(c.key)) c.key = key;
}

/** The chat the popup shows on an element: its open one (the last that "New chat" didn't close). */
function openChatOn(key: string): Chat | undefined {
  return chats.filter((c) => c.key === key && !c.closed).at(-1);
}

/** The pins: one per chat whose element is on this page. Rebuilt now and then (follow). */
let pins: { key: string; el: Element; node: HTMLElement }[] = [];
function refreshPins() {
  const show = open && picking;
  const next: typeof pins = [];
  if (show) {
    const keys = new Set(chats.filter((c) => !c.closed && c.messages.length).map((c) => c.key));
    for (const key of keys) {
      const el = findByKey(key);
      if (!el) continue;
      const k = chatKey(el, instancePath(el));
      if (k !== key) adoptChat(el, k);
      const old = pins.find((p) => p.key === k);
      const node =
        old?.node ??
        h("button", {
          class: "pin",
          type: "button",
          click: (e: Event) => {
            e.stopPropagation();
            const at = pins.find((p) => p.node === node)?.el;
            if (!at?.isConnected) return;
            select(at);
            askInput.focus();
          },
        }, lucide("message-circle", 12));
      const chat = openChatOn(k) ?? openChatOn(key);
      if (!chat) continue;
      const lastClaude = [...chat.messages].reverse().find((m) => m.role === "claude");
      node.title = `Chat with Claude about ${chat.label || "this element"}${lastClaude ? `\n${lastClaude.text.split("\n")[0].slice(0, 120)}` : ""}`;
      next.push({ key: k, el, node });
    }
  }
  pins = next;
  pinLayer.replaceChildren(...pins.map((p) => p.node));
  placePins();
}
function placePins() {
  // Pins stay out of the way of a selection: with one (here or in another frame), only the
  // selected element's own pin shows.
  const none = !selected && !shell?.selectedElsewhere?.(window);
  for (const p of pins) {
    const visible = p.el.isConnected && (none || p.el === selected);
    p.node.style.display = visible ? "inline-flex" : "none";
    p.node.classList.toggle("busy", isRunning() && !!runChat && chats.find((c) => c.id === runChat)?.key === p.key);
    if (!visible) continue;
    const r = p.el.getBoundingClientRect();
    // The pin's bottom-left corner sits on the element's top-right one.
    p.node.style.left = `${r.right}px`;
    p.node.style.top = `${r.top - 22}px`;
  }
}

// ---------------------------------------------------------------------------
// The selection survives Claude's edits and reloads

/** This frame's own place to remember its selection (frames on the board share an origin). */
const SEL_STORE = `spark:selection:${(shell && window.frameElement?.getAttribute("data-spark-frame")) || ""}${location.pathname}${location.search}`;
/** The selected element's key, to find it again when React replaces it. */
let selKey: string | null = null;
/** When the selected element went missing, to give up on it after a moment. */
let lostSince = 0;
/** A selection from before this page reloaded, to bring back once the app is up. */
let restoreKey: string | null = (() => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SEL_STORE) ?? "null") as { key: string; at: number } | null;
    return saved && Date.now() - saved.at < 10 * 60_000 ? saved.key : null;
  } catch {
    return null;
  }
})();
const restoreUntil = performance.now() + 8000;

function rememberSelection(el: Element | null) {
  selKey = el ? chatKey(el, instancePath(el)) : null;
  lostSince = 0;
  try {
    if (selKey) sessionStorage.setItem(SEL_STORE, JSON.stringify({ key: selKey, at: Date.now() }));
    else sessionStorage.removeItem(SEL_STORE);
  } catch {
    // Storage off: a reload drops the selection.
  }
}

/** Fast Refresh can keep the selected node and only move its lines: follow its new key,
 * so the popup keeps showing its chat (the pins re-file the chat under that key). */
function rekeySelection() {
  if (!selected?.isConnected || !selKey) return;
  const key = chatKey(selected, instancePath(selected));
  if (key === selKey) return;
  rememberSelection(selected);
  render();
}

/** Every frame: find a selection React replaced, or one from before a reload. */
function keepSelection(now: number) {
  if (selected && !selected.isConnected) {
    const again = selKey ? findByKey(selKey) : null;
    if (again) {
      // The same element, re-rendered: keep where edits go, the view and the chat.
      selected = again;
      rememberSelection(again);
      place(selectBox, again);
      placeHandles();
      render();
    } else if (!lostSince) lostSince = now;
    else if (now - lostSince > 1500) select(null);
    return;
  }
  if (restoreKey && !selected && open && picking) {
    const el = findByKey(restoreKey);
    if (el) {
      restoreKey = null;
      select(el);
    } else if (now > restoreUntil) restoreKey = null;
  }
}

/** Fill the popup for the selection: its name, then its conversation. */
function renderAsk(el: Element, path: PathEntry[], kind: Kind) {
  const n = askName(el, path);
  const r = el.getBoundingClientRect();
  askTag.style.setProperty("--role", ROLE_COLOR[roleOf(el)]);
  askTag.title = `<${el.tagName.toLowerCase()}> ${Math.round(r.width)}×${Math.round(r.height)} · ${path.map((o) => o.name).join(" › ") || "no component"}`;
  askTag.replaceChildren(lucide(n.comp ? "component" : KIND_ICON[kind], 12), h("span", { class: "nm" }, n.name), ...(n.owner ? [h("span", { class: "in" }, `in ${n.owner}`)] : []));
  const key = chatKey(el, path);
  const label = n.owner ? `${n.name} in ${n.owner}` : n.name;
  adoptChat(el, key);
  if (askOn?.key !== key) {
    askOn = { key, label };
    renderChat();
  }
}

type ChatMessage = { role: "user" | "claude"; text: string; ok?: boolean; at: number };
/** One chat with Claude about an element (chats.ts on the dev server). */
type Chat = { id: string; key: string; label: string; sessionId: string | null; model?: string; messages: ChatMessage[]; created: number; updated: number; closed?: boolean };

/** "claude-sonnet-5-5" (or with a date) as people say it: "Sonnet 5.5". */
function modelName(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[.*\])?$/i);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}
/** The model answering the running chat, as soon as its session starts. */
let runModel: string | null = null;
/** Every chat (.spark/chats.json), kept in step by the dev server. */
let chats: Chat[] = [];
/** The chat Claude is answering right now (its id), if the run is one. */
let runChat: string | null = null;

/** The conversation on the selected element, with Claude's progress while it answers. */
function renderChat() {
  const chat = askOn ? openChatOn(askOn.key) : undefined;
  const answering = isRunning() && !!chat && runChat === chat.id;
  const msgs = chat?.messages ?? [];
  askBox.classList.toggle("has-chat", msgs.length > 0 || answering);
  const model = (answering && runModel) || chat?.model;
  askTitle.replaceChildren("Claude", ...(model ? [h("span", { class: "model" }, modelName(model))] : []));
  askTitle.title = [model, chat?.sessionId && `session ${chat.sessionId}`].filter(Boolean).join(" · ");
  newChatBtn.toggleAttribute("disabled", answering);
  // Claude writes Markdown; the person's own words stay as typed.
  const nodes: HTMLElement[] = msgs.map((m) =>
    m.role === "claude" ? h("div", { class: `msg claude md${m.ok === false ? " bad" : ""}` }, markdown(m.text)) : h("div", { class: "msg user" }, m.text),
  );
  if (answering) {
    nodes.push(
      h(
        "div",
        { class: "msg work" },
        h("span", { class: "spin" }),
        h("span", { class: "line grow" }, run?.lines.at(-1) ?? "Thinking…"),
        h("button", { type: "button", click: () => import.meta.hot?.send("spark:stop", {}) }, "Stop"),
      ),
    );
  }
  const stick = askThread.scrollHeight - askThread.scrollTop - askThread.clientHeight < 24;
  askThread.replaceChildren(...nodes);
  if (stick || answering) askThread.scrollTop = askThread.scrollHeight;
  const busy = isRunning();
  askInput.placeholder = busy ? (answering ? "Claude is answering…" : "Claude is busy…") : msgs.length ? "Reply…" : "Ask Claude to change this…";
  sendBtn.toggleAttribute("disabled", busy);
}

function resetChat() {
  if (!askOn) return;
  import.meta.hot?.send("spark:chat-new", { chat: askOn.key });
  askInput.focus();
}

type Box = { l: number; t: number; r: number; b: number };

/**
 * Where the popup goes so it never covers the element: to its left (a chat
 * reads beside what it's about), else right, else above or below; only an
 * element bigger than the room around it gets the popup over it, pinned to
 * the side with more room.
 */
function placeBeside(e: Box, w: number, hgt: number, room: Box, gap: number): { x: number; y: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  const cx = clamp((e.l + e.r) / 2 - w / 2, room.l, room.r - w);
  const cy = clamp(e.t, room.t, room.b - hgt);
  if (e.l - gap - w >= room.l) return { x: e.l - gap - w, y: cy };
  if (e.r + gap + w <= room.r) return { x: e.r + gap, y: cy };
  if (e.t - gap - hgt >= room.t) return { x: cx, y: e.t - gap - hgt };
  if (e.b + gap + hgt <= room.b) return { x: cx, y: e.b + gap };
  return { x: cx, y: e.t - room.t >= room.b - e.b ? room.t : room.b - hgt };
}

/**
 * The popup sits next to the selection, out of its way (placeBeside). On the
 * board it lives in the shell, over the canvas, at its screen size: the
 * element's box is mapped out of its zoomed frame, and the room is the
 * canvas, so a small component frame doesn't squeeze it onto the element.
 */
function placeAsk() {
  const show = open && picking && !!selected && selected.isConnected && !editing && !resizing;
  const hide = () => {
    askBox.style.display = "none";
  };
  if (!show) return hide();
  const el = selected!;
  const r = el.getBoundingClientRect();
  let e: Box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
  let room: Box;
  const fe = shell ? (window.frameElement as HTMLElement | null) : null;
  if (fe) {
    const f = fe.getBoundingClientRect();
    const z = fe.offsetWidth ? f.width / fe.offsetWidth : 1;
    // Only the part of the element its frame shows.
    e = {
      l: Math.max(f.left, f.left + e.l * z),
      t: Math.max(f.top, f.top + e.t * z),
      r: Math.min(f.right, f.left + e.r * z),
      b: Math.min(f.bottom, f.top + e.b * z),
    };
    const c = (fe.closest(".canvas") ?? fe.ownerDocument.documentElement).getBoundingClientRect();
    room = { l: c.left, t: c.top, r: c.right, b: c.bottom };
  } else {
    room = { l: 0, t: 0, r: window.innerWidth - (open ? PANEL_W : 0), b: window.innerHeight };
  }
  // Scrolled or panned out of sight: no popup.
  if (e.r <= room.l || e.l >= room.r || e.b <= room.t || e.t >= room.b || e.r <= e.l || e.b <= e.t) return hide();
  // The popup names the selection, so its floating label goes (unless something else is hovered).
  if (!hovered || hovered === el) tagLabel.style.display = "none";
  askBox.style.display = "flex";
  const pad = 8;
  const inner = { l: room.l + pad, t: room.t + pad, r: room.r - pad, b: room.b - pad };
  const { x, y } = placeBeside(e, askBox.offsetWidth, askBox.offsetHeight, inner, 10);
  askBox.style.left = `${Math.round(x)}px`;
  askBox.style.top = `${Math.round(y)}px`;
}

/** Claude's runs show in the Chats list; the panel only says one is going (renderChanges). */
function renderRun() {
  renderChanges();
}

import.meta.hot?.on("spark:run", (e: RunEvent) => {
  if (e.type === "start") {
    run = { kind: e.kind, lines: [] };
    runChat = e.chat ?? null;
    runModel = null;
  } else if (!run) run = { kind: "implement", lines: [] };
  if (e.type === "session") runModel = e.model ?? null;
  if (e.type === "log") run.lines.push(e.text);
  if (e.type === "done") run.done = e;
  if (e.type === "error") run.error = e.text;
  if (e.type === "done" || e.type === "error") runChat = null;
  renderRun();
  renderChanges();
  renderChat();
});
// An element's conversation changed (a prompt, Claude's reply, New chat).
import.meta.hot?.on("spark:chats", (d: { chats: Chat[] }) => {
  chats = d.chats;
  rekeySelection();
  renderChat();
  refreshPins();
});
// Claude marked changes applied: their previews give way to the real code.
import.meta.hot?.on("spark:log", (log: ChangeLog) => {
  load(log.changes);
  renderOverrides();
  resetHistory();
  render();
});
import.meta.hot?.on("spark:run-state", (s: { running: boolean; chat?: string | null }) => {
  if (s.running && !run) {
    run = { kind: s.chat ? "ask" : "implement", lines: [] };
    runChat = s.chat ?? null;
    renderRun();
    renderChat();
  }
});
import.meta.hot?.send("spark:run-state", {});

// ---------------------------------------------------------------------------
// The panel's contents

/** The closest element around `el` that's written in owner `k` of its path. */
function ownerElement(el: Element, path: PathEntry[], k: number): Element | null {
  for (let x = el.parentElement; x; x = x.parentElement) {
    if (!x.hasAttribute("data-spark-src")) continue;
    const p = instancePath(x);
    if (p[0]?.name === path[k].name && p.length === path.length - k) return x;
  }
  return null;
}

/**
 * Where edits go, as the chain they can go to (click a step to edit there):
 * the component, its variants, this one. Then the owners around it (click one
 * to select it), and the edits on this element, each movable along the chain.
 */
function instanceHeader(el: Element, path: PathEntry[]): HTMLElement {
  const box = h("div", { class: "instance" });
  if (path.length === 0) {
    box.append(h("div", { class: "hint" }, "Not inside a component Spark knows; edits apply to this element."));
    return box;
  }
  const chain = chainOf(path);
  const step = targetStep(path)!;
  const steps = h("div", { class: "chain" });
  chain.forEach((s, i) => {
    if (i > 0) steps.append(h("span", { class: "sep" }, "›"));
    const b = h(
      "button",
      { class: `step${s.key === step.key ? " on" : ""}${s.key === "base" ? " base" : ""}${s.key === "one" ? " one" : ""}`, type: "button", title: `Edit ${s.words}` },
      s.key === "base" ? lucide("component", 12) : null,
      s.label,
    );
    b.addEventListener("click", () => {
      editTarget = s.key;
      render();
    });
    steps.append(b);
  });
  const n = coverCount(path, step);
  const words = step.key === "one" ? "Edits change only this one" : `Edits change ${step.words} · ${n} on screen`;
  box.append(h("div", { class: "chain-head" }, h("span", {}, "Edits go to")), steps, h("div", { class: "hint" }, words));

  if (path.length > 1) {
    const name = (e: PathEntry) => e.name + (e.key !== null ? ` [${e.key}]` : "");
    const crumbs = h("div", { class: "crumbs" }, h("span", { class: "inst" }, "Used in "));
    path.slice(1).forEach((e, i) => {
      const k = i + 1;
      const target = ownerElement(el, path, k);
      if (i > 0) crumbs.append(h("span", { class: "sep" }, " › "));
      crumbs.append(
        target
          ? h("span", { class: "link", title: `Select ${e.name}${e.call ? ` (rendered at ${e.call})` : ""}`, click: () => select(target) }, name(e))
          : h("span", { title: e.call ?? "" }, name(e)),
      );
    });
    box.append(crumbs);
  }

  // The edits on this element, narrowest first: what this step changes against the one above it.
  const mine = [...overridesOn(el)].reverse();
  if (mine.length) {
    const list = h("div", { class: "edits" });
    const here = mine.filter((c) => sameStep(c.instance, step));
    const parent = chain[chain.findIndex((s) => s.key === step.key) - 1];
    const head = h("div", { class: "edits-head" }, h("span", {}, `Edits on this ${path[0].name}`));
    if (here.length && parent) {
      const push = h("button", { class: "push", type: "button", title: `Move ${here.length === 1 ? "this edit" : `these ${here.length} edits`} to ${parent.words}` }, `Apply all to ${parent.label}`);
      push.addEventListener("click", () => {
        for (const c of here) applyTo(c.id, parent.scope, scopeWords(path, parent.scope, parent.variant), parent.variant);
        editTarget = parent.key;
        changed();
      });
      head.append(push);
    }
    list.append(head);
    for (const c of mine) list.append(editLine(c, chain, path));
    box.append(list);
  }
  return box;
}

/** One edit on the selection: what it changes, and the step it lives on (pick another to move it). */
function editLine(c: Change, chain: Step[], path: PathEntry[]): HTMLElement {
  const what = c.property === "text" ? `text "${c.to}"` : c.property === "removed" ? "removed" : c.property === "children-order" ? "children order" : `${c.property}: ${c.to}`;
  const key = stepKey(c.instance);
  const sel = h("select", { title: "Where this edit lives: pick another step to move it" }) as HTMLSelectElement;
  const known = chain.some((s) => sameStep(c.instance, s));
  if (!known) sel.append(h("option", { value: "", selected: true }, stepLabel(c)));
  for (const s of chain) sel.append(h("option", { value: s.key, selected: known && sameStep(c.instance, s) }, s.key === "one" ? "this one" : s.label));
  sel.addEventListener("change", () => {
    const s = chain.find((x) => x.key === sel.value);
    if (!s) return;
    applyTo(c.id, s.scope, scopeWords(path, s.scope, s.variant), s.variant);
    changed();
  });
  const revertBtn = h("button", { class: "tb", type: "button", title: "Revert this edit" }, lucide("rotate-ccw", 12));
  revertBtn.addEventListener("click", () => {
    revert(c.id);
    changed();
  });
  return h("div", { class: `edit-line ${key === "one" ? "one" : key === "base" ? "base" : "variant"}`, title: `${c.property}: ${c.from || "unset"} → ${c.to}` }, h("code", {}, what), sel, revertBtn);
}

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

  body.append(instanceHeader(el, path));

  /** What a field shows: the pending edit, else the source's value (instance: falling back to computed). */
  const overrides = overridesOn(el);
  const valueOf = (prop: string): { value: string; changed: boolean } => {
    const c = overrides.filter((x) => x.property === prop).at(-1);
    // Computed lengths come with long fractions (108.641px); two decimals is plenty.
    const computed = cs.getPropertyValue(prop).replace(/(\.\d\d)\d+/g, "$1");
    if (c) overridden.set(prop, c);
    return { value: c?.to ?? authored(el, rules, prop) ?? computed, changed: !!c };
  };
  const overridden = new Map<string, Change>();
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

  /** One property's row in the panel. */
  const fieldRow = (f: Field): HTMLElement => {
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
      return row(f.prop, quadVar, resolvedLine(values.join(" "), computeds.join(" "), jumpToVariable));
    }
    const { value, changed } = valueOf(f.prop);
    const computed = cs.getPropertyValue(f.prop);
    let field: HTMLElement;
    if (f.kind === "number") field = numberField(value, { computed, step: f.step, unit: f.unit, min: f.min, keywords: f.keywords, changed }, onValue(f.prop));
    else if (f.kind === "select") field = selectField(value || computed, f.options, changed, onValue(f.prop), f.prop === "font-weight" ? WEIGHTS : {});
    else if (f.kind === "color") field = colorField(value, computed, colors, changed, onValue(f.prop));
    else field = textField(value, changed, onValue(f.prop));
    if (f.kind !== "select") {
      const prop = f.prop;
      field = withVar(field, f.kind === "color" ? "color" : f.kind === "number" ? "size" : null, value, computed, (v) => edit(el, prop, v, true));
    }
    const notes = [resolvedLine(value, computed, jumpToVariable), inheritLine(f.prop, changed)].filter((x): x is HTMLElement => !!x);
    return row(f.prop, field, notes.length ? h("div", {}, ...notes) : null);
  };

  // The essentials for this kind of element first; everything else, by category, under "All properties".
  const kind = kindOf(el, cs);
  const essentials = ESSENTIALS[kind].map(fieldFor).filter((f): f is Field => !!f);
  body.append(h("h3", {}, KIND_LABEL[kind]));
  for (const f of essentials) body.append(fieldRow(f));
  const toggle = h("button", { class: `all-head${allOpen ? " open" : ""}`, title: "Every property, by category" }, "All properties");
  toggle.addEventListener("click", () => {
    allOpen = !allOpen;
    try {
      localStorage.setItem("spark:all-props", allOpen ? "1" : "0");
    } catch {
      // Not remembered.
    }
    render();
  });
  body.append(toggle);
  if (allOpen) {
    for (const { group, fields } of FIELDS) {
      const rest = fields.filter((f) => !essentials.includes(f));
      if (!rest.length) continue;
      body.append(h("h3", {}, group));
      for (const f of rest) body.append(fieldRow(f));
    }
  }
  renderAsk(el, path, kind);
  // Mark the fields an override sets, and say where it lives.
  const target = targetStep(path) ?? { scope: null };
  for (const k of Array.from(body.querySelectorAll<HTMLElement>(".row > .k[title]"))) {
    const name = k.title;
    const c = overridden.get(name) ?? SIDES.map((side) => overridden.get(`${name}-${side}`)).find(Boolean);
    if (!c) continue;
    // Set on the step edits go to (or narrower): this level's own diff. Wider: it comes from the parent.
    const own = breadth(c.instance) >= breadth(target);
    k.classList.add("ov");
    if (!own) k.classList.add("up");
    k.title = own ? `${name}: changed on ${stepLabel(c)}` : `${name}: comes from ${stepLabel(c)}`;
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

/** Where an override lives: a step of its chain, or (style overrides) one of the CSS rules that match it. */
function scopeSelect(c: Change): HTMLElement {
  const path = pathFor(c);
  const el = coveredElements(c)[0];
  // The chain of an element it covers (its variant props), else of the path it was made on.
  const chain = chainOf(el ? instancePath(el) : path);
  const sel = h("select", { title: "Where this change lives" }) as HTMLSelectElement;
  const known = chain.some((s) => sameStep(c.instance, s));
  if (!known) sel.append(h("option", { value: "", selected: true }, stepLabel(c)));
  for (const s of chain) sel.append(h("option", { value: s.key, selected: known && sameStep(c.instance, s) }, s.key === "one" ? "Only this one" : `${s.label}: ${s.words}`));
  const rules = el && !["text", "children-order", "removed"].includes(c.property) ? matchedRules(el, skip) : [];
  for (const [i, m] of [...rules.entries()].reverse()) sel.append(h("option", { value: `rule:${i}` }, `Move to CSS rule ${m.selector} · ${shortFile(m.file)}`));
  sel.addEventListener("change", () => {
    if (sel.value.startsWith("rule:")) {
      const m = rules[Number(sel.value.slice(5))];
      applyToRule(c.id, rel(m.file), m.selector, m.rule.style.getPropertyValue(c.property));
    } else {
      const s = chain.find((x) => x.key === sel.value);
      if (!s) return;
      applyTo(c.id, s.scope, scopeWords(el ? instancePath(el) : path, s.scope, s.variant), s.variant);
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
  // A run going: what Claude is doing now, and Stop. Its transcript and result are in the Chats list.
  if (run?.kind === "implement" && isRunning()) {
    implementBtn.replaceChildren("Stop");
    implementBtn.disabled = false;
    implementBtn.title = "Stop Claude";
    implementBtn.onclick = (e) => {
      e.stopPropagation();
      import.meta.hot?.send("spark:stop", {});
    };
    footer.append(h("div", { class: "run-line" }, h("span", { class: "spin" }), h("span", {}, "Implementing… (Chats has the details)"), h("span", { class: "last" }, run.lines.at(-1) ?? "")));
  }
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
    const kind = c.level === "instance" ? `on ${stepLabel(c)}` : c.level === "component" ? "css rule" : "variable";
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
    // The Chats list (sidebar.ts): is a chat's element in this frame, and open it here.
    findChat: (key) => !!findByKey(key),
    openChat: (key) => {
      const el = findByKey(key);
      if (!el) return null;
      select(el);
      askInput.focus();
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
  });
} else if (reopen) setOpen(true);
requestAnimationFrame(follow);

import.meta.hot?.on("spark:ready", (info: { name: string; root: string; changes: ChangeLog | null; chats?: Chat[] }) => {
  chats = Array.isArray(info.chats) ? info.chats : [];
  renderChat();
  root = info.root;
  status.textContent = info.name;
  if (info.changes) load(info.changes.changes);
  resetHistory();
  render();
});
import.meta.hot?.send("spark:hello", {});
