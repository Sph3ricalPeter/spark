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
import { closePopover, colorField, h, numberField, showPopover, textField, type OnValue, type Token } from "./fields.ts";

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
  const form = newVariableForm(vars, deps);
  const add = h("button", { class: `var-add${form.hidden ? "" : " on"}`, type: "button", title: "New variable" }, icon("plus", 14));
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    form.hidden = !form.hidden;
    add.classList.toggle("on", !form.hidden);
    if (!form.hidden) (form.querySelector("input") as HTMLInputElement | null)?.focus();
  });
  if (vars.length === 0) {
    form.hidden = false;
    into.append(form, h("div", { class: "empty" }, "This app's stylesheets don't define any CSS variables yet (custom properties like --radius-sm)."));
    return;
  }
  const colors: Token[] = vars.filter((v) => v.kind === "color").map((v) => ({ name: v.name, value: deps.pendingValue(v.name) ?? v.resolved }));

  const search = h("input", { class: "var-filter", placeholder: `Filter ${vars.length} variables`, value: filter, spellcheck: "false" }) as HTMLInputElement;
  search.addEventListener("keydown", (e) => e.stopPropagation());
  into.append(
    h("div", { class: "var-top", title: "Editing a variable changes it where it's defined, so everything that uses it follows." }, search, add),
    form,
  );

  const rows: { el: HTMLElement; text: string; group: HTMLElement }[] = [];
  let group: HTMLElement | null = null;
  let kind: VarKind | null = null;
  for (const v of vars) {
    if (v.kind !== kind) {
      kind = v.kind;
      const count = vars.filter((x) => x.kind === kind).length;
      group = h(
        "h3",
        { class: "var-group" },
        h("span", {}, GROUPS[kind]),
        h("span", { class: "var-count" }, String(count)),
        h("span", { class: "var-uses-h", title: "How many rules and variables read it" }, "Uses"),
      );
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

/**
 * One line per variable, like a table: swatch (colors), name, value, uses.
 * The value is the same field the inspector uses (color text with the swatch's
 * picker, scrubbable number, text); "Uses" folds out where it's read below the line.
 */
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
  const tip = refs.length > 0 ? `${v.name}: ${v.authored} = ${shown}` : `${v.name}: ${shown}`;
  const uses = h(
    "button",
    { class: `var-uses${v.uses.length ? "" : " none"}`, type: "button", title: `${v.uses.length === 1 ? "1 use" : `${v.uses.length} uses`}: show where` },
    String(v.uses.length),
  );
  const list = h("div", { class: "var-list" });
  const row = h(
    "div",
    { class: `var is-${v.kind}${changed ? " changed" : ""}`, "data-var": v.name },
    h("span", { class: "var-name", title: tip }, v.name),
    h("div", { class: "var-value", title: tip }, field),
    uses,
    list,
  );

  const toggle = () => {
    if (expanded.has(v.name)) expanded.delete(v.name);
    else expanded.add(v.name);
    fill();
  };
  uses.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });
  const fill = () => {
    list.replaceChildren();
    row.classList.toggle("open", expanded.has(v.name));
    if (!expanded.has(v.name)) return;
    if (refs.length > 0) list.append(h("div", { class: "var-def" }, h("span", { class: "resolved" }, `= ${shown}`)));
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
    .var-top { display: flex; gap: var(--sp-1); margin-bottom: var(--sp-1); }
    .var-filter { flex: 1; min-width: 0; height: 24px; font-family: var(--sp-font); }
    .var-add { flex: none; width: 24px; height: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center; color: var(--sp-text-dim); }
    .var-add:hover, .var-add.on { color: var(--sp-text-strong); }
    .var-add.on { border-color: var(--sp-accent); }
    h3.var-group { display: flex; align-items: baseline; gap: 6px; margin: var(--sp-3) 0 2px; }
    h3.var-group:first-of-type { margin-top: var(--sp-2); }
    .var-count { flex: 1; font: 500 var(--sp-fs-xs)/1 var(--sp-font); letter-spacing: 0; }
    .var-uses-h { font: 500 var(--sp-fs-xs)/1 var(--sp-font); text-transform: none; letter-spacing: 0; }
    /* One line per variable: [swatch] name · value · uses; the uses list folds out below. */
    .var {
      display: grid; grid-template-columns: minmax(0, 1fr) 104px 28px; align-items: center; column-gap: 6px;
      position: relative; margin: 0 -12px; padding: 2px 6px 2px 12px;
    }
    .var.is-size { grid-template-columns: minmax(0, 1fr) 76px 28px; }
    .var.is-other { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) 28px; }
    .var:hover, .var.open { background: var(--sp-surface); }
    .var.flash { background: color-mix(in srgb, var(--sp-accent) 14%, transparent); transition: background .6s; }
    .var-name { font: 500 var(--sp-fs-sm) var(--sp-mono); color: var(--sp-text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .var-value { min-width: 0; }
    .var-value > input, .var-value > .num, .var-value > .color > input { height: 22px; }
    /* Fields look like plain values until the row is hovered or the field is in use; an edit keeps its border. */
    .var:not(:hover) .var-value > input:not(:focus):not(.changed), .var:not(:hover) .var-value > .color > input:not(:focus):not(.changed),
    .var:not(:hover) .var-value > .num:not(:focus-within):not(.changed) {
      background: transparent; border-color: transparent;
    }
    .var:not(:hover) .var-value > .num:not(:focus-within) .grip { color: transparent; }
    .var.changed .var-name { color: var(--sp-warn); }
    /* A color's swatch leads the line; the field's own wrapper steps aside so its picker opens under the whole row. */
    .var.is-color { grid-template-columns: 18px minmax(0, 1fr) 104px 28px; }
    .var.is-color .var-value { display: contents; }
    .var.is-color .var-value > .color { display: contents; }
    .var.is-color .var-value > .color > .swatch { grid-column: 1; grid-row: 1; width: 18px; height: 18px; }
    .var.is-color .var-name { grid-column: 2; grid-row: 1; }
    .var.is-color .var-value > .color > input { grid-column: 3; grid-row: 1; min-width: 0; }
    .var .var-value > .color > .popover { top: calc(100% + 2px); right: 6px; }
    .var-uses {
      justify-self: end; min-width: 22px; height: 18px; padding: 0 5px; border-radius: var(--sp-r-sm);
      font: 500 var(--sp-fs-xs)/1 var(--sp-font); color: var(--sp-link); background: transparent; border-color: transparent;
    }
    .var-uses:hover, .var.open .var-uses { border-color: var(--sp-line-strong); }
    .var-uses.none { color: var(--sp-text-dim); }
    .var-list { grid-column: 1 / -1; font-size: var(--sp-fs-sm); }
    .var-list:not(:empty) { margin: 4px 0 6px; padding: 4px 8px; background: var(--sp-bg); border-radius: var(--sp-r-sm); }
    .var-def { color: var(--sp-text-dim); margin-bottom: 2px; }
    .var-use { padding: 1px 0; word-break: break-word; }
    .resolved { color: var(--sp-text-dim); font: var(--sp-fs-sm) var(--sp-mono); }
    .var-new { margin: 0 0 var(--sp-2); padding: 6px 8px; background: var(--sp-surface); border-radius: var(--sp-r-sm); }
    .var-new-title { color: var(--sp-text-dim); font-size: var(--sp-fs-sm); margin-bottom: 4px; }
    .hint.bad { color: var(--sp-danger); }
    .with-var { display: flex; gap: 4px; align-items: flex-start; position: relative; }
    .with-var > :first-child { flex: 1; min-width: 0; }
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
  const box = h("div", { class: "var-new" });
  box.hidden = !d;
  box.append(h("div", { class: "var-new-title" }, "New variable"));
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
};

/** The "var" button next to a field: use an existing variable, or create one from the value. */
export function varButton(field: HTMLElement, o: VarPickOpts): HTMLElement {
  const bound = varsIn(o.value)[0] ?? null;
  const btn = h("button", { class: `varbtn${bound ? " bound" : ""}`, type: "button", title: bound ? `Uses ${bound}: change or unlink` : "Use a variable, or make one from this value" }, icon("braces", 13));
  const wrap = h("div", { class: "with-var" }, field, btn);
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
  return wrap;
}
