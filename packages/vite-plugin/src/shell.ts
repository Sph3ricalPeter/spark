// The board: the top-level page while Spark is on.
//
// An infinite canvas, like Figma's, holding frames:
// - app frames: the app in an iframe sized to a device, a custom resolution
//   or the window ("Fill"). A frame is a real viewport, so media queries,
//   vw/vh and `position: fixed` answer to its size. "+ Frame" adds another
//   one, so the app can be seen at several sizes side by side;
// - component frames: one per `*.spark.tsx` file, its cases in a row with
//   mock data (gallery.ts), sized to their content. They sit to the right of
//   the app until dragged somewhere else by their title.
// Every frame runs its own Spark client; the board keeps them in step: one
// mode, one open panel (the selected frame's), one change list, one undo
// history. Clicking in a frame selects it; Tab (or View in the bar) puts the
// selected frame in view mode: the others dim. Only Fit and 100% move the
// camera.
//
// The canvas zooms and pans on its own: Ctrl+wheel or a pinch zooms at the
// pointer, Ctrl +/- steps, Ctrl 0 is 100% on the selected frame; wheel over
// the empty canvas pans (Shift for sideways), middle drag or Space drag pans
// anywhere. The browser's own page zoom never kicks in, so the panel and the
// bar stay put.
import { installFont } from "./fonts.ts";
import { THEME, icon } from "./theme.ts";
import { h } from "./fields.ts";
import type { ClientHooks, ShellApi } from "./mode.ts";
import caseFiles from "/@spark/cases";

const BAR_H = 40;
const PANEL_W = 340;
const PAD = 48;
const GAP = 80;
const MIN_Z = 0.05;
const MAX_Z = 8;
const STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const STORE = "spark:board";
const OLD_STORE = "spark:viewport";
const MAX_STEPS = 200;

type Preset = { id: string; name: string; group: string; w: number; h: number };

const PRESETS: Preset[] = [
  { id: "fill", name: "Fill window", group: "", w: 0, h: 0 },
  { id: "1920x1080", name: "Desktop 1920 × 1080", group: "Desktop", w: 1920, h: 1080 },
  { id: "1440x900", name: "Laptop 1440 × 900", group: "Desktop", w: 1440, h: 900 },
  { id: "1366x768", name: "Laptop 1366 × 768", group: "Desktop", w: 1366, h: 768 },
  { id: "1280x720", name: "HD 1280 × 720", group: "Desktop", w: 1280, h: 720 },
  { id: "1024x1366", name: "iPad Pro 12.9″ 1024 × 1366", group: "Tablet", w: 1024, h: 1366 },
  { id: "820x1180", name: "iPad Air 820 × 1180", group: "Tablet", w: 820, h: 1180 },
  { id: "768x1024", name: "iPad mini 768 × 1024", group: "Tablet", w: 768, h: 1024 },
  { id: "430x932", name: "iPhone 15 Pro Max 430 × 932", group: "Phone", w: 430, h: 932 },
  { id: "393x852", name: "iPhone 15 393 × 852", group: "Phone", w: 393, h: 852 },
  { id: "375x667", name: "iPhone SE 375 × 667", group: "Phone", w: 375, h: 667 },
  { id: "412x915", name: "Pixel 8 412 × 915", group: "Phone", w: 412, h: 915 },
  { id: "360x800", name: "Android 360 × 800", group: "Phone", w: 360, h: 800 },
];

/** Aspect ratios keep the current width and set the height. */
const RATIOS: [string, number][] = [
  ["16:9", 16 / 9],
  ["16:10", 16 / 10],
  ["4:3", 4 / 3],
  ["21:9", 21 / 9],
  ["1:1", 1],
  ["3:4", 3 / 4],
  ["9:16", 9 / 16],
];

// ---------------------------------------------------------------------------
// State

type Frame = {
  id: string;
  kind: "app" | "component";
  /** A component frame's case file ("" for the empty view); "" for apps. */
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** App frames: "fill", a preset id, or "custom". */
  preset: string;
  /** A component frame the user moved; the others follow the app frames. */
  placed: boolean;
  /** Component frames: cases in a row or a column ("auto": a column for wide ones). */
  layout: Layout;
  /** Component frames: the cases are in a column right now. */
  stacked: boolean;
  el: HTMLElement;
  name: HTMLElement;
  meta: HTMLElement;
  iframe: HTMLIFrameElement;
};

type SavedApp = { id: string; x: number; y: number; w: number; h: number; preset: string };
type Layout = "auto" | "row" | "column";
type Saved = { apps: SavedApp[]; placed: Record<string, { x: number; y: number }>; selected: string; layouts?: Record<string, Layout> };

let frames: Frame[] = [];
let selectedId = "app-1";
let z = 1;
let px = 0;
let py = 0;
let docked = false;
let edit = false;

function loadSaved(): Saved {
  const fresh: Saved = { apps: [{ id: "app-1", x: 0, y: 0, w: 1280, h: 720, preset: "fill" }], placed: {}, selected: "app-1" };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null") as Saved | null;
    if (saved && Array.isArray(saved.apps) && saved.apps.length) return { ...fresh, ...saved };
    // The single viewport this board replaces.
    const old = JSON.parse(localStorage.getItem(OLD_STORE) ?? "null") as { preset: string; w: number; h: number } | null;
    if (old && typeof old.w === "number") fresh.apps[0] = { ...fresh.apps[0], preset: old.preset, w: old.w, h: old.h };
    docked = localStorage.getItem("spark:open") === "1";
  } catch {
    // Storage may be off: one app frame filling the window.
  }
  return fresh;
}

function save() {
  const s: Saved = {
    apps: frames.filter((f) => f.kind === "app").map(({ id, x, y, w, h, preset }) => ({ id, x, y, w, h, preset })),
    placed: Object.fromEntries(frames.filter((f) => f.kind === "component" && f.placed).map((f) => [f.file, { x: f.x, y: f.y }])),
    selected: selectedId,
    layouts: Object.fromEntries(frames.filter((f) => f.layout !== "auto").map((f) => [f.file, f.layout])),
  };
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {
    // Storage may be off.
  }
}

// ---------------------------------------------------------------------------
// DOM

const host = document.createElement("spark-shell");
host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483646;";
const root = host.attachShadow({ mode: "open" });
installFont();

root.append(
  h(
    "style",
    {},
    `${THEME}
    :host { all: initial; }
    * { box-sizing: border-box; }
    .bar {
      position: absolute; top: 0; left: 0; right: 0; height: ${BAR_H}px;
      display: flex; align-items: center; gap: 6px; padding: 0 10px;
      background: var(--sp-bg); color: var(--sp-text); border-bottom: 1px solid var(--sp-line);
      font: var(--sp-fs-md)/1 var(--sp-font); user-select: none;
      overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
    }
    .docked .bar, .docked .canvas { right: ${PANEL_W}px; }
    button, select, input {
      font: inherit; color: inherit; background: var(--sp-field); border: 1px solid var(--sp-line-strong);
      border-radius: var(--sp-r-sm); height: 26px; padding: 0 8px; flex: none;
    }
    button { cursor: pointer; min-width: 26px; }
    button:hover, select:hover { border-color: var(--sp-line-strong); }
    button:disabled, select:disabled, input:disabled { opacity: .4; cursor: default; }
    select { padding: 0 4px; max-width: 220px; }
    input { width: 62px; font: var(--sp-fs-sm) var(--sp-mono); text-align: center; }
    input:focus, select:focus { outline: 1px solid var(--sp-accent); border-color: var(--sp-accent); }
    .x { color: var(--sp-text-dim); }
    .sep { width: 1px; height: 18px; background: var(--sp-line); flex: none; margin: 0 4px; }
    .grow { flex: 1; min-width: 8px; }
    .zoom { width: 52px; text-align: center; font: var(--sp-fs-sm) var(--sp-mono); color: var(--sp-text-strong); flex: none; }
    .canvas {
      position: absolute; top: ${BAR_H}px; left: 0; right: 0; bottom: 0; overflow: hidden;
      background-color: #0e0f11;
      background-image: radial-gradient(#ffffff14 1px, transparent 1px);
      background-size: 16px 16px;
    }
    .canvas.panning, .canvas.panning * { cursor: grabbing !important; }
    .canvas.space { cursor: grab; }
    .stage { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; }
    .frame { position: absolute; left: 0; top: 0; transition: opacity .15s; }
    .frame iframe {
      display: block; border: 0; background: var(--sp-text-strong);
      box-shadow: 0 0 0 calc(1px / var(--z, 1)) var(--sp-line), 0 12px 40px #0008;
    }
    .frame.component iframe { background: transparent; }
    /* The selected frame: a faint ring, so it never reads as a selected element. */
    .edit-mode .frame.selected iframe {
      box-shadow: 0 0 0 calc(1px / var(--z, 1)) color-mix(in srgb, var(--sp-accent) 45%, transparent), 0 12px 40px #0008;
    }
    .frame.dim { opacity: .35; cursor: pointer; }
    .frame.dim iframe { pointer-events: none; }
    .moving .frame iframe { pointer-events: none; }
    /* The frame's title: above it, at a constant on-screen size. */
    .ftitle {
      position: absolute; left: 0; bottom: 100%; display: flex; align-items: center; gap: 8px;
      padding: 0 0 6px; white-space: nowrap; transform: scale(calc(1 / var(--z, 1))); transform-origin: 0 100%;
      font: 600 var(--sp-fs-sm)/1.2 var(--sp-font); color: var(--sp-text-dim); cursor: grab; user-select: none;
    }
    .ftitle:active { cursor: grabbing; }
    .ftitle .meta { font: var(--sp-fs-xs) var(--sp-mono); font-weight: 400; color: var(--sp-text-faint, var(--sp-text-dim)); opacity: .75; }
    .ftitle .icon { vertical-align: 0; }
    .frame.selected .ftitle { color: var(--sp-accent); }
    .frame.component .ftitle { color: color-mix(in srgb, var(--sp-component) 75%, transparent); }
    .frame.component.selected .ftitle { color: var(--sp-component); }
    .edit-mode .frame.component.selected iframe {
      box-shadow: 0 0 0 calc(1px / var(--z, 1)) color-mix(in srgb, var(--sp-component) 55%, transparent), 0 12px 40px #0008;
    }
    .ftitle button {
      height: 16px; min-width: 16px; padding: 0 4px; border: none; background: transparent; color: var(--sp-text-dim);
      font-size: 13px; line-height: 1; visibility: hidden;
    }
    .ftitle:hover button { visibility: visible; }
    .ftitle button:hover { color: var(--sp-text-strong); }
    .ftitle button.flip { font: 500 var(--sp-fs-xs)/1 var(--sp-font); color: inherit; opacity: .8; }
    /* Covers the frames while panning, so the drag isn't lost into an app. */
    .shield { position: absolute; inset: 0; display: none; }
    .panning .shield, .space .shield { display: block; }
    /* The mode island: in the middle of the bar, so the mode is never in doubt
       and it never covers the app. */
    .island {
      display: none; flex: none; align-items: center; gap: 8px; padding: 2px 6px 2px 2px; height: 32px;
      background: #16171aee; border: 1px solid var(--sp-line); border-radius: 999px;
      box-shadow: 0 6px 20px #0008; font: var(--sp-fs-md)/1 var(--sp-font); color: var(--sp-text-dim);
      user-select: none;
    }
    .island.ready { display: flex; }
    .island button { border-radius: 999px; height: 26px; font-weight: 600; padding: 0 14px; border-color: transparent; background: transparent; }
    .island button.on { background: var(--sp-text-strong); color: var(--sp-bg); }
    .island.edit button.on { background: var(--sp-accent); color: var(--sp-text-strong); }
    .island kbd {
      font: var(--sp-fs-xs) var(--sp-mono); color: var(--sp-text); border: 1px solid var(--sp-line-strong);
      border-bottom-width: 2px; border-radius: var(--sp-r-sm); padding: 2px 5px;
    }
    /* Edit mode: a soft glow in from the canvas edges, unlike any selection outline. */
    .canvas::after {
      content: ""; position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .2s;
      box-shadow: inset 0 0 48px 0 color-mix(in srgb, var(--sp-accent) 30%, transparent),
        inset 0 0 12px 0 color-mix(in srgb, var(--sp-accent) 22%, transparent);
    }
    .edit-mode .canvas::after { opacity: 1; }
    `,
  ),
);

const presetSel = h("select", { title: "Device or resolution of the selected app frame" }) as HTMLSelectElement;
{
  let group: HTMLElement | null = null;
  for (const p of PRESETS) {
    const opt = h("option", { value: p.id }, p.name);
    if (!p.group) presetSel.append(opt);
    else {
      if (!group || group.getAttribute("label") !== p.group) {
        group = h("optgroup", { label: p.group });
        presetSel.append(group);
      }
      group.append(opt);
    }
  }
  presetSel.append(h("option", { value: "custom" }, "Custom"));
}
const addBtn = h("button", { title: "Add an app frame (another size of the app, side by side)" }, "+ Frame");
const prevBtn = h("button", { title: "Previous size" }, "‹");
const nextBtn = h("button", { title: "Next size" }, "›");
const wIn = h("input", { title: "Width (px)", inputmode: "numeric" }) as HTMLInputElement;
const hIn = h("input", { title: "Height (px)", inputmode: "numeric" }) as HTMLInputElement;
const rotateBtn = h("button", { title: "Swap width and height" }, "⟲");
// Aspect ratios as one dropdown, so the bar keeps room for the mode island and zoom.
const ratioSel = h("select", { title: "Aspect ratio: keeps the width" }) as HTMLSelectElement;
ratioSel.append(h("option", { value: "" }, "Ratio"));
for (const [i, [name]] of RATIOS.entries()) ratioSel.append(h("option", { value: String(i) }, name));
ratioSel.addEventListener("change", () => {
  const f = selectedApp();
  if (f && ratioSel.value !== "") setSize(f, f.w, f.w / RATIOS[Number(ratioSel.value)][1]);
});
const zoomOut = h("button", { title: "Zoom out (Ctrl −)" }, "−");
const zoomLabel = h("span", { class: "zoom", title: "Ctrl+wheel or pinch to zoom at the pointer" });
const zoomIn = h("button", { title: "Zoom in (Ctrl +)" }, "+");
const fitBtn = h("button", { title: "Zoom to fit every frame" }, "Fit");
const oneBtn = h("button", { title: "The selected frame at actual size (Ctrl 0)" }, "100%");

const islandView = h("button", { title: "Use the selected frame normally (Tab)" }, "View");
const islandEdit = h("button", { title: "Select and edit elements (Tab)" }, "Edit");
const island = h("div", { class: "island" }, h("span", { class: "seg" }, islandView, islandEdit), h("kbd", { title: "Tab switches mode" }, "Tab"));
islandView.addEventListener("click", () => switchMode(false));
islandEdit.addEventListener("click", () => switchMode(true));
const sizeControls = [presetSel, prevBtn, nextBtn, wIn, hIn, rotateBtn, ratioSel];

const bar = h(
  "div",
  { class: "bar" },
  addBtn,
  h("span", { class: "sep" }),
  presetSel,
  prevBtn,
  nextBtn,
  h("span", { class: "sep" }),
  wIn,
  h("span", { class: "x" }, "×"),
  hIn,
  rotateBtn,
  h("span", { class: "sep" }),
  ratioSel,
  h("span", { class: "grow" }),
  island,
  h("span", { class: "grow" }),
  zoomOut,
  zoomLabel,
  zoomIn,
  fitBtn,
  oneBtn,
);

// The bar's buttons and dropdowns never keep focus: Tab and Esc are Spark's
// shortcuts, not focus moves, and the first Esc mustn't go to a dropdown.
bar.addEventListener("click", (e) => {
  const b = (e.target as Element).closest("button");
  if (b && root.activeElement === b) b.blur();
});
bar.addEventListener("change", (e) => {
  if (e.target instanceof HTMLSelectElement) e.target.blur();
});

/** Take focus out of the bar and every panel (they're shadow roots in the shell). */
function blurChrome() {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (el instanceof HTMLElement && el !== document.body) el.blur();
}

const stage = h("div", { class: "stage" });
const shield = h("div", { class: "shield" });
const canvas = h("div", { class: "canvas" }, stage, shield);
const shellEl = h("div", { class: "shell" }, bar, canvas);
root.append(shellEl);

// ---------------------------------------------------------------------------
// Frames

/** The page's address without Spark's own parameters: what app frames load. */
function appUrl() {
  const url = new URL(location.href);
  url.searchParams.delete("spark");
  url.searchParams.delete("file");
  return url.href;
}

function componentUrl(file: string, layout: Layout = "auto") {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set("spark", "components");
  url.searchParams.set("file", file);
  if (layout !== "auto") url.searchParams.set("layout", layout);
  return url.href;
}

/** "/src/ui/Meter.spark.tsx" → "Meter". */
function fileTitle(file: string) {
  return file ? file.split("/").pop()!.replace(/\.spark\.[jt]sx?$/, "") : "Components";
}

function makeFrame(kind: Frame["kind"], id: string, file: string, at: Partial<Frame> = {}): Frame {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("data-spark-frame", "");
  const name = h("span", { class: "name" });
  const meta = h("span", { class: "meta" });
  // App frames run the real app at a chosen size; component frames render
  // cases with mock data and hug them. Each kind has its own icon and color.
  const title = h("div", { class: "ftitle" }, icon(kind === "app" ? "app-window" : "component", 12), name, meta);
  const el = h("div", { class: `frame ${kind}` }, title, iframe);
  const f: Frame = { id, kind, file, x: 0, y: 0, w: kind === "app" ? 1280 : 320, h: kind === "app" ? 720 : 160, preset: "custom", placed: false, layout: "auto", stacked: false, el, name, meta, iframe, ...at };
  if (kind === "app") {
    if (id !== "app-1") {
      const close = h("button", { title: "Remove this frame" }, "×");
      close.addEventListener("pointerdown", (e) => e.stopPropagation());
      close.addEventListener("click", () => removeFrame(f));
      title.append(close);
    }
    iframe.title = "App";
  } else {
    iframe.title = `${fileTitle(file)} cases`;
    meta.textContent = file.replace(/^\//, "");
    const flip = h("button", { class: "flip", title: "Cases in a row or stacked in a column" });
    flip.addEventListener("pointerdown", (e) => e.stopPropagation());
    flip.addEventListener("click", () => setLayout(f, f.stacked ? "row" : "column"));
    title.append(flip);
  }
  title.addEventListener("pointerdown", (e) => moveFrame(f, e as PointerEvent));
  // A dimmed frame (view mode) takes the click itself: select it, where it is.
  el.addEventListener("pointerdown", (e) => {
    if ((e as PointerEvent).button !== 0 || !el.classList.contains("dim")) return;
    selectFrame(f);
  });
  stage.append(el);
  iframe.src = kind === "app" ? appUrl() : componentUrl(file, f.layout);
  return f;
}

/** Cases in a row or a column, for this component frame from now on. */
function setLayout(f: Frame, layout: Layout) {
  f.layout = layout;
  const win = f.iframe.contentWindow as (Window & { __sparkLayout?: (v: string) => void }) | null;
  try {
    win?.__sparkLayout?.(layout);
    // A reload of the frame keeps it.
    win?.history.replaceState(win.history.state, "", componentUrl(f.file, layout));
  } catch {
    // Off-origin: the next load picks it up from the saved board.
  }
  save();
}

function selected(): Frame {
  return frames.find((f) => f.id === selectedId) ?? frames[0];
}

function selectedApp(): Frame | null {
  const f = selected();
  return f.kind === "app" ? f : null;
}

function selectFrame(f: Frame) {
  if (f.id === selectedId) return;
  selectedId = f.id;
  const win = f.iframe.contentWindow;
  if (win) activate(win);
  save();
  apply();
}

function removeFrame(f: Frame) {
  if (f.id === "app-1") return;
  const win = f.iframe.contentWindow;
  const hooks = win && clients.get(win);
  if (hooks) {
    hooks.panel.remove();
    clients.delete(win);
  }
  f.el.remove();
  frames = frames.filter((x) => x !== f);
  if (selectedId === f.id) {
    selectedId = frames[0].id;
    const w = frames[0].iframe.contentWindow;
    if (w) activate(w);
  }
  save();
  apply();
}

function addApp() {
  const apps = frames.filter((f) => f.kind === "app");
  const from = selectedApp() ?? apps[0];
  let n = 2;
  while (frames.some((f) => f.id === `app-${n}`)) n++;
  const right = Math.max(...apps.map((f) => f.x + f.w));
  // A Fill frame copies the window's size as a fixed one.
  const f = makeFrame("app", `app-${n}`, "", { x: right + GAP, y: apps[0].y, w: from.w, h: from.h, preset: from.preset === "fill" ? "custom" : from.preset });
  frames.splice(apps.length, 0, f);
  if (activeWin) clients.get(activeWin)?.deselect();
  activeWin = null;
  selectedId = f.id;
  save();
  apply();
  focusFrame(f);
  apply();
}

/** The case files changed (one added or removed): frames follow. */
function syncComponents(files: string[]) {
  const want = files.length ? files : [""];
  for (const f of frames.filter((f) => f.kind === "component" && !want.includes(f.file))) {
    const win = f.iframe.contentWindow;
    if (win && clients.has(win)) {
      clients.get(win)!.panel.remove();
      clients.delete(win);
    }
    f.el.remove();
    frames = frames.filter((x) => x !== f);
  }
  const placed = loaded.placed;
  for (const file of want) {
    if (frames.some((f) => f.kind === "component" && f.file === file)) continue;
    const p = placed[file];
    const layout = loaded.layouts?.[file] ?? "auto";
    frames.push(makeFrame("component", `c:${file}`, file, { layout, ...(p ? { x: p.x, y: p.y, placed: true } : {}) }));
  }
  if (!frames.some((f) => f.id === selectedId)) selectedId = frames[0].id;
  apply();
}

/** Drag a frame by its title. */
function moveFrame(f: Frame, e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  selectFrame(f);
  const t = e.currentTarget as HTMLElement;
  t.setPointerCapture(e.pointerId);
  shellEl.classList.add("moving");
  // Where the frame would be without snapping; Ctrl snaps it to the visible grid.
  const x0 = f.x;
  const y0 = f.y;
  const cx = e.clientX;
  const cy = e.clientY;
  const move = (ev: PointerEvent) => {
    const rx = x0 + (ev.clientX - cx) / z;
    const ry = y0 + (ev.clientY - cy) / z;
    const g = gridStep();
    f.x = ev.ctrlKey || ev.metaKey ? Math.round(rx / g) * g : rx;
    f.y = ev.ctrlKey || ev.metaKey ? Math.round(ry / g) * g : ry;
    if (f.kind === "component") f.placed = true;
    apply();
  };
  const up = () => {
    shellEl.classList.remove("moving");
    f.x = Math.round(f.x);
    f.y = Math.round(f.y);
    t.removeEventListener("pointermove", move as EventListener);
    t.removeEventListener("pointerup", up);
    t.removeEventListener("pointercancel", up);
    save();
    apply();
  };
  t.addEventListener("pointermove", move as EventListener);
  t.addEventListener("pointerup", up);
  t.addEventListener("pointercancel", up);
}

// ---------------------------------------------------------------------------
// Layout

function canvasSize() {
  return { cw: canvas.clientWidth, ch: canvas.clientHeight };
}

function clampZ(v: number) {
  return Math.min(MAX_Z, Math.max(MIN_Z, v));
}

/** The board's grid in world pixels: 16, coarser when zoomed out so the dots stay apart. */
function gridStep() {
  let g = 16;
  while (g * z < 10) g *= 4;
  return g;
}

/** Component frames nobody moved: a column to the right of the app frames. */
function layout() {
  const apps = frames.filter((f) => f.kind === "app");
  const left = Math.max(...apps.map((f) => f.x + f.w)) + GAP;
  let y = Math.min(...apps.map((f) => f.y));
  for (const f of frames) {
    if (f.kind !== "component" || f.placed) continue;
    f.x = left;
    f.y = y;
    y += f.h + GAP / 2;
  }
}

function apply() {
  const { cw, ch } = canvasSize();
  for (const f of frames) {
    if (f.kind === "app" && f.preset === "fill" && cw > 0) {
      f.w = cw;
      f.h = ch;
    }
  }
  layout();
  const sel = selected();
  stage.style.transform = `translate(${px}px, ${py}px) scale(${z})`;
  // The dot grid is on the board, so it pans and zooms with the frames.
  const g = gridStep() * z;
  canvas.style.backgroundSize = `${g}px ${g}px`;
  canvas.style.backgroundPosition = `${px - g / 2}px ${py - g / 2}px`;
  stage.style.setProperty("--z", String(z));
  for (const f of frames) {
    f.el.style.transform = `translate(${f.x}px, ${f.y}px)`;
    f.iframe.style.width = `${f.w}px`;
    f.iframe.style.height = `${f.h}px`;
    f.el.classList.toggle("selected", f === sel);
    f.el.classList.toggle("dim", !edit && f !== sel);
    if (f.kind === "app") {
      const apps = frames.filter((x) => x.kind === "app");
      f.name.textContent = apps.length > 1 ? `App ${apps.indexOf(f) + 1}` : "App";
      f.meta.textContent = f.preset === "fill" ? `Fill · ${f.w} × ${f.h}` : `${f.w} × ${f.h}`;
    } else f.name.textContent = fileTitle(f.file);
  }
  shellEl.classList.toggle("docked", docked);
  showPanels();
  zoomLabel.textContent = `${Math.round(z * 100)}%`;
  const app = selectedApp();
  for (const c of sizeControls) (c as HTMLInputElement).disabled = !app;
  presetSel.value = app?.preset ?? "custom";
  const focused = (el: HTMLElement) => document.activeElement === host && root.activeElement === el;
  if (!focused(wIn)) wIn.value = app ? String(app.w) : "";
  if (!focused(hIn)) hIn.value = app ? String(app.h) : "";
  const ratio = !app || app.preset === "fill" ? -1 : RATIOS.findIndex(([, r]) => Math.abs(app.w / app.h - r) < 0.01);
  ratioSel.value = ratio < 0 ? "" : String(ratio);
}

/** Center the box (world coordinates) at zoom `zz`. */
function centerOn(x: number, y: number, w: number, hh: number, zz: number) {
  const { cw, ch } = canvasSize();
  z = clampZ(zz);
  px = Math.round((cw - w * z) / 2 - x * z);
  py = Math.round((ch - hh * z) / 2 - y * z);
}

function fitZoom(w: number, hh: number) {
  const { cw, ch } = canvasSize();
  return Math.min((cw - PAD * 2) / w, (ch - PAD * 2) / hh);
}

/** Bring a frame into view: 100% if it fits, otherwise fit. A Fill frame fills the canvas. */
function focusFrame(f: Frame, zz?: number) {
  apply();
  if (f.kind === "app" && f.preset === "fill") {
    z = 1;
    px = -f.x;
    py = -f.y;
    return;
  }
  centerOn(f.x, f.y, f.w, f.h, zz ?? Math.min(1, fitZoom(f.w, f.h)));
}

function fitAll() {
  apply();
  const x0 = Math.min(...frames.map((f) => f.x));
  const y0 = Math.min(...frames.map((f) => f.y)) - 24;
  const x1 = Math.max(...frames.map((f) => f.x + f.w));
  const y1 = Math.max(...frames.map((f) => f.y + f.h));
  centerOn(x0, y0, x1 - x0, y1 - y0, Math.min(1, fitZoom(x1 - x0, y1 - y0)));
  apply();
}

function setPreset(f: Frame, id: string) {
  const p = PRESETS.find((p) => p.id === id);
  f.preset = id;
  if (p && p.id !== "fill") {
    f.w = p.w;
    f.h = p.h;
  }
  save();
  focusFrame(f);
  apply();
}

function setSize(f: Frame, nw: number, nh: number) {
  f.w = Math.round(Math.min(10000, Math.max(50, nw)));
  f.h = Math.round(Math.min(10000, Math.max(50, nh)));
  f.preset = PRESETS.find((p) => p.w === f.w && p.h === f.h)?.id ?? "custom";
  save();
  focusFrame(f);
  apply();
}

/** Zoom to `zz`, keeping the canvas point (cx, cy) still. */
function zoomAt(zz: number, cx: number, cy: number) {
  const nz = clampZ(zz);
  px = cx - ((cx - px) * nz) / z;
  py = cy - ((cy - py) * nz) / z;
  z = nz;
  apply();
}

function zoomStep(dir: 1 | -1) {
  const { cw, ch } = canvasSize();
  const next = dir > 0 ? STEPS.find((s) => s > z + 0.001) : [...STEPS].reverse().find((s) => s < z - 0.001);
  zoomAt(next ?? z, cw / 2, ch / 2);
}

function wheelDelta(e: WheelEvent) {
  return e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
}

function zoomByWheel(deltaY: number, cx: number, cy: number) {
  // Pinches send small deltas, mouse wheels ~100 a notch.
  zoomAt(z * Math.exp(-Math.max(-100, Math.min(100, deltaY)) * 0.0025), cx, cy);
}

function panBy(dx: number, dy: number) {
  px += dx;
  py += dy;
  apply();
}

// ---------------------------------------------------------------------------
// Bar

addBtn.addEventListener("click", addApp);
presetSel.addEventListener("change", () => {
  const f = selectedApp();
  if (f) setPreset(f, presetSel.value);
});

function stepPreset(dir: 1 | -1) {
  const f = selectedApp();
  if (!f) return;
  const i = PRESETS.findIndex((p) => p.id === f.preset);
  const next = PRESETS[(Math.max(0, i) + dir + PRESETS.length) % PRESETS.length];
  setPreset(f, next.id);
}
prevBtn.addEventListener("click", () => stepPreset(-1));
nextBtn.addEventListener("click", () => stepPreset(1));

function typedSize() {
  const f = selectedApp();
  const nw = parseInt(wIn.value, 10);
  const nh = parseInt(hIn.value, 10);
  if (f && nw > 0 && nh > 0) setSize(f, nw, nh);
  else apply();
}
for (const input of [wIn, hIn]) {
  input.addEventListener("change", typedSize);
  input.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.key === "Enter") input.blur();
    if (k.key === "ArrowUp" || k.key === "ArrowDown") {
      k.preventDefault();
      const d = (k.key === "ArrowUp" ? 1 : -1) * (k.shiftKey ? 10 : 1);
      input.value = String((parseInt(input.value, 10) || 0) + d);
      typedSize();
    }
  });
}
rotateBtn.addEventListener("click", () => {
  const f = selectedApp();
  if (f) setSize(f, f.h, f.w);
});
zoomOut.addEventListener("click", () => zoomStep(-1));
zoomIn.addEventListener("click", () => zoomStep(1));
fitBtn.addEventListener("click", fitAll);
oneBtn.addEventListener("click", () => zoomKey("reset"));

// ---------------------------------------------------------------------------
// Zoom and pan input on the canvas

canvas.addEventListener(
  "wheel",
  (e) => {
    const we = e as WheelEvent;
    we.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (we.ctrlKey || we.metaKey) zoomByWheel(wheelDelta(we), we.clientX - r.left, we.clientY - r.top);
    else if (we.shiftKey) panBy(-wheelDelta(we), 0);
    else panBy(-we.deltaX, -wheelDelta(we));
  },
  { passive: false },
);

let space = false;
function setSpace(v: boolean) {
  space = v;
  canvas.classList.toggle("space", space);
}

function startPan(e: PointerEvent) {
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("panning");
  // clientX, not screenX: with Windows display scaling screenX can be in
  // device pixels, which overshoots.
  let x = e.clientX;
  let y = e.clientY;
  const move = (ev: PointerEvent) => {
    panBy(ev.clientX - x, ev.clientY - y);
    x = ev.clientX;
    y = ev.clientY;
  };
  const up = () => {
    canvas.classList.remove("panning");
    canvas.removeEventListener("pointermove", move as EventListener);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", up);
  };
  canvas.addEventListener("pointermove", move as EventListener);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
}
canvas.addEventListener("pointerdown", (e) => {
  const p = e as PointerEvent;
  blurChrome();
  if (p.button === 1 || (p.button === 0 && (space || p.target === canvas))) startPan(p);
});
// Middle button: no autoscroll, no paste, no auxclick in the shell.
canvas.addEventListener("mousedown", (e) => (e as MouseEvent).button === 1 && e.preventDefault());
canvas.addEventListener("auxclick", (e) => e.preventDefault());

/** True when keys belong to a text field, not to shortcuts. */
function typing(e: Event) {
  const t = e.composedPath()[0];
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

/** Ctrl +, Ctrl -, Ctrl 0, anywhere outside the app. */
function zoomKeyOf(e: KeyboardEvent): "in" | "out" | "reset" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd") return "in";
  if (e.key === "-" || e.code === "NumpadSubtract") return "out";
  if (e.key === "0" || e.code === "Numpad0") return "reset";
  return null;
}

function zoomKey(k: "in" | "out" | "reset") {
  if (k === "reset") {
    focusFrame(selected(), 1);
    apply();
  } else zoomStep(k === "in" ? 1 : -1);
}

window.addEventListener(
  "keydown",
  (e) => {
    const k = zoomKeyOf(e);
    if (k) {
      e.preventDefault();
      zoomKey(k);
    } else if (e.code === "Space" && !typing(e)) {
      e.preventDefault();
      setSpace(true);
    } else if (e.shiftKey && e.code === "Digit1" && !e.ctrlKey && !e.altKey && !typing(e)) {
      // Figma's Shift+1: everything in view.
      e.preventDefault();
      fitAll();
    }
  },
  true,
);
window.addEventListener("keyup", (e) => e.code === "Space" && setSpace(false), true);
window.addEventListener("blur", () => setSpace(false));
// Ctrl+wheel anywhere in the shell (the bar, the panel) is ours, not the page's.
window.addEventListener("wheel", (e) => (e.ctrlKey || e.metaKey) && e.preventDefault(), { passive: false });

new ResizeObserver(() => apply()).observe(canvas);

// ---------------------------------------------------------------------------
// The clients, one per frame (see mode.ts)

const clients = new Map<Window, ClientHooks>();

function frameOf(win: Window) {
  return frames.find((f) => f.iframe.contentWindow === win);
}

function activeHooks() {
  const win = selected().iframe.contentWindow;
  return win ? clients.get(win) : undefined;
}

/** Show this frame's panel, and drop the selection in the one before. */
let activeWin: Window | null = null;
function activate(win: Window) {
  if (activeWin && activeWin !== win) clients.get(activeWin)?.deselect();
  activeWin = win;
  showPanels();
}

/** Only the selected frame's panel shows. */
function showPanels() {
  const win = selected()?.iframe.contentWindow;
  for (const [w, hooks] of clients) hooks.panel.style.display = w === win ? "" : "none";
}

/** The bar's View/Edit: the active client switches, which tells the board. */
function switchMode(v: boolean) {
  const hooks = activeHooks();
  if (hooks) hooks.setPicking(v);
  else api.setMode(v);
}

let history: string[] = [];
let step = -1;

const api: ShellApi = {
  get zoom() {
    return z;
  },
  register(hooks) {
    // A reloaded frame registers a fresh client; the old one belongs to a dead page.
    for (const [w, old] of clients) {
      if (w.closed || !frameOf(w)) {
        old.panel.remove();
        clients.delete(w);
      }
    }
    clients.set(hooks.win, hooks);
    root.append(hooks.panel);
    if (frameOf(hooks.win) === selected()) activate(hooks.win);
    else showPanels();
    hooks.setOpen(docked);
    hooks.setPicking(edit);
  },
  isActive(win) {
    return selected().iframe.contentWindow === win;
  },
  setDocked(v) {
    if (v === docked) return;
    docked = v;
    for (const hooks of clients.values()) hooks.setOpen(v);
    apply();
  },
  wheelZoom(x, y, deltaY) {
    const f = selected();
    zoomByWheel(deltaY, px + (f.x + x) * z, py + (f.y + y) * z);
  },
  zoomKey,
  panBy,
  space: setSpace,
  setMode(v) {
    island.classList.add("ready");
    island.classList.toggle("edit", v);
    islandView.classList.toggle("on", !v);
    islandEdit.classList.toggle("on", v);
    shellEl.classList.toggle("edit-mode", v);
    if (v === edit) return;
    edit = v;
    for (const hooks of clients.values()) hooks.setPicking(v);
    apply();
  },
  commit(changes, from) {
    const json = JSON.stringify(changes);
    if (json === history[step]) return;
    history = [...history.slice(0, step + 1), json].slice(-MAX_STEPS);
    step = history.length - 1;
    for (const [w, hooks] of clients) if (w !== from) hooks.restore(changes);
  },
  step(dir, from) {
    const to = step + dir;
    if (to < 0 || to >= history.length) return null;
    step = to;
    const list = JSON.parse(history[step]) as unknown[];
    for (const [w, hooks] of clients) if (w !== from) hooks.restore(JSON.parse(history[step]));
    return list;
  },
  resetHistory(changes) {
    // Every frame loads the same list: only a different one starts over.
    const json = JSON.stringify(changes);
    if (json === history[step]) return;
    history = [json];
    step = 0;
  },
  contentSize(win, w, hh, stacked) {
    const f = frameOf(win);
    if (!f || f.kind !== "component") return;
    f.stacked = !!stacked;
    const flip = f.el.querySelector(".flip");
    if (flip) flip.textContent = f.stacked ? "↕ Stacked" : "↔ Row";
    const nw = Math.max(80, Math.ceil(w));
    const nh = Math.max(40, Math.ceil(hh));
    if (nw === f.w && nh === f.h) return;
    f.w = nw;
    f.h = nh;
    apply();
  },
};
window.__sparkShell = api;

// The page's address follows the selected app frame (or the first): reloading
// comes back to the same route, and the tab shows the app's title.
function syncLocation() {
  const f = selectedApp() ?? frames.find((f) => f.kind === "app");
  try {
    const loc = f?.iframe.contentWindow?.location;
    if (loc && loc.href !== "about:blank" && loc.href !== location.href) history_.replaceState(history_.state, "", loc.href);
    const title = f?.iframe.contentDocument?.title;
    if (title && title !== document.title) document.title = title;
  } catch {
    // The frame navigated off-origin.
  }
}
const history_ = window.history;
setInterval(syncLocation, 500);

// Ctrl+wheel, pinches and Ctrl +/-/0 over a frame must zoom the canvas, never
// the page. The board puts its own listeners on each frame's window rather
// than leaving that to the client in it: the client only loads after the
// app's own modules, so while a frame loads, after a full reload or when the
// app throws on start there was no listener and the browser zoomed the whole
// page. A reload or navigation gives the frame a new window, so this checks
// every animation frame and re-attaches. A press in a frame also selects it.
const GUARD = "__sparkZoomGuard";
function guardFrames() {
  for (const f of frames) {
    try {
      const w = f.iframe.contentWindow as (Window & { [GUARD]?: boolean }) | null;
      if (!w || w[GUARD]) continue;
      w[GUARD] = true;
      w.addEventListener(
        "wheel",
        (e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          e.stopPropagation();
          zoomByWheel(wheelDelta(e), px + (f.x + e.clientX) * z, py + (f.y + e.clientY) * z);
        },
        { passive: false, capture: true },
      );
      w.addEventListener(
        "keydown",
        (e) => {
          const k = zoomKeyOf(e);
          if (!k) return;
          e.preventDefault();
          e.stopPropagation();
          zoomKey(k);
        },
        true,
      );
      w.addEventListener(
        "pointerdown",
        () => {
          blurChrome();
          selectFrame(f);
        },
        true,
      );
    } catch {
      // The frame navigated off-origin: nothing to guard.
    }
  }
  requestAnimationFrame(guardFrames);
}

// ---------------------------------------------------------------------------
// Start

// An old bookmark of the Components view opens the board.
if (new URL(location.href).searchParams.has("spark")) history_.replaceState(history_.state, "", appUrl());
const loaded = loadSaved();
frames = loaded.apps.map((a) => makeFrame("app", a.id, "", { x: a.x, y: a.y, w: a.w, h: a.h, preset: a.preset }));
selectedId = loaded.selected;
document.documentElement.append(host);
syncComponents(caseFiles);
window.addEventListener("spark:cases", (e) => syncComponents((e as CustomEvent<string[]>).detail));
shellEl.classList.toggle("docked", docked);
focusFrame(selected());
apply();
requestAnimationFrame(guardFrames);
