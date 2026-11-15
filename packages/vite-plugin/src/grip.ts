// Resizable side panels on the board (shell.ts): the left sidebar's right
// edge and the inspector's left edge drag to change their width.
//
// A width is a CSS variable on the shell's host (`--sp-side-w`,
// `--sp-panel-w`). Custom properties cross shadow roots, so the client's
// panel (mounted in the shell, mode.ts) reads it too. Each width stays
// between its min and max and leaves the canvas some room, is remembered per
// project (state.ts, "panel-widths"), and goes back to its default on a
// double-click of the edge.
import { h } from "./fields.ts";
import { getState, setState } from "./state.ts";

type Widths = Partial<Record<"sidebar" | "panel", number>>;

export type Edge = {
  /** Its name in the saved "panel-widths". */
  name: keyof Widths;
  /** The CSS variable it sets. */
  prop: string;
  def: number;
  min: number;
  max: number;
  /** A drag to the right widens it (+1, a panel on the left) or narrows it (-1, a panel on the right). */
  dir: 1 | -1;
};

/** The canvas never gets narrower than this from a panel being widened. */
export const MIN_CANVAS = 240;

export const GRIP_STYLE = `
  /* 7px to grab, centered on the panel's border; an accent line once hovered a moment or while dragging. */
  .grip {
    position: absolute; top: 0; bottom: 0; width: 7px; margin-left: -3px; display: none;
    cursor: col-resize; touch-action: none; pointer-events: auto;
  }
  .grip::after {
    content: ""; position: absolute; top: 0; bottom: 0; left: 2px; width: 3px;
    background: transparent; transition: background .12s;
  }
  .grip:hover::after { background: var(--sp-accent); transition-delay: .15s; }
  .grip.dragging::after { background: var(--sp-accent); transition-delay: 0s; }
  .sizing, .sizing * { cursor: col-resize !important; }
`;

/**
 * A draggable edge for one panel; call `show` once both panels have theirs. `room` is the most the panel may take right
 * now (the window minus the other panel and the canvas's minimum);
 * `dragging` is told when a drag starts and ends (the board stops its frames
 * from swallowing the pointer).
 */
export function edgeGrip(target: HTMLElement, edge: Edge, room: () => number, dragging: (on: boolean) => void) {
  let saved = edge.def;
  const v = getState<Widths>("panel-widths")?.[edge.name];
  if (typeof v === "number" && Number.isFinite(v) && v > 0) saved = v;
  let width = edge.def;
  const clamp = (w: number) => Math.round(Math.max(edge.min, Math.min(edge.max, room(), w)));
  const grip = h("div", { class: "grip", title: "Drag to resize, double-click for the default width" });

  /** Apply the saved width, as much of it as fits. */
  function show() {
    width = clamp(saved);
    target.style.setProperty(edge.prop, `${width}px`);
  }
  function store() {
    setState("panel-widths", { ...getState<Widths>("panel-widths"), [edge.name]: saved });
  }

  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("dragging");
    dragging(true);
    const x0 = e.clientX;
    const w0 = width;
    let frame = 0;
    let next = w0;
    const move = (ev: PointerEvent) => {
      next = clamp(w0 + (ev.clientX - x0) * edge.dir);
      // At most once a frame: the board re-lays out its frames on every change.
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          saved = next;
          show();
        });
    };
    const up = () => {
      cancelAnimationFrame(frame);
      saved = next;
      show();
      store();
      grip.classList.remove("dragging");
      dragging(false);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("dblclick", () => {
    saved = edge.def;
    show();
    store();
  });

  return {
    grip,
    /** Re-fit the saved width (the window or the other panel changed). */
    show,
    /** The width it has now. */
    width: () => width,
  };
}
