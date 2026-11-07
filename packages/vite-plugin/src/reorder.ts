// Drag to reorder: in edit mode, drag the selected element along its flex or
// grid parent to move it among its siblings.
//
// A drop line shows where it will land. The move is previewed with CSS
// `order` on the siblings (React's DOM is left alone) and recorded as one
// "children-order" override on the parent, which Claude applies by moving the
// JSX (see changes.ts). Only flex and grid parents for now: in normal flow,
// `order` does nothing, so there is no honest preview.
import { overridesOn, record, type PathEntry } from "./changes.ts";

export type ReorderContext = {
  overlay: ShadowRoot;
  /** Edit mode, nothing in progress (text editing, resizing). */
  active: () => boolean;
  selected: () => Element | null;
  /** The nearest element under the pointer Spark knows the source of. */
  pickable: (target: EventTarget | null) => Element | null;
  select: (el: Element) => void;
  instancePath: (el: Element) => PathEntry[];
  elementInfo: (el: Element) => { src: string | null; comp: string | null; tag: string; classes: string[] };
  scopeWords: (path: PathEntry[], scope: number | null) => string;
  /** Save the log and refresh the panel. */
  changed: () => void;
};

const THRESHOLD = 4;

function layoutOf(parent: Element): "row" | "column" | null {
  const cs = getComputedStyle(parent);
  if (cs.display.includes("grid")) return "row";
  if (!cs.display.includes("flex")) return null;
  return cs.flexDirection.startsWith("column") ? "column" : "row";
}

/** The children as shown: by `order`, then as written. */
function shown(parent: Element): Element[] {
  const kids = Array.from(parent.children);
  const ord = (el: Element) => parseInt(getComputedStyle(el).order, 10) || 0;
  return kids.map((el, i) => ({ el, i, o: ord(el) })).sort((a, b) => a.o - b.o || a.i - b.i).map((x) => x.el);
}

function labelOf(el: Element, path: PathEntry[]): string {
  const comp = el.getAttribute("data-spark-comp");
  const key = path[0]?.key;
  const name = comp ? `${comp}${key !== null && key !== undefined ? `[${key}]` : ""}` : el.tagName.toLowerCase();
  // The key names a list item; anything else is told apart by its text.
  const text = key !== null && key !== undefined ? "" : (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 24);
  const src = el.getAttribute("data-spark-src");
  return `${name}${text ? ` "${text}"` : ""}${src ? ` (${src})` : ""}`;
}

/** Where a drop at (x, y) lands among `others` (the siblings without the dragged one). */
function slot(others: Element[], axis: "row" | "column", x: number, y: number): number {
  for (const [i, el] of others.entries()) {
    const r = el.getBoundingClientRect();
    if (axis === "column") {
      if (y < r.top + r.height / 2) return i;
    } else if (y < r.top || (y < r.bottom && x < r.left + r.width / 2)) {
      // Reading order, so wrapping rows and grids work too.
      return i;
    }
  }
  return others.length;
}

/**
 * What a drag starting on `target` moves: the selection when it's grabbed,
 * otherwise a tagged element under the pointer that sits in a flex or grid
 * with siblings.
 */
function draggable(ctx: ReorderContext, target: EventTarget | null): Element | null {
  const sel = ctx.selected();
  if (sel && target instanceof Node && sel.contains(target)) return movable(sel) ? sel : null;
  // A component's outermost element first (grabbing a Track's label drags
  // the Track), else the nearest element that can move.
  let first: Element | null = null;
  for (let el = ctx.pickable(target); el; el = el.parentElement?.closest("[data-spark-src]") ?? null) {
    if (!movable(el)) continue;
    first ??= el;
    const comp = el.getAttribute("data-spark-comp");
    if (comp && el.parentElement?.closest("[data-spark-comp]")?.getAttribute("data-spark-comp") !== comp) return el;
  }
  return first;
}

function movable(el: Element) {
  const parent = el.parentElement;
  return !!parent && parent.children.length > 1 && layoutOf(parent) !== null;
}

export function installReorder(ctx: ReorderContext) {
  const line = document.createElement("div");
  line.className = "drop";
  const ghost = document.createElement("div");
  ghost.className = "box dragging";
  const style = document.createElement("style");
  style.textContent = `
    .drop { position: fixed; display: none; pointer-events: none; background: #4f8cff; border-radius: 1px; }
    .box.dragging { display: none; outline: none; background: #4f8cff22; box-shadow: 0 0 0 calc(1px / var(--z, 1)) #4f8cff; }
  `;
  ctx.overlay.append(style, ghost, line);

  /** True from the moment a drag starts until its click has been swallowed. */
  let dragging = false;

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !ctx.active()) return;
      const el = draggable(ctx, e.target);
      if (!el || (el as HTMLElement).isContentEditable) return;
      const parent = el.parentElement!;
      const axis = layoutOf(parent)!;

      const x0 = e.clientX;
      const y0 = e.clientY;
      const id = e.pointerId;
      const z = () => window.__sparkShell?.zoom ?? 1;
      let started = false;
      let at = -1;
      const before = shown(parent);
      const others = before.filter((x) => x !== el);

      const showLine = () => {
        const gap = 2 / z();
        const thick = `${2 / z()}px`;
        const ref = others[at] ?? others[at - 1];
        if (!ref) return;
        const r = ref.getBoundingClientRect();
        const after = at >= others.length;
        if (axis === "column") {
          const y = after ? r.bottom + gap : r.top - gap;
          Object.assign(line.style, { display: "block", left: `${r.left}px`, top: `${y - 1 / z()}px`, width: `${r.width}px`, height: thick });
        } else {
          const x = after ? r.right + gap : r.left - gap;
          Object.assign(line.style, { display: "block", left: `${x - 1 / z()}px`, top: `${r.top}px`, width: thick, height: `${r.height}px` });
        }
      };

      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        if (!started) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) * z() < THRESHOLD) return;
          started = true;
          dragging = true;
          if (ctx.selected() !== el) ctx.select(el);
          document.documentElement.setPointerCapture(id);
          const r = el.getBoundingClientRect();
          Object.assign(ghost.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        }
        ev.preventDefault();
        ev.stopPropagation();
        const r = el.getBoundingClientRect();
        // The ghost follows the pointer; the element itself stays until the drop.
        Object.assign(ghost.style, { transform: `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px)`, width: `${r.width}px`, height: `${r.height}px` });
        at = slot(others, axis, ev.clientX, ev.clientY);
        showLine();
      };

      const end = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", end, true);
        document.removeEventListener("pointercancel", end, true);
        line.style.display = "none";
        ghost.style.display = "none";
        ghost.style.transform = "";
        if (!started) return;
        ev.stopPropagation();
        // The click this drag ends in must not select something else.
        setTimeout(() => (dragging = false), 0);
        if (ev.type === "pointercancel" || at < 0) return;
        const next = [...others];
        next.splice(at, 0, el);
        if (next.every((x, i) => x === before[i])) return;
        commit(parent, next);
      };
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", end, true);
      document.addEventListener("pointercancel", end, true);
    },
    true,
  );

  // Swallow the click that ends a drag, before the client selects with it.
  window.addEventListener(
    "click",
    (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dragging = false;
    },
    true,
  );

  function commit(parent: Element, next: Element[]) {
    const kids = Array.from(parent.children);
    const label = (el: Element) => labelOf(el, ctx.instancePath(el));
    const order = next.map((el) => kids.indexOf(el));
    const path = ctx.instancePath(parent);
    const element = ctx.elementInfo(parent);
    // Moving again replaces this instance's own override; one applied upstream stays under it.
    const mine = overridesOn(parent).filter((c) => c.property === "children-order");
    const existing = mine.filter((c) => (c.instance?.scope ?? null) === null).at(-1);
    const from = existing?.from ?? kids.map(label).join(", ");
    const to = next.map(label).join(", ");
    record({
      level: "instance",
      property: "children-order",
      from,
      to,
      file: null,
      selector: null,
      element,
      instance: existing?.instance ?? {
        component: path[0]?.name ?? element.comp ?? "?",
        call: path[0]?.call ?? null,
        path,
        scope: null,
        appliesTo: ctx.scopeWords(path, null),
      },
      children: { order, labels: next.map(label) },
    });
    ctx.changed();
  }
}
