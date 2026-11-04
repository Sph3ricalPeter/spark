// The Spark client: runs inside the app being edited, in dev only.
//
// Everything lives in one Shadow DOM so the app's CSS and Spark's never mix.
// No React here on purpose: the app's React and ours would share a page.
//
// Alt+S opens or closes the panel. While "Pick" is on, hovering highlights
// the element under the pointer and a click selects it instead of reaching
// the app. Arrow Up selects the parent, Esc clears the selection.
//
// Edits made in the panel are previewed live and recorded as changes (see
// changes.ts), which the dev server saves to .spark/changes.json.
import {
  allChanges,
  initChanges,
  load,
  record,
  renderInstances,
  revert,
  setCallResolver,
  type Change,
  type ChangeLog,
} from "./changes.ts";
import { authored, matchedRules, tokenRule, tokensUsed, type RuleRef } from "./css.ts";

const PANEL_W = 340;
const ACCENT = "#4f8cff";

// ---------------------------------------------------------------------------
// What a selection knows

type Fiber = {
  return: Fiber | null;
  type: unknown;
  memoizedProps: Record<string, unknown> | null;
};

type Owner = { name: string; call: string | null };

/** The properties the panel edits, grouped as they're shown. */
const EDITABLE: { group: string; props: string[] }[] = [
  { group: "Layout", props: ["display", "flex-direction", "align-items", "justify-content", "gap"] },
  { group: "Size and spacing", props: ["width", "height", "padding", "margin"] },
  { group: "Text", props: ["color", "font-size", "font-weight", "line-height"] },
  { group: "Fill and border", props: ["background-color", "border", "border-radius", "box-shadow", "opacity"] },
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

/** The line that renders the instance of `comp` this element belongs to. */
function instanceCall(el: Element, comp: string | null): string | null {
  const owners = ownersOf(el);
  return (comp ? owners.find((o) => o.name === comp) : owners[0])?.call ?? null;
}

const skip = (n: Node) => host.contains(n) || (n instanceof Element && n.hasAttribute("data-spark"));

// ---------------------------------------------------------------------------
// DOM helpers

type Child = Node | string | null | false | undefined;
type Props = Record<string, string | boolean | ((e: Event) => void)>;

function h(tag: string, props: Props = {}, ...children: Child[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "function") el.addEventListener(k, v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

let root = "";
/** Project-relative path of a file Vite reports as absolute. */
function rel(file: string | null): string | null {
  if (!file) return null;
  const clean = file.split("?")[0];
  return root && clean.startsWith(root + "/") ? clean.slice(root.length + 1) : clean;
}

function shortFile(file: string | null): string {
  if (!file) return "inline";
  return (rel(file) ?? file).split("/").slice(-2).join("/");
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
    header .grow { flex: 1; color: #8a8f98; font-weight: 400; }
    button, select, input {
      font: inherit; color: inherit; background: #23252a; border: 1px solid #33363c;
      border-radius: 4px; padding: 3px 8px;
    }
    button { cursor: pointer; }
    button.on { background: ${ACCENT}; border-color: ${ACCENT}; color: #fff; }
    select { width: 100%; padding: 4px 6px; }
    input { width: 100%; font: 11px ui-monospace, monospace; padding: 3px 6px; }
    input:focus, select:focus { outline: 1px solid ${ACCENT}; border-color: ${ACCENT}; }
    input.changed { border-color: #d9a441; }
    input.bad { border-color: #e5534b; }
    .body { flex: 1; overflow: auto; padding: 12px; }
    .footer { border-top: 1px solid #2a2c31; padding: 10px 12px; max-height: 40%; overflow: auto; }
    .empty { color: #8a8f98; }
    h3 { margin: 16px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8a8f98; }
    h3:first-child { margin-top: 0; }
    .title { font: 600 13px ui-monospace, monospace; color: #fff; word-break: break-all; }
    .link { color: #8fb4ff; cursor: pointer; font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
    .link:hover { text-decoration: underline; }
    .row { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
    .row .k { color: #8a8f98; width: 112px; flex: none; }
    .row .v { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
    .hint { color: #8a8f98; font-size: 11px; margin-top: 4px; }
    .owner { padding: 3px 0; }
    .owner b { color: #fff; font-weight: 600; margin-right: 6px; }
    details { margin-top: 12px; }
    summary { cursor: pointer; color: #8a8f98; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    .rule { margin: 6px 0; padding: 6px 8px; background: #1d1f23; border-radius: 4px; }
    .rule .sel { font: 600 11px ui-monospace, monospace; color: #fff; }
    .rule .file { color: #8a8f98; font-size: 11px; }
    .rule pre { margin: 4px 0 0; white-space: pre-wrap; font: 11px/1.5 ui-monospace, monospace; color: #b9bdc5; }
    .change { display: flex; gap: 8px; align-items: flex-start; padding: 5px 0; border-bottom: 1px solid #23252a; }
    .change .what { flex: 1; min-width: 0; }
    .change .lvl { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #d9a441; }
    .change .where { color: #8a8f98; font-size: 11px; word-break: break-all; }
    .change code { font: 11px ui-monospace, monospace; color: #fff; word-break: break-all; }
    .change button { padding: 0 6px; }
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
const footer = h("div", { class: "footer" });
const panel = h(
  "div",
  { class: "panel" },
  h("header", {}, "Spark", status, pickBtn, h("button", { title: "Close (Alt+S)", click: () => setOpen(false) }, "×")),
  body,
  footer,
);
const fab = h("button", { class: "fab", title: "Open Spark (Alt+S)", click: () => setOpen(true) }, "Spark");
shadow.append(hoverBox, selectBox, tagLabel, panel, fab);

// Docking: the app gives up room on the right while the panel is open.
const dockStyle = document.createElement("style");
dockStyle.setAttribute("data-spark", "dock");
dockStyle.textContent = `html.spark-docked body { margin-right: ${PANEL_W}px !important; }`;

let open = false;
let picking = false;
let hovered: Element | null = null;
let selected: Element | null = null;
/** What edits apply to: "instance", or the index of a matched rule. */
let target: "instance" | number = "instance";

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
function pickable(node: EventTarget | null): Element | null {
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
  if (el !== selected) target = "instance";
  selected = el;
  place(selectBox, el);
  label(el);
  render();
  if (el) import.meta.hot?.send("spark:select", snapshot(el));
}

/** The selection as the MCP server will see it. */
function snapshot(el: Element) {
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    classes: Array.from(el.classList),
    src: el.getAttribute("data-spark-src"),
    comp: el.getAttribute("data-spark-comp"),
    owners: ownersOf(el),
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    rules: matchedRules(el, skip).map((m) => ({ selector: m.selector, file: rel(m.file), css: m.rule.style.cssText })),
  };
}

// Keep the boxes on their elements through scrolling, layout and hot reloads,
// and instance previews on elements React re-created.
let frame = 0;
function follow() {
  if (open) {
    place(hoverBox, hovered);
    place(selectBox, selected);
    if (selected && !selected.isConnected) select(null);
  }
  if (++frame % 30 === 0) renderInstances();
  requestAnimationFrame(follow);
}

// ---------------------------------------------------------------------------
// Editing

function commit(el: Element, rules: RuleRef[], prop: string, value: string, input: HTMLInputElement) {
  value = value.trim();
  if (value && !CSS.supports(prop, value)) {
    input.classList.add("bad");
    return;
  }
  input.classList.remove("bad");
  const comp = el.getAttribute("data-spark-comp");
  const element = { src: el.getAttribute("data-spark-src"), comp, tag: el.tagName.toLowerCase(), classes: Array.from(el.classList) };

  if (target === "instance") {
    const prev = allChanges().find(
      (c) => c.level === "instance" && c.property === prop && c.element.src === element.src && c.instance?.call === instanceCall(el, comp),
    );
    const from = prev?.from ?? authored(el, rules, prop) ?? getComputedStyle(el).getPropertyValue(prop);
    if (!value) value = from;
    record({
      level: "instance",
      property: prop,
      from,
      to: value,
      file: null,
      selector: null,
      element,
      instance: { component: comp ?? "?", call: instanceCall(el, comp) },
    });
  } else {
    const ref = rules[target];
    if (!ref) return;
    const prev = allChanges().find((c) => c.level === "component" && c.property === prop && c.selector === ref.selector && c.file === rel(ref.file));
    const from = prev?.from ?? ref.rule.style.getPropertyValue(prop);
    record({ level: "component", property: prop, from, to: value, file: rel(ref.file), selector: ref.selector, element, instance: null });
  }
  changed();
}

function commitToken(el: Element, name: string, value: string, input: HTMLInputElement) {
  value = value.trim();
  const ref = tokenRule(name, skip);
  if (!ref || !value) {
    input.classList.add("bad");
    return;
  }
  input.classList.remove("bad");
  const prev = allChanges().find((c) => c.level === "token" && c.property === name);
  const from = prev?.from ?? ref.rule.style.getPropertyValue(name).trim();
  record({
    level: "token",
    property: name,
    from,
    to: value,
    file: rel(ref.file),
    selector: ref.selector,
    element: { src: el.getAttribute("data-spark-src"), comp: el.getAttribute("data-spark-comp"), tag: el.tagName.toLowerCase(), classes: Array.from(el.classList) },
    instance: null,
  });
  changed();
}

function changed() {
  const log: ChangeLog = { version: 1, changes: [...allChanges()] };
  import.meta.hot?.send("spark:changes", log);
  render();
}

function input(value: string, onCommit: (v: string, el: HTMLInputElement) => void, isChanged: boolean) {
  const el = h("input", { value, spellcheck: "false", class: isChanged ? "changed" : "" }) as HTMLInputElement;
  el.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") el.blur();
    e.stopPropagation();
  });
  el.addEventListener("change", () => onCommit(el.value, el));
  return el;
}

// ---------------------------------------------------------------------------
// The panel's contents

function locLink(loc: string | null) {
  if (!loc) return h("span", { class: "empty" }, "unknown");
  return h("span", { class: "link", title: "Open in editor", click: () => openInEditor(loc) }, loc);
}

function render() {
  renderChanges();
  body.replaceChildren();
  if (!selected) {
    body.append(h("div", { class: "empty" }, "Click an element in the app to select it. Arrow Up selects its parent."));
    return;
  }
  const el = selected;
  const rules = matchedRules(el, skip);
  const owners = ownersOf(el);
  const comp = el.getAttribute("data-spark-comp");
  const call = instanceCall(el, comp);
  const classes = Array.from(el.classList);
  const r = el.getBoundingClientRect();

  // Element
  body.append(
    h("div", { class: "title" }, `<${el.tagName.toLowerCase()}${classes.length ? "." + classes.join(".") : ""}>`),
    h("div", { class: "row" }, h("span", { class: "k" }, "Written in"), locLink(el.getAttribute("data-spark-src"))),
    h("div", { class: "row" }, h("span", { class: "k" }, "Size"), h("span", { class: "v" }, `${Math.round(r.width)} × ${Math.round(r.height)}`)),
  );

  // Where edits go
  const sel = h("select", {}) as HTMLSelectElement;
  sel.append(h("option", { value: "instance", selected: target === "instance" }, `This ${comp ?? "element"} only${call ? ` (${call})` : ""}`));
  // Most specific-looking first: later rules win ties.
  [...rules.entries()].reverse().forEach(([i, m]) => sel.append(h("option", { value: String(i), selected: target === i }, `Every match of ${m.selector}  · ${shortFile(m.file)}`)));
  sel.addEventListener("change", () => {
    target = sel.value === "instance" ? "instance" : Number(sel.value);
    render();
  });
  body.append(
    h("h3", {}, "Apply edits to"),
    sel,
    h(
      "div",
      { class: "hint" },
      target === "instance"
        ? "Changes this one instance, at the line that renders it."
        : "Changes the CSS rule, so every element it matches.",
    ),
  );

  // Properties
  const pending = allChanges().filter((c) => c.status === "pending");
  for (const { group, props } of EDITABLE) {
    body.append(h("h3", {}, group));
    for (const prop of props) {
      let value: string;
      let isChanged: boolean;
      if (target === "instance") {
        const c = pending.find((x) => x.level === "instance" && x.property === prop && x.element.src === el.getAttribute("data-spark-src") && x.instance?.call === call);
        value = c?.to ?? authored(el, rules, prop) ?? getComputedStyle(el).getPropertyValue(prop);
        isChanged = !!c;
      } else {
        const ref = rules[target];
        value = ref?.rule.style.getPropertyValue(prop) ?? "";
        isChanged = pending.some((x) => x.level === "component" && x.property === prop && x.selector === ref?.selector && x.file === rel(ref?.file ?? null));
      }
      body.append(
        h("div", { class: "row" }, h("span", { class: "k" }, prop), input(value, (v, i) => commit(el, rules, prop, v, i), isChanged)),
      );
    }
  }

  // Tokens this element uses
  const tokens = tokensUsed(el, rules);
  if (tokens.length) {
    body.append(h("h3", {}, "Tokens"), h("div", { class: "hint" }, "Changing a token changes everything that uses it."));
    for (const t of tokens) {
      const c = pending.find((x) => x.level === "token" && x.property === t);
      const value = c?.to ?? getComputedStyle(document.documentElement).getPropertyValue(t).trim();
      body.append(h("div", { class: "row" }, h("span", { class: "k", title: t }, t), input(value, (v, i) => commitToken(el, t, v, i), !!c)));
    }
  }

  // Context
  const instances = h("details", {}, h("summary", {}, "Component instances"));
  if (owners.length === 0) instances.append(h("div", { class: "empty" }, "No React components found above this element."));
  for (const o of owners) {
    instances.append(h("div", { class: "owner" }, h("b", {}, o.name), o.call ? locLink(o.call) : h("span", { class: "empty" }, "root")));
  }
  const matched = h("details", {}, h("summary", {}, `Matched rules (${rules.length})`));
  for (const m of [...rules].reverse()) {
    matched.append(
      h("div", { class: "rule" }, h("div", { class: "sel" }, m.selector), h("div", { class: "file" }, shortFile(m.file)), h("pre", {}, m.rule.style.cssText.split("; ").join(";\n"))),
    );
  }
  body.append(instances, matched);
}

function describeChange(c: Change): string {
  if (c.level === "token") return `${c.file ?? "?"}`;
  if (c.level === "component") return `${c.selector} · ${c.file ?? "?"}`;
  return `${c.instance?.component ?? "?"} at ${c.instance?.call ?? c.element.src ?? "?"}`;
}

function renderChanges() {
  const pending = allChanges().filter((c) => c.status === "pending");
  footer.replaceChildren(h("h3", {}, `Changes (${pending.length})`));
  if (pending.length === 0) {
    footer.append(h("div", { class: "empty" }, "Edits you make show up here."));
    return;
  }
  for (const c of pending) {
    footer.append(
      h(
        "div",
        { class: "change" },
        h(
          "div",
          { class: "what" },
          h("div", { class: "lvl" }, c.level),
          h("code", {}, `${c.property}: ${c.from || "unset"} → ${c.to}`),
          h("div", { class: "where" }, describeChange(c)),
        ),
        h(
          "button",
          {
            title: "Revert",
            click: () => {
              revert(c.id);
              changed();
            },
          },
          "↺",
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Events. Capture phase, so picking happens before the app sees anything.

const swallow = (e: Event) => {
  if (!picking || !pickable(e.target)) return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
};

document.addEventListener("pointermove", (e) => picking && hover(pickable(e.target)), true);
document.addEventListener("pointerdown", swallow, true);
document.addEventListener("mousedown", swallow, true);
document.addEventListener("pointerup", swallow, true);
document.addEventListener("mouseup", swallow, true);
document.addEventListener(
  "click",
  (e) => {
    if (swallow(e)) select(pickable(e.target));
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
initChanges(skip);
setCallResolver(instanceCall);
render();
let reopen = false;
try {
  reopen = localStorage.getItem("spark:open") === "1";
} catch {
  // Storage may be off.
}
if (reopen) setOpen(true);
requestAnimationFrame(follow);

import.meta.hot?.on("spark:ready", (info: { name: string; root: string; changes: ChangeLog | null }) => {
  root = info.root;
  status.textContent = info.name;
  if (info.changes) load(info.changes.changes);
  render();
});
import.meta.hot?.send("spark:hello", {});
