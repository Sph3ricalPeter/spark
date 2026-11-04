// The Spark client: runs inside the app being edited, in dev only.
//
// Everything lives in one Shadow DOM so the app's CSS and Spark's never mix.
// No React here on purpose: the app's React and ours would share a page.
//
// Alt+S opens or closes the panel. While "Pick" is on, hovering highlights
// the element under the pointer and a click selects it instead of reaching
// the app. Arrow Up selects the parent, Esc clears the selection.

const PANEL_W = 320;
const ACCENT = "#4f8cff";

// ---------------------------------------------------------------------------
// What a selection knows

type Fiber = {
  return: Fiber | null;
  type: unknown;
  memoizedProps: Record<string, unknown> | null;
};

type Owner = { name: string; call: string | null };
type MatchedRule = { selector: string; file: string | null; css: string };

type Selection = {
  tag: string;
  classes: string[];
  src: string | null;
  comp: string | null;
  owners: Owner[];
  rect: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  rules: MatchedRule[];
};

const STYLE_PROPS = [
  "display",
  "position",
  "flex-direction",
  "align-items",
  "justify-content",
  "gap",
  "width",
  "height",
  "margin",
  "padding",
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "border",
  "border-radius",
  "box-shadow",
  "opacity",
];

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

/** The components that rendered this element, innermost first, each with its call site. */
function ownersOf(el: Element): Owner[] {
  const owners: Owner[] = [];
  for (let f = fiberOf(el); f && owners.length < 12; f = f.return) {
    const name = componentName(f.type);
    if (!name) continue;
    const call = f.memoizedProps?.["data-spark-call"];
    owners.push({ name, call: typeof call === "string" ? call : null });
  }
  return owners;
}

function matchedRules(el: Element): MatchedRule[] {
  const out: MatchedRule[] = [];
  const walk = (rules: CSSRuleList, file: string | null) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        try {
          if (el.matches(rule.selectorText)) out.push({ selector: rule.selectorText, file, css: rule.style.cssText });
        } catch {
          // A selector the browser can't match against (::before and friends).
        }
        // Nested rules.
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
    if (owner && host.contains(owner)) continue;
    // Vite's dev server marks each injected <style> with the file it came from.
    const file = owner?.getAttribute?.("data-vite-dev-id") ?? sheet.href ?? null;
    try {
      walk(sheet.cssRules, file);
    } catch {
      // Cross-origin sheet.
    }
  }
  return out;
}

function describe(el: Element): Selection {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    classes: Array.from(el.classList),
    src: el.getAttribute("data-spark-src"),
    comp: el.getAttribute("data-spark-comp"),
    owners: ownersOf(el),
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    styles: Object.fromEntries(STYLE_PROPS.map((p) => [p, cs.getPropertyValue(p)])),
    rules: matchedRules(el),
  };
}

// ---------------------------------------------------------------------------
// DOM helpers

type Child = Node | string | null | false | undefined;

function h(tag: string, props: Record<string, string | ((e: Event) => void)> = {}, ...children: Child[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "function") el.addEventListener(k, v);
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

function shortFile(file: string | null): string {
  if (!file) return "inline";
  return file.split("/").slice(-2).join("/");
}

function openInEditor(loc: string) {
  void fetch(`/__open-in-editor?file=${encodeURIComponent(loc)}`);
}

// ---------------------------------------------------------------------------
// Shadow root, overlay and panel

const host = document.createElement("spark-root");
host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
const shadow = host.attachShadow({ mode: "open" });
shadow.append(
  h(
    "style",
    {},
    `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .box { position: fixed; pointer-events: none; display: none; }
    .hover { outline: 1px dashed ${ACCENT}; background: ${ACCENT}14; }
    .selected { outline: 2px solid ${ACCENT}; }
    .tag {
      position: fixed; display: none; pointer-events: none;
      font: 600 11px/1 ui-sans-serif, system-ui, sans-serif;
      background: ${ACCENT}; color: #fff; padding: 3px 6px; border-radius: 3px; white-space: nowrap;
    }
    .panel {
      position: fixed; top: 0; right: 0; bottom: 0; width: ${PANEL_W}px;
      display: none; flex-direction: column; pointer-events: auto;
      background: #16171a; color: #d6d8dc; border-left: 1px solid #2a2c31;
      font: 12px/1.45 ui-sans-serif, system-ui, sans-serif;
    }
    .panel.open { display: flex; }
    header {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      border-bottom: 1px solid #2a2c31; font-weight: 600; color: #fff;
    }
    header .grow { flex: 1; }
    button {
      font: inherit; color: inherit; background: #23252a; border: 1px solid #33363c;
      border-radius: 4px; padding: 3px 8px; cursor: pointer;
    }
    button.on { background: ${ACCENT}; border-color: ${ACCENT}; color: #fff; }
    .body { flex: 1; overflow: auto; padding: 12px; }
    .empty { color: #8a8f98; }
    h3 { margin: 16px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8a8f98; }
    h3:first-child { margin-top: 0; }
    .title { font: 600 13px ui-monospace, monospace; color: #fff; word-break: break-all; }
    .link { color: #8fb4ff; cursor: pointer; font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
    .link:hover { text-decoration: underline; }
    .row { display: flex; gap: 8px; padding: 2px 0; }
    .row .k { color: #8a8f98; width: 118px; flex: none; }
    .row .v { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
    .owner { padding: 3px 0; }
    .owner b { color: #fff; font-weight: 600; margin-right: 6px; }
    .rule { margin: 6px 0; padding: 6px 8px; background: #1d1f23; border-radius: 4px; }
    .rule .sel { font: 600 11px ui-monospace, monospace; color: #fff; }
    .rule .file { color: #8a8f98; font-size: 11px; }
    .rule pre { margin: 4px 0 0; white-space: pre-wrap; font: 11px/1.5 ui-monospace, monospace; color: #b9bdc5; }
    .fab {
      position: fixed; right: 12px; bottom: 12px; pointer-events: auto;
      background: ${ACCENT}; border-color: ${ACCENT}; color: #fff; font-weight: 600;
    }
    .fab.hidden { display: none; }
    `,
  ),
);

const hoverBox = h("div", { class: "box hover" });
const selectBox = h("div", { class: "box selected" });
const tagLabel = h("div", { class: "tag" });
const pickBtn = h("button", { title: "Pick an element (click in the app)" }, "Pick");
const status = h("span", { class: "grow" });
const body = h("div", { class: "body" });
const panel = h(
  "div",
  { class: "panel" },
  h("header", {}, "Spark", status, pickBtn, h("button", { title: "Close (Alt+S)", click: () => setOpen(false) }, "×")),
  body,
);
const fab = h("button", { class: "fab", title: "Open Spark (Alt+S)", click: () => setOpen(true) }, "Spark");
shadow.append(hoverBox, selectBox, tagLabel, panel, fab);

// Docking: the app gives up room on the right while the panel is open.
const dockStyle = document.createElement("style");
dockStyle.textContent = `html.spark-docked body { margin-right: ${PANEL_W}px !important; }`;

let open = false;
let picking = false;
let hovered: Element | null = null;
let selected: Element | null = null;

function setOpen(v: boolean) {
  open = v;
  panel.classList.toggle("open", v);
  fab.classList.toggle("hidden", v);
  document.documentElement.classList.toggle("spark-docked", v);
  setPicking(v);
  if (!v) select(null);
  try {
    localStorage.setItem("spark:open", v ? "1" : "0");
  } catch {
    // Storage may be off; the panel just starts closed next time.
  }
}

function setPicking(v: boolean) {
  picking = v;
  pickBtn.classList.toggle("on", v);
  if (!v) hover(null);
}
pickBtn.addEventListener("click", () => setPicking(!picking));

/** The nearest element we know the source of. */
function target(node: EventTarget | null): Element | null {
  if (!(node instanceof Element) || host.contains(node)) return null;
  return node.closest("[data-spark-src]");
}

function place(box: HTMLElement, el: Element | null) {
  if (!el || !el.isConnected) {
    box.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  Object.assign(box.style, {
    display: "block",
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
}

function label(el: Element | null) {
  if (!el) {
    tagLabel.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  const comp = el.getAttribute("data-spark-comp");
  tagLabel.textContent = `${comp ? comp + " · " : ""}${el.tagName.toLowerCase()}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  tagLabel.style.display = "block";
  // Keep it on screen and out from under the panel.
  const maxLeft = window.innerWidth - (open ? PANEL_W : 0) - tagLabel.offsetWidth - 4;
  tagLabel.style.left = `${Math.max(0, Math.min(r.left, maxLeft))}px`;
  tagLabel.style.top = `${r.top > 22 ? r.top - 20 : r.bottom + 4}px`;
}

function hover(el: Element | null) {
  hovered = el;
  place(hoverBox, el);
  label(el ?? selected);
}

function select(el: Element | null) {
  selected = el;
  place(selectBox, el);
  label(el);
  render();
  if (el) import.meta.hot?.send("spark:select", describe(el));
}

// Keep the boxes on their elements through scrolling, layout and hot reloads.
function follow() {
  if (open) {
    place(hoverBox, hovered);
    place(selectBox, selected);
    if (selected && !selected.isConnected) select(null);
  }
  requestAnimationFrame(follow);
}

// ---------------------------------------------------------------------------
// The panel's contents

function locLink(loc: string | null) {
  if (!loc) return h("span", { class: "empty" }, "unknown");
  return h("span", { class: "link", title: "Open in editor", click: () => openInEditor(loc) }, loc);
}

function render() {
  body.replaceChildren();
  if (!selected) {
    body.append(h("div", { class: "empty" }, "Click an element in the app to select it. Arrow Up selects its parent."));
    return;
  }
  const s = describe(selected);
  const name = `<${s.tag}${s.classes.length ? "." + s.classes.join(".") : ""}>`;

  body.append(
    h("h3", {}, "Element"),
    h("div", { class: "title" }, name),
    h("div", { class: "row" }, h("span", { class: "k" }, "Written in"), h("span", { class: "v" }, s.comp ?? "?")),
    h("div", { class: "row" }, h("span", { class: "k" }, "Source"), locLink(s.src)),
    h("div", { class: "row" }, h("span", { class: "k" }, "Size"), h("span", { class: "v" }, `${s.rect.width} × ${s.rect.height}`)),
  );

  body.append(h("h3", {}, "Component instances"));
  if (s.owners.length === 0) body.append(h("div", { class: "empty" }, "No React components found above this element."));
  for (const o of s.owners) {
    body.append(h("div", { class: "owner" }, h("b", {}, o.name), o.call ? locLink(o.call) : h("span", { class: "empty" }, "root")));
  }

  body.append(h("h3", {}, "Computed"));
  for (const [k, v] of Object.entries(s.styles)) {
    body.append(h("div", { class: "row" }, h("span", { class: "k" }, k), h("span", { class: "v" }, v)));
  }

  body.append(h("h3", {}, `Matched rules (${s.rules.length})`));
  // Later rules win ties, so show them first.
  for (const r of [...s.rules].reverse()) {
    body.append(
      h(
        "div",
        { class: "rule" },
        h("div", { class: "sel" }, r.selector),
        h("div", { class: "file" }, shortFile(r.file)),
        h("pre", {}, r.css.split("; ").join(";\n")),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Events. Capture phase, so picking happens before the app sees anything.

const swallow = (e: Event) => {
  if (!picking || !target(e.target)) return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
};

document.addEventListener("pointermove", (e) => picking && hover(target(e.target)), true);
document.addEventListener("pointerdown", swallow, true);
document.addEventListener("mousedown", swallow, true);
document.addEventListener("pointerup", swallow, true);
document.addEventListener("mouseup", swallow, true);
document.addEventListener(
  "click",
  (e) => {
    if (swallow(e)) select(target(e.target));
  },
  true,
);

document.addEventListener(
  "keydown",
  (e) => {
    if (e.altKey && e.code === "KeyS") {
      e.preventDefault();
      setOpen(!open);
      return;
    }
    if (!open || !selected) return;
    if (e.key === "Escape") {
      e.preventDefault();
      select(null);
    } else if (e.key === "ArrowUp" && picking) {
      const parent = selected.parentElement?.closest("[data-spark-src]");
      if (parent) {
        e.preventDefault();
        select(parent);
      }
    }
  },
  true,
);

// ---------------------------------------------------------------------------
// Start

document.head.append(dockStyle);
document.documentElement.append(host);
render();
let reopen = false;
try {
  reopen = localStorage.getItem("spark:open") === "1";
} catch {
  // Storage may be off.
}
if (reopen) setOpen(true);
requestAnimationFrame(follow);

import.meta.hot?.on("spark:ready", (info: { root: string }) => {
  status.textContent = info.root;
  status.style.cssText = "color: #8a8f98; font-weight: 400; margin-left: 4px;";
});
import.meta.hot?.send("spark:hello", {});
