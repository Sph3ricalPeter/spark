// The changelog: every visual edit, at the level the person chose, plus its
// live preview in the page.
//
// Previews are exact where they can be: a token or component edit changes
// the real CSS rule in the page's CSSOM, which is what the code change will
// do. When the edited file hot-reloads, Vite replaces the sheet and the
// preview gives way to the real thing. An instance edit has no rule of its
// own yet, so it's previewed as a rule on that one element.
//
// The saved shape (.spark/changes.json, `version: 1`) is read by the MCP
// server and Claude, so it only grows; fields are never renamed or removed.
import { findRule, tokenRule } from "./css.ts";

export type Level = "instance" | "component" | "token";

export type Change = {
  id: string;
  level: Level;
  /** The CSS property, or the token's name for a token change. */
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
  /** The component instance (instance level): its name and the line that renders it. */
  instance: { component: string; call: string | null } | null;
  status: "pending" | "applied";
  at: string;
};

export type ChangeLog = { version: 1; changes: Change[] };

let changes: Change[] = [];
let skip: (n: Node) => boolean = () => false;
const instanceSheet = document.createElement("style");
instanceSheet.setAttribute("data-spark", "instance-previews");

export function initChanges(skipNode: (n: Node) => boolean) {
  skip = skipNode;
  document.head.append(instanceSheet);
}

export function allChanges(): readonly Change[] {
  return changes;
}

/** Same thing being changed: a later edit replaces the earlier one's `to`. */
function sameTarget(a: Change, b: Omit<Change, "id" | "from" | "to" | "at" | "status">) {
  if (a.level !== b.level || a.property !== b.property) return false;
  if (a.level === "instance") return a.element.src === b.element.src && a.instance?.call === b.instance?.call;
  return a.file === b.file && a.selector === b.selector;
}

export function record(c: Omit<Change, "id" | "at" | "status">): Change {
  const existing = changes.find((x) => x.status === "pending" && sameTarget(x, c));
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

export function revert(id: string) {
  const c = changes.find((x) => x.id === id);
  if (!c) return;
  changes = changes.filter((x) => x.id !== id);
  if (c.level === "instance") renderInstances();
  else setOnRule(c, c.from);
}

/** Replace the list (loaded from disk after a reload) and re-apply its previews. */
export function load(list: Change[]) {
  changes = list;
  for (const c of changes) if (c.status === "pending") preview(c);
}

export function preview(c: Change) {
  if (c.level === "instance") renderInstances();
  else setOnRule(c, c.to);
}

function setOnRule(c: Change, value: string) {
  const rule = c.level === "token" ? tokenRule(c.property, skip)?.rule : c.selector ? findRule(c.file, c.selector, skip) : null;
  if (!rule) return;
  if (value) rule.style.setProperty(c.property, value);
  else rule.style.removeProperty(c.property);
}

// ---------------------------------------------------------------------------
// Instance previews: each instance gets a stable attribute, and one sheet
// holds a rule per instance.

const keyOf = (src: string | null, call: string | null) => `${src ?? "?"}@${call ?? "root"}`;
const pids = new Map<string, number>();

function pidFor(key: string): number {
  let pid = pids.get(key);
  if (pid === undefined) {
    pid = pids.size + 1;
    pids.set(key, pid);
  }
  return pid;
}

/** Called by the client with a way to find an element's instance call site. */
let callOf: (el: Element, comp: string | null) => string | null = () => null;
export function setCallResolver(fn: typeof callOf) {
  callOf = fn;
}

/** Re-mark elements (React may have re-created them) and rebuild the sheet. */
export function renderInstances() {
  const groups = new Map<string, Change[]>();
  for (const c of changes) {
    if (c.level !== "instance" || c.status !== "pending") continue;
    const key = keyOf(c.element.src, c.instance?.call ?? null);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  markInstances(groups);
  let css = "";
  for (const [key, list] of groups) {
    const decls = list.map((c) => `${c.property}: ${c.to} !important;`).join(" ");
    css += `[data-spark-pid="${pidFor(key)}"] { ${decls} }\n`;
  }
  if (instanceSheet.textContent !== css) instanceSheet.textContent = css;
}

function markInstances(groups: Map<string, Change[]>) {
  for (const [key, list] of groups) {
    const { element, instance } = list[0];
    if (!element.src) continue;
    const pid = String(pidFor(key));
    for (const el of Array.from(document.querySelectorAll(`[data-spark-src="${CSS.escape(element.src)}"]`))) {
      if (el.getAttribute("data-spark-pid") === pid) continue;
      if (callOf(el, element.comp) === (instance?.call ?? null)) el.setAttribute("data-spark-pid", pid);
    }
  }
}
