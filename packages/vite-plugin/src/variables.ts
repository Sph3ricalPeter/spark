// The Variables view: every CSS custom property (design token) the app's
// stylesheets define, with its value, a control to edit it, and where it is
// used.
//
// Editing a variable records a "token" change (see changes.ts) on the rule
// that defines it, so Claude applies it at the definition and everything that
// uses the variable follows. The preview changes that rule in the CSSOM, the
// same thing the code change will do.
import { eachRule } from "./css.ts";
import { colorField, h, numberField, textField, type OnValue, type Token } from "./fields.ts";

export type VarKind = "color" | "size" | "other";

/** One place a variable is read: a declaration in a rule, or another variable. */
export type VarUse = { selector: string; file: string | null; property: string };

export type Variable = {
  name: string;
  /** The value as written where it's defined (may itself be a var()). */
  authored: string;
  /** What it resolves to on the root element ("" when it's defined below :root). */
  resolved: string;
  /** The rule that defines it: the last :root/html rule, else the last rule. */
  selector: string;
  file: string | null;
  kind: VarKind;
  uses: VarUse[];
};

const ROOT = /(^|,)\s*(:root|html)\s*($|,)/;
const SIZE = /^-?\d*\.?\d+[a-z%]*$/i;
const VAR_REF = /var\(\s*(--[\w-]+)/g;

export function kindOf(value: string): VarKind {
  const v = value.trim();
  if (SIZE.test(v)) return "size";
  if (v && !/^-?\d/.test(v) && CSS.supports("color", v)) return "color";
  return "other";
}

/** The variables names referenced in a value, in order. */
export function varsIn(value: string): string[] {
  return [...value.matchAll(VAR_REF)].map((m) => m[1]);
}

/** Declarations of a rule as written, including shorthands that use var() (which the CSSOM
 * otherwise only exposes as empty longhands). */
function declarations(rule: CSSStyleRule): [string, string][] {
  const out: [string, string][] = [];
  for (const part of rule.style.cssText.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const prop = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (prop) out.push([prop, value]);
  }
  return out;
}

/** Every custom property the app's stylesheets define, sorted by kind and then source order. */
export function collectVariables(skip: (n: Node) => boolean): Variable[] {
  const defs = new Map<string, { authored: string; selector: string; file: string | null; root: boolean }>();
  const uses = new Map<string, VarUse[]>();
  eachRule(skip, (rule, file) => {
    const root = ROOT.test(rule.selectorText);
    for (const [prop, value] of declarations(rule)) {
      if (prop.startsWith("--")) {
        const prev = defs.get(prop);
        // A :root definition wins over one further in, like tokenRule().
        if (!prev || root || !prev.root) defs.set(prop, { authored: value, selector: rule.selectorText, file, root });
      }
      for (const name of new Set(varsIn(value))) {
        const list = uses.get(name) ?? [];
        list.push({ selector: rule.selectorText, file, property: prop });
        uses.set(name, list);
      }
    }
  });
  const cs = getComputedStyle(document.documentElement);
  const order: VarKind[] = ["color", "size", "other"];
  return [...defs]
    .map(([name, d]) => {
      const resolved = cs.getPropertyValue(name).trim();
      return { name, ...d, resolved, kind: kindOf(resolved || d.authored), uses: uses.get(name) ?? [] };
    })
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export type VariablesDeps = {
  skip: (n: Node) => boolean;
  /** The pending value Spark has for a variable, if it was edited. */
  pendingValue: (name: string) => string | undefined;
  edit: (v: Variable, value: string, final: boolean) => void;
  /** Select the first element a rule matches (switches to the inspector). */
  selectRule: (selector: string) => boolean;
  shortFile: (file: string | null) => string;
};

/** Expanded usage lists and the filter survive a re-render. */
const expanded = new Set<string>();
let filter = "";

const GROUPS: Record<VarKind, string> = { color: "Colors", size: "Sizes", other: "Other" };

export function renderVariables(into: HTMLElement, deps: VariablesDeps) {
  const vars = collectVariables(deps.skip);
  if (vars.length === 0) {
    into.append(h("div", { class: "empty" }, "This app's stylesheets don't define any CSS variables (custom properties like --radius-sm)."));
    return;
  }
  const colors: Token[] = vars.filter((v) => v.kind === "color").map((v) => ({ name: v.name, value: deps.pendingValue(v.name) ?? v.resolved }));

  const search = h("input", { class: "var-filter", placeholder: `Filter ${vars.length} variables`, value: filter, spellcheck: "false" }) as HTMLInputElement;
  search.addEventListener("keydown", (e) => e.stopPropagation());
  into.append(search, h("div", { class: "hint" }, "Editing a variable changes it where it's defined, so everything that uses it follows."));

  const rows: { el: HTMLElement; text: string; group: HTMLElement }[] = [];
  let group: HTMLElement | null = null;
  let kind: VarKind | null = null;
  for (const v of vars) {
    if (v.kind !== kind) {
      kind = v.kind;
      group = h("h3", {}, GROUPS[kind]);
      into.append(group);
    }
    const el = varRow(v, colors, deps);
    rows.push({ el, text: `${v.name} ${v.authored} ${v.resolved}`.toLowerCase(), group: group! });
    into.append(el);
  }

  const apply = () => {
    filter = search.value;
    const q = filter.trim().toLowerCase();
    const shown = new Set<HTMLElement>();
    for (const r of rows) {
      const on = !q || r.text.includes(q);
      r.el.style.display = on ? "" : "none";
      if (on) shown.add(r.group);
    }
    for (const r of rows) r.group.style.display = shown.has(r.group) ? "" : "none";
  };
  search.addEventListener("input", apply);
  apply();
}

function varRow(v: Variable, colors: Token[], deps: VariablesDeps): HTMLElement {
  const pending = deps.pendingValue(v.name);
  const value = pending ?? v.authored;
  const changed = pending !== undefined;
  const onValue: OnValue = (val, final) => deps.edit(v, val, final);
  const shown = v.resolved || v.authored;

  let field: HTMLElement;
  if (v.kind === "color") field = colorField(value, pending ?? shown, colors.filter((c) => c.name !== v.name), changed, onValue);
  else if (v.kind === "size" && SIZE.test(value)) {
    const unit = value.replace(/^-?\d*\.?\d+/, "");
    field = numberField(value, { computed: shown, unit, step: /^-?\d*\.\d/.test(value) ? 0.1 : 1, changed }, onValue);
  } else field = textField(value, changed, onValue);

  const refs = varsIn(v.authored);
  const head = h(
    "div",
    { class: "var-head" },
    h("span", { class: "var-name", title: v.name }, v.name),
    refs.length > 0 && h("span", { class: "resolved", title: "Resolved value" }, `= ${shown}`),
    h(
      "button",
      { class: `var-uses${v.uses.length ? "" : " none"}`, title: "Where it's used", click: () => toggle() },
      v.uses.length === 1 ? "1 use" : `${v.uses.length} uses`,
    ),
  );
  const list = h("div", { class: "var-list" });
  const row = h("div", { class: "var", "data-var": v.name }, head, h("div", { class: "field" }, field), list);

  const toggle = () => {
    if (expanded.has(v.name)) expanded.delete(v.name);
    else expanded.add(v.name);
    fill();
  };
  const fill = () => {
    list.replaceChildren();
    if (!expanded.has(v.name)) return;
    list.append(h("div", { class: "var-def" }, `defined in ${v.selector} · ${deps.shortFile(v.file)}`));
    if (v.uses.length === 0) list.append(h("div", { class: "empty" }, "Not used by any rule."));
    for (const u of v.uses) {
      const count = matchCount(u.selector, deps.skip);
      const link = h(
        "span",
        {
          class: count ? "link" : "",
          title: count ? "Select the first element this rule matches" : "Nothing on screen matches this rule",
          click: () => count && deps.selectRule(u.selector),
        },
        u.selector,
      );
      list.append(h("div", { class: "var-use" }, link, h("span", { class: "empty" }, ` ${u.property} · ${deps.shortFile(u.file)}${count ? ` · ${count} on screen` : ""}`)));
    }
  };
  fill();
  return row;
}

function matchCount(selector: string, skip: (n: Node) => boolean): number {
  if (selector.startsWith("--")) return 0;
  try {
    return Array.from(document.querySelectorAll(selector)).filter((el) => !skip(el)).length;
  } catch {
    return 0;
  }
}

/** Under a field whose value uses var(): what it resolves to, and links to each variable. */
export function resolvedLine(value: string, computed: string, jump: (name: string) => void): HTMLElement | null {
  const names = [...new Set(varsIn(value))];
  if (names.length === 0) return null;
  const line = h("div", { class: "resolved-line" }, h("span", { class: "resolved" }, `= ${computed.trim() || "unset"}`));
  for (const n of names) line.append(h("span", { class: "link", title: "Edit this variable", click: () => jump(n) }, n));
  return line;
}

export const VARIABLES_STYLE = `
    .tabs { display: flex; gap: 4px; padding: 8px 12px 0; border-bottom: 1px solid #2a2c31; }
    .tabs button { border: none; border-radius: 4px 4px 0 0; background: transparent; color: #8a8f98; padding: 4px 10px 6px; }
    .tabs button.on { background: #23252a; color: #fff; }
    .var-filter { margin-bottom: 4px; font-family: ui-sans-serif, system-ui, sans-serif; }
    .var { padding: 6px 0; border-bottom: 1px solid #1f2125; }
    .var.flash { background: #4f8cff22; margin: 0 -12px; padding: 6px 12px; transition: background .6s; }
    .var-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; min-width: 0; }
    .var-name { font: 600 11px ui-monospace, monospace; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .var-head .resolved { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .var-uses { margin-left: auto; padding: 0 6px; font-size: 10px; color: #8fb4ff; background: transparent; border-color: #2a2c31; }
    .var-uses.none { color: #8a8f98; }
    .var-list { font-size: 11px; }
    .var-list:not(:empty) { margin-top: 6px; padding: 4px 8px; background: #1d1f23; border-radius: 4px; }
    .var-def { color: #8a8f98; margin-bottom: 2px; }
    .var-use { padding: 1px 0; word-break: break-word; }
    .resolved { color: #8a8f98; font: 11px ui-monospace, monospace; }
    .resolved-line { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
    `;
