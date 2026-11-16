// The Components view: every component on its own, with mock data.
//
// A component gets cases from a `*.spark.tsx` file next to it. Each exported
// function is one case, rendered alone in its own card:
//
//   // Meter.spark.tsx
//   import { Meter } from "./Meter";
//   export const Quiet = () => <Meter level={0.2} />;
//   export const Loud = () => <Meter level={0.9} />;
//
// An optional `spark.setup.tsx` in the project root can export a default
// `Wrapper` component (providers, a theme) that wraps every case, and
// `tauri`: an object of command name → (args) => result, which fakes the
// app's own Tauri commands (its Rust side doesn't run inside Spark), and
// `samples`, named sets of such fakes (sample.ts); cases get the first.
//
// On the board (shell.ts) each file gets a frame of its own
// (`?spark=components&file=/src/ui/Meter.spark.tsx`): its cases in a row, no
// title (the frame has one), and the frame is sized to them.
//
// The page runs in the shell's frame (`?spark=components`) instead of the app,
// with the app's global CSS (see index.ts), and the Spark client loads on top
// as usual, so every case can be selected, edited, and implemented. Runs with
// the app's own React, which the generated module passes in.
import type * as ReactNS from "react";
import type { createRoot as CreateRoot } from "react-dom/client";
import { UI_FONT, installFont } from "./fonts.ts";
import { installSample, type Setup as SampleSetup } from "./sample.ts";

type Module = Record<string, unknown>;
type Setup = SampleSetup & { default?: ReactNS.ComponentType<{ children: ReactNS.ReactNode }> };

export type GalleryInput = {
  React: typeof ReactNS;
  createRoot: typeof CreateRoot;
  /** `*.spark.tsx` modules by root-relative path. */
  files: Record<string, Module>;
  setup: Setup | undefined;
};

const STYLE = `
  .spark-gallery {
    box-sizing: border-box; min-height: 100vh; padding: 32px;
    font: 12px/1.4 ${UI_FONT};
  }
  .spark-gallery * { box-sizing: border-box; }
  /* One file in its own board frame (shell.ts): as big as its cases, no title. */
  .spark-gallery.one { min-height: 0; width: max-content; padding: 24px; }
  /* A component frame never scrolls: the board sizes it to the cases. */
  html.spark-one, html.spark-one body { overflow: hidden !important; }
  .spark-gallery.one .spark-gallery-file { margin: 0; }
  .spark-gallery.one .spark-gallery-cases { flex-wrap: nowrap; }
  /* A frame given a width (dragged on the board, or typed): the cases wrap to it. */
  .spark-gallery.one.fixed .spark-gallery-cases { flex-wrap: wrap; }
  .spark-gallery.one.stack .spark-gallery-cases { flex-direction: column; }
  .spark-gallery.one .spark-gallery-empty { margin: 0; }
  .spark-gallery-file { margin: 0 0 40px; }
  .spark-gallery-file > h2 {
    all: unset; display: block; margin: 0 0 12px; font: 600 13px/1.2 ${UI_FONT}; color: #8a8f98;
  }
  .spark-gallery-file > h2 code { font: 11px ui-monospace, monospace; color: #6b7079; margin-left: 8px; }
  .spark-gallery-cases { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
  .spark-gallery-case > .spark-gallery-name { font: 500 11px/1 ${UI_FONT}; color: #8a8f98; margin: 0 0 6px; cursor: text; outline: none; }
  .spark-gallery-case > .spark-gallery-name[contenteditable="plaintext-only"] { color: #fff; box-shadow: 0 1px 0 #4f8cff; }
  /* A containing block for the case's absolute and fixed parts (readouts, popovers), so each stays in its own box. */
  .spark-gallery-case > .spark-gallery-stage {
    position: relative; contain: layout; padding: 24px; border: 1px dashed rgba(138, 143, 152, 0.35); border-radius: 8px; min-width: 120px;
  }
  .spark-gallery-error { color: #e5534b; font: 11px/1.4 ui-monospace, monospace; white-space: pre-wrap; max-width: 360px; }
  .spark-gallery-empty { max-width: 520px; margin: 64px auto; color: #8a8f98; font: 13px/1.6 ${UI_FONT}; }
  .spark-gallery-empty h2 { all: unset; display: block; color: inherit; font: 600 15px/1.3 ${UI_FONT}; margin-bottom: 8px; }
  .spark-gallery-empty pre {
    background: rgba(138, 143, 152, 0.1); border-radius: 6px; padding: 12px; font: 12px/1.5 ui-monospace, monospace;
    color: inherit; overflow: auto;
  }
  .spark-gallery-empty button {
    font: 600 12px ${UI_FONT}; color: #fff; background: #4f8cff; border: none; border-radius: 6px; padding: 8px 14px;
    cursor: pointer;
  }
  .spark-gallery-empty button:disabled { opacity: 0.6; cursor: default; }
`;

/** A component frame's sizes the person set on the board (shell.ts), in px; a missing one hugs. */
export type BoxSizes = { w?: number; h?: number; cases?: Record<string, { w?: number; h?: number }> };

/** A box that's the whole viewport (a modal's backdrop): it says nothing about where the overlay is. */
function fullScreen(r: DOMRect) {
  return r.left <= 0.5 && r.top <= 0.5 && r.width >= innerWidth - 1 && r.height >= innerHeight - 1;
}

/** Spark's own elements and what never draws. */
const SKIP = /^(SCRIPT|STYLE|LINK|TEMPLATE|NOSCRIPT|META)$/;

/** Clear: no alpha (transparent, rgba(…, 0)). */
const clear = (c: string) => c === "transparent" || /^rgba?\(.*[,/]\s*0(\.0*)?\)$/.test(c);

/**
 * Does the element draw anything itself (a fill, a border, a shadow, text, an
 * image or a control)? Wrappers that only place an overlay (Radix's popper
 * wrapper, its select's full-height positioner) don't, so they don't count.
 */
function paints(n: Element, cs: CSSStyleDeclaration) {
  if (Number(cs.opacity) === 0) return false;
  if (/^(IMG|SVG|CANVAS|VIDEO|INPUT|TEXTAREA|SELECT|BUTTON|IFRAME|PICTURE|HR)$/i.test(n.tagName)) return true;
  if (!clear(cs.backgroundColor) || cs.backgroundImage !== "none" || cs.boxShadow !== "none") return true;
  const border = (w: string, st: string, c: string) => parseFloat(w) > 0 && st !== "none" && st !== "hidden" && !clear(c);
  if (
    border(cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor) ||
    border(cs.borderRightWidth, cs.borderRightStyle, cs.borderRightColor) ||
    border(cs.borderBottomWidth, cs.borderBottomStyle, cs.borderBottomColor) ||
    border(cs.borderLeftWidth, cs.borderLeftStyle, cs.borderLeftColor)
  )
    return true;
  return Array.from(n.childNodes).some((c) => c.nodeType === Node.TEXT_NODE && !!c.textContent?.trim());
}

/**
 * Where an overlay shows: the union of the boxes that draw something, each
 * cut to the ancestors that clip it (a long list scrolls inside its menu),
 * backdrops left out. Null when nothing of it shows.
 */
function overlayBounds(root: Element): DOMRect | null {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  const visit = (n: Element, clip: DOMRect | null) => {
    if (SKIP.test(n.tagName)) return;
    const cs = getComputedStyle(n);
    if (cs.display === "none") return;
    const box = n.getBoundingClientRect();
    if (box.width && box.height && cs.visibility !== "hidden" && !fullScreen(box) && paints(n, cs)) {
      const x0 = clip ? Math.max(box.left, clip.left) : box.left;
      const y0 = clip ? Math.max(box.top, clip.top) : box.top;
      const x1 = clip ? Math.min(box.right, clip.right) : box.right;
      const y1 = clip ? Math.min(box.bottom, clip.bottom) : box.bottom;
      if (x1 > x0 && y1 > y0) {
        l = Math.min(l, x0);
        t = Math.min(t, y0);
        r = Math.max(r, x1);
        b = Math.max(b, y1);
      }
    }
    const clips = cs.overflowX !== "visible" || cs.overflowY !== "visible";
    const inner = clips && box.width && box.height ? (clip ? intersect(clip, box) : box) : clip;
    for (const c of Array.from(n.children)) visit(c, inner);
  };
  visit(root, null);
  // Off screen (a popper before it's placed sits at -200%): not there yet.
  return r > l && b > t && r > 0 && b > 0 ? new DOMRect(l, t, r - l, b - t) : null;
}

function intersect(a: DOMRect, b: DOMRect) {
  const l = Math.max(a.left, b.left);
  const t = Math.max(a.top, b.top);
  return new DOMRect(l, t, Math.max(0, Math.min(a.right, b.right) - l), Math.max(0, Math.min(a.bottom, b.bottom) - t));
}

/**
 * The app's overlays: what a case portals out of its box into the page (a
 * Radix or floating-ui popover, a menu, a dialog), each the outermost
 * positioned element outside the gallery.
 */
function overlayRoots(gallery: Element): Element[] {
  const out: Element[] = [];
  const visit = (n: Element) => {
    if (n === gallery || n.tagName.startsWith("SPARK-") || SKIP.test(n.tagName)) return;
    const cs = getComputedStyle(n);
    if (cs.display === "none") return;
    if (cs.position === "fixed" || cs.position === "absolute") out.push(n);
    else for (const c of Array.from(n.children)) visit(c);
  };
  for (const c of Array.from(document.body.children)) visit(c);
  return out;
}

/** How far apart two boxes are (0 when they touch or overlap). */
function gap(a: DOMRect, b: DOMRect) {
  return Math.hypot(Math.max(0, a.left - b.right, b.left - a.right), Math.max(0, a.top - b.bottom, b.top - a.bottom));
}

/** What opens an overlay, while it's open: Radix, Headless UI, React Aria and plain ARIA all mark it. */
const OPEN_TRIGGER = '[aria-expanded="true"], [data-state="open"], [data-state="delayed-open"], [data-state="instant-open"], [data-open], [data-headlessui-state~="open"]';

/**
 * The case box an overlay belongs to: the one whose open trigger it sits next
 * to (within 24px: popovers keep a few px off their trigger, a select's list
 * covers it), else one whose content it touches. Measured from the trigger and
 * the content, never the box, which grows to hold the overlay: what's merely
 * near a box (a dialog in the middle of the page) never sticks to it. -1: none.
 */
function ownerOf(o: DOMRect, stages: HTMLElement[]): number {
  let best = -1;
  let bestD = Infinity;
  for (const [i, s] of stages.entries()) {
    for (const t of Array.from(s.querySelectorAll(OPEN_TRIGGER))) {
      const d = gap(o, t.getBoundingClientRect());
      if (d <= 24 && d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  if (best >= 0) return best;
  for (const [i, s] of stages.entries()) {
    for (const c of Array.from(s.children)) {
      const r = c.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const d = gap(o, r);
      if (d <= 8 && d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  return best;
}

/**
 * Each case's box holds what its component shows: parts positioned absolutely
 * or fixed (a readout, a popover inside it) take no room, and overlays portaled
 * out to the page (a select's list, a menu) aren't in it at all, so the box
 * grows right and down to hold them and the cases don't pile up on each other.
 * Only parts that stick out past the box count, so a part sized to the box
 * (width: 100%) never makes it grow. A size set on the board wins: that side
 * doesn't grow. Returns the overlays, so the frame can be sized to them too.
 */
function fitStages(root: HTMLElement, sizes: BoxSizes, between: () => void): DOMRect[] {
  const stages = Array.from(root.querySelectorAll<HTMLElement>(".spark-gallery-stage"));
  const pad = 24;
  // Overlays are placed by script, so they stay put while the boxes are laid
  // out again below: measure them now, against the boxes they were placed for,
  // as how far they reach from the box's top-left corner (where its content
  // starts, so that stays put as the box grows).
  const rects = stages.map((s) => s.getBoundingClientRect());
  const overlays = overlayRoots(root)
    .map((o) => overlayBounds(o))
    .filter((o): o is DOMRect => !!o);
  const reach = stages.map(() => ({ w: 0, h: 0 }));
  for (const o of overlays) {
    const i = ownerOf(o, stages);
    if (i < 0) continue;
    reach[i].w = Math.max(reach[i].w, o.right - rects[i].left);
    reach[i].h = Math.max(reach[i].h, o.bottom - rects[i].top);
  }
  const set = stages.map((stage) => sizes.cases?.[stage.parentElement?.getAttribute("data-spark-case") ?? ""] ?? {});
  for (const [i, stage] of stages.entries()) {
    const fixW = set[i].w ? `${set[i].w}px` : "";
    const fixH = set[i].h ? `${set[i].h}px` : "";
    if (stage.style.width !== fixW) stage.style.width = fixW;
    if (stage.style.height !== fixH) stage.style.height = fixH;
    stage.style.minWidth = stage.style.minHeight = "";
  }
  // The boxes at their own size: the row or column is picked from those.
  between();
  for (const [i, stage] of stages.entries()) {
    const box = stage.getBoundingClientRect();
    let right = box.right;
    let bottom = box.bottom;
    for (const d of Array.from(stage.querySelectorAll("*"))) {
      const pos = getComputedStyle(d).position;
      if (pos !== "absolute" && pos !== "fixed") continue;
      const r = d.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    // Past the box at its own size: an overlay as wide as the box's trigger never makes it grow.
    right = Math.max(right, box.left + reach[i].w);
    bottom = Math.max(bottom, box.top + reach[i].h);
    const w = right > box.right + 0.5 ? right - box.left + pad : 0;
    const h = bottom > box.bottom + 0.5 ? bottom - box.top + pad : 0;
    if (w > box.width + 0.5 && !set[i].w) stage.style.minWidth = `${Math.ceil(w)}px`;
    if (h > box.height + 0.5 && !set[i].h) stage.style.minHeight = `${Math.ceil(h)}px`;
  }
  return overlays;
}

/** A component frame stacks its cases when one is wider than this. */
const STACK_W = 360;

/** "QuietLevel" → "Quiet level": a case as the board names it. */
export function words(name: string) {
  const s = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** "Very quiet" → "VeryQuiet": a case name as an export name, or "" if there's nothing to name. */
function identifier(text: string) {
  const parts = text.trim().split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  const id = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return !id ? "" : /^[0-9]/.test(id) ? `_${id}` : id;
}

/** "/src/ui/Meter.spark.tsx" → "Meter". */
function fileTitle(path: string) {
  return path.split("/").pop()!.replace(/\.spark\.[jt]sx?$/, "");
}

export function mountGallery({ React, createRoot, files, setup }: GalleryInput) {
  const h = React.createElement;
  installFont();
  installSample(setup, null);

  if (!document.querySelector("style[data-spark='gallery']")) {
    const style = document.createElement("style");
    style.setAttribute("data-spark", "gallery");
    style.textContent = STYLE;
    document.head.append(style);
  }
  // The app's own mount point stays empty; the gallery gets its own.
  const params = new URLSearchParams(location.search);
  const one = params.has("file");
  const only = params.get("file");
  if (only) files = Object.fromEntries(Object.entries(files).filter(([p]) => p === only));
  const g = window as unknown as { __sparkGallery?: ReturnType<typeof CreateRoot> };
  if (!g.__sparkGallery) {
    // The app's empty mount points (#root and friends) would take up the page.
    for (const child of Array.from(document.body.children)) {
      if (child instanceof HTMLElement && child.tagName === "DIV" && child.childNodes.length === 0) child.style.display = "none";
    }
    const el = document.createElement("div");
    el.className = one ? "spark-gallery one" : "spark-gallery";
    document.body.append(el);
    if (one) {
      // Cases sit in a row, or stack in a column: "auto" stacks wide ones
      // (a case wider than STACK_W), the board's toggle picks one for good.
      let layout = params.get("layout") ?? "auto";
      const shellApi = () => window.parent.__sparkShell;
      let queued = 0;
      const arrange = () => {
        cancelAnimationFrame(queued);
        queued = 0;
        const sizes = shellApi()?.boxSizes?.(window) ?? {};
        // A width set on the board: the cases wrap to it.
        const fixW = sizes.w ? `${sizes.w}px` : "";
        if (el.style.width !== fixW) el.style.width = fixW;
        el.classList.toggle("fixed", !!sizes.w);
        let cases = { w: 0, h: 0 };
        const overlays = fitStages(el, sizes, () => {
          const widest = Math.max(0, ...Array.from(el.querySelectorAll(".spark-gallery-case"), (c) => c.getBoundingClientRect().width));
          el.classList.toggle("stack", layout === "column" || (layout === "auto" && widest > STACK_W));
          // The cases at their own size, before their boxes grow for what they
          // opened: the frame's page gets room around this, so opening a
          // popover never resizes the page (Radix closes its select then).
          const n = el.getBoundingClientRect();
          cases = { w: n.right, h: n.bottom };
        });
        // The board sizes the frame to the cases (with the page's own margin
        // around them), and to anything that sticks out of them: parts, and
        // the overlays the cases open.
        const r = el.getBoundingClientRect();
        let right = r.right;
        let bottom = r.bottom;
        for (const d of Array.from(el.querySelectorAll("*"), (d) => d.getBoundingClientRect())) {
          if (!d.width && !d.height) continue;
          right = Math.max(right, d.right);
          bottom = Math.max(bottom, d.bottom);
        }
        // An overlay past the cases gets the page's margin around it too.
        for (const o of overlays) {
          right = Math.max(right, o.right + 16);
          bottom = Math.max(bottom, o.bottom + 16);
        }
        shellApi()?.contentSize(window, right + r.left, bottom + r.top, el.classList.contains("stack"), cases);
      };
      /** Overlays move on their own (a popper placed a frame later): measure again then. */
      const later = () => {
        if (!queued) queued = requestAnimationFrame(arrange);
      };
      document.documentElement.classList.add("spark-one");
      // The cases can change size on their own (fonts, images, state): measure
      // again, a frame later (arranging resizes what it observes).
      const ro = new ResizeObserver(later);
      ro.observe(el);
      new MutationObserver((records) => {
        for (const c of Array.from(el.querySelectorAll(".spark-gallery-stage"))) ro.observe(c);
        // An overlay opened, closed or moved (outside the gallery, which the
        // ResizeObserver already watches; never Spark's own overlay).
        const outside = records.some((m) => {
          const t = m.target instanceof Element ? m.target : m.target.parentElement;
          return !!t && !el.contains(t) && !t.closest("spark-root, spark-panel, spark-changes");
        });
        if (outside) later();
      }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden", "data-state", "data-side"] });
      void document.fonts?.ready.then(arrange);
      const w = window as unknown as { __sparkLayout?: (v: string) => void; __sparkArrange?: () => void };
      w.__sparkLayout = (v) => {
        layout = v;
        arrange();
      };
      // The board changed a size (a frame or a case box dragged, typed, or fit).
      w.__sparkArrange = arrange;
    }
    g.__sparkGallery = createRoot(el);
  }

  /** One broken case shouldn't take the others down. */
  class Boundary extends React.Component<{ children: ReactNS.ReactNode }, { error: Error | null }> {
    /** The client's owner paths stop here: what's above is the gallery, not the app. */
    static sparkInternal = true;
    state = { error: null as Error | null };
    static getDerivedStateFromError(error: Error) {
      return { error };
    }
    render() {
      return this.state.error ? h("div", { className: "spark-gallery-error" }, String(this.state.error.stack ?? this.state.error)) : this.props.children;
    }
  }

  /** A case's name: double-click to rename it (renames the export in its file). */
  function CaseName({ file, name }: { file: string; name: string }) {
    const commit = (el: HTMLElement) => {
      const to = identifier(el.textContent ?? "");
      if (to && to !== name) import.meta.hot?.send("spark:rename-case", { file: file.replace(/^\//, ""), from: name, to });
      else el.textContent = words(name);
    };
    return h(
      "div",
      {
        className: "spark-gallery-name",
        title: "Double-click to rename",
        onDoubleClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => {
          e.stopPropagation();
          const el = e.currentTarget;
          el.contentEditable = "plaintext-only";
          el.focus();
          getSelection()?.selectAllChildren(el);
        },
        onKeyDown: (e: ReactNS.KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.currentTarget.textContent = words(name);
            e.currentTarget.blur();
          }
          e.stopPropagation();
        },
        onBlur: (e: ReactNS.FocusEvent<HTMLDivElement>) => {
          e.currentTarget.contentEditable = "false";
          commit(e.currentTarget);
        },
      },
      words(name),
    );
  }

  const Wrapper = setup?.default ?? React.Fragment;
  const sections = Object.entries(files)
    .sort(([a], [b]) => fileTitle(a).localeCompare(fileTitle(b)))
    .map(([path, mod]) => {
      // In the order they're written (index.ts adds __sparkOrder); a namespace lists them alphabetically.
      const order = Array.isArray(mod.__sparkOrder) ? (mod.__sparkOrder as string[]) : Object.keys(mod);
      const cases = order.filter((k) => typeof mod[k] === "function").map((k) => [k, mod[k]]) as [string, ReactNS.ComponentType][];
      return h(
        "section",
        { key: path, className: "spark-gallery-file" },
        one ? null : h("h2", {}, fileTitle(path), h("code", {}, path.replace(/^\//, ""))),
        h(
          "div",
          { className: "spark-gallery-cases" },
          cases.map(([name, Case]) =>
            h(
              "div",
              // The variant box: Spark selects it as a whole (client.ts targetOf), to Ask Claude about this case.
              { key: name, className: "spark-gallery-case", "data-spark-case": name, "data-spark-case-file": path },
              h(CaseName, { key: "name", file: path, name }),
              h("div", { className: "spark-gallery-stage" }, h(Boundary, null, h(Wrapper, null, h(Case)))),
            ),
          ),
        ),
      );
    });

  g.__sparkGallery.render(sections.length ? h(React.StrictMode, null, sections) : h(Empty, { h }));
}

/** No `*.spark.tsx` yet: how to add one, or have Claude write them. */
function Empty({ h }: { h: typeof ReactNS.createElement }) {
  const example = `// src/ui/Button.spark.tsx\nimport { Button } from "./Button";\n\nexport const Default = () => <Button>Save</Button>;\nexport const Primary = () => <Button variant="primary">Export</Button>;`;
  return h(
    "div",
    { className: "spark-gallery-empty" },
    h("h2", {}, "No components to show yet"),
    h("p", {}, "Add a ", h("code", {}, "*.spark.tsx"), " file next to a component. Each function it exports is one case, rendered here on its own with the props you give it:"),
    h("pre", {}, example),
    h("p", {}, "Or let Claude write them for the components in this project (it's a chat in Chats):"),
    h(
      "button",
      {
        className: "spark-gallery-write",
        onClick: (e: ReactNS.MouseEvent<HTMLButtonElement>) => {
          e.currentTarget.disabled = true;
          e.currentTarget.textContent = "Claude is writing them…";
          import.meta.hot?.send("spark:gallery-generate", {});
        },
      },
      WRITE,
    ),
  );
}

const WRITE = "Write them with Claude";
/** The run ended (its reply is in its chat) or Claude was busy: the button can be pressed again. */
function resetWrite(text = WRITE) {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".spark-gallery-write")) {
    if (!b.disabled) continue;
    b.disabled = false;
    b.textContent = text;
  }
}
import.meta.hot?.on("spark:run", (e: { type: string }) => {
  if (e.type === "done" || e.type === "error") resetWrite();
});
import.meta.hot?.on("spark:busy", () => resetWrite(`Claude is busy in another chat. ${WRITE}`));
