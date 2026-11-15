// One pointer drag, from press to release, that always ends.
//
// The release can get lost: let go outside the window, over another frame's
// iframe, or after the window lost focus, and the pointerup never reaches
// the element that captured the pointer. The drag's move handler then kept
// running on every later hover, so the canvas went on panning with no button
// held. A drag here also ends when its capture is lost, when Spark's window
// loses focus, and on the first move that comes without its button down.

/** The `buttons` bit of each `button`: left 1, middle 4, right 2, back 8, forward 16. */
const BIT = [1, 4, 2, 8, 16];

/** The drag in progress in this window: a new press ends it first. */
let current: (() => void) | null = null;

/**
 * Drag from the press `e`: `el` captures the pointer, `move` gets each move
 * while the pressed button is held, and `end` runs once when the drag ends,
 * however it ends.
 */
export function drag(el: Element, e: PointerEvent, move: (ev: PointerEvent) => void, end?: () => void): void {
  current?.();
  const bit = BIT[e.button] ?? 1;
  const id = e.pointerId;
  const win = el.ownerDocument.defaultView ?? window;
  try {
    el.setPointerCapture(id);
  } catch {
    // The pointer is already gone; the button check below still ends the drag.
  }

  const onMove = (ev: Event) => {
    const p = ev as PointerEvent;
    if (p.pointerId !== id) return;
    if (!(p.buttons & bit)) stop();
    else move(p);
  };
  const onUp = (ev: Event) => (ev as PointerEvent).pointerId === id && stop();
  // A window blur also fires when focus only moves between the board and a
  // frame; end the drag only when the whole window lost focus.
  const onBlur = () =>
    setTimeout(() => {
      try {
        if (!win.top?.document.hasFocus()) stop();
      } catch {
        stop();
      }
    });

  const ends = ["pointerup", "pointercancel", "lostpointercapture"];
  function stop() {
    if (current !== stop) return;
    current = null;
    el.removeEventListener("pointermove", onMove);
    for (const t of ends) el.removeEventListener(t, onUp);
    win.removeEventListener("pointerup", onUp, true);
    win.removeEventListener("blur", onBlur);
    try {
      if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    } catch {
      // Already released.
    }
    end?.();
  }
  current = stop;

  el.addEventListener("pointermove", onMove);
  for (const t of ends) el.addEventListener(t, onUp);
  // In case the capture didn't take: a release anywhere in this window.
  win.addEventListener("pointerup", onUp, true);
  win.addEventListener("blur", onBlur);
}
