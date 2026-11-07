// The changelog: every visual edit, plus its live preview in the page.
//
// Edits work like Unity prefab overrides. An edit starts as an override on
// exactly the instance you touched. Each override can then be applied
// upstream to any component that owns it: the component that renders it
// (every instance it renders at that line), further out, or all the way
// to the original definition (every instance everywhere). A token edit
// is always global; an override can also be applied to a matched CSS rule.
//
// Previews are exact where they can be: a token or CSS rule edit changes the
// real rule in the page's CSSOM, which is what the code change will do. When
// the edited file hot-reloads, Vite replaces the sheet and the preview gives
// way to the real thing. An override is previewed with a rule that matches
// the elements it covers, narrower scopes after wider ones so they win.
//
// The saved shape (.spark/changes.json, `version: 1`) is read by the MCP
// server and Claude, so it only grows; fields are never renamed or removed.
import { findRule, tokenRule } from "./css.ts";

export type Level = "instance" | "component" | "token";

/** One component on the way from an element up to the root, innermost first. */
export type PathEntry = {
  /** The component's name. */
  name: string;
  /** The line that renders this component instance (in its parent's file). */
  call: string | null;
  /** Its React key, when it's one of a list (rendered by .map()). */
  key: string | null;
};

export type Change = {
  id: string;
  /** "instance": an override, see `instance.scope`. "component": a CSS rule. "token": a design token. */
  level: Level;
  /** The CSS property, the token's name for a token change, or "text" for an
   * element's text content. */
  property: string;
  /** The value before Spark touched it ("" when it wasn't set). */
  from: string;
  to: string;
  /** Project-relative file of the rule (component, token). */
  file: string | null;
  /** The rule's selector (component, token). */
  selector: string | null;
  /** The element that was selected when the edit was made. */
  element: { src: string | null; comp: string | null; tag: string; classes: string[] };
  /** Overrides only. */
  instance: {
    /** The component the element is written in (`path[0].name`). */
    component: string;
    /** The line that renders that component instance (`path[0].call`). */
    call: string | null;
    /** Owners from the element's component up to the root, innermost first. */
    path?: PathEntry[];
    /**
     * Where the override is applied:
     * - null: only this exact instance (every call site and list key in `path` must match);
     * - k ≥ 1: in `path[k].name`'s source, so every instance it renders through the
     *   calls `path[0..k-1]`;
     * - 0: in the definition of `path[0].name` itself, so every instance everywhere.
     */
    scope?: number | null;
    /** `scope` in words, for whoever applies the change to code. */
    appliesTo?: string;
  } | null;
  status: "pending" | "applied";
  at: string;
};

export type ChangeLog = { version: 1; changes: Change[] };

let changes: Change[] = [];
let skip: (n: Node) => boolean = () => false;
/** How the client finds an element's owner path (starting at the component it's written in). */
let pathOf: (el: Element) => PathEntry[] = () => [];
const overrideSheet = document.createElement("style");
overrideSheet.setAttribute("data-spark", "override-previews");

export function initChanges(skipNode: (n: Node) => boolean, resolvePath: (el: Element) => PathEntry[]) {
  skip = skipNode;
  pathOf = resolvePath;
  document.head.append(overrideSheet);
}

export function allChanges(): readonly Change[] {
  return changes;
}

export function pathFor(c: Change): PathEntry[] {
  return c.instance?.path ?? [{ name: c.instance?.component ?? "?", call: c.instance?.call ?? null, key: null }];
}

const scopeOf = (c: Change) => c.instance?.scope ?? null;

/** Does an element with this owner path fall under override `c`? */
function covers(c: Change, path: PathEntry[]): boolean {
  const want = pathFor(c);
  const scope = scopeOf(c);
  if (scope === 0) return true;
  const depth = scope === null ? want.length : scope;
  if (path.length < depth) return false;
  for (let i = 0; i < depth; i++) {
    if (path[i].name !== want[i].name || path[i].call !== want[i].call) return false;
    if (scope === null && path[i].key !== want[i].key) return false;
  }
  return true;
}

/** Elements the override covers right now. */
export function coveredElements(c: Change): Element[] {
  if (c.level !== "instance" || !c.element.src) return [];
  return Array.from(document.querySelectorAll(`[data-spark-src="${CSS.escape(c.element.src)}"]`)).filter((el) => covers(c, pathOf(el)));
}

/** Overrides that apply to this element, widest first (so the last one wins). */
export function overridesOn(el: Element): Change[] {
  const src = el.getAttribute("data-spark-src");
  const path = pathOf(el);
  return byBreadth(changes.filter((c) => c.status === "pending" && c.level === "instance" && c.element.src === src && covers(c, path)));
}

/** Widest scope first: the definition (0), then outer owners, then the exact instance. */
function byBreadth(list: Change[]): Change[] {
  const rank = (c: Change) => (scopeOf(c) === null ? Infinity : (scopeOf(c) as number));
  return [...list].sort((a, b) => rank(a) - rank(b));
}

function samePlace(a: Change, b: Pick<Change, "level" | "property" | "file" | "selector" | "element" | "instance">) {
  if (a.level !== b.level || a.property !== b.property) return false;
  if (a.level !== "instance") return a.file === b.file && a.selector === b.selector;
  if (a.element.src !== b.element.src || scopeOf(a) !== (b.instance?.scope ?? null)) return false;
  // Same scope and the same owners as far as that scope looks.
  const probe = { ...a, instance: { ...a.instance!, scope: scopeOf(a) } } as Change;
  return covers(probe, b.instance?.path ?? []);
}

export function record(c: Omit<Change, "id" | "at" | "status">): Change {
  const existing = changes.find((x) => x.status === "pending" && samePlace(x, c));
  if (existing) {
    existing.to = c.to;
    existing.at = new Date().toISOString();
    if (existing.to === existing.from) {
      revert(existing.id);
      return existing;
    }
    preview(existing);
    return existing;
  }
  const change: Change = { ...c, id: Math.random().toString(36).slice(2, 10), status: "pending", at: new Date().toISOString() };
  changes.push(change);
  preview(change);
  return change;
}

/** Move an override to another scope (null: this instance only). An override already there absorbs it. */
export function applyTo(id: string, scope: number | null, appliesTo: string) {
  const c = changes.find((x) => x.id === id);
  if (!c?.instance) return;
  const restore = c.property === "text" ? coveredElements(c) : [];
  c.instance = { ...c.instance, scope, appliesTo };
  const twin = changes.find((x) => x !== c && x.status === "pending" && samePlace(x, c));
  if (twin) {
    twin.to = c.to;
    changes = changes.filter((x) => x !== c);
  }
  // Text the old scope covered and the new one doesn't goes back.
  const now = new Set(coveredElements(twin ?? c));
  for (const el of restore) if (!now.has(el)) setText(el, c.from);
  renderOverrides();
}

/** Turn an override into an edit of a CSS rule. */
export function applyToRule(id: string, file: string | null, selector: string, from: string) {
  const c = changes.find((x) => x.id === id);
  if (!c) return;
  changes = changes.filter((x) => x !== c);
  renderOverrides();
  record({ level: "component", property: c.property, from, to: c.to, file, selector, element: c.element, instance: null });
}

export function revert(id: string) {
  const c = changes.find((x) => x.id === id);
  if (!c) return;
  const restore = c.level === "instance" && c.property === "text" ? coveredElements(c) : [];
  changes = changes.filter((x) => x.id !== id);
  for (const el of restore) setText(el, c.from);
  if (c.level === "instance") renderOverrides();
  else setOnRule(c, c.from);
}

/** Replace the list (loaded from disk after a reload) and re-apply its previews. */
export function load(list: Change[]) {
  changes = list;
  for (const c of changes) if (c.status === "pending") preview(c);
}

export function preview(c: Change) {
  if (c.level === "instance") renderOverrides();
  else setOnRule(c, c.to);
}

function setOnRule(c: Change, value: string) {
  const rule = c.level === "token" ? tokenRule(c.property, skip)?.rule : c.selector ? findRule(c.file, c.selector, skip) : null;
  if (!rule) return;
  if (value) rule.style.setProperty(c.property, value);
  else rule.style.removeProperty(c.property);
}

// ---------------------------------------------------------------------------
// Override previews: each covered element lists the overrides on it in
// `data-spark-o`, and one sheet holds a rule per override, widest first.

/** Re-mark elements (React may have re-created them) and rebuild the sheet. */
export function renderOverrides() {
  const overrides = byBreadth(changes.filter((c) => c.level === "instance" && c.status === "pending"));
  const marks = new Map<Element, string[]>();
  for (const c of overrides) for (const el of coveredElements(c)) marks.set(el, [...(marks.get(el) ?? []), c.id]);

  for (const el of Array.from(document.querySelectorAll("[data-spark-o]"))) if (!marks.has(el)) el.removeAttribute("data-spark-o");
  for (const [el, ids] of marks) {
    const v = ids.join(" ");
    if (el.getAttribute("data-spark-o") !== v) el.setAttribute("data-spark-o", v);
  }

  let css = "";
  for (const c of overrides) {
    if (c.property === "text") {
      for (const [el, ids] of marks) if (lastText(ids) === c.id) setText(el, c.to);
      continue;
    }
    css += `[data-spark-o~="${c.id}"] { ${c.property}: ${c.to} !important; }\n`;
  }
  if (overrideSheet.textContent !== css) overrideSheet.textContent = css;
}

/** The narrowest text override among these ids. */
function lastText(ids: string[]): string | undefined {
  for (let i = ids.length - 1; i >= 0; i--) if (changes.find((c) => c.id === ids[i])?.property === "text") return ids[i];
  return undefined;
}

/** Text previews change the text node React already owns, so React can still update it. */
function setText(el: Element, value: string) {
  if (el.textContent === value || (el as HTMLElement).isContentEditable) return;
  const nodes = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE);
  if (nodes.length === 0) el.append(value);
  else {
    nodes[0].nodeValue = value;
    for (const n of nodes.slice(1)) n.nodeValue = "";
  }
}
