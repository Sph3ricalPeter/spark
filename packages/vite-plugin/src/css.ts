// Reading the page's CSS the way the source wrote it: which rules match an
// element, what value each rule gives a property, and where a token lives.

export type RuleRef = {
  rule: CSSStyleRule;
  selector: string;
  /** The file the rule comes from, as Vite's dev server marks it (absolute), or the sheet's URL. */
  file: string | null;
};

function eachRule(skip: (n: Node) => boolean, fn: (rule: CSSStyleRule, file: string | null) => void) {
  const walk = (rules: CSSRuleList, file: string | null) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        fn(rule, file);
        if (rule.cssRules?.length) walk(rule.cssRules, file);
      } else if (rule instanceof CSSMediaRule) {
        if (matchMedia(rule.conditionText).matches) walk(rule.cssRules, file);
      } else if ("cssRules" in rule) {
        walk((rule as CSSGroupingRule).cssRules, file);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    const owner = sheet.ownerNode as Element | null;
    if (owner && skip(owner)) continue;
    const file = owner?.getAttribute?.("data-vite-dev-id") ?? sheet.href ?? null;
    try {
      walk(sheet.cssRules, file);
    } catch {
      // Cross-origin sheet.
    }
  }
}

/** Rules that match `el`, in document order (later ones win ties). */
export function matchedRules(el: Element, skip: (n: Node) => boolean): RuleRef[] {
  const out: RuleRef[] = [];
  eachRule(skip, (rule, file) => {
    try {
      if (el.matches(rule.selectorText)) out.push({ rule, selector: rule.selectorText, file });
    } catch {
      // A selector the browser can't match against (::before and friends).
    }
  });
  return out;
}

/** True when `file` (absolute or URL) is the project-relative `rel`. */
export function sameFile(file: string | null, rel: string | null): boolean {
  if (!file || !rel) return file === rel;
  return file === rel || file.endsWith("/" + rel);
}

export function findRule(rel: string | null, selector: string, skip: (n: Node) => boolean): CSSStyleRule | null {
  let found: CSSStyleRule | null = null;
  eachRule(skip, (rule, file) => {
    if (rule.selectorText === selector && sameFile(file, rel)) found = rule;
  });
  return found;
}

/** The last rule that defines the custom property `name` on :root (or anywhere, failing that). */
export function tokenRule(name: string, skip: (n: Node) => boolean): RuleRef | null {
  let root: RuleRef | null = null;
  let any: RuleRef | null = null;
  eachRule(skip, (rule, file) => {
    if (!rule.style.getPropertyValue(name)) return;
    const ref = { rule, selector: rule.selectorText, file };
    any = ref;
    if (/(^|,)\s*(:root|html)\s*($|,)/.test(rule.selectorText)) root = ref;
  });
  return root ?? any;
}

/** Custom properties referenced by these rules (and the element's inline style), in first-seen order. */
export function tokensUsed(el: Element, rules: RuleRef[]): string[] {
  const seen = new Set<string>();
  const texts = rules.map((r) => r.rule.style.cssText);
  texts.push(el.getAttribute("style") ?? "");
  for (const t of texts) for (const m of t.matchAll(/var\(\s*(--[\w-]+)/g)) seen.add(m[1]);
  return [...seen];
}

/** The value the source gives `prop` for this element: inline style first, then the last rule that sets it. */
export function authored(el: Element, rules: RuleRef[], prop: string): string | null {
  const inline = (el as HTMLElement).style?.getPropertyValue(prop);
  if (inline) return inline;
  for (let i = rules.length - 1; i >= 0; i--) {
    const v = rules[i].rule.style.getPropertyValue(prop);
    if (v) return v;
  }
  return null;
}
