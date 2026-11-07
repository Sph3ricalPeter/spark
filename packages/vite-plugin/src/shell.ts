// The viewport shell: the top-level page while Spark is on.
//
// The app runs in an iframe ("the frame") placed on a canvas. The frame is a
// real viewport, so media queries, vw/vh and `position: fixed` all answer to
// the chosen size, not the window. The canvas zooms and pans on its own:
// - Ctrl+wheel or a pinch zooms at the pointer, Ctrl +/- steps, Ctrl 0 is 100%;
// - wheel over the empty canvas pans (Shift for sideways), middle drag or
//   Space drag pans anywhere.
// The browser's own page zoom never kicks in, so the Spark panel and this bar
// stay put. Pick a device, an aspect ratio, or type a size in the bar;
// "Fill" makes the frame follow the window like a normal page.
//
// The client in the frame mounts its panel here (see mode.ts).
import { installFont } from "./fonts.ts";
import { THEME } from "./theme.ts";
import { h } from "./fields.ts";
import type { ShellApi } from "./mode.ts";

const BAR_H = 40;
const PANEL_W = 340;
const PAD = 32;
const MIN_Z = 0.1;
const MAX_Z = 8;
const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const STORE = "spark:viewport";

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

/** "fill", a preset id, or "custom". */
let preset = "fill";
let w = 1280;
let hgt = 720;
let z = 1;
let px = 0;
let py = 0;
let docked = false;

try {
  const saved = JSON.parse(localStorage.getItem(STORE) ?? "null") as { preset: string; w: number; h: number } | null;
  if (saved && typeof saved.w === "number" && typeof saved.h === "number") {
    preset = saved.preset;
    w = saved.w;
    hgt = saved.h;
  }
} catch {
  // Storage may be off: start in Fill.
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ preset, w, h: hgt }));
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
    button.on { background: var(--sp-accent); border-color: var(--sp-accent); color: var(--sp-text-strong); }
    button:disabled { opacity: .4; cursor: default; }
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
    .stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
    iframe {
      display: block; border: 0; background: var(--sp-text-strong);
      box-shadow: 0 0 0 1px var(--sp-line), 0 12px 40px #0008;
    }
    .fill iframe { box-shadow: none; }
    .size {
      position: absolute; left: 0; top: 0; transform-origin: 0 100%;
      color: var(--sp-text-dim); font: var(--sp-fs-sm) var(--sp-mono); white-space: nowrap; pointer-events: none;
    }
    .fill .size { display: none; }
    /* Covers the frame while panning, so the drag isn't lost into the app. */
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
    /* Edit mode frames the canvas in the accent color. */
    .edit-mode .canvas::after {
      content: ""; position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 2px var(--sp-accent);
    }
    `,
  ),
);

const presetSel = h("select", { title: "Device or resolution" }) as HTMLSelectElement;
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
  if (ratioSel.value !== "") setRatio(RATIOS[Number(ratioSel.value)][1]);
});
const zoomOut = h("button", { title: "Zoom out (Ctrl −)" }, "−");
const zoomLabel = h("span", { class: "zoom", title: "Ctrl+wheel or pinch to zoom at the pointer" });
const zoomIn = h("button", { title: "Zoom in (Ctrl +)" }, "+");
const fitBtn = h("button", { title: "Zoom to fit" }, "Fit");
const oneBtn = h("button", { title: "Actual size (Ctrl 0)" }, "100%");

const islandView = h("button", { title: "Use the app normally (Tab)" }, "View");
const islandEdit = h("button", { title: "Select and edit elements (Tab)" }, "Edit");
const island = h("div", { class: "island" }, h("span", { class: "seg" }, islandView, islandEdit), h("kbd", { title: "Tab switches mode" }, "Tab"));
let toggleMode: ((edit: boolean) => void) | null = null;
islandView.addEventListener("click", () => toggleMode?.(false));
islandEdit.addEventListener("click", () => toggleMode?.(true));

const bar = h(
  "div",
  { class: "bar" },
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

const frame = document.createElement("iframe");
frame.setAttribute("data-spark-frame", "");
frame.title = "App";
const sizeLabel = h("div", { class: "size" });
const stage = h("div", { class: "stage" }, frame);
const shield = h("div", { class: "shield" });
const canvas = h("div", { class: "canvas" }, stage, sizeLabel, shield);
const shellEl = h("div", { class: "shell" }, bar, canvas);
root.append(shellEl);

// ---------------------------------------------------------------------------
// Layout

function canvasSize() {
  return { cw: canvas.clientWidth, ch: canvas.clientHeight };
}

const fill = () => preset === "fill";

function clampZ(v: number) {
  return Math.min(MAX_Z, Math.max(MIN_Z, v));
}

/** Keep at least a sliver of the frame on screen. */
function clampPan() {
  const { cw, ch } = canvasSize();
  const keep = 48;
  px = Math.min(cw - keep, Math.max(keep - w * z, px));
  py = Math.min(ch - keep, Math.max(keep - hgt * z, py));
}

function apply() {
  if (fill()) {
    const { cw, ch } = canvasSize();
    w = cw;
    hgt = ch;
    z = 1;
    px = 0;
    py = 0;
  } else clampPan();
  frame.style.width = `${w}px`;
  frame.style.height = `${hgt}px`;
  stage.style.transform = `translate(${px}px, ${py}px) scale(${z})`;
  shellEl.classList.toggle("fill", fill());
  shellEl.classList.toggle("docked", docked);
  sizeLabel.textContent = `${w} × ${hgt}`;
  sizeLabel.style.transform = `translate(${px}px, ${py - 18}px)`;
  zoomLabel.textContent = `${Math.round(z * 100)}%`;
  presetSel.value = preset;
  if (document.activeElement !== host || root.activeElement !== wIn) wIn.value = String(w);
  if (document.activeElement !== host || root.activeElement !== hIn) hIn.value = String(hgt);
  const ratio = fill() ? -1 : RATIOS.findIndex(([, r]) => Math.abs(w / hgt - r) < 0.01);
  ratioSel.value = ratio < 0 ? "" : String(ratio);
}

/** Center the frame at zoom `zz`. */
function center(zz: number) {
  const { cw, ch } = canvasSize();
  z = clampZ(zz);
  px = Math.round((cw - w * z) / 2);
  py = Math.round((ch - hgt * z) / 2);
}

function fitZoom() {
  const { cw, ch } = canvasSize();
  return Math.min((cw - PAD * 2) / w, (ch - PAD * 2) / hgt);
}

/** A new size: 100% if it fits, otherwise fit. */
function resized() {
  center(Math.min(1, fitZoom()));
  apply();
  save();
}

function setPreset(id: string) {
  const p = PRESETS.find((p) => p.id === id);
  preset = id;
  if (p && p.id !== "fill") {
    w = p.w;
    hgt = p.h;
  }
  if (fill()) apply();
  else resized();
  save();
}

function setSize(nw: number, nh: number) {
  w = Math.round(Math.min(10000, Math.max(50, nw)));
  hgt = Math.round(Math.min(10000, Math.max(50, nh)));
  preset = PRESETS.find((p) => p.w === w && p.h === hgt)?.id ?? "custom";
  resized();
}

function setRatio(r: number) {
  setSize(w, w / r);
}

/** Leave Fill for a fixed size: the current one, so nothing re-lays out. */
function freeze() {
  if (!fill()) return;
  preset = PRESETS.find((p) => p.w === w && p.h === hgt)?.id ?? "custom";
  save();
}

/** Zoom to `zz`, keeping the canvas point (cx, cy) still. */
function zoomAt(zz: number, cx: number, cy: number) {
  freeze();
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
  if (fill()) return;
  px += dx;
  py += dy;
  apply();
}

// ---------------------------------------------------------------------------
// Bar

presetSel.addEventListener("change", () => setPreset(presetSel.value));

function stepPreset(dir: 1 | -1) {
  const list = PRESETS;
  const i = list.findIndex((p) => p.id === preset);
  const next = list[(Math.max(0, i) + dir + list.length) % list.length];
  setPreset(next.id);
}
prevBtn.addEventListener("click", () => stepPreset(-1));
nextBtn.addEventListener("click", () => stepPreset(1));

function typedSize() {
  const nw = parseInt(wIn.value, 10);
  const nh = parseInt(hIn.value, 10);
  if (nw > 0 && nh > 0) setSize(nw, nh);
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
rotateBtn.addEventListener("click", () => setSize(hgt, w));
zoomOut.addEventListener("click", () => zoomStep(-1));
zoomIn.addEventListener("click", () => zoomStep(1));
fitBtn.addEventListener("click", () => {
  freeze();
  center(fitZoom());
  apply();
});
oneBtn.addEventListener("click", () => {
  freeze();
  center(1);
  apply();
});

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
  space = v && !fill();
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
    freeze();
    center(1);
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
// The client's side (see mode.ts)

const api: ShellApi = {
  get zoom() {
    return z;
  },
  mount(el) {
    // A reloaded frame mounts a fresh panel; the old one belongs to a dead page.
    for (const old of Array.from(root.querySelectorAll(`[data-spark-mount="${el.tagName}"]`))) old.remove();
    el.setAttribute("data-spark-mount", el.tagName);
    root.append(el);
  },
  setDocked(v) {
    docked = v;
    apply();
  },
  wheelZoom(x, y, deltaY) {
    // A point in the app is at (px + x·z, py + y·z) on the canvas.
    zoomByWheel(deltaY, px + x * z, py + y * z);
  },
  zoomKey,
  panBy,
  space: setSpace,
  setMode(edit, toggle) {
    toggleMode = toggle;
    island.classList.add("ready");
    island.classList.toggle("edit", edit);
    islandView.classList.toggle("on", !edit);
    islandEdit.classList.toggle("on", edit);
    shellEl.classList.toggle("edit-mode", edit);
  },
};
window.__sparkShell = api;

// The frame keeps the page's address: reloading comes back to the same
// route, and the tab shows the app's title.
function syncLocation() {
  try {
    const loc = frame.contentWindow?.location;
    if (loc && loc.href !== "about:blank" && loc.href !== location.href) history.replaceState(history.state, "", loc.href);
    const title = frame.contentDocument?.title;
    if (title && title !== document.title) document.title = title;
  } catch {
    // The frame navigated off-origin.
  }
}
setInterval(syncLocation, 500);

// Ctrl+wheel, pinches and Ctrl +/-/0 over the app must zoom the canvas, never
// the page. The shell puts its own listeners on the frame's window rather
// than leaving that to the client in the frame: the client only loads after
// the app's own modules, so while the frame loads, after a full reload (Vite
// does one when an edit can't hot-update, e.g. after Implement changes) or
// when the app throws on start, there was no listener and the browser zoomed
// the whole page. A reload or navigation gives the frame a new window, so
// this checks every animation frame and re-attaches.
const GUARD = "__sparkZoomGuard";
function guardFrame() {
  try {
    const w = frame.contentWindow as (Window & { [GUARD]?: boolean }) | null;
    if (w && !w[GUARD]) {
      w[GUARD] = true;
      w.addEventListener(
        "wheel",
        (e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          e.stopPropagation();
          api.wheelZoom(e.clientX, e.clientY, wheelDelta(e));
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
    }
  } catch {
    // The frame navigated off-origin: nothing to guard.
  }
  requestAnimationFrame(guardFrame);
}
requestAnimationFrame(guardFrame);

document.documentElement.append(host);
apply();
if (!fill()) resized();
frame.src = location.href;
