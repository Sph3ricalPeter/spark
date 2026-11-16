// The Spark client: runs inside the app being edited, in dev only.
//
// Everything lives in one Shadow DOM so the app's CSS and Spark's never mix.
// No React here on purpose: the app's React and ours would share a page.
//
// Alt+S opens or closes the panel. View mode (the default) leaves the app
// alone. Edit mode (the Edit toggle, Tab, or Alt+E):
// - hover highlights, click selects (the app doesn't see the click),
//   Arrow Up selects the parent (up to the variant box and the frame itself);
//   Esc steps out one level at a time (popover, text edit, selection) but
//   never leaves edit mode: only Tab (or Alt+E) switches back to view; in the
//   empty chat prompt (a chat pin focuses it) one Esc leaves it and the selection;
// - the selection has handles: drag them to resize (Shift keeps the ratio
//   on a corner, Alt drags slower; sizes stay whole pixels);
// - double-click text to edit it in place; Enter or Esc keeps the edit.
// The panel's fields scrub (drag the ↔ grip, Alt slower, Shift ×10; whole px), colors
// open token swatches and a picker, keyword properties are dropdowns.
//
// Edits are previewed live and recorded as changes (see changes.ts), which
// the dev server saves to .spark/changes.json.
import { installFont } from "./fonts.ts";
import { getState, setState } from "./state.ts";
import "./settings.ts";
import { scanSystem } from "./system.ts";
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
import { iconLabel, iconMarkup, iconPreview, openIconPicker, sourceIcon, svgRoot } from "./icons.ts";
import { closePopover, colorField, colorTokens, displayColor, h, menuButton, numberField, selectField, textField, type OnValue } from "./fields.ts";
import { frameGlue } from "./frame.ts";
import { words as caseTitle } from "./gallery.ts";
import { markdown, MARKDOWN_STYLE } from "./markdown.ts";
import { shell, type Layer } from "./mode.ts";
import { blockFileDrops, blockNativeMenu, openMenu, type MenuEntry } from "./menu.ts";
import { installReorder } from "./reorder.ts";
import { draftVariable, renderVariables, resolvedLine, varButton, VARIABLES_STYLE, type Variable, type VarKind, type VarTarget } from "./variables.ts";
import { INHERITED, PAGE_STYLE, inheritedFrom, isPageSelector, pageRules, renderPage } from "./page.ts";
import type { RuleRef } from "./css.ts";

const PANEL_W = 340;

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
type Kind = "text" | "button" | "input" | "icon" | "media" | "stack" | "box";
const KIND_LABEL: Record<Kind, string> = { text: "Text", button: "Button", input: "Field", icon: "Icon", media: "Image", stack: "Layout", box: "Box" };
/** The properties people change most on each kind, first in the inspector and in the Ask popup. */
const ESSENTIALS: Record<Kind, string[]> = {
  text: ["color", "font-size", "font-weight", "line-height", "text-align", "margin"],
  button: ["background-color", "color", "border-radius", "font-size", "font-weight", "padding"],
  input: ["background-color", "color", "border-color", "border-radius", "font-size", "padding"],
  icon: ["width", "height", "color", "opacity"],
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
  icon: "smile",
  media: "image",
  stack: "rows-2",
  box: "square",
};
const INLINE = /^(B|I|EM|STRONG|SMALL|CODE|BR|SPAN|A|SUB|SUP|MARK|ABBR|KBD|S|U)$/;

function kindOf(el: Element, cs: CSSStyleDeclaration): Kind {
  const tag = el.tagName;
  if (tag.toLowerCase() === "svg") return "icon";
  if (/^(IMG|VIDEO|CANVAS|PICTURE|IFRAME)$/.test(tag)) return "media";
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

/** Which of the inspector's folding sections are open, remembered with the project (state.ts). */
const sectionsOpen: Record<string, boolean> = { changes: true, all: false, vars: false, owners: false, rules: false };
Object.assign(sectionsOpen, getState<Record<string, boolean>>("sections"));

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
/** A component frame (gallery.ts): its cases are the components and their variants themselves, not uses of them. */
const inComponentFrame = new URLSearchParams(location.search).get("spark") === "components";

/**
 * The step new edits to `path` go to: the one picked, else, like a prefab,
 * this one instance (an override that never reaches the component unless
 * applied upstream). Editing a case in a component frame is editing the
 * component's own definition, so there the default is its variant (or base),
 * which flows down to every instance.
 */
function targetStep(path: PathEntry[]): Step | null {
  const chain = chainOf(path);
  if (!chain.length) return null;
  return chain.find((s) => s.key === editTarget) ?? (inComponentFrame ? chain.at(-2)! : chain.at(-1)!);
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
    /* Images attached to the next message (pasted, dropped or picked), and the ones a sent message carried. */
    .ask-files { display: none; flex-wrap: wrap; gap: 6px; margin: 0 2px 6px; }
    .ask.has-files .ask-files { display: flex; }
    .ask-files .file { position: relative; width: 52px; height: 52px; }
    .ask-files img, .msg .imgs img {
      display: block; width: 100%; height: 100%; object-fit: cover; border-radius: var(--sp-r-md);
      border: 1px solid var(--sp-line-strong); background: var(--sp-field);
    }
    .ask-files .rm {
      position: absolute; top: -6px; right: -6px; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0;
      border: 1px solid var(--sp-line-strong); border-radius: 50%; background: var(--sp-surface); color: var(--sp-text-strong);
    }
    .ask-files .rm:hover { background: var(--sp-line-strong); }
    .msg.user .imgs { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 4px; white-space: normal; }
    .msg.user.only-imgs .imgs { margin: 0; }
    .msg.user .imgs a { display: block; width: 72px; height: 72px; cursor: zoom-in; }
    .msg.user.only-imgs { padding: 3px; }
    /* Dragging an image over the chat: it's dropped into the message. */
    .ask.dropping .ask-main { border-color: var(--sp-accent); background: color-mix(in srgb, var(--sp-accent) 12%, var(--sp-bg)); }
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
    .ask-more {
      flex: none; display: inline-flex; align-items: center; height: 22px; padding: 0 6px; border-radius: var(--sp-r-sm); cursor: default;
      background: var(--sp-field); color: var(--sp-text); font: 600 var(--sp-fs-sm)/1 var(--sp-font);
    }
    .msg.user .with { margin-top: 2px; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
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

/**
 * On the board the panel and the Ask chat are columns on the right (shell.ts):
 * the inspector, and rightmost the chat, each as wide as the board's resize
 * grips say (--sp-panel-w, --sp-chat-w), under the title bar (--sp-panel-top).
 */
const COLUMN_STYLE = `
    .panel.in-shell { right: var(--sp-chat-w, 340px); width: var(--sp-panel-w, ${PANEL_W}px); }
    .panel.in-shell > header { display: none; }
    .panel.in-shell .tabs { display: flex; align-items: center; gap: 2px; height: 40px; padding: 0 8px; flex: none; }
    .panel.in-shell .tabs button {
      height: 26px; padding: 0 8px; border: none; border-radius: var(--sp-r-sm); background: transparent;
      color: var(--sp-text-dim); font: 500 var(--sp-fs-md)/1 var(--sp-font);
    }
    .panel.in-shell .tabs button:hover { color: var(--sp-text-strong); background: var(--sp-field); }
    .panel.in-shell .tabs button.on { color: var(--sp-text-strong); background: var(--sp-line-strong); }
    .ask.column {
      top: var(--sp-panel-top, 0px); right: 0; bottom: 0; left: auto; width: var(--sp-chat-w, 340px); padding: 0;
      background: var(--sp-bg); border: none; border-left: 1px solid var(--sp-line); border-radius: 0; box-shadow: none;
    }
    .ask.column .ask-top, .ask.column.has-chat .ask-top {
      display: flex; flex: none; height: 40px; padding: 0 8px 0 14px; border-bottom: 1px solid var(--sp-line);
      color: var(--sp-text-strong); font: 600 var(--sp-fs-md)/1 var(--sp-font);
    }
    .ask.column .ask-thread { display: flex; flex: 1; min-height: 0; max-height: none; margin: 0; padding: 12px 14px; gap: 10px; }
    .ask.column .ask-main { flex: none; margin: 0 10px 10px; height: 38px; }
    .ask.column .ask-files { margin: 0 10px 8px; }
    .ask.column .chat-empty { margin: auto 0; padding: 0 8px; text-align: center; color: var(--sp-text-dim); }
    .ask.column .chat-empty b { color: var(--sp-text); font-weight: 600; }
    /* The Chats button: the column switches to the list of every chat and back. */
    .ask-top .chats-btn { display: inline-flex; align-items: center; gap: 5px; height: 24px; }
    .ask-top .chats-btn .n { color: var(--sp-text-dim); font: var(--sp-fs-xs) var(--sp-mono); }
    .ask-top .chats-btn.on { background: var(--sp-line-strong); color: var(--sp-text-strong); }
    .ask-list { display: none; }
    .ask.column.listing .ask-list { display: block; flex: 1; min-height: 0; }
    .ask.column.listing .ask-thread, .ask.column.listing .ask-main, .ask.column.listing .ask-files { display: none; }
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
    /* The frame itself: drawn inside its edges, and hovering it doesn't tint the whole page. */
    .box.inset.hover { outline-offset: -1px; background: none; }
    .box.inset.selected { outline-offset: -2px; }
    .tag {
      position: fixed; display: none; pointer-events: none;
      font: 600 var(--sp-fs-sm)/1 var(--sp-font);
      background: var(--tag, var(--sp-accent)); color: var(--sp-text-strong); padding: 3px 6px; border-radius: var(--sp-r-sm); white-space: nowrap;
    }
    /* The selection's measurements, centered under it like Figma's size badge. */
    .dims {
      position: fixed; display: none; pointer-events: none; align-items: center; gap: 6px;
      transform: translateX(-50%); transform-origin: 0 0;
      font: 600 var(--sp-fs-sm)/1 var(--sp-font); font-variant-numeric: tabular-nums;
      background: var(--sel, var(--sp-accent)); color: var(--sp-text-strong); padding: 3px 6px; border-radius: var(--sp-r-sm); white-space: nowrap;
    }
    .dims span { display: inline-flex; align-items: center; gap: 3px; }
    .dims span + span { padding-left: 6px; border-left: 1px solid color-mix(in srgb, var(--sp-text-strong) 35%, transparent); }
    .dims .icon { opacity: .8; }
    .panel {
      position: fixed; top: var(--sp-panel-top, 0px); right: 0; bottom: 0; width: var(--sp-panel-w, ${PANEL_W}px);
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
    ${COLUMN_STYLE}
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
    /* Folding sections: one header style for every group below the essentials. */
    .sec { margin-top: var(--sp-3); border-top: 1px solid var(--sp-line); }
    .sec + .sec { margin-top: 0; }
    .sec.open { padding-bottom: var(--sp-2); }
    .sec-head {
      display: flex; align-items: center; gap: 6px; width: 100%; padding: var(--sp-2) 0; border: none; border-radius: 0; background: none;
      color: var(--sp-text-dim); font: 600 var(--sp-fs-sm)/1.2 var(--sp-font); text-transform: uppercase; letter-spacing: .06em; text-align: left;
    }
    .sec-head .icon { transform: rotate(-90deg); transition: transform .12s; }
    .sec-head.open .icon { transform: none; }
    .sec-head:hover { color: var(--sp-text-strong); }
    .sec-title { flex: 1; }
    .sec-count { color: var(--sp-text-dim); font: 500 var(--sp-fs-xs)/1 var(--sp-font); text-transform: none; letter-spacing: 0; }
    .sec > .hint:first-of-type { margin: 0 0 var(--sp-2); }
    h4 { margin: var(--sp-3) 0 var(--sp-1); font: 500 var(--sp-fs-sm)/1.2 var(--sp-font); color: var(--sp-text-dim); }
    .sec-head + h4 { margin-top: 0; }
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
    /* On the board the change list is the sidebar's Changes tab (shell.ts), not the panel's footer. */
    .changes-tab { color: var(--sp-text); font: var(--sp-fs-md)/1.45 var(--sp-font); }
    .changes-tab .footer { border-top: none; max-height: none; overflow: visible; }
    .empty { color: var(--sp-text-dim); }
    h3 { margin: 16px 0 6px; font-size: var(--sp-fs-sm); text-transform: uppercase; letter-spacing: .06em; color: var(--sp-text-dim); }
    h3:first-child { margin-top: 0; }
    .title { font: 600 var(--sp-fs-lg) var(--sp-mono); color: var(--sp-text-strong); word-break: break-all; }
    .el-head { display: flex; align-items: baseline; gap: var(--sp-2); }
    .el-head .title { flex: 1; min-width: 0; }
    .el-head .size { flex: none; color: var(--sp-text-dim); font: var(--sp-fs-sm) var(--sp-mono); }
    .el-src { margin-top: 2px; }
    .link { color: var(--sp-link); cursor: pointer; font-family: var(--sp-mono); font-size: var(--sp-fs-sm); word-break: break-all; }
    .link:hover { text-decoration: underline; }
    /* Names sit level with the field's first line, whatever notes go under it. */
    .row { display: flex; align-items: flex-start; gap: 8px; padding: 2px 0; }
    .row .k { position: relative; color: var(--sp-text-dim); width: 108px; flex: none; line-height: 24px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .v { font-family: var(--sp-mono); font-size: var(--sp-fs-sm); word-break: break-all; }
    .hint { color: var(--sp-text-dim); font-size: var(--sp-fs-sm); margin-top: 4px; }
    .instance { margin: var(--sp-2) 0 var(--sp-1); padding: var(--sp-2); border-radius: var(--sp-r-md); background: var(--sp-surface); }
    .instance .crumbs { margin-bottom: var(--sp-2); line-height: 1.5; }
    .instance .crumbs b { color: var(--sp-text-strong); }
    .instance .inst, .instance .sep { color: var(--sp-text-dim); }
    .instance .chain-head { display: flex; align-items: baseline; color: var(--sp-text-dim); font-size: var(--sp-fs-xs); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--sp-1); }
    .instance .count { color: var(--sp-text-dim); font: 500 var(--sp-fs-xs)/1 var(--sp-font); text-transform: none; letter-spacing: 0; }
    .instance .chain { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
    .instance .chain .sep { color: var(--sp-text-dim); padding: 0 2px; }
    .instance .chain .step {
      display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: var(--sp-r-sm);
      border: 1px solid var(--sp-line); background: transparent; color: var(--sp-text); font: 500 var(--sp-fs-sm)/1.2 var(--sp-font); cursor: pointer;
    }
    .instance .chain .step:hover { border-color: var(--sp-line-strong); color: var(--sp-text-strong); }
    .instance .chain .step.base { color: var(--sp-component); }
    .instance .chain .step.on { background: var(--sp-accent); border-color: var(--sp-accent); color: #fff; }
    /* Selection colors: purple is the component, pink one instance of it. */
    .instance .chain .step.one.on { background: var(--sp-instance); border-color: var(--sp-instance); }
    .instance .crumbs { margin-top: var(--sp-1); line-height: 1.5; font-size: var(--sp-fs-sm); }
    .instance .edits { margin-top: var(--sp-2); border-top: 1px solid var(--sp-line); padding-top: var(--sp-2); }
    .instance .edits-head { display: flex; align-items: center; gap: var(--sp-2); color: var(--sp-text-dim); font-size: var(--sp-fs-sm); margin-bottom: var(--sp-1); }
    .instance .edits-head > span:first-child { flex: 1; }
    .instance .edits-head .push {
      padding: 2px 8px; border-radius: var(--sp-r-sm); border: 1px solid var(--sp-accent); background: transparent;
      color: var(--sp-accent); font: 500 var(--sp-fs-xs)/1.4 var(--sp-font); cursor: pointer;
    }
    .instance .edits-head .push:hover { background: var(--sp-accent); color: #fff; }
    .instance .edit-line { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
    .instance .edit-line .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--sp-warn); }
    .instance .edit-line.up .dot { background: var(--sp-component); }
    .instance .edit-line code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--sp-fs-xs) var(--sp-mono); color: var(--sp-text); }
    .instance .edit-line .sel { flex: none; min-width: 84px; max-width: 45%; }
    .instance .edit-line button.select { height: 20px; padding: 0 4px 0 6px; font-size: var(--sp-fs-xs); background: transparent; border-color: var(--sp-line); }
    .instance .edit-line button.select:hover { border-color: var(--sp-line-strong); }
    .instance .edit-line .tb { border: none; background: transparent; color: var(--sp-text-dim); cursor: pointer; padding: 2px; display: inline-flex; }
    .instance .edit-line .tb:hover { color: var(--sp-text-strong); }
    /* An edited property: orange when the step edits go to sets it, purple when a wider step does.
       The name, a dot in the gutter and the field's border all say the same. */
    .row .k.ov { overflow: visible; color: var(--sp-warn); }
    .row .k.ov::before { content: ""; position: absolute; left: -9px; top: 9px; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
    .row .k.ov.up { color: var(--sp-component); }
    .field .up.changed, .field .up .changed { border-color: var(--sp-component); }
    /* Fields share one height, so rows line up. */
    .field .num, .field .color > input, .field > input { height: 24px; }
    .field .color .swatch, .field .varbtn { width: 24px; height: 24px; }
    .field .resolved-line { flex-wrap: nowrap; white-space: nowrap; overflow: hidden; gap: 6px; }
    .field .resolved-line > * { flex: none; }
    .field .resolved-line .resolved { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
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
    .change.here { background: color-mix(in srgb, var(--sp-accent) 8%, transparent); margin: 0 -12px; padding: 5px 12px; }
    .change code { font: var(--sp-fs-sm) var(--sp-mono); color: var(--sp-text-strong); word-break: break-all; }
    .change button { padding: 0 6px; }
    .here-actions { display: flex; justify-content: flex-end; margin-top: var(--sp-2); }
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
    .pop-title { display: flex; align-items: baseline; gap: 8px; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); margin: 0 0 6px; }
    .pop-name { flex: 1; min-width: 0; display: flex; gap: 6px; justify-content: flex-end; overflow: hidden; white-space: nowrap; }
    .pop-name code { font: var(--sp-fs-xs) var(--sp-mono); color: var(--sp-text-strong); overflow: hidden; text-overflow: ellipsis; }
    .pop-name span { font: var(--sp-fs-xs) var(--sp-mono); }
    .swatches { display: grid; grid-template-columns: repeat(8, 22px); gap: 5px; margin-bottom: 10px; max-height: 160px; overflow: auto; }
    .cp { display: flex; flex-direction: column; gap: 8px; }
    .cp-sv { position: relative; height: 140px; border-radius: var(--sp-r-sm); cursor: crosshair; touch-action: none; }
    .cp-knob {
      position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%;
      border: 2px solid #fff; box-shadow: 0 0 0 1px #0008; pointer-events: none;
    }
    .icon-row { position: relative; display: flex; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-2); }
    .icon-row > .ico { width: 32px; height: 32px; border-radius: var(--sp-r-sm); background: var(--sp-field); border: 1px solid var(--sp-line-strong); color: var(--sp-text-strong); }
    .icon-row > .ico.own { border-color: var(--sp-warn); }
    .icon-row > .ico.up { border-color: var(--sp-component); }
    .ico { display: inline-flex; align-items: center; justify-content: center; flex: none; }
    .icon-name { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .icon-name b { color: var(--sp-text-strong); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .icon-name span { color: var(--sp-text-dim); font: var(--sp-fs-xs) var(--sp-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .icon-swap { flex: none; height: 24px; padding: 0 10px; }
    .popover.icons { top: calc(100% + 4px); left: 0; right: 0; width: auto; display: flex; flex-direction: column; gap: 6px; }
    .ico-tabs { display: flex; flex-wrap: wrap; gap: 2px; }
    .ico-tab { height: 22px; padding: 0 8px; border: 1px solid transparent; background: transparent; color: var(--sp-text-dim); font: 500 var(--sp-fs-sm)/1 var(--sp-font); border-radius: var(--sp-r-sm); cursor: pointer; }
    .ico-tab:hover { color: var(--sp-text-strong); }
    .ico-tab.on { border-color: var(--sp-line-strong); background: var(--sp-field); color: var(--sp-text-strong); }
    .ico-search { height: 24px; }
    .ico-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(32px, 1fr)); gap: 2px; max-height: 232px; overflow: auto; }
    .ico-cell { height: 32px; padding: 0; border: 1px solid transparent; border-radius: var(--sp-r-sm); background: transparent; color: var(--sp-text); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
    .ico-cell:hover { background: var(--sp-field); color: var(--sp-text-strong); }
    .ico-cell.on { border-color: var(--sp-accent); color: var(--sp-text-strong); }
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
/** The selection's size, radius and font size, under it (placeDims). */
const dimsBadge = h("div", { class: "dims" });
const DIRS = ["n", "e", "s", "w", "ne", "nw", "se", "sw"] as const;
type Dir = (typeof DIRS)[number];
const handles = DIRS.map((dir) => h("div", { class: "handle", "data-dir": dir }));
// View: the app works as normal. Edit: hover highlights, clicks select (Tab or Alt+E).
const viewBtn = h("button", { title: "Use the app normally (Tab or Alt+E)" }, "View");
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
// On the board the toolbar's View/Edit switch is right there; the panel doesn't repeat it.
if (shell) modeToggle.style.display = "none";
// On the board the inspector is always open, a column left of the chat (COLUMN_STYLE): no header, no Spark button.
if (shell) panel.classList.add("in-shell");
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
askInput.addEventListener("input", () => syncSend());
/** The send button lights up once there's something to send: words, or an attached image. */
const syncSend = () => sendBtn.classList.toggle("ready", !!askInput.value.trim() || attached.length > 0);

/** Images attached to the next message: pasted (Ctrl+V), dropped on the chat, or picked. They go to Claude with it. */
type Attached = { type: string; data: string; url: string };
let attached: Attached[] = [];
const askFiles = h("div", { class: "ask-files" });
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Longest side Claude gets: it scales bigger images down to about this anyway, and smaller ones send faster. */
const IMAGE_MAX = 2000;

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
  });

/** A picked, pasted or dropped image, as Claude takes it: PNG, JPEG, GIF or WebP, at most IMAGE_MAX px and under 5 MB. */
async function attachImage(file: Blob) {
  if (!file.type.startsWith("image/")) return;
  let url = await readAsDataUrl(file);
  let type = file.type;
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    return;
  }
  const scale = Math.min(1, IMAGE_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  // Anything Claude can't read (BMP, SVG…), too big or too heavy is redrawn: a PNG, or a JPEG if that's still heavy.
  if (!IMAGE_TYPES.includes(type) || scale < 1 || url.length > 3_500_000) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
    type = "image/png";
    url = c.toDataURL(type);
    if (url.length > 3_500_000) {
      type = "image/jpeg";
      url = c.toDataURL(type, 0.9);
    }
  }
  attached.push({ type, data: url.slice(url.indexOf(",") + 1), url });
  renderAttached();
  askInput.focus();
}

function renderAttached() {
  askFiles.replaceChildren(
    ...attached.map((a, i) =>
      h(
        "div",
        { class: "file" },
        h("img", { src: a.url, alt: "Attached image" }),
        h(
          "button",
          {
            type: "button",
            class: "rm",
            title: "Remove",
            click: (e: Event) => {
              e.stopPropagation();
              attached.splice(i, 1);
              renderAttached();
            },
          },
          lucide("x", 11),
        ),
      ),
    ),
  );
  askBox.classList.toggle("has-files", attached.length > 0);
  syncSend();
}

/** The images in a paste or a drop. */
const imagesIn = (dt: DataTransfer | null): File[] =>
  [...(dt?.items ?? [])].filter((it) => it.kind === "file" && it.type.startsWith("image/")).flatMap((it) => it.getAsFile() ?? []);

askInput.addEventListener("paste", (e) => {
  const files = imagesIn(e.clipboardData);
  if (!files.length) return;
  // An image copied from a browser also carries its HTML or URL as text: only the image goes in.
  e.preventDefault();
  for (const f of files) void attachImage(f);
});
const imagePicker = h("input", { type: "file", accept: "image/*", multiple: "" }) as HTMLInputElement;
imagePicker.style.display = "none";
imagePicker.addEventListener("change", () => {
  for (const f of imagePicker.files ?? []) void attachImage(f);
  imagePicker.value = "";
});
const attachBtn = h("button", { type: "button", class: "ib", title: "Attach an image (or paste one, or drop it here)", click: () => imagePicker.click() }, lucide("image"));
const makeBtn = h(
  "button",
  {
    class: "ib",
    title: shell?.breakdown ? "Break down into components: plan them with Claude, then build" : "Make component: have Claude extract this into its own component",
    click: () => {
      const el = askElement();
      if (el && shell?.breakdown) {
        breakdown(el);
        return;
      }
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
/** How many more elements are picked (Shift+click); they go to Claude with the request. */
const askMore = h("span", { class: "ask-more" });
/** The conversation with Claude about the selected element (renderChat fills it). */
const askThread = h("div", { class: "ask-thread" });
const askTitle = h("span", { class: "grow" }, "Claude");
const newChatBtn = h("button", { type: "button", class: "new-chat", title: "Start over with a new Claude session; this chat stays in Chats", click: () => resetChat() }, "New chat");
/** On the board: every chat with Claude, the column's other view (the board's list, mounted here by syncChatsMode). */
const chatsCount = h("span", { class: "n" });
const chatsBtn = h(
  "button",
  { type: "button", class: "chats-btn", title: "Every chat with Claude: switch to another, read or resolve one", click: () => shell?.setChatsOpen?.(!shell.chatsOpen?.()) },
  lucide("message-circle", 13),
  "Chats",
  chatsCount,
);
const askList = h("div", { class: "ask-list" });
const askTop = h("div", { class: "ask-top" }, askTitle, ...(shell ? [chatsBtn] : []), newChatBtn);
const askBox = h(
  "div",
  { class: "ask" },
  askTop,
  askList,
  askThread,
  askFiles,
  h("div", { class: "ask-main" }, askTag, askMore, askInput, attachBtn, imagePicker, makeBtn, sendBtn),
);
askBox.addEventListener("click", () => closePopover());
// Drop images on the chat to attach them.
const dragsFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
askBox.addEventListener("dragover", (e) => {
  if (!dragsFiles(e) || listing) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  askBox.classList.add("dropping");
});
askBox.addEventListener("dragleave", (e) => {
  if (!askBox.contains(e.relatedTarget as Node | null)) askBox.classList.remove("dropping");
});
askBox.addEventListener("drop", (e) => {
  askBox.classList.remove("dropping");
  if (!dragsFiles(e) || listing) return;
  e.preventDefault();
  for (const f of imagesIn(e.dataTransfer)) void attachImage(f);
});
/** Pins on the elements that have a chat with Claude (refreshPins/placePins). */
const pinLayer = h("div", { class: "pins" });
shadow.append(marginBox, paddingBox, hoverBox, selectBox, ...handles, dimsBadge, tagLabel, pinLayer);
// In the viewport shell the panel lives outside the zoomed frame (mode.ts).
const panelHost = shell ? document.createElement("spark-panel") : host;
const panelRoot = shell ? panelHost.attachShadow({ mode: "open" }) : shadow;
if (shell) {
  panelHost.style.cssText = host.style.cssText;
  panelRoot.append(h("style", {}, STYLE));
}
panelRoot.append(panel);
if (!shell) panelRoot.append(fab);
// On the board the change list lives in the sidebar's Changes tab, out of the inspector's way.
const changesHost = shell ? document.createElement("spark-changes") : null;
if (changesHost) {
  changesHost.style.cssText = "display: block; height: 100%;";
  const r = changesHost.attachShadow({ mode: "open" });
  r.append(h("style", {}, STYLE), h("div", { class: "changes-tab" }, footer));
  dropFocus(r);
}
// On the board the chat is the rightmost column, always there (COLUMN_STYLE);
// on a page on its own it's a popup next to the selection.
if (shell) askBox.classList.add("column");
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
 * More elements picked with Shift+click, after `selected` (the first pick).
 * The first one leads: the inspector, the handles and the Ask popup are on it;
 * Ask Claude sends all of them. Each keeps its key (chatKey) to be found again
 * when React replaces it. Any plain selection drops them.
 */
let also: { el: Element; key: string; box: HTMLElement; lostSince: number }[] = [];
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
  // On the board the panels are always open.
  if (shell) v = true;
  open = v;
  panel.classList.toggle("open", v);
  fab.classList.toggle("hidden", v);
  if (shell) shell.setDocked(v);
  else document.documentElement.classList.toggle("spark-docked", v);
  if (!v) {
    select(null);
    setPicking(false);
  }
  setState("panel-open", v);
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

/** One step out on Esc: popover, then selection. Never leaves edit mode (only Tab does). True when something closed. */
function escapeStep(): boolean {
  blurApp();
  if (closePopover()) return true;
  if (selected) {
    select(null);
    return true;
  }
  return false;
}

/**
 * The nearest element we know the source of; else the variant box it's in, else (on the page's own backdrop) the frame.
 * An icon is picked whole: its `<svg>`, not a path in it.
 */
function pickable(node: EventTarget | null): Element | null {
  if (!(node instanceof Element) || host.contains(node)) return null;
  const svg = svgRoot(node);
  if (svg?.hasAttribute("data-spark-src")) return svg;
  return node.closest("[data-spark-src]") ?? node.closest("[data-spark-case]") ?? (isBackdrop(node) ? document.documentElement : null);
}

// ---------------------------------------------------------------------------
// Board targets: the frame itself, and a component frame's variant boxes
//
// Besides the app's elements, the selection can be the whole frame (its page,
// document.documentElement) or, in a component frame, one variant box (a
// case, gallery.ts). They aren't written in the app's source, so they have no
// style fields, handles, drag or delete: they're there to Ask Claude about,
// like any element, with chats of their own.

type Target = { kind: "frame" } | { kind: "case"; name: string; file: string };

/** This frame on the board ("app-1", "c:/src/ui/Meter.spark.tsx"), or "page" outside the board. */
const frameId = (shell && window.frameElement?.getAttribute("data-spark-frame")) || "page";

/** The frame or variant box `el` is, or null for an element of the app. */
function targetOf(el: Element | null): Target | null {
  if (!el) return null;
  if (el === document.documentElement) return { kind: "frame" };
  const name = el.getAttribute("data-spark-case");
  return name === null ? null : { kind: "case", name, file: el.getAttribute("data-spark-case-file") ?? "" };
}

/** The page around the app (html, body, a mount point like #root): what an empty spot of the frame is. */
function isBackdrop(node: Element) {
  return node === document.documentElement || node === document.body || !!node.querySelector("[data-spark-src], [data-spark-case]");
}

/** The frame as the board names it ("App", "App 2", "Meter"). */
function frameTitle(): string {
  return shell?.frameTitle?.(window) || frameComponent || "App";
}

/** What the popup and the chat call a target: "App frame", "Primary in Meter". */
function targetName(t: Target): { name: string; owner: string | null } {
  if (t.kind === "frame") return { name: `${frameTitle()} frame`, owner: null };
  return { name: caseTitle(t.name), owner: t.file.split("/").pop()!.replace(/\.spark\.[jt]sx?$/, "") };
}

/** One step out from `el`: its tagged parent, else its variant box, else the frame (null from the frame). */
function parentOf(el: Element): Element | null {
  if (el === document.documentElement) return null;
  const up = el.parentElement;
  return up?.closest("[data-spark-src]") ?? up?.closest("[data-spark-case]") ?? document.documentElement;
}

/** The outermost elements of the app's source inside `within` (where Claude finds what a target shows). */
function roots(within: Element): { src: string | null; comp: string | null }[] {
  const out: { src: string | null; comp: string | null }[] = [];
  for (const el of Array.from(within.querySelectorAll("[data-spark-src]"))) {
    const up = el.parentElement?.closest("[data-spark-src]");
    if (up && within.contains(up)) continue;
    out.push({ src: el.getAttribute("data-spark-src"), comp: el.getAttribute("data-spark-comp") });
    if (out.length >= 8) break;
  }
  return out;
}

/** What Claude is told a target is (prompt.ts AskSelection.target). */
function targetInfo(t: Target, el: Element) {
  if (t.kind === "case") {
    return { kind: "case" as const, name: t.name, file: t.file.replace(/^\//, ""), component: targetName(t).owner, roots: roots(el) };
  }
  const file = new URLSearchParams(location.search).get("file");
  const cases = Array.from(document.querySelectorAll("[data-spark-case]"), (c) => c.getAttribute("data-spark-case")!);
  return {
    kind: "frame" as const,
    name: frameTitle(),
    frame: inComponentFrame ? ("component" as const) : ("app" as const),
    size: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    ...(inComponentFrame ? { file: file?.replace(/^\//, "") ?? null, component: frameComponent, cases } : { url: location.pathname + location.search }),
    roots: roots(document.body),
  };
}

/** Where `el` is on screen; the frame is its viewport (the page may scroll under it). */
function rectOf(el: Element): DOMRect {
  if (el !== document.documentElement) return el.getBoundingClientRect();
  return new DOMRect(0, 0, el.clientWidth, el.clientHeight);
}

/**
 * Inside a disabled control (dawg's Undo while there's nothing to undo): the
 * browser sends it no click, so picking happens on pointerup instead.
 */
const inDisabled = (node: EventTarget | null) => node instanceof Element && !!node.closest("button:disabled, input:disabled, select:disabled, textarea:disabled, fieldset:disabled");

function place(box: HTMLElement, el: Element | null) {
  if (!el || !el.isConnected) {
    box.style.display = "none";
    return;
  }
  // The frame's outline goes inside its edges, where the frame doesn't clip it.
  box.classList.toggle("inset", el === document.documentElement);
  const r = rectOf(el);
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
  const show = altHeld && !!selected && selected.isConnected && picking && !editing && !targetOf(selected);
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
  const show = !!selected && selected.isConnected && picking && !editing && !targetOf(selected);
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
  placeDims(r);
}

/** A CSS length as the badge shows it: whole pixels, or one decimal when it has one. */
const px = (v: number) => String(Math.round(v * 10) / 10);

/** True when the element shows text of its own (a text node of its own, or a field). */
function hasOwnText(el: Element): boolean {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE && n.textContent!.trim()) return true;
  return false;
}

/** The border radius, if it has one: "6", "50%", or the four corners when they differ. */
function radiusOf(cs: CSSStyleDeclaration): string | null {
  const corners = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => {
    // "8px" or "50%"; an elliptical corner ("8px 4px") shows its first radius.
    const first = v.trim().split(/\s+/)[0] ?? "0";
    const n = parseFloat(first) || 0;
    return { n, text: first.endsWith("%") ? `${px(n)}%` : px(n) };
  });
  if (corners.every((c) => c.n === 0)) return null;
  return corners.every((c) => c.text === corners[0].text) ? corners[0].text : corners.map((c) => c.text).join(" ");
}

let dimsKey = "";
/**
 * The selection's measurements, centered under it like Figma's size badge:
 * width × height, the border radius when it has one, and the font size when
 * it shows text. On the board it keeps its screen size (divided by the zoom)
 * and stays inside the frame: above the element when there's no room below,
 * inside its bottom edge when there's room neither side.
 */
function placeDims(r: DOMRect | null) {
  if (!r || !selected) {
    dimsBadge.style.display = "none";
    dimsKey = "";
    return;
  }
  const cs = getComputedStyle(selected);
  const radius = radiusOf(cs);
  const font = hasOwnText(selected) ? px(parseFloat(cs.fontSize) || 0) : null;
  const key = `${px(r.width)}|${px(r.height)}|${radius}|${font}`;
  if (key !== dimsKey) {
    dimsKey = key;
    const parts: HTMLElement[] = [h("span", { title: "Width × height" }, `${px(r.width)} × ${px(r.height)}`)];
    if (radius) parts.push(h("span", { title: "Border radius" }, lucide("corner", 10), radius));
    if (font) parts.push(h("span", { title: "Font size" }, lucide("type", 10), font));
    dimsBadge.replaceChildren(...parts);
  }
  dimsBadge.style.display = "inline-flex";
  // On the board the overlay is zoomed with the frame; the badge isn't (frame.ts).
  const z = shell?.zoom || 1;
  const w = dimsBadge.offsetWidth / z;
  const hgt = dimsBadge.offsetHeight / z;
  const gap = 6 / z;
  const vw = window.innerWidth - (open && !shell ? PANEL_W : 0);
  const vh = window.innerHeight;
  const top = r.bottom + gap + hgt <= vh ? r.bottom + gap : r.top - gap - hgt >= 0 ? r.top - gap - hgt : Math.max(0, r.bottom - gap - hgt);
  const cx = Math.max(w / 2 + 2 / z, Math.min(r.left + r.width / 2, vw - w / 2 - 2 / z));
  dimsBadge.style.left = `${cx}px`;
  dimsBadge.style.top = `${top}px`;
  dimsBelow = top >= r.bottom ? (gap + hgt) * z : 0;
}
/** How far (on screen) the badge reaches below the selection, for the Ask popup to keep clear of. */
let dimsBelow = 0;

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
  // A variant box, and a component frame as a whole, are the component itself.
  const t = targetOf(el);
  if (t) return t.kind === "case" || inComponentFrame ? "definition" : "plain";
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
  const t = targetOf(el);
  // The frame's title on the board already names it.
  if (t?.kind === "frame") {
    tagLabel.style.display = "none";
    return;
  }
  const r = rectOf(el);
  const comp = el.getAttribute("data-spark-comp");
  const what = t ? `Variant · ${caseTitle(t.name)}` : `${comp ? comp + " · " : ""}${el.tagName.toLowerCase()}`;
  tagLabel.textContent = `${what}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  tagLabel.style.display = "block";
  // Keep it on screen and out from under the panel.
  const maxLeft = window.innerWidth - (open && !shell ? PANEL_W : 0) - tagLabel.offsetWidth - 4;
  tagLabel.style.left = `${Math.max(0, Math.min(r.left, maxLeft))}px`;
  tagLabel.style.top = `${r.top > 22 ? r.top - 20 : r.bottom + 4}px`;
}

function hover(el: Element | null) {
  if (el !== hovered) shell?.setHovered?.(window, el);
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
  stopViewing();
  clearAlso();
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
  shell?.setSelected?.(window, !!el, el);
  placePins();
  if (el) import.meta.hot?.send("spark:select", snapshot(el));
}

/** Shift+click: add an element to the selection, or take it out again. Taking out the
 * first pick hands the lead (inspector, handles, Ask popup) to the next one. */
function toggleSelect(el: Element | null) {
  if (!el) return;
  // A frame or variant box is picked on its own: Shift+click with one on either side starts over.
  if (!selected || targetOf(el) || targetOf(selected)) return select(el);
  if (el === selected) {
    const rest = also;
    also = [];
    const next = rest.shift();
    next?.box.remove();
    select(next?.el ?? null);
    also = rest;
  } else {
    const i = also.findIndex((a) => a.el === el);
    if (i >= 0) also.splice(i, 1)[0].box.remove();
    else {
      const box = h("div", { class: "box selected also" });
      selectBox.before(box);
      also.push({ el, key: chatKey(el, instancePath(el)), box, lostSince: 0 });
    }
  }
  placeAlso(performance.now());
  render();
}

function clearAlso() {
  for (const a of also) a.box.remove();
  also = [];
}

/** Every element selected, the first pick first. */
const selection = (): Element[] => (selected ? [selected, ...also.map((a) => a.el)] : []);

/** Keep the extra picks' boxes on them, and find ones React replaced (or let them go). */
function placeAlso(now: number) {
  also = also.filter((a) => {
    if (!a.el.isConnected) {
      const again = findByKey(a.key);
      if (again && again !== selected && !also.some((b) => b.el === again)) {
        a.el = again;
        a.lostSince = 0;
      } else if (!a.lostSince) a.lostSince = now;
      else if (now - a.lostSince > 1500) {
        a.box.remove();
        return false;
      }
    }
    a.box.style.setProperty("--sel", ROLE_COLOR[roleOf(a.el)]);
    place(a.box, open && !editing ? a.el : null);
    return true;
  });
}

/** The selection as the MCP server will see it. */
function snapshot(el: Element) {
  const r = rectOf(el);
  const t = targetOf(el);
  if (t) {
    return {
      tag: el.tagName.toLowerCase(),
      classes: [] as string[],
      src: null,
      comp: null,
      owners: [] as PathEntry[],
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      rules: [] as { selector: string; file: string | null; css: string }[],
      target: targetInfo(t, el),
    };
  }
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
  placeAlso(performance.now());
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

/**
 * Preview `prop: value` as an override on exactly this instance; `final` saves it and refreshes the panel.
 * `prop` is a CSS property, or "icon" (with the new icon's markup in `extra.iconSvg`).
 */
function edit(el: Element, prop: string, value: string, final: boolean, extra: Pick<Change, "iconSvg"> = {}): boolean {
  value = value.trim();
  if (prop !== "icon" && value && !CSS.supports(prop, value)) return false;
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
    record({ ...existing, ...extra, to: value || existing.from });
  } else {
    // Starts from what's applied further out, if anything.
    const upstream = mine.filter((c) => breadth(c.instance) < breadth(want)).at(-1);
    const from =
      upstream?.to ?? (prop === "icon" ? sourceIcon(el) : (authored(el, matchedRules(el, skip), prop) ?? getComputedStyle(el).getPropertyValue(prop)));
    record({
      ...extra,
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
    // Only the main button resizes (a right-click on a handle opens the menu).
    if (!el || p.button !== 0) return;
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
 * Delete (or Backspace) in edit mode: remove the selection (every element picked) from the design.
 * Like any override it starts on this instance only; the Changes list can
 * apply it upstream (every instance) or revert it. The selection moves to
 * the parent.
 */
function removeSelected() {
  const el = selected;
  // A frame or variant box isn't in the app's source: nothing to remove.
  if (!el || targetOf(el)) return;
  // Shift+click picks go too.
  for (const x of selection()) {
    if (targetOf(x)) continue;
    const path = instancePath(x);
    record({
      level: "instance",
      property: "removed",
      from: "",
      to: "removed",
      file: null,
      selector: null,
      element: elementInfo(x),
      instance: { component: path[0]?.name ?? "?", call: path[0]?.call ?? null, path, scope: null, appliesTo: scopeWords(path, null) },
    });
  }
  select(el.parentElement?.closest("[data-spark-src]") ?? null);
  changed();
}

const isDelete = (e: KeyboardEvent) => (e.key === "Delete" || e.key === "Backspace") && !e.altKey && !e.ctrlKey && !e.metaKey;

// ---------------------------------------------------------------------------
// Claude: "Implement changes" and "Ask Claude" run the local claude CLI on the
// dev server, each run a chat (claude.ts); progress comes back as spark:run events.

type RunEvent =
  | { type: "start"; kind: "implement" | "ask"; ids: string[]; chat?: string }
  | { type: "log"; text: string }
  | { type: "session"; sessionId: string; model?: string; chat?: string }
  | { type: "done"; ok: boolean; applied: string[]; skipped: { id: string; why: string }[]; summary: string; cost?: number }
  | { type: "error"; text: string };

let run: { kind: "implement" | "ask"; lines: string[]; done?: Extract<RunEvent, { type: "done" }>; error?: string } | null = null;
const isRunning = () => !!run && !run.done && !run.error;

/** Have Claude apply the pending changes, or only those with these ids. */
function implement(ids?: string[]) {
  if (isRunning()) return;
  import.meta.hot?.send("spark:implement", ids ? { ids } : {});
}

/** The prompt is sent: it and its images are cleared. */
function clearAsk() {
  askInput.value = "";
  attached = [];
  renderAttached();
  askInput.blur();
}

function sendAsk() {
  const request = askInput.value.trim();
  if ((!request && !attached.length) || isRunning()) return;
  const images = attached.length ? { images: attached.map(({ type, data }) => ({ type, data })) } : {};
  // A reply in a chat with no element: it carries on that chat's Claude session.
  const v = viewed();
  if (v) {
    if (v.closed) import.meta.hot?.send("spark:chat-open", { id: v.id });
    import.meta.hot?.send("spark:ask", { request, selection: null, chat: v.key, ...images });
    clearAsk();
    return;
  }
  const el = askElement();
  // A frame or variant box isn't one element: no owners or text, just its target.
  const about = (x: Element, label?: string) => {
    const own = targetOf(x) ? {} : { owners: instancePath(x), text: (x.textContent ?? "").trim().slice(0, 200) };
    return { ...snapshot(x), ...own, label: label ?? askLabel(x, instancePath(x)) };
  };
  // The chat stays with the first pick; the others go along as context.
  const others = also.filter((a) => a.el.isConnected).map((a) => about(a.el));
  import.meta.hot?.send("spark:ask", {
    request,
    selection: el ? about(el, askOn?.label) : null,
    chat: el ? askOn?.key : undefined,
    ...(el && others.length ? { others } : {}),
    ...images,
  });
  clearAsk();
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

/** What a chat calls an element: "Button in Primary", "h2 in Card". */
function askLabel(el: Element, path: PathEntry[]): string {
  const t = targetOf(el);
  const n = t ? targetName(t) : askName(el, path);
  return n.owner ? `${n.name} in ${n.owner}` : n.name;
}

/** The element the popup is on: its chat key and what it's called. */
let askOn: { key: string; label: string } | null = null;
/** On the board: a chat with no element (an Implement changes run, a task) opened from the Chats list. The column
 * shows it instead of the selection's chat until something is selected or it's closed (stopViewing). */
let viewing: string | null = null;
const viewed = () => (viewing ? chats.find((c) => c.id === viewing) : undefined);

/** Open a chat with no element in the column, like an element's: its conversation, and a reply resumes it. */
function showChat(id: string) {
  viewing = id;
  syncAsk();
  renderChat();
  askInput.focus();
}

/** Back from a chat with no element to the selection's own chat. */
function stopViewing() {
  if (viewing === null) return;
  viewing = null;
  syncAsk();
  renderChat();
}

/** An element's chat: where it's written plus the instance it is (owners, list keys), so a
 * conversation stays with one element across reloads, and each list item has its own. */
function chatKey(el: Element, path: PathEntry[]): string {
  // A frame by its place on the board; a variant box by its case: "@frame:app-1", "@case:/src/ui/Meter.spark.tsx#Loud".
  const t = targetOf(el);
  if (t) return t.kind === "frame" ? `@frame:${frameId}` : `@case:${t.file}#${t.name}`;
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
  if (key.startsWith("@frame:")) return key === `@frame:${frameId}` ? document.documentElement : null;
  if (key.startsWith("@case:")) {
    const i = key.lastIndexOf("#");
    const sel = `[data-spark-case="${CSS.escape(key.slice(i + 1))}"][data-spark-case-file="${CSS.escape(key.slice(6, i))}"]`;
    return i < 0 ? null : document.querySelector(sel);
  }
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
            if (at?.isConnected) openPin(at);
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
  // Only when the pins changed: taking a pin out of the page, even to put it straight
  // back, drops a click pressed on it (refreshPins runs twice a second, see follow).
  const nodes = pins.map((p) => p.node);
  const now = pinLayer.children;
  if (nodes.length !== now.length || nodes.some((n, i) => now[i] !== n)) pinLayer.replaceChildren(...nodes);
  placePins();
}
/** A pin was clicked: its element's chat, with the cursor in the prompt (Esc steps out of both). */
function openPin(el: Element) {
  // The column shows the conversation, not the list, so the prompt can take focus.
  if (listing && shell?.isActive(window)) shell.setChatsOpen?.(false);
  select(el);
  askInput.focus();
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
    const r = rectOf(p.el);
    if (p.el === document.documentElement) {
      // The frame's pin goes inside its top-right corner (it's scaled by 1/zoom about its bottom-left, frame.ts).
      const s = 1 / (shell?.zoom ?? 1);
      p.node.style.left = `${r.right - 28 * s}px`;
      p.node.style.top = `${r.top + 28 * s - 22}px`;
      continue;
    }
    // The pin's bottom-left corner sits on the element's top-right one, kept inside the
    // frame: an element as wide or as high up as the page would put it past the edge, out of reach.
    const s = 1 / (shell?.zoom ?? 1);
    p.node.style.left = `${Math.min(r.right, document.documentElement.clientWidth - 22 * s)}px`;
    p.node.style.top = `${Math.max(r.top, 22 * s) - 22}px`;
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

/**
 * What the chat is about: the selection; on the board with nothing selected,
 * the whole frame (its chat column is always there, so it's never about nothing).
 */
function askElement(): Element | null {
  if (selected?.isConnected) return selected;
  return shell ? document.documentElement : null;
}

/** Point the chat at what it's about (askElement), whatever the inspector shows. */
function syncAsk() {
  const el = askElement();
  if (!el) return;
  const t = targetOf(el);
  renderAsk(el, t ? [] : instancePath(el), t ? "box" : kindOf(el, getComputedStyle(el)));
}

/** Fill the popup for the selection: its name, then its conversation. */
function renderAsk(el: Element, path: PathEntry[], kind: Kind) {
  const v = viewed();
  makeBtn.style.display = v ? "none" : "";
  if (v) {
    askTag.style.setProperty("--role", "var(--sp-accent)");
    askTag.title = `${v.label || "Claude"}: a chat of its own, with no element. Select something to ask about it instead.`;
    askTag.replaceChildren(lucide("message-circle", 12), h("span", { class: "nm" }, v.label || "Claude"));
    askMore.style.display = "none";
    return;
  }
  const t = targetOf(el);
  const n = t ? { ...targetName(t), comp: true } : askName(el, path);
  // Already a component (its instance's root element), or a frame or variant: there's nothing to extract,
  // but on the board they can still be broken down further.
  makeBtn.style.display = n.comp && !shell?.breakdown ? "none" : "";
  const r = rectOf(el);
  askTag.style.setProperty("--role", ROLE_COLOR[roleOf(el)]);
  askTag.title = t
    ? `${t.kind === "frame" ? "The whole frame" : "This variant of the component"} · ${Math.round(r.width)}×${Math.round(r.height)}`
    : `<${el.tagName.toLowerCase()}> ${Math.round(r.width)}×${Math.round(r.height)} · ${path.map((o) => o.name).join(" › ") || "no component"}`;
  const ic: IconName = t?.kind === "frame" && !inComponentFrame ? "app-window" : n.comp ? "component" : KIND_ICON[kind];
  askTag.replaceChildren(lucide(ic, 12), h("span", { class: "nm" }, n.name), ...(n.owner ? [h("span", { class: "in" }, `in ${n.owner}`)] : []));
  // Shift+click picks ride along: the chat is this element's, Claude sees them all.
  askMore.textContent = also.length ? `+${also.length}` : "";
  askMore.style.display = also.length ? "" : "none";
  if (!isRunning() && !askBox.classList.contains("has-chat")) askHint(false, false);
  askMore.title = also.length ? `Also sent to Claude:\n${also.map((a) => askLabel(a.el, instancePath(a.el))).join("\n")}` : "";
  const key = chatKey(el, path);
  const label = askLabel(el, path);
  adoptChat(el, key);
  if (askOn?.key !== key) {
    askOn = { key, label };
    renderChat();
  }
}

type ChatMessage = { role: "user" | "claude"; text: string; ok?: boolean; at: number; with?: string[]; images?: string[] };
/** One chat with Claude about an element (chats.ts on the dev server). */
type Chat = {
  id: string;
  key: string;
  label: string;
  sessionId: string | null;
  model?: string;
  messages: ChatMessage[];
  created: number;
  updated: number;
  closed?: boolean;
  resolved?: boolean;
  /** A chat with no element (an Implement changes run, a task such as "Write sample data with Claude"). */
  kind?: "implement" | "task";
};

/** The chat column shows every chat (the board's list) instead of the selection's conversation. */
let listing = false;

/** Follow the board: the list or the conversation, and the Chats button's count. */
function syncChatsMode() {
  if (!shell) return;
  listing = !!shell.chatsOpen?.();
  askBox.classList.toggle("listing", listing);
  chatsBtn.classList.toggle("on", listing);
  const n = shell.chatCount?.() ?? 0;
  chatsCount.textContent = n ? String(n) : "";
  // One list for the board: only the selected frame's column holds it.
  if (listing && shell.isActive(window)) {
    const list = shell.chatList?.();
    if (list && list.parentNode !== askList) askList.replaceChildren(list);
  }
  renderChat();
}

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
  const chat = viewed() ?? (askOn ? openChatOn(askOn.key) : undefined);
  const answering = isRunning() && !!chat && runChat === chat.id;
  const msgs = chat?.messages ?? [];
  askBox.classList.toggle("has-chat", msgs.length > 0 || answering);
  const model = (answering && runModel) || chat?.model;
  askTitle.replaceChildren(...(listing ? ["All chats"] : ["Claude", ...(model ? [h("span", { class: "model" }, modelName(model))] : [])]));
  askTitle.title = [model, chat?.sessionId && `session ${chat.sessionId}`].filter(Boolean).join(" · ");
  newChatBtn.toggleAttribute("disabled", answering && !viewing && !listing);
  newChatBtn.textContent = viewing && !listing ? "Close" : "New chat";
  newChatBtn.title = viewing ? "Back to the selection's chat; this one stays in Chats" : "Start over with a new Claude session; this chat stays in Chats";
  // Claude writes Markdown; the person's own words stay as typed.
  const nodes: HTMLElement[] = msgs.map((m) =>
    m.role === "claude"
      ? h("div", { class: `msg claude md${m.ok === false ? " bad" : ""}` }, markdown(m.text))
      : h(
          "div",
          { class: `msg user${m.images?.length && !m.text ? " only-imgs" : ""}` },
          ...(m.images?.length
            ? [
                h(
                  "div",
                  { class: "imgs" },
                  ...m.images.map((n) => h("a", { href: `/@spark/images/${n}`, target: "_blank", title: "Open the image" }, h("img", { src: `/@spark/images/${n}`, alt: "Attached image" }))),
                ),
              ]
            : []),
          m.text,
          ...(m.with?.length ? [h("div", { class: "with" }, `with ${m.with.join(", ")}`)] : []),
        ),
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
  // The chat column is always there: with nothing said yet it says what it's for.
  if (shell && !nodes.length) {
    nodes.push(
      h(
        "div",
        { class: "chat-empty" },
        "Ask Claude about ",
        h("b", {}, askOn?.label ?? "the selection"),
        ". Select an element (Edit, Tab) to ask about that one instead; Shift+click adds more.",
      ),
    );
  }
  const stick = askThread.scrollHeight - askThread.scrollTop - askThread.clientHeight < 24;
  askThread.replaceChildren(...nodes);
  if (stick || answering) askThread.scrollTop = askThread.scrollHeight;
  askHint(answering, msgs.length > 0);
  sendBtn.toggleAttribute("disabled", isRunning());
}

/** The prompt's placeholder: what Claude is doing, or what you'd ask about (this or, with Shift+click picks, these). */
function askHint(answering: boolean, replying: boolean) {
  askInput.placeholder = isRunning() ? (answering ? "Claude is answering…" : "Claude is busy…") : replying ? "Reply…" : also.length ? "Ask Claude to change these…" : "Ask Claude to change this…";
}

function resetChat() {
  // From the list: back to the conversation, a new one.
  if (listing) {
    shell?.setChatsOpen?.(false);
    if (viewing) stopViewing();
    if (!askOn || (isRunning() && runChat === openChatOn(askOn.key)?.id)) return askInput.focus();
  } else if (viewing) return stopViewing();
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
  // On the board it's a column, always shown, and the selection keeps its floating label.
  if (shell) {
    askBox.style.display = "flex";
    return;
  }
  const show = open && picking && !!selected && selected.isConnected && !editing && !resizing;
  const hide = () => {
    askBox.style.display = "none";
  };
  if (!show) return hide();
  const el = selected!;
  const r = rectOf(el);
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
  // Keep clear of the measurements under the selection too.
  if (dimsBadge.style.display !== "none") e.b += dimsBelow;
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
  if (viewing) syncAsk();
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
  const words = step.key === "one" ? "Only this one" : step.words[0].toUpperCase() + step.words.slice(1);
  box.append(
    h("div", { class: "chain-head" }, h("span", { class: "grow" }, "Edits go to"), step.key !== "one" ? h("span", { class: "count", title: "Elements on screen this step changes" }, `${n} on screen`) : null),
    steps,
    h("div", { class: "hint" }, words),
  );

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
      const push = h("button", { class: "push", type: "button", title: `Move ${here.length === 1 ? "this edit" : `these ${here.length} edits`} to ${parent.words}` }, `Move up to ${parent.label}`);
      push.addEventListener("click", () => {
        for (const c of here) applyTo(c.id, parent.scope, scopeWords(path, parent.scope, parent.variant), parent.variant);
        editTarget = parent.key;
        changed();
      });
      head.append(push);
    }
    list.append(head);
    for (const c of mine) list.append(editLine(c, chain, path, step));
    box.append(list);
  }
  return box;
}

/**
 * One edit on the selection: what it changes, and the step it lives on (pick
 * another to move it). Its dot is colored like the fields: orange when the
 * step edits go to (or a narrower one) sets it, purple when a wider step does.
 */
function editLine(c: Change, chain: Step[], path: PathEntry[], step: Step): HTMLElement {
  const what = c.property === "text" ? `text "${c.to}"` : c.property === "removed" ? "removed" : c.property === "children-order" ? "children order" : `${c.property}: ${c.to}`;
  const known = chain.find((s) => sameStep(c.instance, s));
  const label = (s: Step) => (s.key === "one" ? "This one" : s.label);
  const stepBtn = h("button", { class: "select step-pick", type: "button", title: "Where this edit lives: pick another step to move it" }, h("span", { class: "sel-v" }, known ? label(known) : stepLabel(c)), lucide("chevron-down", 12));
  const wrap = h("div", { class: "sel" }, stepBtn);
  menuButton(
    stepBtn,
    wrap,
    () => chain.map((s) => ({ value: s.key, label: label(s), hint: s.key === "one" ? "only this one" : `${coverCount(path, s)} on screen` })),
    () => known?.key ?? null,
    (key) => {
      const s = chain.find((x) => x.key === key);
      if (!s || s === known) return;
      applyTo(c.id, s.scope, scopeWords(path, s.scope, s.variant), s.variant);
      changed();
    },
    "right",
  );
  const revertBtn = h("button", { class: "tb", type: "button", title: "Revert this edit" }, lucide("rotate-ccw", 12));
  revertBtn.addEventListener("click", () => {
    revert(c.id);
    changed();
  });
  const mark = breadth(c.instance) >= breadth(step) ? "own" : "up";
  return h(
    "div",
    { class: `edit-line ${mark}`, title: `${c.property}: ${c.from || "unset"} → ${c.to}\n${mark === "own" ? "Changed on" : "Comes from"} ${stepLabel(c)}` },
    h("span", { class: "dot" }),
    h("code", {}, what),
    wrap,
    revertBtn,
  );
}

/** The inspector on a frame or a variant box: what it is, and that the popup asks Claude about all of it. */
function renderTarget(el: Element, t: Target) {
  const r = rectOf(el);
  const n = targetName(t);
  const file = t.kind === "case" ? t.file : new URLSearchParams(location.search).get("file");
  body.append(
    h(
      "div",
      { class: "el-head" },
      h("div", { class: "title" }, t.kind === "frame" ? n.name : `${n.name} · ${n.owner} variant`),
      h("span", { class: "size", title: "Size on screen" }, `${Math.round(r.width)} × ${Math.round(r.height)}`),
    ),
    ...(file ? [h("div", { class: "el-src", title: "Its cases are written in" }, locLink(file.replace(/^\//, "")))] : []),
  );
  // The frame's own properties (size, device, layout), like a component's.
  const fp = t.kind === "frame" ? shell?.frameProps?.(window) : null;
  if (fp) body.append(h("div", { style: "margin-top: var(--sp-3)" }, fp));
  const where = shell ? "in the chat on the right" : "in the popup next to it";
  body.append(
    h(
      "p",
      { class: "empty" },
      t.kind === "frame"
        ? `The whole frame. Ask Claude about all of it ${where}; click an element inside to edit that one.`
        : `This variant (case) of the component. Ask Claude about it ${where}; click an element inside to edit that one, Arrow Up for the frame.`,
    ),
    changesHere(el),
  );
}

function locLink(loc: string | null) {
  if (!loc) return h("span", { class: "empty" }, "unknown");
  return h("span", { class: "link", title: "Open in editor", click: () => openInEditor(loc) }, loc);
}

/** A property row: its name, the field, notes under the field. `mark` colors the name when an edit sets it. */
function row(name: string | HTMLElement, field: HTMLElement, below?: HTMLElement | null, mark?: { mark: "own" | "up" | null; title: string } | null) {
  const k = typeof name === "string" ? h("span", { class: "k", title: name }, name) : h("span", { class: "k" }, name);
  if (mark?.mark) {
    k.classList.add("ov");
    if (mark.mark === "up") k.classList.add("up");
    k.title = mark.title;
  }
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
  syncAsk();
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
    // On the board: the frame's own properties (its size, device, layout) first.
    const fp = shell?.frameProps?.(window);
    if (fp) body.append(fp);
    body.append(
      h(
        "div",
        { class: "empty" },
        picking
          ? "Click an element to select it, Shift+click to add more for Claude. Drag its handles to resize, double-click text to edit it, Arrow Up for the parent. Esc clears the selection, Tab goes back to View."
          : "View mode: use the app as normal. Switch to Edit (Tab) to select and change elements.",
      ),
    );
    return;
  }
  const t = targetOf(selected);
  if (t) {
    renderTarget(selected, t);
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

  // Element: its tag and size, and where it's written.
  body.append(
    h(
      "div",
      { class: "el-head" },
      h("div", { class: "title" }, `<${el.tagName.toLowerCase()}${classes.length ? "." + classes.join(".") : ""}>`),
      h("span", { class: "size", title: "Size on screen" }, `${Math.round(r.width)} × ${Math.round(r.height)}`),
    ),
    h("div", { class: "el-src", title: "Written in" }, locLink(el.getAttribute("data-spark-src"))),
  );

  body.append(instanceHeader(el, path));

  // Edits on this element and how they relate to the step edits go to: set
  // on that step or narrower is this step's own diff ("own", orange); set on
  // a wider step it comes from above ("up", purple).
  const target = targetStep(path) ?? { scope: null };
  const overrides = overridesOn(el);
  const markOf = (c: Change | undefined): Mark => (!c ? null : breadth(c.instance) >= breadth(target) ? "own" : "up");
  /** What a field shows: the pending edit, else the source's value (instance: falling back to computed). */
  const valueOf = (prop: string): { value: string; changed: boolean; mark: Mark } => {
    const c = overrides.filter((x) => x.property === prop).at(-1);
    // Computed lengths come with long fractions (108.641px); two decimals is plenty.
    const computed = cs.getPropertyValue(prop).replace(/(\.\d\d)\d+/g, "$1");
    if (c) overridden.set(prop, c);
    return { value: c?.to ?? authored(el, rules, prop) ?? computed, changed: !!c, mark: markOf(c) };
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
  /** A field's own mark: its border says whether this step or a wider one set it. */
  const marked = <T extends HTMLElement>(field: T, mark: Mark): T => {
    if (mark === "up") field.classList.add("up");
    return field;
  };

  /** One property's row in the panel. */
  const fieldRow = (f: Field): HTMLElement => {
    if (f.kind === "sides") {
      const quad = h("div", { class: "quad" });
      const values: string[] = [];
      const computeds: string[] = [];
      const marks: Mark[] = [];
      for (const side of SIDES) {
        const prop = `${f.prop}-${side}`;
        const { value, changed, mark } = valueOf(prop);
        values.push(value);
        computeds.push(cs.getPropertyValue(prop).trim());
        marks.push(mark);
        quad.append(
          marked(numberField(value, { computed: cs.getPropertyValue(prop), label: side[0].toUpperCase(), changed, min: f.prop === "padding" ? 0 : undefined, keywords: f.prop === "margin" ? ["auto"] : [] }, onValue(prop)), mark),
        );
      }
      const sideProps = SIDES.map((side) => `${f.prop}-${side}`);
      const same = values.every((v) => v === values[0]) ? values[0] : "";
      const quadVar = withVar(quad, "size", same, computeds[0], (v) => {
        sideProps.forEach((p, i) => edit(el, p, v, i === sideProps.length - 1));
      });
      return row(f.prop, quadVar, resolvedLine(values.join(" "), computeds.join(" "), jumpToVariable), rowMark(f.prop, sideProps, marks));
    }
    const { value, changed, mark } = valueOf(f.prop);
    const computed = cs.getPropertyValue(f.prop);
    let field: HTMLElement;
    if (f.kind === "number") field = numberField(value, { computed, step: f.step, unit: f.unit, min: f.min, keywords: f.keywords, changed }, onValue(f.prop));
    else if (f.kind === "select") field = selectField(value || computed, f.options, changed, onValue(f.prop), f.prop === "font-weight" ? WEIGHTS : {});
    else if (f.kind === "color") field = colorField(value, computed, colors, changed, onValue(f.prop));
    else field = textField(value, changed, onValue(f.prop));
    marked(field, mark);
    if (f.kind !== "select") {
      const prop = f.prop;
      field = withVar(field, f.kind === "color" ? "color" : f.kind === "number" ? "size" : null, value, computed, (v) => edit(el, prop, v, true));
    }
    const notes = [resolvedLine(value, f.kind === "color" ? displayColor(computed) : computed, jumpToVariable), inheritLine(f.prop, changed)].filter((x): x is HTMLElement => !!x);
    return row(f.prop, field, notes.length ? h("div", {}, ...notes) : null, rowMark(f.prop, [f.prop], [mark]));
  };
  /** The label's mark: orange when this step changes any of the row's properties, purple when only wider steps do. */
  const rowMark = (name: string, props: string[], marks: Mark[]): { mark: Mark; title: string } | null => {
    const mark: Mark = marks.includes("own") ? "own" : marks.includes("up") ? "up" : null;
    if (!mark) return null;
    const where = props
      .map((p) => overridden.get(p))
      .filter((c): c is Change => !!c)
      .map((c) => `${c.property}: ${markOf(c) === "own" ? "changed on" : "comes from"} ${stepLabel(c)}`);
    return { mark, title: where.join("\n") || name };
  };

  // The essentials for this kind of element first; everything else, by category, under "All properties".
  const kind = kindOf(el, cs);
  const essentials = ESSENTIALS[kind].map(fieldFor).filter((f): f is Field => !!f);
  body.append(h("h3", {}, KIND_LABEL[kind]));
  if (kind === "icon") body.append(iconRow(el, overrides.filter((c) => c.property === "icon").at(-1), markOf));
  for (const f of essentials) body.append(fieldRow(f));
  // Edits in the folded part still show: their categories open on their own.
  const editedRest = FIELDS.flatMap((g) => g.fields).filter((f) => !essentials.includes(f) && (f.kind === "sides" ? SIDES.some((s) => overrides.some((c) => c.property === `${f.prop}-${s}`)) : overrides.some((c) => c.property === f.prop)));
  body.append(changesHere(el));
  const all = section("all", "All properties", editedRest.length ? `${editedRest.length} changed` : "", () => {
    const out: HTMLElement[] = [];
    for (const { group, fields } of FIELDS) {
      const rest = fields.filter((f) => !essentials.includes(f));
      if (!rest.length) continue;
      out.push(h("h4", {}, group));
      for (const f of rest) out.push(fieldRow(f));
    }
    return out;
  });
  body.append(all);
  if (!sectionsOpen.all) for (const f of editedRest) all.append(fieldRow(f));

  // Variables this element uses: editing one changes everything that uses it.
  const tokens = tokensUsed(el, rules);
  if (tokens.length) {
    body.append(
      section("vars", "Variables used here", String(tokens.length), () => {
        const out: HTMLElement[] = [h("div", { class: "hint" }, "Changing a variable changes everything that uses it. Click a name to see it in Variables.")];
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
          out.push(row(h("span", { class: "link", title: `${t}: show in Variables`, click: () => jumpToVariable(t) }, t), field));
        }
        return out;
      }),
    );
  }

  // Context
  body.append(
    section("owners", "Component instances", String(owners.length), () => {
      if (owners.length === 0) return [h("div", { class: "empty" }, "No React components found above this element.")];
      return owners.map((o) => h("div", { class: "owner" }, h("b", {}, o.name), o.call ? locLink(o.call) : h("span", { class: "empty" }, "root")));
    }),
    section("rules", "Matched rules", String(rules.length), () =>
      [...rules]
        .reverse()
        .map((m) => h("div", { class: "rule" }, h("div", { class: "sel" }, m.selector), h("div", { class: "file" }, shortFile(m.file)), h("pre", {}, m.rule.style.cssText.split("; ").join(";\n")))),
    ),
  );
}

/**
 * An icon's row: which icon it is (library and name, or an inline SVG), and
 * Swap, which opens the picker; the pick is an "icon" override like any edit.
 */
function iconRow(el: Element, c: Change | undefined, markOf: (c: Change | undefined) => Mark): HTMLElement {
  const id = c?.to ?? sourceIcon(el);
  const { name, from } = iconLabel(id, el.getAttribute("data-spark-src"));
  const wrap = h("div", { class: "icon-row" });
  const swap = h("button", { type: "button", class: "icon-swap", title: "Pick another icon" }, "Swap");
  swap.addEventListener("click", (e) => {
    e.stopPropagation();
    openIconPicker(wrap, id, (choice) => {
      closePopover();
      edit(el, "icon", choice.id, true, { iconSvg: choice.svg });
    });
  });
  const mark = markOf(c);
  const preview = iconPreview(c?.iconSvg ?? iconMarkup(el as SVGSVGElement), 20);
  if (mark) preview.classList.add(mark === "up" ? "up" : "own");
  wrap.append(preview, h("div", { class: "icon-name" }, h("b", {}, name), h("span", {}, from)), swap);
  return wrap;
}

/** How a field relates to the step edits go to: set there or narrower ("own"), set on a wider step ("up"), or not edited. */
type Mark = "own" | "up" | null;

/**
 * A folding section of the inspector: a header with a count, and the rows
 * `build` makes, built only while it's open. Remembered per `key`.
 */
function section(key: string, title: string, count: string, build: () => HTMLElement[]): HTMLElement {
  const open = !!sectionsOpen[key];
  const head = h("button", { class: `sec-head${open ? " open" : ""}`, type: "button", "aria-expanded": open ? "true" : "false" }, lucide("chevron-down", 12), h("span", { class: "sec-title" }, title), count ? h("span", { class: "sec-count" }, count) : null);
  head.addEventListener("click", () => {
    sectionsOpen[key] = !open;
    setState("sections", { ...sectionsOpen });
    render();
  });
  const box = h("div", { class: `sec${open ? " open" : ""}` }, head);
  if (open) box.append(...build());
  return box;
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
  const rules = el && !["text", "children-order", "removed", "icon"].includes(c.property) ? matchedRules(el, skip) : [];
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
    { class: "sp-btn primary", title: "Have Claude apply these changes to the code", click: () => implement() },
    "Implement changes",
  ) as HTMLButtonElement;
  implementBtn.disabled = pending.length === 0 || isRunning();
  footer.replaceChildren(h("div", { class: "changes-head" }, h("h3", {}, `Changes (${pending.length})`), h("span", { class: "grow" }), implementBtn));
  shell?.setChangeCount?.(pending.length);
  if (scopedImplement) scopedImplement.disabled = isRunning();
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
  for (const c of newestFirst(pending)) footer.append(changeRow(c, here.has(c.id)));
}

const newestFirst = (list: Change[]) => [...list].sort((a, b) => b.at.localeCompare(a.at));

/** One pending change in a list (the Changes tab, the inspector's "Changes here"): what, where, its step, Revert. */
function changeRow(c: Change, here: boolean): HTMLElement {
  const what =
    c.property === "text"
      ? `text: "${c.from}" → "${c.to}"`
      : c.property === "removed"
        ? `removed <${c.element.tag}>${c.element.comp ? ` in ${c.element.comp}${pathFor(c)[0]?.key != null ? `[${pathFor(c)[0].key}]` : ""}` : ""}`
        : `${c.property}: ${c.from || "unset"} → ${c.to}`;
  const kind = c.level === "instance" ? `on ${stepLabel(c)}` : c.level === "component" ? "css rule" : "variable";
  return h(
    "div",
    { class: `change${here ? " here" : ""}` },
    h("div", { class: "what" }, h("div", { class: "lvl" }, kind), h("code", {}, what), h("div", { class: "where" }, describeChange(c)), c.level === "instance" && scopeSelect(c)),
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
  );
}

/** A rule's selector as it matches at rest: no pseudo-elements or states (`.btn:hover::after` → `.btn`). */
function restingSelector(sel: string): string {
  return sel.replace(/::?(focus-visible|focus-within|first-letter|first-line|placeholder|selection|backdrop|before|after|marker|hover|focus|active|visited|target)(?![\w-])/gi, "");
}

/** Does `scope` or anything inside it match a selector list (as written, or at rest)? */
function matchesWithin(scope: Element, selector: string): boolean {
  for (const sel of [selector, restingSelector(selector)]) {
    try {
      if (scope.matches(sel) || scope.querySelector(sel)) return true;
    } catch {
      // Not a selector the DOM takes (a pseudo-element left over): try the next form.
    }
  }
  return false;
}

/**
 * The pending changes that change something in `scope` (the element and
 * everything inside it): overrides covering an element there; CSS rule edits
 * whose rule matches an element there; and any edit made with an element
 * there selected (a variable is global, so only those count).
 */
function changesWithin(scope: Element): Change[] {
  const inside = (x: Element) => x === scope || scope.contains(x);
  const madeHere = (c: Change) => {
    const src = c.element.src;
    return !!src && (scope.getAttribute("data-spark-src") === src || !!scope.querySelector(`[data-spark-src="${CSS.escape(src)}"]`));
  };
  return allChanges().filter((c) => {
    if (c.status !== "pending") return false;
    if (c.level === "instance") return coveredElements(c).some(inside);
    if (madeHere(c)) return true;
    return c.level === "component" && !!c.selector && matchesWithin(scope, c.selector);
  });
}

/** Its Implement button, kept in step with Claude's runs by renderChanges. */
let scopedImplement: HTMLButtonElement | null = null;

/**
 * The inspector's "Changes here": the pending changes in the selection's
 * subtree (it and everything inside it), as in the Changes tab, and
 * Implement for just those.
 */
function changesHere(scope: Element): HTMLElement {
  const list = newestFirst(changesWithin(scope));
  scopedImplement = null;
  return section("changes", "Changes here", String(list.length), () => {
    if (list.length === 0) return [h("div", { class: "empty" }, "No pending changes on this or anything inside it.")];
    const btn = h(
      "button",
      { class: "on", title: "Have Claude apply only these changes to the code", click: () => implement(list.map((c) => c.id)) },
      list.length === 1 ? "Implement this change" : `Implement these ${list.length}`,
    ) as HTMLButtonElement;
    btn.disabled = isRunning();
    scopedImplement = btn;
    const on = new Set(scope === selected ? overridesOn(scope).map((c) => c.id) : []);
    return [...list.map((c) => changeRow(c, on.has(c.id))), h("div", { class: "here-actions" }, btn)];
  });
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
// Leaving the page (to another frame, the canvas or the panel) gets no
// pointermove here, so the hover would stay: drop it when the pointer goes.
document.addEventListener("mouseout", (e) => !e.relatedTarget && hovered && hover(null), true);
document.addEventListener("pointerdown", swallow, true);
document.addEventListener("mousedown", swallow, true);
/** A click picks: Shift+click adds to the selection (or takes out); a plain click starts over. */
function pick(e: Event) {
  // A click on the canvas is about that element: the chat column goes back from the list to its conversation.
  if (listing && shell?.isActive(window)) shell.setChatsOpen?.(false);
  if ((e as MouseEvent).shiftKey) toggleSelect(pickable(e.target));
  else select(pickable(e.target));
}
document.addEventListener(
  "pointerup",
  (e) => {
    // Only the left button picks; the middle one pans (frame.ts).
    if (swallow(e) && e.button === 0 && inDisabled(e.target)) pick(e);
  },
  true,
);
document.addEventListener("mouseup", swallow, true);
document.addEventListener(
  "click",
  (e) => {
    if (editing && e.target instanceof Node && editing.contains(e.target)) return;
    if (!swallow(e) || inDisabled(e.target)) return;
    pick(e);
  },
  true,
);
document.addEventListener(
  "dblclick",
  (e) => {
    if (editing && e.target instanceof Node && editing.contains(e.target)) return;
    // A variant's name renames its case (gallery.ts), in edit mode too.
    if (e.target instanceof Element && e.target.closest(".spark-gallery-name")) return;
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
    // Renaming a variant (gallery.ts): Enter and Esc are its own.
    if (e.target instanceof HTMLElement && e.target.isContentEditable && e.target.closest(".spark-gallery-name")) return;
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
      // In view mode Esc belongs to the app; in edit mode it's Spark's, even
      // with nothing left to close (it doesn't go to the app or leave edit mode).
      if (picking) {
        escapeStep();
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (!textEntry(e) && styleShortcut(e)) {
      // Copied or pasted style.
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
      const parent = parentOf(selected);
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
  } else if (!textEntry(k) && styleShortcut(k)) {
    // Copied or pasted style.
  } else if (undoKey(k) && !textEntry(k)) {
    // Outside the app (panel, bar) undo is always Spark's.
    k.preventDefault();
    k.stopPropagation();
    undoRedo(undoKey(k) as -1 | 1);
  } else if (isDelete(k) && picking && selected && !textEntry(k)) {
    k.preventDefault();
    k.stopPropagation();
    removeSelected();
  } else if (k.key === "ArrowUp" && picking && selected && !textEntry(k) && !k.composedPath().includes(panelHost)) {
    // Focus on the board, not in the frame: Arrow Up still steps out (element, variant, frame).
    const parent = parentOf(selected);
    if (parent) {
      k.preventDefault();
      select(parent);
    }
  } else if (k.key === "Escape") {
    const t = k.composedPath()[0] as HTMLElement | undefined;
    // Esc while typing leaves the field; otherwise it steps out like in the app.
    // The chat prompt is the exception: one Esc leaves it and steps out too (clears the
    // selection a pin or a click put it on), unless there's a draft in it to keep in context.
    if (t === askInput && !askInput.value.trim()) {
      t.blur();
      escapeStep();
    } else if (t && textEntry(k)) {
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
// Right-click menus (menu.ts), in edit mode: on an element, a variant box or
// the frame itself. A right-click selects what's under it first (unless it's
// already in the selection, so the menu acts on all of it), like Figma. In
// view mode the app keeps its own right-clicks; the browser's menu never shows.

/** On the board the menu is drawn by the board, over the canvas, at screen size. */
const menuDoc = shell ? window.parent.document : document;

/** A point in this frame, in the menu's document (the frame may be zoomed on the board). */
function toMenuPoint(x: number, y: number) {
  const fe = shell ? (window.frameElement as HTMLElement | null) : null;
  if (!fe) return { x, y };
  const f = fe.getBoundingClientRect();
  const z = fe.offsetWidth ? f.width / fe.offsetWidth : 1;
  return { x: f.left + x * z, y: f.top + y * z };
}

// Copy and paste style: the Text and Fill and border properties, like
// Figma's copy and paste properties. The copy lives on the board, so it
// pastes into another frame too.
type StyleCopy = { props: { prop: string; value: string; computed: string }[] };
const CLIP = "__sparkStyleCopy";
const clipWin = (shell ? window.parent : window) as Window & { [CLIP]?: StyleCopy };
const STYLE_PROPS = FIELDS.filter((g) => g.group === "Text" || g.group === "Fill and border").flatMap((g) => g.fields.map((f) => f.prop));

function copyStyle(el: Element) {
  const rules = matchedRules(el, skip);
  const cs = getComputedStyle(el);
  const own = overridesOn(el);
  clipWin[CLIP] = {
    props: STYLE_PROPS.map((prop) => ({
      prop,
      value: own.filter((c) => c.property === prop).at(-1)?.to ?? authored(el, rules, prop) ?? cs.getPropertyValue(prop),
      computed: cs.getPropertyValue(prop),
    })),
  };
}

/** Paste the copied style onto `els`: an edit for each property that looks different there. */
function pasteStyle(els: Element[]) {
  const copy = clipWin[CLIP];
  if (!copy) return;
  let n = 0;
  for (const el of els) {
    if (targetOf(el)) continue;
    const cs = getComputedStyle(el);
    for (const p of copy.props) {
      if (cs.getPropertyValue(p.prop) === p.computed) continue;
      if (edit(el, p.prop, p.value, false)) n++;
    }
  }
  if (n) changed();
}

/** Revert every edit on `els` (what the inspector lists under "Edits on this …"). */
function resetEdits(els: Element[]) {
  let n = 0;
  for (const el of els) {
    for (const c of overridesOn(el)) {
      revert(c.id);
      n++;
    }
  }
  if (n) changed();
}

/** Open the Ask popup on the selection, with the cursor in it. */
function askAbout() {
  if (!picking) setPicking(true);
  if (!open) setOpen(true);
  // The Claude column may be showing the chats list, which has no prompt: back to the conversation.
  if (shell?.chatsOpen?.()) shell.setChatsOpen?.(false);
  requestAnimationFrame(() => {
    placeAsk();
    askInput.focus();
  });
}

const styleKey = (e: KeyboardEvent): "copy" | "paste" | null =>
  (e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey ? (e.code === "KeyC" ? "copy" : e.code === "KeyV" ? "paste" : null) : null;
/** Ctrl+Alt+C / Ctrl+Alt+V on the selection; true when it was one. */
function styleShortcut(e: KeyboardEvent): boolean {
  const k = styleKey(e);
  if (!k || !picking || !selected || targetOf(selected)) return false;
  e.preventDefault();
  e.stopPropagation();
  if (k === "copy") copyStyle(selected);
  else pasteStyle(selection());
  return true;
}

// ---------------------------------------------------------------------------
// Break down into components (the board's Components tab, components-tab.ts)

/** The tagged elements under `scope` as an indented outline: tag and class, where it's written, which component writes it. */
function outlineOf(scope: Element): string {
  const lines: string[] = [];
  const walk = (node: Element, depth: number) => {
    for (const child of Array.from(node.children)) {
      if (lines.length >= 1500) return;
      const src = child.getAttribute("data-spark-src");
      if (!src) {
        walk(child, depth);
        continue;
      }
      const cls = Array.from(child.classList).slice(0, 3).map((c) => `.${c}`).join("");
      const comp = child.getAttribute("data-spark-comp");
      const own = Array.from(child.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      const text = own ? ` "${(child.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}"` : "";
      lines.push(`${"  ".repeat(depth)}<${child.tagName.toLowerCase()}${cls}> ${src}${comp ? ` (${comp})` : ""}${text}`);
      if (depth < 40) walk(child, depth + 1);
    }
  };
  const top = scope.getAttribute("data-spark-src");
  if (top) {
    lines.push(`<${scope.tagName.toLowerCase()}> ${top}${scope.getAttribute("data-spark-comp") ? ` (${scope.getAttribute("data-spark-comp")})` : ""}`);
    walk(scope, 1);
  } else walk(scope, 0);
  return lines.join("\n");
}

/** What Break down works on for `el`: a frame (the whole app, or a component frame), a variant box, or an element. */
function breakdownTarget(el: Element) {
  const t = targetOf(el);
  const caseFile = inComponentFrame ? (new URLSearchParams(location.search).get("file") ?? "").replace(/^\//, "") || null : null;
  if (t?.kind === "frame") {
    return inComponentFrame
      ? { label: frameTitle(), kind: "case" as const, file: caseFile, comp: frameComponent, outline: outlineOf(document.body) }
      : { label: `${frameTitle()} frame`, kind: "frame" as const, outline: outlineOf(document.body) };
  }
  if (t?.kind === "case") {
    const n = targetName(t);
    return { label: `${n.name} in ${n.owner}`, kind: "case" as const, file: t.file.replace(/^\//, ""), comp: n.owner, outline: outlineOf(el) };
  }
  return {
    label: askLabel(el, instancePath(el)),
    kind: "element" as const,
    src: el.getAttribute("data-spark-src"),
    comp: el.getAttribute("data-spark-comp"),
    file: caseFile,
    outline: outlineOf(el),
  };
}

/** Open the board's Components tab on `el`. */
function breakdown(el: Element) {
  shell?.breakdown?.(breakdownTarget(el));
}

/** The menu for `el` (selected first), at a point in the menu's document. */
function showMenuFor(el: Element, at: { x: number; y: number }) {
  if (editing) stopTextEdit(true);
  if (!selection().includes(el)) select(el);
  const sel = selection();
  const t = targetOf(el);
  const many = sel.length > 1;
  const ask: MenuEntry = { label: many ? `Ask Claude about these ${sel.length}…` : "Ask Claude…", run: askAbout };
  const breakDown: MenuEntry = !many && !!shell?.breakdown && { label: "Break down into components…", run: () => breakdown(el) };
  const parent = parentOf(el);
  const up: MenuEntry = { label: parent === document.documentElement ? "Select frame" : "Select parent", hint: "↑", disabled: !parent, run: () => parent && select(parent) };
  if (t?.kind === "frame") {
    openMenu(at.x, at.y, [ask, breakDown, "-", ...(shell?.frameMenu?.(window) ?? [])], menuDoc);
    return;
  }
  if (t?.kind === "case") {
    const name = el.querySelector(".spark-gallery-name");
    openMenu(
      at.x,
      at.y,
      [
        ask,
        breakDown,
        "-",
        up,
        name && {
          label: "Rename variant",
          hint: "Double-click",
          run: () => name.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window })),
        },
        !!t.file && { label: "Open in code editor", run: () => openInEditor(t.file.replace(/^\//, "")) },
      ],
      menuDoc,
    );
    return;
  }
  const src = el.getAttribute("data-spark-src");
  const textual = el instanceof HTMLElement && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && hasOwnText(el);
  const edits = sel.reduce((n, x) => n + overridesOn(x).length, 0);
  const copied = !!clipWin[CLIP];
  // An instance (or something inside one) has a main component: where it's written, in its component frame.
  const main = !many && roleOf(el) === "instance" && !!src && !!shell?.hasSource?.(src, window);
  openMenu(
    at.x,
    at.y,
    [
      ask,
      breakDown,
      !many && textual && { label: "Edit text", hint: "Double-click", run: () => startTextEdit(el as HTMLElement) },
      "-",
      !many && up,
      "-",
      !many && { label: "Copy style", hint: "Ctrl+Alt+C", run: () => copyStyle(el) },
      { label: many ? `Paste style to ${sel.length}` : "Paste style", hint: "Ctrl+Alt+V", disabled: !copied, run: () => pasteStyle(sel) },
      { label: edits ? `Reset edits (${edits})` : "Reset edits", disabled: !edits, run: () => resetEdits(sel) },
      "-",
      main && { label: "Go to main component", run: () => shell?.goToSource?.(src!, window) },
      !many && !!src && { label: "Open in code editor", run: () => openInEditor(src!) },
      "-",
      { label: many ? `Delete ${sel.length}` : "Delete", hint: "Del", danger: true, run: removeSelected },
    ],
    menuDoc,
  );
}

document.addEventListener(
  "contextmenu",
  (e) => {
    // Editing text in place: the browser's menu (copy, paste, spelling) is the useful one.
    if (editing && e.target instanceof Node && editing.contains(e.target)) return;
    if (!picking) return;
    // Spark's own overlay (a handle, a pin) stands for the selection.
    const el = e.target === host ? selected : pickable(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    showMenuFor(el, toMenuPoint(e.clientX, e.clientY));
  },
  true,
);

/** Is `src` written here (a component frame shows its main component)? */
function findSource(src: string): Element | null {
  return document.querySelector(`[data-spark-src="${CSS.escape(src)}"]`);
}

// ---------------------------------------------------------------------------
// Start

document.head.append(dockStyle);
installFont();
// The browser's own menu never shows (the board guards its frames too; this covers an app outside it).
blockNativeMenu(window);
blockFileDrops(window);
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
  // A frame or variant box isn't the app's to reorder.
  selected: () => (targetOf(selected) ? null : selected),
  pickable: (t) => {
    const el = pickable(t);
    return targetOf(el) ? null : el;
  },
  select,
  instancePath,
  elementInfo,
  scopeWords,
  changed,
});
// ---------------------------------------------------------------------------
// Layers: this frame's tree, for the board's Layers tab (layers.ts)
//
// A layer is a tagged element (`data-spark-src`) under the nearest tagged
// ancestor, so untagged wrappers (a library's, React portals' hosts) fold
// away. An svg is one layer: its paths aren't. A component frame's cases are
// the top level, each holding what the case renders.

const CASE = ".spark-gallery-case";
const isLayer = (el: Element) => el.hasAttribute("data-spark-src") && !skip(el);
const leafLayer = (el: Element) => el.tagName.toLowerCase() === "svg";

/** The tagged elements right under `of`: its descendants with no tagged element between. */
function layerKids(of: Element): Element[] {
  const out: Element[] = [];
  const walk = (p: Element) => {
    for (const c of Array.from(p.children)) {
      if (c === host || c.hasAttribute("data-spark") || c.matches("script, style, template")) continue;
      if (isLayer(c)) out.push(c);
      else walk(c);
    }
  };
  if (!leafLayer(of)) walk(of);
  return out;
}

/** Does `el` start its component's markup (the first element of an instance) rather than sit inside it? */
function isInstanceRoot(el: Element): boolean {
  for (let f = fiberOf(el)?.return; f; f = f.return) {
    if (typeof f.type === "string") return false;
    if ((f.type as { sparkInternal?: boolean } | null)?.sparkInternal) return false;
    const name = componentName(f.type);
    if (name) return name === el.getAttribute("data-spark-comp");
  }
  return false;
}

/** A layer's own name, Figma style: an instance by its component, text by what it says, the rest by its class or tag. */
function layerOf(el: Element): Layer {
  const comp = el.getAttribute("data-spark-comp");
  const role = roleOf(el);
  const root = !!comp && isInstanceRoot(el);
  const cs = getComputedStyle(el);
  const kind = kindOf(el, cs);
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const cls = Array.from(el.classList).find((c) => /^[a-z_-][\w-]*$/i.test(c) && !/^(css|sc|jsx|svelte)-/.test(c));
  const tag = el.tagName.toLowerCase();
  let name: string;
  let hint: string | undefined;
  if (root) {
    name = comp!;
    // A list's item by its key, else the variant it is.
    const own = ownersOf(el)[0];
    hint = own?.key ?? (own?.variant ? variantName(own.variant) : undefined);
  } else if (kind === "text" && text) {
    name = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  } else name = cls ?? tag;
  if (!root && kind === "stack") hint = /grid/.test(cs.display) ? "grid" : cs.flexDirection.startsWith("column") ? "column" : "row";
  const box = el.getBoundingClientRect();
  return {
    el,
    name,
    hint,
    role,
    icon: root ? "component" : kind === "stack" && !/grid/.test(cs.display) && !cs.flexDirection.startsWith("column") ? "columns-2" : KIND_ICON[kind],
    root,
    hasKids: layerKids(el).length > 0,
    hidden: cs.display === "none" || cs.visibility === "hidden" || (box.width === 0 && box.height === 0),
  };
}

function layers(of: Element | null): Layer[] {
  if (!of && inComponentFrame) {
    return Array.from(document.querySelectorAll(CASE)).map((c) => ({
      el: c,
      name: c.querySelector(".spark-gallery-name")?.textContent?.trim() || "Case",
      role: "case" as const,
      icon: "hash",
      root: false,
      hasKids: layerKids(c).length > 0,
      hidden: false,
    }));
  }
  if (of?.matches(CASE)) return layerKids(of).map(layerOf);
  return layerKids(of ?? document.body).map(layerOf);
}

/** The layers from the top down to the one showing `el`. */
function layerChain(el: Element): Element[] {
  const chain: Element[] = [];
  for (let p: Element | null | undefined = el.closest("[data-spark-src]"); p; p = p.parentElement?.closest("[data-spark-src]")) {
    if (skip(p)) continue;
    // Inside an svg the svg is the layer.
    if (leafLayer(p)) chain.length = 0;
    chain.unshift(p);
  }
  if (inComponentFrame) {
    const c = el.closest(CASE);
    if (c) chain.unshift(c);
  }
  return chain;
}

/**
 * Scroll the page (and anything scrolling inside it) so `el` shows, the least
 * needed. Not `scrollIntoView`: that would scroll the board around the frame too.
 */
function scrollTo(el: Element) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const page = p === document.documentElement;
    const cs = getComputedStyle(p);
    if (!page && !/auto|scroll/.test(cs.overflowX + cs.overflowY)) continue;
    if (p.scrollHeight <= p.clientHeight && p.scrollWidth <= p.clientWidth) continue;
    const r = el.getBoundingClientRect();
    const v = page ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } : p.getBoundingClientRect();
    const dy = r.top < v.top ? r.top - v.top : r.bottom > v.bottom ? Math.min(r.bottom - v.bottom, r.top - v.top) : 0;
    const dx = r.left < v.left ? r.left - v.left : r.right > v.right ? Math.min(r.right - v.right, r.left - v.left) : 0;
    if (dx || dy) p.scrollBy(dx, dy);
  }
}

function selectLayer(el: Element) {
  if (!el.isConnected) return null;
  // A case is a target of its own (data-spark-case), like an element.
  select(el);
  scrollTo(el);
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Tell the board when the tree changes: React rendering, hot reloads, class or text changes (at most every 250 ms). */
if (shell?.layersChanged) {
  let pending = 0;
  new MutationObserver(() => {
    if (pending) return;
    pending = window.setTimeout(() => {
      pending = 0;
      shell!.layersChanged!(window);
    }, 250);
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
}

render();
const reopen = getState<boolean>("panel-open") === true;
if (shell) {
  // On the board the shell sends the panel state and the mode.
  shell.register({
    win: window,
    panel: panelHost,
    changes: changesHost ?? undefined,
    setOpen,
    setPicking,
    deselect: () => select(null),
    showChat,
    refresh: () => {
      render();
      syncChatsMode();
    },
    chatsChanged: syncChatsMode,
    unhover: () => hovered && hover(null),
    // The frame's title on the board was clicked in edit mode: the frame itself is the selection.
    selectFrame: () => select(document.documentElement),
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
    layers,
    layerChain,
    selectLayer,
    hoverLayer: (el) => hover(el && el.isConnected ? el : null),
    // A right-click on its Layers row or the frame's title: select it and show its menu there.
    contextMenu: (el, x, y) => {
      const t = el && el.isConnected ? el : document.documentElement;
      if (t !== document.documentElement && t !== selected) scrollTo(t);
      showMenuFor(t, { x, y });
    },
    hasSource: (src) => !!findSource(src),
    breakdownTarget: () => breakdownTarget(document.documentElement),
    scanSystem: () => scanSystem(skip),
    selectSource: (src) => {
      const el = findSource(src);
      return el ? selectLayer(el) : null;
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
