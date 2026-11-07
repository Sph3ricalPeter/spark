// The client's side of the viewport shell, when the app runs in its iframe
// (see mode.ts and shell.ts).
//
// - Ctrl+wheel, pinches and Ctrl +/-/0 inside the app zoom the canvas: the
//   shell catches those itself (shell.ts, guardFrame).
// - Middle drag, and Space drag in edit mode, pan the canvas.
// - The overlay is drawn inside the frame, so it scales with the canvas and
//   stays on its elements; handles, outlines and the tag keep their on-screen
//   size by dividing by the zoom.
import { shell } from "./mode.ts";

// Box shadows, not borders or outlines: those snap to whole pixels of the
// frame, which a zoom then blows up.
const COUNTER_ZOOM = `
  .box.hover { outline: none; box-shadow: 0 0 0 calc(1px / var(--z, 1)) #4f8cff; }
  .box.selected { outline: none; box-shadow: 0 0 0 calc(2px / var(--z, 1)) #4f8cff; }
  .box.selected.editing { box-shadow: 0 0 0 calc(2px / var(--z, 1)) #d9a441; }
  .handle {
    width: calc(8px / var(--z, 1)); height: calc(8px / var(--z, 1));
    margin: calc(-4px / var(--z, 1)) 0 0 calc(-4px / var(--z, 1));
    border: none; box-shadow: inset 0 0 0 calc(1px / var(--z, 1)) #4f8cff;
  }
  .tag { transform: scale(calc(1 / var(--z, 1))); transform-origin: 0 100%; }
  .ask { transform: scale(calc(1 / var(--z, 1))); }
`;

function typing(e: Event) {
  const t = e.composedPath()[0] as HTMLElement | undefined;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? ""));
}

/**
 * `overlay` is the client's shadow host; `isOpen` says whether Spark has the
 * pointer (edit mode), which turns on Space-drag panning; `toggle` opens or
 * closes the panel (Alt+S pressed outside the app).
 */
export function frameGlue(overlay: HTMLElement, isOpen: () => boolean, toggle: () => void) {
  const s = shell;
  if (!s) return;

  const style = document.createElement("style");
  style.textContent = COUNTER_ZOOM;
  overlay.shadowRoot?.append(style);
  let z = 0;
  const sync = () => {
    if (s.zoom !== z) {
      z = s.zoom;
      overlay.style.setProperty("--z", String(z));
    }
    requestAnimationFrame(sync);
  };
  sync();

  // Ctrl+wheel and Ctrl +/-/0 inside the app are caught by the shell itself
  // (shell.ts, guardFrame), so they work even before this client loads.

  let spaceDown = false;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code === "Space" && isOpen() && !typing(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (!spaceDown) s.space(true);
        spaceDown = true;
      }
    },
    true,
  );
  const spaceUp = () => {
    if (spaceDown) s.space(false);
    spaceDown = false;
  };
  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space" || !spaceDown) return;
    e.stopPropagation();
    spaceUp();
  }, true);
  window.addEventListener("blur", spaceUp);

  // Middle drag pans, wherever it starts.
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      const el = document.documentElement;
      el.setPointerCapture(e.pointerId);
      // Keep the grabbed point of the app under the pointer. The frame moves
      // as it pans, so the pointer's position in the app drifts back to
      // where it was grabbed; screenX can't be used here because Chromium
      // doesn't scale it for a transformed iframe (and Windows display scaling
      // can put it in device pixels), which overshoots.
      const x = e.clientX;
      const y = e.clientY;
      const move = (ev: PointerEvent) => {
        s.panBy((ev.clientX - x) * s.zoom, (ev.clientY - y) * s.zoom);
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    },
    true,
  );

  // The middle button's own default (Windows autoscroll) would fight the pan.
  const noMiddle = (e: MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("mousedown", noMiddle, true);
  window.addEventListener("auxclick", noMiddle, true);

  // Alt+S also works with focus outside the app (the bar, the panel).
  const parentDoc = window.parent.document;
  const altS = (e: KeyboardEvent) => {
    if (e.altKey && e.code === "KeyS") {
      e.preventDefault();
      toggle();
    }
  };
  parentDoc.addEventListener("keydown", altS, true);
  // This page's functions die with it: don't leave them in the shell.
  window.addEventListener("pagehide", () => parentDoc.removeEventListener("keydown", altS, true));
}
