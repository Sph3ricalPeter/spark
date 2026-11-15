// The Layers tab of the board's left sidebar (shell.ts, sidebar.ts), like
// Figma's layer list: every frame on the board at the top level, and under
// each the elements of its page as a tree, components and their instances by
// name. A frame's client says what its tree is (mode.ts `Layer`, client.ts);
// this only draws it and keeps it in step with the canvas:
//
// - clicking a layer selects its element on the canvas (in Edit mode), and
//   selecting one on the canvas opens the tree down to it and marks its row;
// - hovering a row outlines its element, and hovering an element marks its row;
// - clicking a frame's row selects the frame, double-clicking zooms to it;
// - right-clicking a row selects it and opens its menu (menu.ts), as on the canvas.
//
// Which rows are open is remembered with the project (state.ts, "layers"): by
// frame, and by where each element is written plus which of its siblings it
// is, so the tree survives reopening the project and React re-creating elements.
import { h } from "./fields.ts";
import type { ClientHooks, Layer } from "./mode.ts";
import { getState, setState } from "./state.ts";
import { icon, type IconName } from "./theme.ts";

export type LayerFrame = {
  id: string;
  kind: "app" | "component";
  name: string;
  meta: string;
  /** Its client, once loaded. */
  hooks: ClientHooks | undefined;
  /** The board's selected frame. */
  selected: boolean;
};

export type LayersDeps = {
  /** The board's frames, in order. */
  frames(): LayerFrame[];
  /** A frame's row was clicked: select the frame (and no element in it). */
  pickFrame(id: string): void;
  /** A frame's row was double-clicked: zoom to it. */
  focusFrame(id: string): void;
  /** A layer was clicked: select its element in that frame. */
  pickLayer(id: string, el: Element): void;
  /** Right-click on a frame's row: its menu at (x, y). */
  menuFrame?(id: string, x: number, y: number): void;
  /** Right-click on a layer's row: select its element and show its menu at (x, y). */
  menuLayer?(id: string, el: Element, x: number, y: number): void;
  /** Is the tab showing (only then is it drawn). */
  shown(): boolean;
};

export const LAYERS_STYLE = `
  .layers { padding: 4px 0 12px; user-select: none; }
  .layer {
    display: flex; align-items: center; gap: 6px; height: 28px; padding-right: 8px; cursor: default;
    color: var(--sp-text); white-space: nowrap;
  }
  .layer:hover, .layer.hov { background: var(--sp-surface); box-shadow: inset 0 0 0 1px var(--sp-line-strong); }
  .layer.sel { background: color-mix(in srgb, var(--sel, var(--sp-accent)) 24%, transparent); color: var(--sp-text-strong); box-shadow: none; }
  .layer .tw {
    flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-right: -4px;
    color: var(--sp-text-dim); border-radius: var(--sp-r-sm);
  }
  .layer .tw:hover { color: var(--sp-text-strong); background: var(--sp-field); }
  .layer .tw .icon { transition: transform .1s; }
  .layer .tw.open .icon { transform: rotate(90deg); }
  .layer > .icon { color: var(--sp-text-dim); }
  .layer .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .layer .hint { flex: none; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
  .layer.board { height: 30px; margin-top: 2px; font-weight: 600; color: var(--sp-text-strong); }
  .layer.board .hint { font: var(--sp-fs-xs) var(--sp-mono); font-weight: 400; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
  .layer.board.on:not(.sel) > .icon { color: var(--sp-accent); }
  .layer.board.k-component > .icon { color: var(--sp-component); }
  .layer.root.instance > .icon, .layer.root.instance .nm { color: var(--sp-instance); }
  .layer.root.plain > .icon { color: var(--sp-accent); }
  .layer.definition > .icon, .layer.definition.root .nm { color: var(--sp-component); }
  .layer.instance:not(.root) > .icon { color: color-mix(in srgb, var(--sp-instance) 70%, var(--sp-text-dim)); }
  .layer.case .nm { color: var(--sp-text-dim); }
  .layer.off .nm, .layer.off > .icon { opacity: .45; }
  .layers-note { padding: 4px 0; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
`;

const INDENT = 14;
const MAX_REMEMBERED = 400;

/** The Layers tab's content. Call `refresh` when the frames or a tree changed. */
export function layersTab(deps: LayersDeps) {
  const el = h("div", { class: "layers", role: "tree" });
  /** Element rows that are open, by key. */
  let open = new Set<string>();
  /** Frames that are folded (frames start open). */
  let folded = new Set<string>();
  // Remembered with the project (state.ts).
  const saved = getState<{ open?: string[]; folded?: string[] }>("layers");
  if (Array.isArray(saved?.open)) open = new Set(saved.open);
  if (Array.isArray(saved?.folded)) folded = new Set(saved.folded);
  function remember() {
    setState("layers", { open: [...open].slice(-MAX_REMEMBERED), folded: [...folded] }, 300);
  }

  /** The selected element (or case), the frame it's in, and the hovered one. */
  let sel: Element | null = null;
  let selFrame: Window | null = null;
  let hov: Element | null = null;
  /** Open the rows above these on the next draw (the selection's ancestors). */
  let reveal = new Set<Element>();
  let scrollToSel = false;
  const rows = new Map<Element, HTMLElement>();
  /** What the last draw showed. */
  let lastSig = "";
  let lastEls: Element[] = [];

  let queued = 0;
  function refresh() {
    if (queued || !deps.shown()) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      draw();
    });
  }

  function twisty(isOpen: boolean, toggle: () => void) {
    const t = h("span", { class: `tw${isOpen ? " open" : ""}`, title: isOpen ? "Fold" : "Unfold" }, icon("chevron-right", 12));
    t.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle();
    });
    // Clicking the arrow twice folds and unfolds, never zooms.
    t.addEventListener("dblclick", (e) => e.stopPropagation());
    return t;
  }

  function frameRow(f: LayerFrame, isOpen: boolean) {
    const row = h(
      "div",
      {
        class: `layer board k-${f.kind}${f.selected ? " on" : ""}${f.selected && (!sel || isFrame(f, sel)) ? " sel" : ""}`,
        role: "treeitem",
        "aria-expanded": String(isOpen),
        title: `${f.name}: click to select, double-click to zoom to it`,
        style: "padding-left: 6px",
      },
      twisty(isOpen, () => {
        if (isOpen) folded.add(f.id);
        else folded.delete(f.id);
        remember();
        draw();
      }),
      icon(f.kind === "app" ? "app-window" : "component", 13),
      h("span", { class: "nm" }, f.name),
      f.meta ? h("span", { class: "hint" }, f.meta) : null,
    );
    row.addEventListener("click", () => deps.pickFrame(f.id));
    row.addEventListener("dblclick", () => deps.focusFrame(f.id));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      deps.menuFrame?.(f.id, e.clientX, e.clientY);
    });
    return row;
  }

  function layerRow(f: LayerFrame, l: Layer, key: string, depth: number, isOpen: boolean) {
    const cls = ["layer", l.role, l.root ? "root" : "", l.hidden ? "off" : "", l.el === sel ? "sel" : "", l.el === hov ? "hov" : ""].filter(Boolean).join(" ");
    const tag = l.el.tagName.toLowerCase();
    const src = l.el.getAttribute("data-spark-src");
    const row = h(
      "div",
      {
        class: cls,
        role: "treeitem",
        title: l.role === "case" ? `Case ${l.name}` : `${l.root ? `${l.name} · ` : ""}<${tag}>${src ? `  ${src}` : ""}${l.hidden ? "  (hidden)" : ""}`,
        style: `padding-left: ${6 + depth * INDENT}px`,
        ...(l.hasKids ? { "aria-expanded": String(isOpen) } : {}),
      },
      l.hasKids
        ? twisty(isOpen, () => {
            if (isOpen) open.delete(key);
            else open.add(key);
            remember();
            draw();
          })
        : h("span", { class: "tw" }),
      icon(l.icon as IconName, 13),
      h("span", { class: "nm" }, l.name),
      l.hint ? h("span", { class: "hint" }, l.hint) : null,
    );
    if (l.el === sel) row.style.setProperty("--sel", roleVar(l));
    row.addEventListener("click", () => {
      deps.pickLayer(f.id, l.el);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      deps.menuLayer?.(f.id, l.el, e.clientX, e.clientY);
    });
    row.addEventListener("pointerenter", () => f.hooks?.hoverLayer?.(l.el));
    row.addEventListener("pointerleave", () => f.hooks?.hoverLayer?.(null));
    rows.set(l.el, row);
    return row;
  }

  function kids(out: HTMLElement[], f: LayerFrame, of: Element | null, key: string, depth: number) {
    let list: Layer[];
    try {
      list = f.hooks?.layers?.(of) ?? [];
    } catch {
      // The frame is reloading: its old page is gone.
      return;
    }
    if (!of && !list.length) {
      out.push(h("div", { class: "layers-note", style: `padding-left: ${6 + depth * INDENT + 22}px` }, "Nothing tagged here yet"));
      return;
    }
    // Siblings written at the same place (a list's items) are told apart by their order.
    const seen = new Map<string, number>();
    for (const l of list) {
      const id = l.role === "case" ? `case:${l.name}` : (l.el.getAttribute("data-spark-src") ?? l.name);
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      const k = `${key}>${id}#${n}`;
      if (reveal.has(l.el) && !open.has(k)) {
        open.add(k);
        remember();
      }
      const isOpen = l.hasKids && open.has(k);
      out.push(layerRow(f, l, k, depth, isOpen));
      if (isOpen) kids(out, f, l.el, k, depth + 1);
    }
  }

  function draw() {
    if (queued) {
      cancelAnimationFrame(queued);
      queued = 0;
    }
    if (!deps.shown()) return;
    const before = new Map(rows);
    rows.clear();
    const out: HTMLElement[] = [];
    for (const f of deps.frames()) {
      if (selFrame && f.hooks?.win === selFrame && reveal.size) folded.delete(f.id);
      const isOpen = !folded.has(f.id);
      out.push(frameRow(f, isOpen));
      if (!isOpen) continue;
      if (f.hooks?.layers) kids(out, f, null, f.id, 1);
      else out.push(h("div", { class: "layers-note", style: `padding-left: ${6 + INDENT + 22}px` }, f.hooks ? "" : "Loading…"));
    }
    // Unchanged (most redraws: the page re-rendered the same): keep the rows, so a click mid-redraw still lands.
    const sig = out.map((r) => `${r.className}|${r.style.paddingLeft}|${r.getAttribute("aria-expanded")}|${r.textContent}`).join("\n");
    const els = [...rows.keys()];
    if (sig === lastSig && els.length === lastEls.length && els.every((x, i) => x === lastEls[i])) {
      rows.clear();
      for (const [k, v] of before) rows.set(k, v);
    } else {
      el.replaceChildren(...out);
      lastSig = sig;
      lastEls = els;
    }
    reveal = new Set();
    const row = scrollToSel && sel ? rows.get(sel) : undefined;
    // Its own scroll only (the sidebar's body), never the board's.
    const sc = el.parentElement;
    if (row && sc) {
      const r = row.getBoundingClientRect();
      const v = sc.getBoundingClientRect();
      if (r.top < v.top) sc.scrollTop -= v.top - r.top + 24;
      else if (r.bottom > v.bottom) sc.scrollTop += r.bottom - v.bottom + 24;
    }
    scrollToSel = false;
  }

  return {
    el,
    refresh,
    /** Draw now (the tab was opened). */
    draw: () => {
      if (sel && selFrame) scrollToSel = true;
      draw();
    },
    /** The selection in a frame came or went: open the tree down to it and mark it. */
    selected(win: Window, hooks: ClientHooks | undefined, elm: Element | null) {
      if (!elm) {
        if (selFrame !== win) return;
        sel = null;
        selFrame = null;
        refresh();
        return;
      }
      sel = elm;
      selFrame = win;
      try {
        reveal = new Set(hooks?.layerChain?.(elm).slice(0, -1) ?? []);
        // An element folded into its svg marks the svg.
        const shown = hooks?.layerChain?.(elm).at(-1);
        if (shown) sel = shown;
      } catch {
        reveal = new Set();
      }
      scrollToSel = true;
      refresh();
    },
    /** The pointer is over an element on the canvas: mark its row (no redraw). */
    hovered(elm: Element | null) {
      if (elm === hov) return;
      if (hov) rows.get(hov)?.classList.remove("hov");
      hov = elm;
      if (hov) rows.get(hov)?.classList.add("hov");
    },
  };
}

/** Is `el` that frame itself (its page's root element: the frame selected as a whole)? */
function isFrame(f: LayerFrame, el: Element) {
  try {
    return el === f.hooks?.win.document.documentElement;
  } catch {
    return false;
  }
}

function roleVar(l: Layer) {
  return l.role === "definition" ? "var(--sp-component)" : l.role === "instance" ? "var(--sp-instance)" : "var(--sp-accent)";
}
