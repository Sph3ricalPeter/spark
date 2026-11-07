// The Page view: styles set on the document itself (:root, html, body, the
// React root, *), which every element inherits from but nobody can click on.
//
// Each declaration gets a field; an edit is recorded as a "component" change
// on that rule (file + selector), the same kind a CSS-rule edit makes, so
// Claude applies it in the stylesheet. Custom properties defined there live
// in the Variables view instead.
import { eachRule, type RuleRef } from "./css.ts";
import { colorField, h, numberField, textField, type OnValue, type Token } from "./fields.ts";
import { kindOf, resolvedLine } from "./variables.ts";

/** One selector part that targets the page rather than a component. */
const PAGE_PART = /^(:root|html|body|#root|#app|\*|\*::?before|\*::?after|html\s*,?\s*body)$/i;

export function isPageSelector(selector: string): boolean {
  return selector.split(",").every((p) => PAGE_PART.test(p.trim()));
}

/** Rules that style the page, in document order. */
export function pageRules(skip: (n: Node) => boolean): RuleRef[] {
  const out: RuleRef[] = [];
  eachRule(skip, (rule, file) => {
    if (isPageSelector(rule.selectorText)) out.push({ rule, selector: rule.selectorText, file });
  });
  return out;
}

/** Declarations as written (shorthands with var() included), custom properties aside. */
function declarations(rule: CSSStyleRule): { props: [string, string][]; vars: number } {
  const props: [string, string][] = [];
  let vars = 0;
  for (const part of rule.style.cssText.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const prop = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim().replace(/\s*!important$/, "");
    if (!prop) continue;
    if (prop.startsWith("--")) vars++;
    else props.push([prop, value]);
  }
  return { props, vars };
}

export type PageDeps = {
  /** The pending value for a property of a rule, if Spark changed it. */
  pendingValue: (file: string | null, selector: string, prop: string) => string | undefined;
  /** Record `prop: value` on the rule (from: its value before Spark, "" for a new property). */
  edit: (ref: RuleRef, prop: string, from: string, value: string, final: boolean) => void;
  colors: Token[];
  jumpToVariable: (name: string) => void;
  showVariables: () => void;
  shortFile: (file: string | null) => string;
};

export function renderPage(into: HTMLElement, rules: RuleRef[], deps: PageDeps) {
  into.append(h("div", { class: "hint" }, "Styles on the page itself (html, body, :root …). Everything inherits these unless it sets its own."));
  if (rules.length === 0) {
    into.append(h("div", { class: "empty" }, "No page-level rules found."));
    return;
  }
  for (const ref of rules) {
    const { props, vars } = declarations(ref.rule);
    if (props.length === 0 && vars === 0) continue;
    into.append(h("h3", { class: "page-rule" }, h("span", {}, ref.selector), h("span", { class: "empty" }, deps.shortFile(ref.file))));
    const target = targetOf(ref.selector);
    const cs = target ? getComputedStyle(target) : null;
    for (const [prop, original] of props) {
      const pending = deps.pendingValue(ref.file, ref.selector, prop);
      into.append(declRow(ref, prop, original, pending, cs?.getPropertyValue(prop) ?? "", deps));
    }
    if (vars) {
      into.append(h("div", { class: "hint" }, `${vars} variable${vars === 1 ? "" : "s"} defined here: `, h("span", { class: "link", click: deps.showVariables }, "see Variables")));
    }
    into.append(addRow(ref, deps));
  }
}

function targetOf(selector: string): Element | null {
  const first = selector.split(",")[0].trim();
  if (/^(:root|html)$/i.test(first)) return document.documentElement;
  if (/^body$/i.test(first)) return document.body;
  try {
    return first.includes("*") ? document.body : document.querySelector(first);
  } catch {
    return null;
  }
}

function declRow(ref: RuleRef, prop: string, original: string, pending: string | undefined, computed: string, deps: PageDeps) {
  const value = pending ?? original;
  const changed = pending !== undefined;
  const onValue: OnValue = (v, final) => deps.edit(ref, prop, original, v, final);
  const shown = computed.trim() || value;
  const kind = kindOf(value.includes("var(") ? shown : value);
  let field: HTMLElement;
  if (kind === "color") field = colorField(value, shown, deps.colors, changed, onValue);
  else if (kind === "size" && /^-?\d*\.?\d+[a-z%]*$/i.test(value)) {
    field = numberField(value, { computed: shown, unit: value.replace(/^-?\d*\.?\d+/, ""), step: /^-?\d*\.\d/.test(value) ? 0.1 : 1, changed }, onValue);
  } else field = textField(value, changed, onValue);
  return h(
    "div",
    { class: "row" },
    h("span", { class: "k", title: prop }, prop),
    h("div", { class: "field" }, field, resolvedLine(value, computed, deps.jumpToVariable)),
  );
}

/** A property the rule doesn't set yet. */
function addRow(ref: RuleRef, deps: PageDeps) {
  const name = h("input", { placeholder: "add property", spellcheck: "false" }) as HTMLInputElement;
  const value = h("input", { placeholder: "value", spellcheck: "false" }) as HTMLInputElement;
  const bad = (on: boolean) => {
    name.classList.toggle("bad", on);
    value.classList.toggle("bad", on);
  };
  const commit = () => {
    const p = name.value.trim().toLowerCase();
    const v = value.value.trim();
    if (!p || !v) return;
    if (!CSS.supports(p, v)) return bad(true);
    bad(false);
    deps.edit(ref, p, "", v, true);
  };
  for (const input of [name, value]) {
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if ((e as KeyboardEvent).key === "Enter") commit();
    });
    input.addEventListener("keyup", (e) => e.stopPropagation());
  }
  value.addEventListener("change", commit);
  return h("div", { class: "row page-add" }, h("span", { class: "k" }, name), h("div", { class: "field" }, value));
}

/** The nearest ancestor that sets an inherited property, and the rule that sets it. */
export function inheritedFrom(
  el: Element,
  prop: string,
  rulesOf: (el: Element) => RuleRef[],
): { el: Element; rule: RuleRef } | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const rules = rulesOf(p);
    for (let i = rules.length - 1; i >= 0; i--) {
      if (rules[i].rule.style.getPropertyValue(prop) || shorthandSets(rules[i].rule, prop)) return { el: p, rule: rules[i] };
    }
  }
  return null;
}

/** `font: …` sets font-family and friends without exposing them as longhands when it uses var(). */
function shorthandSets(rule: CSSStyleRule, prop: string): boolean {
  if (!prop.startsWith("font-") && prop !== "line-height") return false;
  return /(^|;)\s*font\s*:/.test(rule.style.cssText);
}

/** Properties that inherit: where the inspector says which ancestor they come from. */
export const INHERITED = new Set(["color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "text-transform"]);

export const PAGE_STYLE = `
    h3.page-rule { display: flex; gap: 8px; align-items: baseline; text-transform: none; letter-spacing: 0; font: 600 11px ui-monospace, monospace; color: #fff; }
    h3.page-rule .empty { font-weight: 400; font-family: ui-sans-serif, system-ui, sans-serif; }
    .page-add .k input { width: 100%; }
    .inherited { color: #8a8f98; font-size: 11px; margin-top: 2px; }
    `;
