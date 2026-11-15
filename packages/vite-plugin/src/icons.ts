// Icons: which icon an `<svg>` is, and the picker that swaps it for another.
//
// An icon is named `library:Icon` when it's a component from an icon library
// (tag.ts marks those `data-spark-icon`), or `inline:<src>` when it's an
// `<svg>` written in the app's own JSX at that file:line:col. The picker
// offers the icons this app already draws inline (on every frame of the
// board) and every icon of the libraries the project uses, rendered with
// the app's own React (index.ts serves `/@spark/icons?lib=…`).
import { h, showPopover } from "./fields.ts";

const NS = "http://www.w3.org/2000/svg";

/** An icon and its markup (colors as `currentColor`, so it paints in whatever color it's shown in). */
export type IconChoice = { id: string; svg: string };

/** What the icon `id` is called: its name and where it comes from. */
export function iconLabel(id: string, ownSrc: string | null): { name: string; from: string } {
  if (id.startsWith("inline:")) {
    const src = id.slice(7);
    if (src === ownSrc) return { name: "Inline SVG", from: "drawn in the JSX" };
    return { name: "Inline SVG", from: `as at ${src.split("/").pop()}` };
  }
  const at = id.lastIndexOf(":");
  return { name: id.slice(at + 1), from: id.slice(0, at) };
}

/** The icon an `<svg>` is in the source. */
export function sourceIcon(el: Element): string {
  return el.getAttribute("data-spark-icon") ?? `inline:${el.getAttribute("data-spark-src") ?? "?"}`;
}

/** The outermost `<svg>` around `node`, if it's in one. */
export function svgRoot(node: Element): SVGSVGElement | null {
  let top: SVGSVGElement | null = null;
  for (let s = node.closest("svg"); s; s = s.parentElement?.closest("svg") ?? null) top = s;
  return top;
}

/** Presentation properties copied from computed style onto the markup, with their initial values (left out). */
const PAINT: Record<string, string> = {
  fill: "",
  stroke: "",
  "stroke-width": "1",
  "stroke-linecap": "butt",
  "stroke-linejoin": "miter",
  "stroke-miterlimit": "4",
  "stroke-dasharray": "none",
  "fill-rule": "nonzero",
  "clip-rule": "nonzero",
  opacity: "1",
  "fill-opacity": "1",
  "stroke-opacity": "1",
};

/** A paint as markup: any color is the icon's color. */
const paint = (v: string) => (v === "none" || v.startsWith("url(") ? v : "currentColor");

/** A presentation property as the markup writes it. */
const paintOf = (cs: CSSStyleDeclaration, p: string) => {
  const v = cs.getPropertyValue(p).trim();
  return p === "fill" || p === "stroke" ? paint(v) : p === "stroke-width" ? String(parseFloat(v)) : v;
};

const withNs = (svg: string) => svg.replace(/^<svg(?![^>]*\sxmlns=)/, `<svg xmlns="${NS}"`);

/**
 * An `<svg>` in the page as standalone markup that looks the way it's drawn:
 * its CSS (stroke, fill, widths) written out as attributes, colors as
 * `currentColor`, no classes or Spark attributes.
 */
export function iconMarkup(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const from = [svg, ...Array.from(svg.querySelectorAll("*"))];
  const to = [clone, ...Array.from(clone.querySelectorAll("*"))];
  const styles = new Map(from.map((s) => [s, getComputedStyle(s)]));
  from.forEach((s, i) => {
    const d = to[i];
    const cs = styles.get(s)!;
    const up = s === svg ? null : styles.get(s.parentElement!);
    for (const a of Array.from(d.attributes)) if (/^(class|style|width|height|data-.*|aria-.*|focusable|role)$/.test(a.name)) d.removeAttribute(a.name);
    for (const [p, initial] of Object.entries(PAINT)) {
      let v = cs.getPropertyValue(p).trim();
      if (!v) continue;
      if (p === "fill" || p === "stroke") v = paint(v);
      else if (p === "stroke-width") v = String(parseFloat(v));
      // Left out when it's the default, or the same as what it inherits.
      if (!d.hasAttribute(p) && (up ? (p === "opacity" ? v === "1" : v === paintOf(up, p)) : v === initial)) continue;
      d.setAttribute(p, v);
    }
  });
  let vb = svg.viewBox.baseVal;
  if (!vb || !vb.width) {
    const w = parseFloat(svg.getAttribute("width") ?? "") || svg.getBoundingClientRect().width || 24;
    const hh = parseFloat(svg.getAttribute("height") ?? "") || svg.getBoundingClientRect().height || 24;
    clone.setAttribute("viewBox", `0 0 ${w} ${hh}`);
    vb = { x: 0, y: 0, width: w, height: hh } as DOMRect;
  }
  // A flip or turn on the svg itself (`transform: scaleX(-1)`) is part of how it looks.
  const t = getComputedStyle(svg).transform;
  if (t && t !== "none") {
    const m = new DOMMatrix(t);
    const cx = vb.x + vb.width / 2;
    const cy = vb.y + vb.height / 2;
    const g = document.createElementNS(NS, "g");
    g.setAttribute("transform", `translate(${cx} ${cy}) matrix(${m.a} ${m.b} ${m.c} ${m.d} 0 0) translate(${-cx} ${-cy})`);
    g.append(...Array.from(clone.childNodes));
    clone.append(g);
  }
  clone.removeAttribute("transform");
  return withNs(clone.outerHTML);
}

/** Markup a library rendered: its own attributes say how it looks; drop classes and sizes. */
function libraryMarkup(svg: string): string {
  const t = document.createElement("template");
  t.innerHTML = svg;
  const el = t.content.firstElementChild;
  if (!el) return svg;
  for (const a of Array.from(el.attributes)) if (/^(class|style|width|height|data-.*|aria-.*)$/.test(a.name)) el.removeAttribute(a.name);
  return withNs(el.outerHTML);
}

/** The documents to look for inline icons in: this page and, on the board, the other frames. */
function documents(): Document[] {
  const docs = [document];
  try {
    if (window.parent !== window)
      for (const f of Array.from(window.parent.document.querySelectorAll("iframe"))) {
        const d = f.contentDocument;
        if (d && d !== document) docs.push(d);
      }
  } catch {
    // Not the board, or not ours to read.
  }
  return docs;
}

/** The icons the app draws as inline `<svg>` in its own JSX, each once. */
export function appIcons(): IconChoice[] {
  const seen = new Map<string, IconChoice>();
  for (const doc of documents())
    for (const svg of Array.from(doc.querySelectorAll("svg[data-spark-src]"))) {
      if (svg.hasAttribute("data-spark-icon") || svg.parentElement?.closest("svg")) continue;
      const r = svg.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const markup = iconMarkup(svg as SVGSVGElement);
      const key = markup.replace(/\s+/g, " ");
      if (!seen.has(key)) seen.set(key, { id: `inline:${svg.getAttribute("data-spark-src")}`, svg: markup });
    }
  return [...seen.values()];
}

type Library = { names: string[]; render: (names: string[]) => Promise<Record<string, string>> };
const libraries = new Map<string, Promise<Library>>();
const rendered = new Map<string, string>();

function library(lib: string): Promise<Library> {
  if (!libraries.has(lib)) libraries.set(lib, import(/* @vite-ignore */ `/@spark/icons?lib=${encodeURIComponent(lib)}`) as Promise<Library>);
  return libraries.get(lib)!;
}

/** The project's icon libraries (its package.json). */
let projectLibs: Promise<string[]> | null = null;
function projectLibraries(): Promise<string[]> {
  projectLibs ??= import("/@spark/icon-libs").then((m) => m.default, () => []);
  return projectLibs;
}

/** Markup of these icons of `lib`, rendered once each. */
async function markupOf(lib: string, names: string[]): Promise<Record<string, string>> {
  const todo = names.filter((n) => !rendered.has(`${lib}:${n}`));
  if (todo.length) {
    const out = await (await library(lib)).render(todo);
    for (const n of todo) rendered.set(`${lib}:${n}`, out[n] ? libraryMarkup(out[n]) : "");
  }
  return Object.fromEntries(names.map((n) => [n, rendered.get(`${lib}:${n}`) ?? ""]));
}

/** The markup for any icon id (a library icon is rendered; an inline one is read from the page). */
export async function markupFor(id: string): Promise<string> {
  if (id.startsWith("inline:")) return appIcons().find((x) => x.id === id)?.svg ?? "";
  const at = id.lastIndexOf(":");
  return (await markupOf(id.slice(0, at), [id.slice(at + 1)]))[id.slice(at + 1)] ?? "";
}

/** An icon's markup as an element to show (in Spark's UI, at `size`). */
export function iconPreview(svg: string, size: number): HTMLElement {
  const box = h("span", { class: "ico" });
  box.innerHTML = svg;
  const s = box.firstElementChild as SVGSVGElement | null;
  if (s) s.style.width = s.style.height = `${size}px`;
  return box;
}

/** Words that find an icon: its name split into parts ("ArrowUpRight" → "arrow up right"). */
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").toLowerCase();

/** How many icons a library tab shows at once; the search narrows the rest. */
const SHOWN = 160;

/**
 * Open the icon picker in `parent` (a popover): a tab for the app's own icons
 * and one per icon library, a search, and a grid. `current` is the icon shown
 * now; `pick` gets the chosen one.
 */
export function openIconPicker(parent: HTMLElement, current: string, pick: (choice: IconChoice) => void) {
  const pop = h("div", { class: "popover icons" });
  const tabs = h("div", { class: "ico-tabs" });
  const search = h("input", { class: "ico-search", type: "text", placeholder: "Search icons", spellcheck: "false" }) as HTMLInputElement;
  const grid = h("div", { class: "ico-grid" });
  const note = h("div", { class: "hint" });
  pop.append(tabs, search, grid, note);
  if (!showPopover(parent, pop)) return;
  for (const k of ["keydown", "keyup", "keypress"]) search.addEventListener(k, (e) => e.stopPropagation());

  const currentLib = current.startsWith("inline:") ? null : current.slice(0, current.lastIndexOf(":"));
  let tab = currentLib ?? "app";
  let shown = 0;

  const cell = (choice: IconChoice, title: string) => {
    const b = h("button", { class: `ico-cell${choice.id === current ? " on" : ""}`, type: "button", title }, iconPreview(choice.svg, 18));
    b.addEventListener("click", () => pick(choice));
    return b;
  };

  const fill = async () => {
    const run = ++shown;
    const q = search.value.trim().toLowerCase();
    for (const t of Array.from(tabs.children)) t.classList.toggle("on", (t as HTMLElement).dataset.tab === tab);
    if (tab === "app") {
      const all = appIcons();
      const list = q ? all.filter((x) => x.id.toLowerCase().includes(q)) : all;
      grid.replaceChildren(...list.map((x) => cell(x, `Like the svg at ${x.id.slice(7)}`)));
      note.textContent = list.length ? `${list.length} inline icon${list.length === 1 ? "" : "s"} in this app` : "No other inline icons on screen.";
      return;
    }
    const lib = tab;
    note.textContent = "Loading…";
    let names: string[];
    try {
      names = (await library(lib)).names;
    } catch {
      if (run === shown) note.textContent = `Couldn't load ${lib}.`;
      return;
    }
    const matches = q ? names.filter((n) => words(n).includes(q) || n.toLowerCase().includes(q.replace(/\s+/g, ""))) : names;
    const page = matches.slice(0, SHOWN);
    const svgs = await markupOf(lib, page);
    if (run !== shown) return;
    grid.replaceChildren(...page.filter((n) => svgs[n]).map((n) => cell({ id: `${lib}:${n}`, svg: svgs[n] }, n)));
    note.textContent = matches.length > SHOWN ? `${SHOWN} of ${matches.length}: search to find more` : `${matches.length} icon${matches.length === 1 ? "" : "s"} in ${lib}`;
  };

  const addTab = (key: string, title: string) => {
    const b = h("button", { class: "ico-tab", type: "button" }, title);
    b.dataset.tab = key;
    b.addEventListener("click", () => {
      tab = key;
      void fill();
    });
    tabs.append(b);
  };
  addTab("app", "This app");
  void projectLibraries().then((libs) => {
    for (const lib of new Set([...(currentLib ? [currentLib] : []), ...libs])) addTab(lib, lib);
    void fill();
  });
  search.addEventListener("input", () => void fill());
  search.focus();
}
