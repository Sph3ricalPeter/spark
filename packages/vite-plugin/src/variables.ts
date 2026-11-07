// The Variables view: every CSS custom property (design token) the app's
// stylesheets define, with its value, a control to edit it, and where it is
// used.
//
// Editing a variable records a "token" change (see changes.ts) on the rule
// that defines it, so Claude applies it at the definition and everything that
// uses the variable follows. The preview changes that rule in the CSSOM, the
// same thing the code change will do.
import { eachRule } from "./css.ts";
import { icon } from "./theme.ts";
import { closePopover, colorField, displayColor, h, numberField, showPopover, textField, type OnValue, type Token } from "./fields.ts";

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
  /** Add a new variable to a rule. False when it can't be (bad name, taken). */
  create: (name: string, value: string, target: VarTarget) => boolean;
  /** Select the first element a rule matches (switches to the inspector). */
  selectRule: (selector: string) => boolean;
  shortFile: (file: string | null) => string;
};

/** Expanded usage lists and the filter survive a re-render. */
const expanded = new Set<string>();
let filter = "";

/** A rule a new variable can go in. */
export type VarTarget = { selector: string; file: string | null };

/** Rules that can hold variables: :root/html rules and any rule that already defines some,
 * the one with the most variables first (the app's tokens file, usually). */
export function variableTargets(skip: (n: Node) => boolean): VarTarget[] {
  const seen = new Map<string, VarTarget & { count: number; root: boolean }>();
  eachRule(skip, (rule, file) => {
    const root = ROOT.test(rule.selectorText);
    const count = declarations(rule).filter(([p]) => p.startsWith("--")).length;
    if (!root && count === 0) return;
    const key = `${file} ${rule.selectorText}`;
    const prev = seen.get(key);
    seen.set(key, { selector: rule.selectorText, file, count: (prev?.count ?? 0) + count, root });
  });
  return [...seen.values()].sort((a, b) => Number(b.root) - Number(a.root) || b.count - a.count).map(({ selector, file }) => ({ selector, file }));
}

/** A value to make a variable from, opened from an inspector field; `then` swaps the field to the new var(). */
let draft: { value: string; name: string; then?: (name: string) => void } | null = null;
export function draftVariable(value: string, name: string, then?: (name: string) => void) {
  draft = { value, name, then };
}

const GROUPS: Record<VarKind, string> = { color: "Colors", size: "Sizes", other: "Other" };

export function renderVariables(into: HTMLElement, deps: VariablesDeps) {
  const vars = collectVariables(deps.skip);
  into.append(newVariableForm(vars, deps));
  if (vars.length === 0) {
    into.append(h("div", { class: "empty" }, "This app's stylesheets don't define any CSS variables yet (custom properties like --radius-sm)."));
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
    .tabs { display: flex; gap: 4px; padding: 8px 12px 0; border-bottom: 1px solid var(--sp-line); }
    .tabs button { border: none; border-radius: var(--sp-r-sm) 4px 0 0; background: transparent; color: var(--sp-text-dim); padding: 4px 10px 6px; }
    .tabs button.on { background: var(--sp-field); color: var(--sp-text-strong); }
    .var-filter { margin-bottom: 4px; font-family: var(--sp-font); }
    .var { padding: 6px 0; border-bottom: 1px solid #1f2125; }
    .var.flash { background: #4f8cff22; margin: 0 -12px; padding: 6px 12px; transition: background .6s; }
    .var-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; min-width: 0; }
    .var-name { font: 600 var(--sp-fs-sm) var(--sp-mono); color: var(--sp-text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .var-head .resolved { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .var-uses { margin-left: auto; padding: 0 6px; font-size: var(--sp-fs-xs); color: var(--sp-link); background: transparent; border-color: var(--sp-line); }
    .var-uses.none { color: var(--sp-text-dim); }
    .var-list { font-size: var(--sp-fs-sm); }
    .var-list:not(:empty) { margin-top: 6px; padding: 4px 8px; background: var(--sp-surface); border-radius: var(--sp-r-sm); }
    .var-def { color: var(--sp-text-dim); margin-bottom: 2px; }
    .var-use { padding: 1px 0; word-break: break-word; }
    .resolved { color: var(--sp-text-dim); font: var(--sp-fs-sm) var(--sp-mono); }
    .var-new { margin: 0 0 10px; padding: 6px 8px; background: var(--sp-surface); border-radius: var(--sp-r-sm); }
    .var-new summary { color: var(--sp-link); text-transform: none; letter-spacing: 0; font-size: var(--sp-fs-md); }
    .var-new[open] summary { margin-bottom: 6px; }
    .hint.bad { color: var(--sp-danger); }
    .with-var { display: flex; gap: 4px; align-items: flex-start; position: relative; }
    .with-var > :first-child { flex: 1; min-width: 0; }
    /* A field bound to a variable, compact: the variable's name and what it resolves to. */
    .var-pill {
      display: flex; align-items: center; gap: 5px; min-width: 0; height: 20px; padding: 0 6px; border: none; border-radius: var(--sp-r-sm);
      background: color-mix(in srgb, var(--sp-accent) 14%, transparent); color: var(--sp-link); font: var(--sp-fs-sm)/1 var(--sp-mono); text-align: left;
    }
    .var-pill:hover { background: color-mix(in srgb, var(--sp-accent) 24%, transparent); }
    .var-pill .icon { opacity: .8; }
    .var-pill .dot { flex: none; width: 10px; height: 10px; border-radius: 2px; box-shadow: inset 0 0 0 1px #ffffff30; }
    .var-pill .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .var-pill .vl { flex: none; color: var(--sp-text-dim); }
    .with-var.compact.is-bound > .varbtn { display: none; }
    .varbtn { flex: none; width: 22px; height: 22px; padding: 0; color: var(--sp-text-dim); }
    .varbtn.bound { color: var(--sp-link); border-color: #8fb4ff55; }
    .varbtn:hover { color: var(--sp-text-strong); }
    .var-pop { width: 260px; top: 26px; }
    .var-pop input { margin-bottom: 6px; }
    .var-opts { max-height: 220px; overflow: auto; }
    .var-opt { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; border: none; background: transparent; padding: 3px 4px; }
    .var-opt:hover, .var-opt.on { background: #2a2d33; }
    .var-opt .dot { width: 12px; height: 12px; border-radius: var(--sp-r-sm); border: 1px solid var(--sp-line-strong); flex: none; }
    .var-opt .nm { font: var(--sp-fs-sm) var(--sp-mono); color: var(--sp-text-strong); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .var-opt .vl { font: var(--sp-fs-sm) var(--sp-mono); color: var(--sp-text-dim); flex: none; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .var-act { color: var(--sp-link); }
    .resolved-line { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
    `;

/** "New variable": name, value and the rule it goes in. Open when there's a draft from the inspector. */
function newVariableForm(vars: Variable[], deps: VariablesDeps): HTMLElement {
  const targets = variableTargets(deps.skip);
  const d = draft;
  draft = null;
  const box = h("details", { class: "var-new" }) as HTMLDetailsElement;
  box.open = !!d;
  box.append(h("summary", {}, "+ New variable"));
  if (targets.length === 0) {
    box.append(h("div", { class: "empty" }, "No :root rule to put it in. Add one to a stylesheet first."));
    return box;
  }
  const name = h("input", { placeholder: "--name", spellcheck: "false", value: d?.name ?? "" }) as HTMLInputElement;
  const value = h("input", { placeholder: "value, e.g. 6px or #ff8800", spellcheck: "false", value: d?.value ?? "" }) as HTMLInputElement;
  const where = h("select", { title: "The rule it goes in" }) as HTMLSelectElement;
  targets.forEach((t, i) => where.append(h("option", { value: String(i) }, `${t.selector} · ${deps.shortFile(t.file)}`)));
  const msg = h("div", { class: "hint" });
  const add = h("button", { class: "on" }, d?.then ? "Create and use" : "Create");
  const taken = new Set(vars.map((v) => v.name));

  const submit = () => {
    let n = name.value.trim();
    if (n && !n.startsWith("--")) n = "--" + n.replace(/^-+/, "");
    const v = value.value.trim();
    msg.textContent = "";
    if (!/^--[a-zA-Z_][\w-]*$/.test(n)) msg.textContent = "A name like --radius-lg: letters, digits, - and _.";
    else if (taken.has(n)) msg.textContent = `${n} already exists.`;
    else if (!v) msg.textContent = "Give it a value.";
    else if (!deps.create(n, v, targets[Number(where.value)])) msg.textContent = "Couldn't add it to that rule.";
    else {
      d?.then?.(n);
      return;
    }
    msg.classList.add("bad");
  };
  for (const input of [name, value]) {
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if ((e as KeyboardEvent).key === "Enter") submit();
    });
    input.addEventListener("keyup", (e) => e.stopPropagation());
  }
  add.addEventListener("click", submit);
  box.append(
    h("div", { class: "row" }, h("span", { class: "k" }, "Name"), h("div", { class: "field" }, name)),
    h("div", { class: "row" }, h("span", { class: "k" }, "Value"), h("div", { class: "field" }, value)),
    h("div", { class: "row" }, h("span", { class: "k" }, "Goes in"), h("div", { class: "field" }, where)),
    h("div", { class: "row" }, h("span", { class: "k" }), add),
    msg,
  );
  if (d) setTimeout(() => (d.name ? value : name).focus());
  return box;
}

export type VarPickOpts = {
  /** Which variables fit the field: colors for a color field, sizes for a number field, any for text. */
  kind: VarKind | null;
  /** The field's current value. */
  value: string;
  skip: (n: Node) => boolean;
  pendingValue: (name: string) => string | undefined;
  /** Bind the field to var(name). */
  use: (name: string) => void;
  /** Make a variable from the field's value (opens the New variable form). */
  create: () => void;
  /** Put the resolved value back in place of the var() (unbind). */
  unbind?: () => void;
  /**
   * Compact (the Ask popup): a bound field shows the variable as a pill (its
   * name and what it resolves to here) instead of the raw var(); a click on
   * it opens the picker. The button itself only shows on hover.
   */
  compact?: { resolved: string };
};

/** The "var" button next to a field: use an existing variable, or create one from the value. */
export function varButton(field: HTMLElement, o: VarPickOpts): HTMLElement {
  const bound = varsIn(o.value)[0] ?? null;
  const btn = h("button", { class: `varbtn${bound ? " bound" : ""}`, type: "button", title: bound ? `Uses ${bound}: change or unlink` : "Use a variable, or make one from this value" }, icon("braces", 13));
  let shown = field;
  if (o.compact && bound) {
    const resolved = o.compact.resolved.trim().replace(/(\.\d\d)\d+/g, "$1");
    const dot = h("span", { class: "dot" });
    if (o.kind === "color") dot.style.background = resolved;
    shown = h(
      "button",
      { class: "var-pill", type: "button", title: `var(${bound}) = ${resolved}: change or unlink` },
      o.kind === "color" ? dot : icon("braces", 11),
      h("span", { class: "nm" }, bound.replace(/^--/, "")),
      h("span", { class: "vl" }, o.kind === "color" ? displayColor(resolved) : resolved),
    );
  }
  const wrap = h("div", { class: `with-var${o.compact ? " compact" : ""}${bound ? " is-bound" : ""}` }, shown, btn);
  const openPicker = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    const pop = h("div", { class: "popover var-pop" });
    const all = collectVariables(o.skip).filter((v) => !o.kind || v.kind === o.kind);
    const q = h("input", { placeholder: `Search ${all.length} ${o.kind === "color" ? "color" : o.kind === "size" ? "size" : ""} variables`.replace("  ", " "), spellcheck: "false" }) as HTMLInputElement;
    const list = h("div", { class: "var-opts" });
    const pick = (fn: () => void) => () => {
      closePopover();
      fn();
    };
    const literal = o.value && !bound;
    const actions: HTMLElement[] = [];
    if (literal) actions.push(h("button", { class: "var-opt var-act", click: pick(o.create) }, h("span", { class: "nm" }, `+ New variable from ${o.value}`)));
    else actions.push(h("button", { class: "var-opt var-act", click: pick(o.create) }, h("span", { class: "nm" }, "+ New variable")));
    if (bound && o.unbind) actions.push(h("button", { class: "var-opt var-act", click: pick(o.unbind) }, h("span", { class: "nm" }, `Unlink ${bound} (keep its value)`)));
    const fill = () => {
      const t = q.value.trim().toLowerCase();
      list.replaceChildren(...actions);
      for (const v of all) {
        const val = o.pendingValue(v.name) ?? (v.resolved || v.authored);
        if (t && !`${v.name} ${val}`.toLowerCase().includes(t)) continue;
        const dot = h("span", { class: "dot" });
        if (v.kind === "color") dot.style.background = val;
        else dot.style.visibility = "hidden";
        list.append(
          h("button", { class: `var-opt${v.name === bound ? " on" : ""}`, title: `var(${v.name})`, click: pick(() => o.use(v.name)) }, dot, h("span", { class: "nm" }, v.name), h("span", { class: "vl" }, val)),
        );
      }
    };
    q.addEventListener("input", fill);
    q.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if ((ev as KeyboardEvent).key === "Enter") (list.querySelector(".var-opt:not(.var-act)") as HTMLElement | null)?.click();
    });
    q.addEventListener("keyup", (ev) => ev.stopPropagation());
    fill();
    pop.append(q, list);
    if (showPopover(wrap, pop)) q.focus();
  };
  btn.addEventListener("click", openPicker);
  if (shown !== field) shown.addEventListener("click", openPicker);
  return wrap;
}
