// The design system scan: what the app's CSS uses for each foundation
// (colors, type, spacing, radius, shadows), how much of it already goes
// through tokens (CSS custom properties), and the tokens Spark suggests for
// the rest. Runs in an app frame (client.ts `scanSystem`), read by the
// board's System tab (system-tab.ts), which shows it as a wizard and has
// Claude apply what the person accepts.
//
// Plain functions over the CSSOM; no Claude. Literal values close to each
// other are merged into one suggestion (marked `changesLook`, since using the
// token moves them a little), and a value an existing token already has is
// suggested as that token.
import { eachRule } from "./css.ts";
import { collectVariables } from "./variables.ts";

export type Category = "color" | "type" | "space" | "radius" | "shadow";
export const CATEGORIES: Category[] = ["color", "type", "space", "radius", "shadow"];

/** One place a literal is written: a declaration in a rule, or an element's inline style. */
export type Place = { selector: string; file: string | null; prop: string; value: string };

export type TokenInfo = { name: string; value: string; category: Category; uses: number; file: string | null; selector: string };

export type Suggestion = {
  id: string;
  category: Category;
  /** What it's about inside the category: "background", "font-size", "padding"… */
  kind: string;
  /** The literal values it replaces, as written. */
  values: string[];
  /** The value the token has (an existing token's, or the new one's). */
  value: string;
  uses: number;
  /** Use this existing token instead of making one. */
  existing: string | null;
  /** The new token's name (when there's no existing one). */
  name: string;
  /** Some of the values differ from the token's: using it changes how they look, a little. */
  changesLook: boolean;
  places: Place[];
};

export type Check = { label: string; ok: boolean; detail: string };

export type CategoryReport = {
  category: Category;
  /** Declarations (value parts) of this category in the app's CSS. */
  uses: number;
  /** Of those, how many go through a token. */
  tokenUses: number;
  /** Distinct literal values. */
  literals: number;
  tokens: TokenInfo[];
  suggestions: Suggestion[];
  checks: Check[];
};

export type StateReport = { kinds: number; hover: number; focus: number; disabled: number; disabledKinds: number; missing: string[] };

export type SystemScan = {
  at: number;
  categories: Record<Category, CategoryReport>;
  states: StateReport;
  /** Where the project defines most of its tokens (the rule new ones go in). */
  home: { file: string | null; selector: string } | null;
};

// ---------------------------------------------------------------------------
// Reading the CSS

const COLOR_PROP = /^(color|background(-color)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|fill|stroke|text-decoration(-color)?|caret-color|accent-color|column-rule(-color)?)$/;
const TYPE_PROP = /^(font-size|font-weight|font-family)$/;
const SPACE_PROP = /^(padding|margin)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$|^(gap|row-gap|column-gap)$/;
const RADIUS_PROP = /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/;
const SHADOW_PROP = /^box-shadow$/;

function categoryOf(prop: string): Category | null {
  if (COLOR_PROP.test(prop)) return "color";
  if (TYPE_PROP.test(prop)) return "type";
  if (SPACE_PROP.test(prop)) return "space";
  if (RADIUS_PROP.test(prop)) return "radius";
  if (SHADOW_PROP.test(prop)) return "shadow";
  return null;
}

const VAR = /var\(\s*(--[\w-]+)(?:\s*,[^()]*(?:\([^()]*\)[^()]*)*)?\)/g;
const COLOR_LIT = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\([^()]*\)|\b(?:white|black)\b/gi;
const SIZE_LIT = /^-?\d*\.?\d+(px|rem|em)$/i;

/** A value's parts: the tokens it uses and its literal atoms for `category`. */
function atoms(prop: string, value: string, category: Category): { tokens: string[]; literals: string[] } {
  const tokens = [...value.matchAll(VAR)].map((m) => m[1]);
  const rest = value.replace(VAR, " ").trim();
  let literals: string[] = [];
  if (/^(inherit|initial|unset|revert|none|auto|normal|currentcolor|transparent)$/i.test(rest) || /calc\(|clamp\(|min\(|max\(/i.test(rest)) return { tokens, literals };
  if (category === "color") literals = [...rest.matchAll(COLOR_LIT)].map((m) => m[0].toLowerCase());
  else if (category === "space" || category === "radius") literals = rest.split(/[\s/]+/).filter((a) => (SIZE_LIT.test(a) && parseFloat(a) !== 0) || (category === "radius" && a === "50%"));
  else if (category === "type") {
    if (prop === "font-family") literals = rest && !tokens.length ? [rest.replace(/\s+/g, " ")] : [];
    else if (prop === "font-weight") literals = /^(\d{3}|bold|bolder|lighter)$/i.test(rest) ? [rest.toLowerCase()] : [];
    else literals = SIZE_LIT.test(rest) ? [rest] : [];
  } else if (category === "shadow") literals = rest && !tokens.length ? [rest.replace(/\s+/g, " ")] : [];
  return { tokens, literals };
}

function declarations(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of text.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).replace(/!important/i, "").trim();
    if (prop) out.push([prop, value]);
  }
  return out;
}

type Hit = { category: Category; prop: string; literal: string | null; token: string | null; place: Place };

function readHits(skip: (n: Node) => boolean, others: Document[]): Hit[] {
  const hits: Hit[] = [];
  const take = (prop: string, value: string, selector: string, file: string | null) => {
    if (prop.startsWith("--")) return;
    const category = categoryOf(prop);
    if (!category) return;
    const { tokens, literals } = atoms(prop, value, category);
    for (const t of tokens) hits.push({ category, prop, literal: null, token: t, place: { selector, file, prop, value } });
    for (const l of literals) hits.push({ category, prop, literal: l, token: null, place: { selector, file, prop, value } });
  };
  eachRule(skip, (rule, file) => {
    if (file && /node_modules|\/@spark\//.test(file)) return;
    for (const [prop, value] of declarations(rule.style.cssText)) take(prop, value, rule.selectorText, file);
  });
  // Inline styles written in the JSX: what's rendered, here and in the other app frames (other samples, other sizes).
  const seen = new Set<string>();
  for (const doc of [document, ...others]) {
    for (const el of Array.from(doc.querySelectorAll("[data-spark-src][style]"))) {
      if (doc === document && skip(el)) continue;
      const src = el.getAttribute("data-spark-src") ?? "";
      const style = el.getAttribute("style") ?? "";
      if (seen.has(`${src}|${style}`)) continue;
      seen.add(`${src}|${style}`);
      for (const [prop, value] of declarations(style)) take(prop, value, `<${el.tagName.toLowerCase()}> style at ${src}`, src.replace(/:\d+:\d+$/, ""));
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Values

let ctx: CanvasRenderingContext2D | null = null;
/** A color as [r, g, b, a] (a 0..1), or null. */
export function rgba(value: string): [number, number, number, number] | null {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx || !CSS.supports("color", value)) return null;
  ctx.fillStyle = "#000";
  ctx.fillStyle = value;
  const v = String(ctx.fillStyle);
  if (v.startsWith("#")) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1];
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b, a = "1"] = m[1].split(",").map((s) => s.trim());
  return [+r, +g, +b, +a];
}

const colorDist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) + Math.abs(a[3] - b[3]) * 255;

/** A length in px ("1.5rem" → 24), or null for em and anything else relative. */
function px(value: string): number | null {
  const m = value.match(/^(-?\d*\.?\d+)(px|rem)$/i);
  if (!m) return null;
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return m[2].toLowerCase() === "rem" ? +m[1] * root : +m[1];
}

const WEIGHT: Record<string, number> = { bold: 700, normal: 400, bolder: 700, lighter: 300 };
const WEIGHT_NAME: Record<number, string> = { 100: "thin", 200: "extralight", 300: "light", 400: "regular", 500: "medium", 600: "semibold", 700: "bold", 800: "extrabold", 900: "black" };
const SCALE = ["3xs", "2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl"];

/** Scale names for sorted sizes, the most used one "md". */
function scaleNames(sizes: number[], counts: number[]): string[] {
  const base = counts.indexOf(Math.max(...counts));
  return sizes.map((_, i) => SCALE[Math.min(SCALE.length - 1, Math.max(0, 4 + i - base))]);
}

// ---------------------------------------------------------------------------
// Tokens

const ROLES: [string, RegExp][] = [
  ["background", /(^|-)(bg|background|canvas|base)(-|$)/],
  ["surface", /(^|-)(surface|panel|card|raised|elevated|field)(-|$)|(^|-)(bg|background)-([1-9]|alt|subtle|raised|elevated)$/],
  ["text", /(^|-)(text|fg|foreground|ink|content)(-|$)/],
  ["muted text", /(^|-)(text|fg|ink)-(dim|muted|faint|subtle|secondary|2)|(^|-)(muted|dim|faint)(-|$)/],
  ["border", /(^|-)(border|line|divider|stroke|outline)(-|$)/],
  ["accent", /(^|-)(accent|primary|brand|link|focus)(-|$)/],
  ["danger", /(^|-)(danger|error|critical|destructive|negative|red)(-|$)/],
];

function tokenCategory(name: string, value: string, usedBy: string[]): Category | null {
  const counts = new Map<Category, number>();
  for (const p of usedBy) {
    const c = categoryOf(p);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best) return best;
  const n = name.toLowerCase();
  if (/radius|(^|-)r-/.test(n)) return "radius";
  if (/shadow|elev/.test(n)) return "shadow";
  if (/font|text-size|fs-|weight|leading/.test(n)) return "type";
  if (/space|gap|pad|margin|(^|-)sp-\d/.test(n)) return "space";
  if (rgba(value)) return "color";
  return null;
}

// ---------------------------------------------------------------------------
// The scan

/**
 * Scan this page's styles. Rules come from every loaded stylesheet; what only
 * shows when rendered (inline styles, the controls checked for states) also
 * comes from `others`, the other app frames' documents (same origin), so frames
 * on other samples count too.
 */
export function scanSystem(skip: (n: Node) => boolean, others: Document[] = []): SystemScan {
  const vars = collectVariables(skip).filter((v) => !(v.file && /node_modules|\/@spark\//.test(v.file)));
  const tokens: TokenInfo[] = [];
  for (const v of vars) {
    const value = v.resolved || v.authored;
    const category = tokenCategory(v.name, value, v.uses.map((u) => u.property));
    if (category) tokens.push({ name: v.name, value, category, uses: v.uses.length, file: v.file, selector: v.selector });
  }
  // Where new tokens go: the :root rule that defines the most of them.
  const homes = new Map<string, { file: string | null; selector: string; n: number }>();
  for (const v of vars) {
    if (!/(^|,)\s*(:root|html)\s*($|,)/.test(v.selector)) continue;
    const k = `${v.file}|${v.selector}`;
    homes.set(k, { file: v.file, selector: v.selector, n: (homes.get(k)?.n ?? 0) + 1 });
  }
  const home = [...homes.values()].sort((a, b) => b.n - a.n)[0] ?? null;

  const hits = readHits(skip, others);
  const categories = {} as Record<Category, CategoryReport>;
  for (const category of CATEGORIES) {
    const mine = hits.filter((h) => h.category === category);
    const lit = mine.filter((h) => h.literal !== null);
    const own = tokens.filter((t) => t.category === category);
    const suggestions = suggest(category, lit, own);
    categories[category] = {
      category,
      uses: mine.length,
      tokenUses: mine.length - lit.length,
      literals: new Set(lit.map((h) => h.literal)).size,
      tokens: own,
      suggestions,
      checks: [],
    };
    categories[category].checks = checks(categories[category], mine);
  }
  return { at: Date.now(), categories, states: stateReport(skip, others), home: home ? { file: home.file, selector: home.selector } : null };
}

/** The literal values of one category, grouped into the tokens Spark suggests. */
function suggest(category: Category, lit: Hit[], own: TokenInfo[]): Suggestion[] {
  // Each literal with its uses, most used first.
  const byValue = new Map<string, Hit[]>();
  for (const h of lit) {
    const key = category === "type" ? `${h.prop}|${h.literal}` : (h.literal as string);
    byValue.set(key, [...(byValue.get(key) ?? []), h]);
  }
  const values = [...byValue].sort((a, b) => b[1].length - a[1].length);
  type Group = { kind: string; value: string; existing: string | null; members: { value: string; hits: Hit[] }[]; key: number[] | number | string };
  const groups: Group[] = [];
  const taken = new Set(own.map((t) => t.name));
  const join = (g: Group, value: string, hits: Hit[]) => g.members.push({ value, hits });

  for (const [key, hits] of values) {
    const value = hits[0].literal as string;
    const prop = hits[0].prop;
    if (category === "color") {
      const c = rgba(value);
      if (!c) continue;
      const near = (other: number[]) => colorDist(c, other) <= 14;
      const g = groups.find((x) => near(x.key as number[]));
      if (g) {
        join(g, value, hits);
        continue;
      }
      const tok = own.map((t) => ({ t, c: rgba(t.value) })).filter((x) => x.c && near(x.c)).sort((a, b) => colorDist(c, a.c!) - colorDist(c, b.c!))[0];
      groups.push({ kind: roleOf(hits), value: tok ? tok.t.value : value, existing: tok?.t.name ?? null, members: [{ value, hits }], key: tok?.c ?? c });
    } else if (category === "space" || category === "radius") {
      const n = value === "50%" ? 9999 : px(value);
      if (n === null) {
        groups.push({ kind: prop, value, existing: own.find((t) => t.value === value)?.name ?? null, members: [{ value, hits }], key: value });
        continue;
      }
      // Spacing snaps to the 4px grid (2px and less stay hairlines); radii merge within 1px.
      const target = category === "space" ? (n <= 2 ? n : Math.max(4, Math.round(n / 4) * 4)) : n >= 999 ? 9999 : n;
      const g = groups.find((x) => typeof x.key === "number" && Math.abs((x.key as number) - target) <= (category === "radius" ? 1 : 0));
      if (g) {
        join(g, value, hits);
        continue;
      }
      const tok = own.find((t) => {
        const tv = t.value === "50%" ? 9999 : px(t.value);
        return tv !== null && Math.abs(tv - target) < 0.5;
      });
      groups.push({ kind: category === "space" ? "spacing" : "radius", value: tok ? tok.value : target === 9999 ? "9999px" : `${target}px`, existing: tok?.name ?? null, members: [{ value, hits }], key: target });
    } else if (category === "type") {
      if (prop === "font-size") {
        const n = px(value);
        const g = n === null ? undefined : groups.find((x) => x.kind === "font-size" && typeof x.key === "number" && Math.abs((x.key as number) - n) <= 0.5);
        if (g) {
          join(g, value, hits);
          continue;
        }
        const tok = n === null ? undefined : own.find((t) => px(t.value) === n);
        groups.push({ kind: "font-size", value: tok?.value ?? value, existing: tok?.name ?? null, members: [{ value, hits }], key: n ?? value });
      } else if (prop === "font-weight") {
        const w = WEIGHT[value] ?? +value;
        const g = groups.find((x) => x.kind === "font-weight" && x.key === w);
        if (g) {
          join(g, value, hits);
          continue;
        }
        const tok = own.find((t) => (WEIGHT[t.value] ?? +t.value) === w);
        groups.push({ kind: "font-weight", value: tok?.value ?? String(w), existing: tok?.name ?? null, members: [{ value, hits }], key: w });
      } else {
        const norm = value.toLowerCase().replace(/["']/g, "");
        const tok = own.find((t) => t.value.toLowerCase().replace(/["']/g, "").replace(/\s+/g, " ") === norm);
        groups.push({ kind: "font-family", value: tok?.value ?? value, existing: tok?.name ?? null, members: [{ value, hits }], key: key });
      }
    } else {
      const tok = own.find((t) => t.value.replace(/\s+/g, " ") === value);
      groups.push({ kind: "shadow", value: tok?.value ?? value, existing: tok?.name ?? null, members: [{ value, hits }], key: value });
    }
  }

  // Names for the new ones.
  const name = (base: string) => {
    let n = base;
    for (let i = 2; taken.has(n); i++) n = `${base}-${i}`;
    taken.add(n);
    return n;
  };
  const fresh = groups.filter((g) => !g.existing);
  if (category === "type") {
    const sizes = fresh.filter((g) => g.kind === "font-size" && typeof g.key === "number").sort((a, b) => (a.key as number) - (b.key as number));
    const names = scaleNames(
      sizes.map((g) => g.key as number),
      sizes.map((g) => g.members.reduce((n, m) => n + m.hits.length, 0)),
    );
    sizes.forEach((g, i) => ((g as Group & { name?: string }).name = name(`--font-size-${names[i]}`)));
  }
  if (category === "radius") {
    const radii = fresh.filter((g) => typeof g.key === "number" && g.key !== 9999).sort((a, b) => (a.key as number) - (b.key as number));
    const names = radii.length <= 1 ? ["md"] : radii.length === 2 ? ["sm", "md"] : radii.length === 3 ? ["sm", "md", "lg"] : radii.map((_, i) => SCALE[Math.min(SCALE.length - 1, 3 + i)]);
    radii.forEach((g, i) => ((g as Group & { name?: string }).name = name(`--radius-${names[i]}`)));
  }
  let shadow = 1;
  const named = (g: Group): string => {
    const preset = (g as Group & { name?: string }).name;
    if (preset) return preset;
    if (category === "color") return name(`--color-${g.kind}`);
    if (category === "space") return name(typeof g.key === "number" ? `--space-${String(g.key / 4).replace(".", "-")}` : "--space");
    if (category === "radius") return name(g.key === 9999 ? "--radius-full" : "--radius");
    if (category === "shadow") return name(`--shadow-${shadow++}`);
    if (g.kind === "font-weight") return name(`--font-weight-${WEIGHT_NAME[g.key as number] ?? g.key}`);
    if (g.kind === "font-family") return name(/mono|consol|courier|menlo/i.test(g.value) ? "--font-mono" : /serif/i.test(g.value) && !/sans/i.test(g.value) ? "--font-serif" : "--font-sans");
    return name("--font-size");
  };

  return groups
    .map((g, i) => {
      const hits = g.members.flatMap((m) => m.hits);
      const same = (v: string) => {
        if (category === "color") {
          const a = rgba(v);
          const b = rgba(g.value);
          return !!a && !!b && colorDist(a, b) <= 2;
        }
        const a = px(v);
        const b = px(g.value);
        return a !== null && b !== null ? Math.abs(a - b) < 0.01 : v.toLowerCase().replace(/["'\s]/g, "") === g.value.toLowerCase().replace(/["'\s]/g, "");
      };
      return {
        id: `${category}-${i + 1}`,
        category,
        kind: g.kind,
        values: g.members.map((m) => m.value),
        value: g.value,
        uses: hits.length,
        existing: g.existing,
        name: g.existing ?? named(g),
        changesLook: g.members.some((m) => !same(m.value)),
        places: hits.map((h) => h.place),
      };
    })
    .sort((a, b) => Number(!!b.existing) - Number(!!a.existing) || b.uses - a.uses);
}

/** What a color is mostly used for: background, text, border, icon. */
function roleOf(hits: Hit[]): string {
  const n = (re: RegExp) => hits.filter((h) => re.test(h.prop)).length;
  const counts: [string, number][] = [
    ["bg", n(/^background/)],
    ["text", n(/^(color|caret-color|text-decoration)/)],
    ["border", n(/^(border|outline|column-rule)/)],
    ["icon", n(/^(fill|stroke)$/)],
  ];
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

function checks(r: CategoryReport, hits: Hit[]): Check[] {
  const out: Check[] = [];
  const pct = r.uses ? Math.round((r.tokenUses / r.uses) * 100) : 100;
  out.push({ label: "Uses tokens", ok: pct >= 90, detail: r.uses ? `${pct}% of ${r.uses} uses go through a token` : "Nothing uses it yet" });
  const distinct = (kind?: string) => {
    const vals = new Set<string>();
    for (const h of hits) {
      if (kind && h.prop !== kind) continue;
      if (h.literal) vals.add(h.literal);
      else if (h.token) vals.add(r.tokens.find((t) => t.name === h.token)?.value ?? h.token);
    }
    return vals.size;
  };
  if (r.category === "color") {
    const names = r.tokens.map((t) => t.name.toLowerCase());
    const have = ROLES.filter(([, re]) => names.some((n) => re.test(n.replace(/^--/, ""))));
    const missing = ROLES.filter((x) => !have.includes(x)).map(([n]) => n);
    out.push({ label: "Semantic roles", ok: missing.length === 0, detail: missing.length ? `Has ${have.length} of ${ROLES.length}; missing ${missing.join(", ")}` : `All ${ROLES.length}: background, surface, text, muted text, border, accent, danger` });
  } else if (r.category === "type") {
    const sizes = distinct("font-size");
    const fams = distinct("font-family");
    const weights = distinct("font-weight");
    out.push({ label: "A short size scale", ok: sizes <= 8, detail: `${sizes} font size${sizes === 1 ? "" : "s"} (8 or fewer reads as a scale)` });
    out.push({ label: "Few families and weights", ok: fams <= 3 && weights <= 4, detail: `${fams} famil${fams === 1 ? "y" : "ies"}, ${weights} weight${weights === 1 ? "" : "s"}` });
  } else if (r.category === "space") {
    const lens = hits.map((h) => (h.literal ? px(h.literal) : px(r.tokens.find((t) => t.name === h.token)?.value ?? ""))).filter((n): n is number => n !== null);
    const on = lens.filter((n) => n <= 2 || n % 4 === 0).length;
    const p = lens.length ? Math.round((on / lens.length) * 100) : 100;
    out.push({ label: "On a 4px grid", ok: p >= 90, detail: `${p}% of spacing values are multiples of 4` });
  } else if (r.category === "radius") {
    const n = distinct();
    out.push({ label: "A few radii", ok: n <= 4, detail: `${n} distinct radi${n === 1 ? "us" : "i"} (4 or fewer)` });
  } else {
    const n = distinct();
    out.push({ label: "A few elevations", ok: n <= 4, detail: `${n} distinct shadow${n === 1 ? "" : "s"} (4 or fewer)` });
  }
  return out;
}

/** Do the app's interactive elements have hover, focus and disabled styles? Counted per kind (tag and classes). */
function stateReport(skip: (n: Node) => boolean, others: Document[]): StateReport {
  const pseudo: Record<"hover" | "focus" | "disabled", string[]> = { hover: [], focus: [], disabled: [] };
  eachRule(skip, (rule, file) => {
    if (file && /node_modules|\/@spark\//.test(file)) return;
    for (const sel of rule.selectorText.split(",")) {
      for (const k of ["hover", "focus", "disabled"] as const) {
        const re = k === "focus" ? /:focus(-visible|-within)?/g : k === "disabled" ? /:disabled|\[disabled\]|\[aria-disabled[^\]]*\]/g : /:hover/g;
        if (!re.test(sel)) continue;
        // The selector without the state and anything after it that can't match now (::before).
        pseudo[k].push(sel.replace(re, "").replace(/::?[\w-]+(\([^)]*\))?$/g, "").trim() || "*");
      }
    }
  });
  const kinds = new Map<string, Element>();
  const controls = [document, ...others].flatMap((doc) => Array.from(doc.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem]")));
  for (const el of controls) {
    if ((el.ownerDocument === document && skip(el)) || !el.hasAttribute("data-spark-src")) continue;
    const key = `${el.tagName.toLowerCase()}${Array.from(el.classList).sort().map((c) => `.${c}`).join("")}`;
    if (!kinds.has(key)) kinds.set(key, el);
  }
  const has = (el: Element, sels: string[]) =>
    sels.some((s) => {
      try {
        return el.matches(s);
      } catch {
        return false;
      }
    });
  let hover = 0;
  let focus = 0;
  let disabled = 0;
  let disabledKinds = 0;
  const missing: string[] = [];
  for (const [key, el] of kinds) {
    const h = has(el, pseudo.hover);
    const f = has(el, pseudo.focus);
    if (h) hover++;
    if (f) focus++;
    const canDisable = /^(button|input|select|textarea)/.test(key);
    if (canDisable) {
      disabledKinds++;
      if (has(el, pseudo.disabled)) disabled++;
    }
    if (!h || !f) missing.push(`${key}${!h ? " (no hover)" : ""}${!f ? " (no focus)" : ""}`);
  }
  return { kinds: kinds.size, hover, focus, disabled, disabledKinds, missing };
}
