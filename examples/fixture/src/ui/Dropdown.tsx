import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

/**
 * A picker whose list is portaled to the page and placed the way popover
 * libraries (Radix, floating-ui) place theirs: under the button, flipped
 * above it when there's more room there, and never past the window's edge
 * (the list gets shorter and scrolls instead). Spark's component frames have
 * to give it room, or it comes out squeezed.
 */
export function Dropdown({ value, options, open: openProp }: { value: string; options: string[]; open?: boolean }) {
  const [openState, setOpen] = useState(false);
  const open = openProp ?? openState;
  const [picked, setPicked] = useState(value);
  const button = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open || !button.current) return setPlace(null);
    const r = button.current.getBoundingClientRect();
    const below = innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 160 && above > below;
    setPlace({ left: r.left, minWidth: r.width, maxHeight: Math.max(0, (up ? above : below) - 4), ...(up ? { bottom: innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  }, [open]);
  return (
    <>
      <button ref={button} type="button" className="btn dropdown" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {picked} <span className="caret">▾</span>
      </button>
      {open &&
        place &&
        createPortal(
          <ul className="dropdown-list" role="listbox" style={place}>
            {options.map((o) => (
              <li
                key={o}
                role="option"
                aria-selected={o === picked}
                onClick={() => {
                  setPicked(o);
                  setOpen(false);
                }}
              >
                {o}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
