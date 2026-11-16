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
// history. Clicking in a frame selects it (its properties in the inspector,
// the panel and Ctrl 0 act on it); in view mode every frame stays usable and
// the selected one has a dashed outline. Only Fit and 100% move the camera.
//
// Around the canvas, Figma style: the title bar on top (titlebar.ts), the
// left panel with its Layers, Chats and Changes tabs (sidebar.ts), and on the
// right two columns, the selected frame's inspector and, rightmost, its chat
// with Claude (both the client's, mode.ts). The panels are always there and
// each resizes from its inner edge; they cover the canvas rather than push
// it, so resizing one crops the view and never moves what's on it. The
// floating toolbar at the bottom has View/Edit, "+ Frame", the device and
// the zoom; the selected frame's own properties (size, device, ratio, a
// component frame's layout) are in the inspector (frameProps).
//
// The canvas zooms and pans on its own: Ctrl+wheel or a pinch zooms at the
// pointer, Ctrl +/- steps, Ctrl 0 is 100% on the selected frame; wheel over
// the empty canvas pans (Shift for sideways), middle drag or Space drag pans
// anywhere. The browser's own page zoom never kicks in, so the panel and the
// bar stay put.
import { installFont } from "./fonts.ts";
import { THEME, icon } from "./theme.ts";
import { h } from "./fields.ts";
import { drag } from "./drag.ts";
import { layersTab, LAYERS_STYLE } from "./layers.ts";
import type { ClientHooks, ShellApi } from "./mode.ts";
import { blockNativeMenu, openMenu, type MenuEntry } from "./menu.ts";
import { chatsTab, CHATS_STYLE, sidebar, SIDEBAR_STYLE, SIDEBAR_W } from "./sidebar.ts";
import { componentsTab, COMPONENTS_STYLE, type BreakdownTarget, type PlanComponent } from "./components-tab.ts";
import { edgeGrip, GRIP_STYLE, MIN_CANVAS } from "./grip.ts";
import caseFiles from "/@spark/cases";
import { name as projectName } from "/@spark/project";
import { inSpark, titleBar, TITLE_BAR_STYLE } from "./titlebar.ts";
import { getState, setState } from "./state.ts";
import { ACCENTS, THEMES, TEXT_SCALE, cleanFamily, getSetting, hasSettings, onSettings, resetSettings, setSetting, type ThemeName } from "./settings.ts";
import { SAMPLE_PARAM } from "./sample.ts";

const BAR_H = 36;
/** The inspector's and the chat's default widths; dragging their left edges changes them (grip.ts). */
const PANEL_W = 300;
const CHAT_W = 340;
const PAD = 48;
const GAP = 80;
const MIN_Z = 0.05;
const MAX_Z = 8;
const STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
/** Camera moves (wheel zoom, panning) are saved once they settle. */
const CAMERA_SAVE_DELAY = 400;
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
  /**
   * A Fill frame's width as the frames beside it last saw it: set when the
   * window resizes or the frame is set to Fill, not when a panel does, so
   * resizing a panel reflows the Fill frame and moves nothing else.
   */
  anchorW?: number;
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
  /** App frames: the sample data picked for it (sample.ts); unset: the first. */
  sample?: string;
  /** App frames: the samples spark.setup has, as the frame last reported them (undefined: not loaded yet). */
  samples?: string[];
  /** App frames: the sample it runs on (null: none). */
  sampleOn?: string | null;
  /** App frames: the app's own commands it called that no sample answers. */
  missing?: string[];
};

/** `sample`: the frame's sample data, when one was picked. */
type SavedApp = { id: string; x: number; y: number; w: number; h: number; preset: string; sample?: string };
type Layout = "auto" | "row" | "column";
type Camera = { z: number; x: number; y: number };
/** The board in the project's state.json (state.ts, key "board"); fields are only ever added. */
type Saved = {
  apps: SavedApp[];
  placed: Record<string, { x: number; y: number }>;
  selected: string;
  layouts?: Record<string, Layout>;
  /** Zoom and pan: the board opens where it was left. */
  camera?: Camera;
  /** 2: the camera is from the window-wide canvas under the panels; before, the canvas started right of an open sidebar. */
  canvas?: 2;
};

let frames: Frame[] = [];
let selectedId = "app-1";
let z = 1;
let px = 0;
let py = 0;
let edit = false;
/** The frames' names and sizes as the Layers tab last saw them. */
let frameNames = "";

function loadSaved(): Saved {
  const fresh: Saved = { apps: [{ id: "app-1", x: 0, y: 0, w: 1280, h: 720, preset: "fill" }], placed: {}, selected: "app-1" };
  const saved = getState<Saved>("board");
  if (saved && Array.isArray(saved.apps) && saved.apps.length) return { ...fresh, ...saved, placed: saved.placed ?? {} };
  // Nothing saved yet: one app frame filling the window.
  return fresh;
}

/** The camera as last saved, so apply() knows when it moved. */
let savedCamera = "";
/** Saves wait for the board to be built from the saved one, so a half-built board never overwrites it. */
let started = false;

function save(delay = 0) {
  if (!started) return;
  const camera: Camera = { z, x: Math.round(px), y: Math.round(py) };
  savedCamera = JSON.stringify(camera);
  const s: Saved = {
    apps: frames.filter((f) => f.kind === "app").map(({ id, x, y, w, h, preset, sample }) => ({ id, x, y, w, h, preset, ...(sample ? { sample } : {}) })),
    placed: Object.fromEntries(frames.filter((f) => f.kind === "component" && f.placed).map((f) => [f.file, { x: f.x, y: f.y }])),
    selected: selectedId,
    layouts: Object.fromEntries(frames.filter((f) => f.layout !== "auto").map((f) => [f.file, f.layout])),
    camera,
    canvas: 2,
  };
  setState("board", s, delay);
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
      position: absolute; top: 0; left: 0; right: 0; height: ${BAR_H}px; z-index: 3;
      display: flex; align-items: center; gap: 6px; padding: 0 10px;
      background: var(--sp-bg); color: var(--sp-text); border-bottom: 1px solid var(--sp-line);
      font: var(--sp-fs-md)/1 var(--sp-font); user-select: none; overflow: hidden;
    }
    .bar .project { flex: none; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--sp-text-strong); }
    .sidebar { top: ${BAR_H}px; }
    ${LAYERS_STYLE}
    ${SIDEBAR_STYLE}
    ${COMPONENTS_STYLE}
    /* Break down: the elements a Components row stands for, outlined on the board. */
    .bd-hl { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 50; }
    .bd-hl > div { position: absolute; box-sizing: border-box; border: calc(2px / var(--z, 1)) solid var(--sp-component); background: color-mix(in srgb, var(--sp-component) 14%, transparent); border-radius: 2px; }
    ${GRIP_STYLE}
    ${TITLE_BAR_STYLE}
    /* The right columns' backgrounds, under the selected frame's inspector and chat (they mount over them, mode.ts). */
    .rcol { position: absolute; top: ${BAR_H}px; bottom: 0; z-index: 1; background: var(--sp-bg); border-left: 1px solid var(--sp-line); }
    .rcol.inspector { right: var(--sp-chat-w, ${CHAT_W}px); width: var(--sp-panel-w, ${PANEL_W}px); }
    .rcol.chat { right: 0; width: var(--sp-chat-w, ${CHAT_W}px); }
    /* The edges between the panels and the canvas, over everything (the panels mount after the shell). */
    .grip { display: block; position: fixed; top: ${BAR_H}px; z-index: 2147483647; }
    .side-grip { left: var(--sp-side-w, ${SIDEBAR_W}px); }
    .panel-grip { left: calc(100% - var(--sp-panel-w, ${PANEL_W}px) - var(--sp-chat-w, ${CHAT_W}px)); }
    .chat-grip { left: calc(100% - var(--sp-chat-w, ${CHAT_W}px)); }
    button, select, input {
      font: inherit; color: inherit; background: var(--sp-field); border: 1px solid var(--sp-line-strong);
      border-radius: var(--sp-r-sm); height: 26px; padding: 0 8px; flex: none;
    }
    button { cursor: pointer; min-width: 26px; }
    button:hover, select:hover { border-color: var(--sp-line-strong); }
    button:disabled, select:disabled, input:disabled { opacity: .4; cursor: default; }
    select { padding: 0 4px; max-width: 220px; }
    input:focus, select:focus { outline: 1px solid var(--sp-accent); border-color: var(--sp-accent); }
    .grow { flex: 1; min-width: 8px; }
    /* The toolbar: floating at the bottom middle of the canvas's visible part, Figma style. */
    .toolbar {
      position: absolute; bottom: 16px; z-index: 2; display: flex; align-items: center; gap: 4px; height: 40px; padding: 0 6px;
      left: calc(var(--sp-side-w, ${SIDEBAR_W}px) + (100% - var(--sp-side-w, ${SIDEBAR_W}px) - var(--sp-panel-w, ${PANEL_W}px) - var(--sp-chat-w, ${CHAT_W}px)) / 2);
      transform: translateX(-50%); max-width: calc(100% - var(--sp-side-w, ${SIDEBAR_W}px) - var(--sp-panel-w, ${PANEL_W}px) - var(--sp-chat-w, ${CHAT_W}px) - 24px);
      background: var(--sp-surface); border: 1px solid var(--sp-line-strong); border-radius: 12px;
      box-shadow: 0 8px 28px #0009, 0 2px 6px #0006; color: var(--sp-text);
      font: var(--sp-fs-md)/1 var(--sp-font); user-select: none; white-space: nowrap; overflow: hidden;
    }
    .toolbar button, .toolbar select { border-color: transparent; background: transparent; }
    .toolbar button:hover, .toolbar select:hover { background: var(--sp-field); border-color: transparent; }
    .toolbar .tb { display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; }
    .toolbar select { width: 150px; min-width: 0; flex: 0 1 auto; }
    .toolbar .sep { width: 1px; height: 20px; background: var(--sp-line-strong); flex: none; margin: 0 4px; }
    .bar .gear { border-color: transparent; background: transparent; color: var(--sp-text-dim); padding: 0; width: 28px; }
    .bar .gear:hover, .bar .gear.on { background: var(--sp-field); color: var(--sp-text-strong); }
    /* Settings (buildSettings): a panel under the title bar's gear, over the right columns. */
    .settings {
      position: absolute; top: ${BAR_H + 6}px; right: 8px; z-index: 2147483647; width: 340px; max-height: calc(100% - ${BAR_H + 14}px);
      display: flex; flex-direction: column; box-sizing: border-box;
      background: var(--sp-surface); border: 1px solid var(--sp-line-strong); border-radius: var(--sp-r-lg);
      box-shadow: 0 12px 40px #000b, 0 2px 6px #0006; color: var(--sp-text); font: var(--sp-fs-md)/1.3 var(--sp-font);
    }
    .settings[hidden] { display: none; }
    .settings .shead { display: flex; align-items: center; padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--sp-line); }
    .settings .title { flex: 1; font-weight: 600; font-size: var(--sp-fs-lg); color: var(--sp-text-strong); }
    .settings .x { width: 26px; padding: 0; border-color: transparent; background: transparent; color: var(--sp-text-dim); }
    .settings .x:hover { background: var(--sp-field); color: var(--sp-text-strong); }
    .settings .sbody { overflow: auto; padding: var(--sp-1) var(--sp-3) var(--sp-2); }
    .settings h3 {
      margin: var(--sp-3) 0 var(--sp-1); color: var(--sp-text-dim); font: 600 var(--sp-fs-sm)/1.2 var(--sp-font);
      text-transform: uppercase; letter-spacing: .06em;
    }
    .settings .srow { display: flex; align-items: flex-start; gap: var(--sp-2); padding: 5px 0; }
    .settings .srow .k { width: 96px; flex: none; padding-top: 5px; color: var(--sp-text-dim); }
    .settings .srow .v { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; min-height: 26px; }
    .settings .stack { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .settings select { width: 100%; max-width: none; }
    .settings input.custom { width: 100%; box-sizing: border-box; }
    .settings input.custom[hidden] { display: none; }
    .settings .slide { flex: 1; display: flex; align-items: center; gap: 8px; }
    .settings input[type="range"] { flex: 1; min-width: 0; height: 18px; margin: 0; padding: 0; border: none; background: none; outline: none; accent-color: var(--sp-accent); }
    .settings .val { width: 40px; text-align: right; font: var(--sp-fs-sm) var(--sp-mono); color: var(--sp-text-strong); }
    .settings .check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
    .settings input[type="checkbox"] { height: auto; margin: 0; accent-color: var(--sp-accent); }
    .settings .themes { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; flex: 1; }
    .settings .theme { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 6px; text-align: left; background: var(--sp-field); }
    .settings .theme .chip {
      width: 16px; height: 16px; flex: none; border-radius: var(--sp-r-sm); border: 1px solid var(--c);
      background: linear-gradient(135deg, var(--a) 50%, var(--b) 50%);
    }
    .settings .theme.on { border-color: var(--sp-accent); color: var(--sp-text-strong); }
    .settings .accents { display: flex; flex-wrap: wrap; gap: 6px; }
    .settings .swatch {
      width: 22px; height: 22px; min-width: 0; padding: 0; border-radius: 50%; background: var(--c); border: 2px solid transparent;
      box-shadow: 0 0 0 1px #0006 inset;
    }
    .settings .swatch.on { border-color: var(--sp-text-strong); }
    .settings input.swatch.any { overflow: hidden; cursor: pointer; background: conic-gradient(#ef4444, #eab308, #22c55e, #14b8a6, #4f8cff, #8b5cf6, #ec4899, #ef4444); }
    .settings input.swatch.any::-webkit-color-swatch-wrapper { padding: 0; }
    .settings input.swatch.any::-webkit-color-swatch { border: none; border-radius: 50%; opacity: 0; }
    .settings input.swatch.any.on::-webkit-color-swatch { opacity: 1; }
    .settings .sfoot { display: flex; align-items: center; gap: 8px; padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--sp-line); }
    .settings .hint { flex: 1; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
    .settings .reset { height: 24px; font-size: var(--sp-fs-sm); }
    .zoom { min-width: 52px; text-align: center; font: var(--sp-fs-sm) var(--sp-mono); color: var(--sp-text-strong); }
    .shell { position: absolute; inset: 0; }
    /* The canvas is the whole window under the bar: the panels cover its edges, so resizing them never moves it. */
    .canvas {
      position: absolute; top: ${BAR_H}px; left: 0; right: 0; bottom: 0; overflow: hidden;
      background-color: var(--spu-canvas, #0e0f11);
      background-image: radial-gradient(#ffffff14 1px, transparent 1px);
      background-size: 16px 16px;
    }
    .canvas.no-grid { background-image: none; }
    .canvas.panning, .canvas.panning * { cursor: grabbing !important; }
    .canvas.space { cursor: grab; }
    .stage { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; }
    .frame { position: absolute; left: 0; top: 0; }
    /* The selected frame is on top of any it overlaps. */
    .frame.selected { z-index: 1; }
    .frame iframe {
      display: block; border: 0; background: var(--sp-text-strong);
      box-shadow: 0 0 0 calc(1px / var(--z, 1)) var(--sp-line), 0 12px 40px #0008;
    }
    .frame.component iframe { background: transparent; }
    /* The selected frame: a faint ring, so it never reads as a selected element. */
    .edit-mode .frame.selected iframe {
      box-shadow: 0 0 0 calc(1px / var(--z, 1)) color-mix(in srgb, var(--sp-accent) 45%, transparent), 0 12px 40px #0008;
    }
    /* View mode: the selected frame (where the bar, the panel and the keys go) has a dashed outline. */
    .shell:not(.edit-mode) .frame.selected iframe {
      outline: calc(1px / var(--z, 1)) dashed color-mix(in srgb, var(--sp-accent) 60%, transparent);
      outline-offset: calc(4px / var(--z, 1));
    }
    .shell:not(.edit-mode) .frame.component.selected iframe { outline-color: color-mix(in srgb, var(--sp-component) 60%, transparent); }
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
    /* View/Edit: the toolbar's first group, so the mode is never in doubt. */
    .island { display: none; flex: none; align-items: center; gap: 6px; color: var(--sp-text-dim); }
    .island.ready { display: flex; }
    .island .seg { display: inline-flex; padding: 2px; border-radius: 9px; background: var(--sp-bg); }
    .island .seg button { border-radius: 7px; height: 26px; font-weight: 600; padding: 0 12px; }
    .island .seg button.on { background: var(--sp-text-strong); color: var(--sp-bg); }
    .island.edit .seg button.on { background: var(--sp-accent); color: var(--sp-text-strong); }
    .island kbd {
      font: var(--sp-fs-xs) var(--sp-mono); color: var(--sp-text); border: 1px solid var(--sp-line-strong);
      border-bottom-width: 2px; border-radius: var(--sp-r-sm); padding: 2px 5px;
    }
    /* Edit mode: a soft glow in from the edges of the canvas's visible part, unlike any selection outline. */
    .glow {
      position: absolute; top: ${BAR_H}px; bottom: 0; left: var(--sp-side-w, ${SIDEBAR_W}px);
      right: calc(var(--sp-panel-w, ${PANEL_W}px) + var(--sp-chat-w, ${CHAT_W}px));
      pointer-events: none; opacity: 0; transition: opacity .2s;
      box-shadow: inset 0 0 48px 0 color-mix(in srgb, var(--sp-accent) 30%, transparent),
        inset 0 0 12px 0 color-mix(in srgb, var(--sp-accent) 22%, transparent);
    }
    .edit-mode .glow { opacity: 1; }
    `,
  ),
);

/** A device dropdown: the toolbar has one, the frame's properties another. */
function presetSelect(title: string) {
  const sel = h("select", { title }) as HTMLSelectElement;
  let group: HTMLElement | null = null;
  for (const p of PRESETS) {
    const opt = h("option", { value: p.id }, p.name);
    if (!p.group) sel.append(opt);
    else {
      if (!group || group.getAttribute("label") !== p.group) {
        group = h("optgroup", { label: p.group });
        sel.append(group);
      }
      group.append(opt);
    }
  }
  sel.append(h("option", { value: "custom" }, "Custom"));
  sel.addEventListener("change", () => {
    const f = selectedApp();
    if (f) setPreset(f, sel.value);
    sel.blur();
  });
  return sel;
}
const presetSel = presetSelect("Device or resolution of the selected app frame");
const addBtn = h("button", { class: "tb", title: "Add an app frame (another size of the app, side by side)" }, icon("plus", 14), h("span", { class: "label" }, "Frame"));
const zoomOut = h("button", { title: "Zoom out (Ctrl −)" }, icon("minus", 14));
const zoomLabel = h("button", { class: "zoom", title: "The selected frame at actual size (Ctrl 0). Ctrl+wheel or pinch zooms at the pointer" });
const zoomIn = h("button", { title: "Zoom in (Ctrl +)" }, icon("plus", 14));
const fitBtn = h("button", { title: "Zoom to fit every frame (Shift 1)" }, "Fit");
const settingsBtn = h("button", { class: "gear", title: "Settings (Ctrl+,)" }, icon("settings", 14));

const islandView = h("button", { title: "Use the selected frame normally (Tab)" }, "View");
const islandEdit = h("button", { title: "Select and edit elements (Tab)" }, "Edit");
const island = h("div", { class: "island" }, h("span", { class: "seg" }, islandView, islandEdit), h("kbd", { title: "Tab switches mode" }, "Tab"));
islandView.addEventListener("click", () => switchMode(false));
islandEdit.addEventListener("click", () => switchMode(true));

// The left panel: Layers, Chats and Changes (sidebar.ts), always shown.
const side = sidebar();
// The title bar: in Spark's window titleBar adds the home button, the project's name and the window buttons.
const bar = h("div", { class: "bar" }, h("span", { class: "grow" }), settingsBtn);
const toolbar = h(
  "div",
  { class: "toolbar" },
  island,
  h("span", { class: "sep" }),
  addBtn,
  presetSel,
  h("span", { class: "sep" }),
  zoomOut,
  zoomLabel,
  zoomIn,
  fitBtn,
);

// The bars' buttons and dropdowns never keep focus: Tab and Esc are Spark's
// shortcuts, not focus moves, and the first Esc mustn't go to a dropdown.
for (const el of [bar, toolbar]) {
  el.addEventListener("click", (e) => {
    const b = (e.target as Element).closest("button");
    if (b && root.activeElement === b) b.blur();
  });
  el.addEventListener("change", (e) => {
    if (e.target instanceof HTMLSelectElement) e.target.blur();
  });
}

/** Take focus out of the bar and every panel (they're shadow roots in the shell). */
function blurChrome() {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  // Duck-typed: a panel's fields belong to its frame's window, not this one.
  if (el && el !== document.body && typeof (el as HTMLElement).blur === "function") (el as HTMLElement).blur();
}

const stage = h("div", { class: "stage" });
/** Break down: outlines of the elements a Components row stands for (highlightCovers). */
const coverLayer = h("div", { class: "bd-hl" });
stage.append(coverLayer);
const shield = h("div", { class: "shield" });
const canvas = h("div", { class: "canvas" }, stage, shield);
const shellEl = h(
  "div",
  { class: "shell" },
  canvas,
  h("div", { class: "glow" }),
  toolbar,
  side.el,
  h("div", { class: "rcol inspector" }),
  h("div", { class: "rcol chat" }),
  bar,
);
// In Spark's window the bar is the window's title bar too (titlebar.ts).
if (inSpark) {
  shellEl.append(titleBar(bar, projectName));
  shellEl.classList.add("titled");
} else bar.prepend(h("span", { class: "project", title: projectName }, projectName));
host.style.setProperty("--sp-panel-top", `${BAR_H}px`);

// The three panels resize from their inner edge (grip.ts); the canvas keeps at
// least MIN_CANVAS visible. They cover the canvas, so a resize only re-lays out
// a Fill frame, never the camera.
const sizing = (on: boolean) => {
  shellEl.classList.toggle("moving", on);
  shellEl.classList.toggle("sizing", on);
};
const rest = () => window.innerWidth - MIN_CANVAS;
const sideEdge = edgeGrip(host, { name: "sidebar", prop: "--sp-side-w", def: SIDEBAR_W, min: 200, max: 560, dir: 1 }, () => rest() - panelEdge.width() - chatEdge.width(), sizing, () => apply());
const panelEdge = edgeGrip(host, { name: "panel", prop: "--sp-panel-w", def: PANEL_W, min: 240, max: 640, dir: -1 }, () => rest() - sideEdge.width() - chatEdge.width(), sizing, () => apply());
const chatEdge = edgeGrip(host, { name: "chat", prop: "--sp-chat-w", def: CHAT_W, min: 260, max: 720, dir: -1 }, () => rest() - sideEdge.width() - panelEdge.width(), sizing, () => apply());
sideEdge.grip.classList.add("side-grip");
panelEdge.grip.classList.add("panel-grip");
chatEdge.grip.classList.add("chat-grip");
/** Fit the widths to the window and to each other (at the start, and when the window resizes). */
function fitPanels() {
  sideEdge.show();
  panelEdge.show();
  chatEdge.show();
  // The window, unlike a panel, may move the frames beside a Fill frame.
  for (const f of frames) f.anchorW = undefined;
  apply();
}
window.addEventListener("resize", fitPanels);
root.append(shellEl, panelEdge.grip, chatEdge.grip, sideEdge.grip);

// ---------------------------------------------------------------------------
// Frames

/** The page's address without Spark's own parameters: what app frames load, on their sample data if one was picked. */
function appUrl(sample?: string) {
  const url = new URL(location.href);
  url.searchParams.delete("spark");
  url.searchParams.delete("file");
  url.searchParams.delete(SAMPLE_PARAM);
  if (sample) url.searchParams.set(SAMPLE_PARAM, sample);
  return url.href;
}

/** Run an app frame on another sample: the app starts over on it. */
function setSample(f: Frame, sample: string) {
  if (f.kind !== "app" || sample === f.sampleOn) return;
  f.sample = sample;
  f.samples = undefined;
  f.missing = [];
  f.iframe.src = appUrl(sample);
  save();
  apply();
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
  // The id lets a frame's client keep its own state (its selection across reloads).
  iframe.setAttribute("data-spark-frame", id);
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
  stage.append(el);
  iframe.src = kind === "app" ? appUrl(f.sample) : componentUrl(file, f.layout);
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
  layers.refresh();
}

function removeFrame(f: Frame) {
  if (f.id === "app-1") return;
  const win = f.iframe.contentWindow;
  const hooks = win && clients.get(win);
  if (hooks) {
    hooks.panel.remove();
    hooks.changes?.remove();
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
  layers.refresh();
}

function addApp() {
  const apps = frames.filter((f) => f.kind === "app");
  const from = selectedApp() ?? apps[0];
  let n = 2;
  while (frames.some((f) => f.id === `app-${n}`)) n++;
  const right = Math.max(...apps.map((f) => f.x + f.w));
  // A Fill frame copies the window's size as a fixed one.
  const f = makeFrame("app", `app-${n}`, "", { x: right + GAP, y: apps[0].y, w: from.w, h: from.h, preset: from.preset === "fill" ? "custom" : from.preset, sample: from.sample });
  frames.splice(apps.length, 0, f);
  if (activeWin) clients.get(activeWin)?.deselect();
  activeWin = null;
  selectedId = f.id;
  save();
  apply();
  focusFrame(f);
  apply();
  layers.refresh();
}

/** The case files changed (one added or removed): frames follow. */
function syncComponents(files: string[]) {
  const want = files.length ? files : [""];
  for (const f of frames.filter((f) => f.kind === "component" && !want.includes(f.file))) {
    const win = f.iframe.contentWindow;
    if (win && clients.has(win)) {
      clients.get(win)!.panel.remove();
      clients.get(win)!.changes?.remove();
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
  layers.refresh();
}

/** Drag a frame by its title; a click on it (no drag) in edit mode selects the frame itself, to Ask Claude about it. */
function moveFrame(f: Frame, e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  selectFrame(f);
  const t = e.currentTarget as HTMLElement;
  shellEl.classList.add("moving");
  // Where the frame would be without snapping; Ctrl snaps it to the visible grid.
  const x0 = f.x;
  const y0 = f.y;
  const cx = e.clientX;
  const cy = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - cx, ev.clientY - cy) < 3) return;
    moved = true;
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
    save();
    apply();
    // A click (no drag) selects the frame itself, to Ask Claude about all of it: from View mode too, which it leaves.
    const hooks = moved ? undefined : clients.get(f.iframe.contentWindow!);
    if (hooks?.selectFrame) {
      if (!edit) switchMode(true);
      hooks.selectFrame();
    }
  };
  drag(t, e, move, up);
}

// ---------------------------------------------------------------------------
// Layout

/** The canvas's visible part, between the panels: its left edge (`cl`) and size, in canvas pixels. */
function canvasSize() {
  const cl = sideEdge.width();
  return { cl, cw: Math.max(1, canvas.clientWidth - cl - panelEdge.width() - chatEdge.width()), ch: canvas.clientHeight };
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
  const left = Math.max(...apps.map((f) => f.x + (f.preset === "fill" ? (f.anchorW ??= f.w) : f.w))) + GAP;
  let y = Math.min(...apps.map((f) => f.y));
  const fixed = frames.filter((f) => f.kind === "app" || f.placed);
  for (const f of frames) {
    if (f.kind !== "component" || f.placed) continue;
    f.x = left;
    f.y = y;
    // Below any frame that was put in the way.
    for (let hit = overlapping(f, fixed); hit; hit = overlapping(f, fixed)) f.y = hit.y + hit.h + ROW_GAP;
    y = f.y + f.h + ROW_GAP;
  }
}

/** Room between stacked frames, for the title above each. */
const ROW_GAP = GAP / 2;

/** A frame in `among` that `f` overlaps (with room for its title), if any. */
function overlapping(f: Frame, among: Frame[]) {
  return among.find((o) => o !== f && f.x < o.x + o.w && o.x < f.x + f.w && f.y < o.y + o.h + ROW_GAP && o.y < f.y + f.h + ROW_GAP);
}

/**
 * A frame grew (its cases restacked, a case was renamed or added): the
 * frames it now runs into below it move down, and the ones those run into.
 */
function pushBelow(f: Frame) {
  const queue = [f];
  for (let a = queue.shift(); a; a = queue.shift()) {
    for (const b of frames) {
      if (b === a || (b.kind === "component" && !b.placed) || b.y < a.y) continue;
      if (b.x < a.x + a.w && a.x < b.x + b.w && b.y < a.y + a.h + ROW_GAP) {
        b.y = a.y + a.h + ROW_GAP;
        queue.push(b);
      }
    }
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
  applyCamera();
  for (const f of frames) {
    f.el.style.transform = `translate(${f.x}px, ${f.y}px)`;
    f.iframe.style.width = `${f.w}px`;
    f.iframe.style.height = `${f.h}px`;
    f.el.classList.toggle("selected", f === sel);
    if (f.kind === "app") {
      const apps = frames.filter((x) => x.kind === "app");
      f.name.textContent = apps.length > 1 ? `App ${apps.indexOf(f) + 1}` : "App";
      f.meta.textContent = `${f.preset === "fill" ? `Fill · ${f.w} × ${f.h}` : `${f.w} × ${f.h}`}${f.sampleOn ? ` · ${f.sampleOn}` : ""}`;
    } else f.name.textContent = fileTitle(f.file);
  }
  // The Layers tab names the frames and their sizes: redraw it when they change.
  const names = frames.map((f) => `${f.id}:${f.name.textContent}:${f.meta.textContent}`).join("|");
  if (names !== frameNames) {
    frameNames = names;
    layers.refresh();
  }
  showPanels();
  const app = selectedApp();
  presetSel.disabled = !app;
  presetSel.value = app?.preset ?? "custom";
  props.update(sel);
}

/**
 * Only the camera moved (zooming, panning): nothing about the frames
 * changes, so this skips the rest of apply() and is cheap enough to run
 * every animation frame.
 */
function applyCamera() {
  canvas.classList.toggle("no-grid", getSetting("grid") === false);
  stage.style.transform = `translate(${px}px, ${py}px) scale(${z})`;
  // The dot grid is on the board, so it pans and zooms with the frames.
  const g = gridStep() * z;
  canvas.style.backgroundSize = `${g}px ${g}px`;
  canvas.style.backgroundPosition = `${px - g / 2}px ${py - g / 2}px`;
  stage.style.setProperty("--z", String(z));
  zoomLabel.textContent = `${Math.round(z * 100)}%`;
  if (started && JSON.stringify({ z, x: Math.round(px), y: Math.round(py) }) !== savedCamera) save(CAMERA_SAVE_DELAY);
}

/** Center the box (world coordinates) at zoom `zz`. */
function centerOn(x: number, y: number, w: number, hh: number, zz: number) {
  const { cl, cw, ch } = canvasSize();
  stopZoom();
  z = clampZ(zz);
  px = Math.round(cl + (cw - w * z) / 2 - x * z);
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
    stopZoom();
    z = 1;
    px = canvasSize().cl - f.x;
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
  f.anchorW = undefined;
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

// ---------------------------------------------------------------------------
// Zooming
//
// Exact under the pointer: every change scales about the canvas point under
// it (zoomAt), so the spot of the board there never moves, however the
// changes are split up. Two kinds of input:
// - A pinch (and any fine-grained Ctrl+wheel) follows the fingers 1:1:
//   Chromium sends a touchpad pinch as Ctrl+wheel with deltaY =
//   -100·ln(scale). Its deltas are summed and applied once per animation
//   frame, no easing, so it never lags behind.
// - A mouse wheel's notches and Ctrl +/- glide to their zoom instead of
//   jumping: each frame closes a fixed share of the gap (in log space, so in
//   and out feel alike), most of it within ~100 ms. A notch mid-glide adds
//   to where the glide is going, so a fast spin loses nothing and always
//   lands on the same zoom as the sum of its notches.
// How far each one zooms is a setting, the same in every project (the
// title bar's gear, settingsPopover): a multiplier for the wheel and one for
// the pinch.

/** A notch's zoom per wheel pixel: a 100 px notch is ×1.28. */
const NOTCH_RATE = 0.0025;
/** The zoom speed multipliers' range: 1/4x to 4x, in powers of two on the sliders. */
const SPEED_MIN = 0.25;
const SPEED_MAX = 4;

function zoomSpeed(kind: "wheel" | "pinch") {
  const v = getSetting("zoom-speed")?.[kind];
  return typeof v === "number" && Number.isFinite(v) ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, v)) : 1;
}

/** The glide's time constant in ms: 63% of the way after it, 95% after three. */
const GLIDE_MS = 30;

/** Where a glide is going (0: not gliding). */
let glideTo = 0;
/** The canvas point the zoom is anchored at. */
let anchorX = 0;
let anchorY = 0;
/** Pinch deltas waiting for the next animation frame. */
let pinch = 0;
let zoomFrame = 0;
let lastTick = 0;

/** Zoom to `zz`, keeping the canvas point (cx, cy) still. */
function zoomAt(zz: number, cx: number, cy: number) {
  const nz = clampZ(zz);
  px = cx - ((cx - px) * nz) / z;
  py = cy - ((cy - py) * nz) / z;
  z = nz;
  applyCamera();
}

function zoomTick(now: number) {
  zoomFrame = 0;
  if (pinch) {
    const d = pinch;
    pinch = 0;
    zoomAt(z * Math.exp(-d / 100), anchorX, anchorY);
    return;
  }
  if (!glideTo) return;
  const dt = lastTick ? Math.min(64, Math.max(1, now - lastTick)) : 16;
  lastTick = now;
  const to = Math.log(glideTo);
  const at = Math.log(z) + (to - Math.log(z)) * (1 - Math.exp(-dt / GLIDE_MS));
  // Smooth zoom off (Settings): straight there.
  const done = getSetting("zoom-glide") === false || Math.abs(to - at) < 0.001;
  zoomAt(done ? glideTo : Math.exp(at), anchorX, anchorY);
  if (done) glideTo = 0;
  else zoomFrame = requestAnimationFrame(zoomTick);
}

function scheduleZoom() {
  if (!zoomFrame) zoomFrame = requestAnimationFrame(zoomTick);
}

/** Glide to `factor` × where the zoom is going, anchored at the canvas point (cx, cy). */
function glideBy(factor: number, cx: number, cy: number) {
  pinch = 0;
  if (!glideTo) lastTick = 0;
  glideTo = clampZ((glideTo || z) * factor);
  anchorX = cx;
  anchorY = cy;
  scheduleZoom();
}

/** A camera jump (fit, focus a frame) wins over a zoom still under way. */
function stopZoom() {
  glideTo = 0;
  pinch = 0;
  if (zoomFrame) cancelAnimationFrame(zoomFrame);
  zoomFrame = 0;
}

function zoomStep(dir: 1 | -1) {
  const { cl, cw, ch } = canvasSize();
  const from = glideTo || z;
  const next = dir > 0 ? STEPS.find((s) => s > from + 0.001) : [...STEPS].reverse().find((s) => s < from - 0.001);
  if (next) glideBy(next / from, cl + cw / 2, ch / 2);
}

function wheelDelta(e: WheelEvent) {
  return e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
}

/** Ctrl+wheel or a pinch at the canvas point (cx, cy). */
function zoomByWheel(e: { deltaY: number; deltaMode: number }, cx: number, cy: number) {
  // Lines and pages (Firefox's wheel): three lines are one 100 px notch.
  const d = e.deltaMode === 1 ? (e.deltaY * 100) / 3 : e.deltaMode === 2 ? e.deltaY * 300 : e.deltaY;
  if (!d) return;
  // A mouse wheel moves in whole notches of 100 px (fewer with fewer lines
  // per notch in Windows' settings, more with display scaling); a pinch's
  // deltas are small and fractional.
  const notch = e.deltaMode !== 0 || Math.abs(d) >= 60 || (Number.isInteger(d) && Math.abs(d) >= 20);
  if (notch) glideBy(Math.exp(-Math.max(-300, Math.min(300, d)) * NOTCH_RATE * zoomSpeed("wheel")), cx, cy);
  else {
    // A pinch takes over from a glide where it is.
    glideTo = 0;
    pinch += d * zoomSpeed("pinch");
    anchorX = cx;
    anchorY = cy;
    scheduleZoom();
  }
}

function panBy(dx: number, dy: number) {
  px += dx;
  py += dy;
  applyCamera();
}

// ---------------------------------------------------------------------------
// Settings: a panel under the title bar's gear (or Ctrl+,). Spark's own
// settings, the same in every project (settings.ts): looks (theme, accent,
// fonts, text size) and the canvas (zoom speeds, glide, grid). Every change
// shows at once, and the panel leaves the canvas usable, so a zoom speed can
// be tried while it's set; Esc, the gear or a press on the board closes it.

const UI_FONTS: [string, string][] = [
  ["", "Inter (Spark's own)"],
  ["system", "System (Segoe UI)"],
  ["Segoe UI Variable Text", "Segoe UI Variable"],
  ["Calibri", "Calibri"],
  ["Verdana", "Verdana"],
];
const MONO_FONTS: [string, string][] = [
  ["", "System (Consolas)"],
  ["Cascadia Mono", "Cascadia Mono"],
  ["Cascadia Code", "Cascadia Code"],
  ["JetBrains Mono", "JetBrains Mono"],
  ["Fira Code", "Fira Code"],
];

const settingsPanel = buildSettings();
root.append(settingsPanel.el);

function buildSettings() {
  const el = h("div", { class: "settings", hidden: "", role: "dialog", "aria-label": "Settings" });
  const draws: (() => void)[] = [];
  const row = (label: string, title: string, ...control: (HTMLElement | string)[]) =>
    h("div", { class: "srow", title }, h("span", { class: "k" }, label), h("div", { class: "v" }, ...control));
  /** Spark's fields never keep focus once used: Tab, Space and Esc are Spark's. */
  const letGo = (input: HTMLElement) => input.addEventListener("change", () => input.blur());

  // A dropdown of choices plus "Custom…" with a field for any installed family.
  function fontPicker(key: "font" | "mono-font", choices: [string, string][]) {
    const sel = h("select", {}) as HTMLSelectElement;
    for (const [v, n] of choices) sel.append(h("option", { value: v }, n));
    sel.append(h("option", { value: "custom" }, "Custom…"));
    const custom = h("input", { class: "custom", placeholder: "Font family installed on this PC", spellcheck: "false" }) as HTMLInputElement;
    sel.addEventListener("change", () => {
      sel.blur();
      if (sel.value === "custom") {
        custom.hidden = false;
        custom.focus();
        if (custom.value.trim()) setSetting(key, custom.value.trim());
      } else setSetting(key, sel.value || undefined);
    });
    custom.addEventListener("input", () => setSetting(key, cleanFamily(custom.value) || undefined, 300));
    custom.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" || e.key === "Escape") custom.blur();
    });
    draws.push(() => {
      const v = getSetting(key) ?? "";
      const known = choices.some(([c]) => c === v);
      if (root.activeElement !== sel) sel.value = known ? v : "custom";
      custom.hidden = known && sel.value !== "custom";
      if (!known && root.activeElement !== custom) custom.value = v;
    });
    return h("div", { class: "stack" }, sel, custom);
  }

  // A slider with its value: `toInput`/`fromInput` map the setting to the slider's scale.
  function slider(opts: { min: number; max: number; step: number; get(): number; set(v: number): void; toInput(v: number): number; fromInput(n: number): number; show(v: number): string }) {
    const input = h("input", { type: "range", min: String(opts.min), max: String(opts.max), step: String(opts.step) }) as HTMLInputElement;
    const val = h("span", { class: "val" });
    input.addEventListener("input", () => {
      opts.set(opts.fromInput(Number(input.value)));
      val.textContent = opts.show(opts.get());
    });
    // Double-click puts it back to the default.
    input.addEventListener("dblclick", () => {
      opts.set(1);
      draw();
    });
    letGo(input);
    draws.push(() => {
      if (root.activeElement !== input) input.value = String(opts.toInput(opts.get()));
      val.textContent = opts.show(opts.get());
    });
    return h("div", { class: "slide" }, input, val);
  }

  function toggle(key: "zoom-glide" | "grid") {
    const box = h("input", { type: "checkbox" }) as HTMLInputElement;
    box.addEventListener("change", () => {
      setSetting(key, box.checked ? undefined : false);
      box.blur();
    });
    draws.push(() => (box.checked = getSetting(key) !== false));
    return box;
  }

  // Theme: a swatch per theme, showing its surface and canvas.
  const themes = h("div", { class: "themes" });
  for (const [id, t] of Object.entries(THEMES) as [ThemeName, (typeof THEMES)[ThemeName]][]) {
    const b = h(
      "button",
      { class: "theme", title: t.name, style: `--a: ${t.colors.canvas}; --b: ${t.colors.surface}; --c: ${t.colors["line-strong"]}` },
      h("span", { class: "chip" }),
      t.name,
    );
    b.addEventListener("click", () => {
      setSetting("theme", id === "dark" ? undefined : id);
      b.blur();
    });
    draws.push(() => b.classList.toggle("on", (getSetting("theme") ?? "dark") === id));
    themes.append(b);
  }

  // Accent: swatches and any color.
  const accents = h("div", { class: "accents" });
  for (const [name, color] of ACCENTS) {
    const b = h("button", { class: "swatch", title: name, style: `--c: ${color}` });
    b.addEventListener("click", () => {
      setSetting("accent", color === ACCENTS[0][1] ? undefined : color);
      b.blur();
    });
    draws.push(() => b.classList.toggle("on", (getSetting("accent") ?? ACCENTS[0][1]).toLowerCase() === color));
    accents.append(b);
  }
  const anyColor = h("input", { type: "color", class: "swatch any", title: "Any color" }) as HTMLInputElement;
  anyColor.addEventListener("input", () => setSetting("accent", anyColor.value, 300));
  letGo(anyColor);
  draws.push(() => {
    const a = getSetting("accent") ?? ACCENTS[0][1];
    if (root.activeElement !== anyColor) anyColor.value = a;
    anyColor.classList.toggle("on", !ACCENTS.some(([, c]) => c === a.toLowerCase()));
  });
  accents.append(anyColor);

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const times = (v: number) => `${v >= 1 ? v.toFixed(1) : v.toFixed(2)}×`;
  const speed = (kind: "wheel" | "pinch") =>
    slider({
      min: -2,
      max: 2,
      step: 0.1,
      get: () => zoomSpeed(kind),
      set: (v) => setSetting("zoom-speed", { ...getSetting("zoom-speed"), [kind]: Math.abs(v - 1) < 0.01 ? undefined : v }, 300),
      toInput: (v) => Math.round(Math.log2(v) * 10) / 10,
      fromInput: (n) => 2 ** n,
      show: times,
    });

  const close = h("button", { class: "x", title: "Close (Esc)" }, icon("x", 14));
  close.addEventListener("click", () => api.close());
  const reset = h("button", { class: "reset", title: "Every setting back to its default" }, "Reset all");
  reset.addEventListener("click", () => {
    resetSettings();
    reset.blur();
  });

  el.append(
    h("div", { class: "shead" }, h("span", { class: "title" }, "Settings"), close),
    h(
      "div",
      { class: "sbody" },
      h("h3", {}, "Appearance"),
      row("Theme", "Spark's colors", themes),
      row("Accent", "Buttons, focus and the selected frame", accents),
      row("Font", "Spark's text (not your app's)", fontPicker("font", UI_FONTS)),
      row("Code font", "Values, code and the zoom level", fontPicker("mono-font", MONO_FONTS)),
      row(
        "Text size",
        "Every size of Spark's text, together. Double-click: 100%",
        slider({
          min: TEXT_SCALE.min,
          max: TEXT_SCALE.max,
          step: 0.05,
          get: () => {
            const v = getSetting("text-scale");
            return typeof v === "number" && Number.isFinite(v) ? v : 1;
          },
          set: (v) => setSetting("text-scale", Math.abs(v - 1) < 0.01 ? undefined : v, 300),
          toInput: (v) => v,
          fromInput: (n) => n,
          show: pct,
        }),
      ),
      h("h3", {}, "Canvas"),
      row("Wheel zoom", "How far one notch of a mouse wheel zooms (Ctrl+wheel). Double-click: 1×", speed("wheel")),
      row("Pinch zoom", "How far a touchpad pinch zooms; at 1× the board follows your fingers. Double-click: 1×", speed("pinch")),
      row("Smooth zoom", "Wheel notches and Ctrl +/− glide to their zoom instead of jumping", h("label", { class: "check" }, toggle("zoom-glide"), "Glide")),
      row("Dot grid", "The dots on the canvas", h("label", { class: "check" }, toggle("grid"), "Show")),
    ),
    h("div", { class: "sfoot" }, h("span", { class: "hint" }, "Saved for every project"), reset),
  );

  function draw() {
    for (const d of draws) d();
    reset.toggleAttribute("disabled", !hasSettings());
  }
  // Another page (or Reset all) changed them.
  onSettings(() => {
    if (!el.hidden) draw();
    apply();
  });

  const api = {
    el,
    get open() {
      return !el.hidden;
    },
    show() {
      draw();
      // Last in the shell, so over the panels and their edges, whatever mounted since.
      root.append(el);
      el.hidden = false;
      settingsBtn.classList.add("on");
    },
    close() {
      el.hidden = true;
      settingsBtn.classList.remove("on");
    },
    toggle() {
      if (api.open) api.close();
      else api.show();
    },
  };
  return api;
}

/** Ctrl+, opens Settings, like most apps. */
function isSettingsKey(e: KeyboardEvent) {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "," || e.code === "Comma");
}

settingsBtn.addEventListener("click", () => settingsPanel.toggle());
// A press on the board closes it (in a frame too: guardFrames); the bar and the other panels don't.
canvas.addEventListener("pointerdown", () => settingsPanel.close(), true);
window.addEventListener(
  "keydown",
  (e) => {
    if (isSettingsKey(e)) {
      e.preventDefault();
      settingsPanel.toggle();
    } else if (e.key === "Escape" && settingsPanel.open) {
      e.preventDefault();
      e.stopPropagation();
      settingsPanel.close();
    }
  },
  true,
);

// ---------------------------------------------------------------------------
// Bar

addBtn.addEventListener("click", addApp);
zoomOut.addEventListener("click", () => zoomStep(-1));
zoomIn.addEventListener("click", () => zoomStep(1));
fitBtn.addEventListener("click", fitAll);
zoomLabel.addEventListener("click", () => zoomKey("reset"));

// ---------------------------------------------------------------------------
// The selected frame's properties, in its inspector (frameProps): an app
// frame's device, size and ratio; a component frame's file and layout.
// Their own element and shadow root, so the client can mount it as is.

/** Claude is writing sample data (the Data row's button): pressed once until the run ends. */
let samplesWriting = false;
const props = frameProperties();

function frameProperties() {
  const el = document.createElement("spark-frame-props");
  el.style.cssText = "display: block;";
  const r = el.attachShadow({ mode: "open" });
  const row = (k: string, ...v: (HTMLElement | string)[]) => h("div", { class: "row" }, h("span", { class: "k" }, k), h("div", { class: "v" }, ...v));
  const name = h("span", { class: "nm" });
  const meta = h("span", { class: "meta" });
  const kindIcon = h("span", { class: "ic" });
  const device = presetSelect("Device or resolution of this frame");
  const wIn = h("input", { title: "Width (px); arrow keys step, Shift by 10", inputmode: "numeric" }) as HTMLInputElement;
  const hIn = h("input", { title: "Height (px); arrow keys step, Shift by 10", inputmode: "numeric" }) as HTMLInputElement;
  const rotate = h("button", { class: "ib", title: "Swap width and height" }, icon("rotate-ccw", 13));
  const ratio = h("select", { title: "Aspect ratio: keeps the width" }) as HTMLSelectElement;
  ratio.append(h("option", { value: "" }, "Free"));
  for (const [i, [n]] of RATIOS.entries()) ratio.append(h("option", { value: String(i) }, n));
  const remove = h("button", { class: "danger", title: "Remove this app frame from the board" }, "Remove frame");
  // Sample data (sample.ts): the mock backend this frame's app runs on.
  const sampleSel = h("select", { title: "The sample data this frame's app runs on (spark.setup.tsx samples). Picking one starts the app over on it." }) as HTMLSelectElement;
  const sampleNone = h("span", { class: "hint" });
  const missingEl = h("div", { class: "missing" });
  const writeSamples = h("button", { class: "write", title: "Claude writes a mock backend for the app in spark.setup.tsx (a chat in Chats)" });
  const file = h("span", { class: "file" });
  const layoutSel = h("select", { title: "Cases in a row or stacked in a column" }) as HTMLSelectElement;
  for (const [v, n] of [["auto", "Auto"], ["row", "Row"], ["column", "Stacked"]]) layoutSel.append(h("option", { value: v }, n));
  const app = h(
    "div",
    {},
    row("Device", device),
    row("Size", h("label", { class: "dim" }, h("i", {}, "W"), wIn), h("label", { class: "dim" }, h("i", {}, "H"), hIn), rotate),
    row("Ratio", ratio),
    row("Data", sampleSel, sampleNone),
    missingEl,
    h("div", { class: "actions" }, writeSamples),
    h("div", { class: "actions" }, remove),
  );
  const comp = h("div", {}, row("File", file), row("Cases", layoutSel), row("Size", meta.cloneNode() as HTMLElement));
  const compSize = comp.querySelector(".meta") as HTMLElement;
  r.append(
    h(
      "style",
      {},
      `${THEME}
      :host { all: initial; display: block; }
      * { box-sizing: border-box; }
      .fp { margin: 0 0 var(--sp-3); padding: var(--sp-2) var(--sp-2) var(--sp-1); border-radius: var(--sp-r-md); background: var(--sp-surface); color: var(--sp-text); font: var(--sp-fs-md)/1.45 var(--sp-font); }
      .head { display: flex; align-items: center; gap: 6px; margin-bottom: var(--sp-2); color: var(--sp-text-dim); font: 600 var(--sp-fs-sm)/1.2 var(--sp-font); text-transform: uppercase; letter-spacing: .06em; }
      .head .ic { display: inline-flex; color: var(--sp-accent); }
      .fp.component .head .ic { color: var(--sp-component); }
      .head .nm { color: var(--sp-text-strong); text-transform: none; letter-spacing: 0; font-size: var(--sp-fs-md); }
      .head .meta { margin-left: auto; font: var(--sp-fs-xs) var(--sp-mono); text-transform: none; letter-spacing: 0; }
      .row { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
      .row .k { width: 64px; flex: none; color: var(--sp-text-dim); }
      .row .v { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; }
      button, select, input {
        font: inherit; color: inherit; background: var(--sp-field); border: 1px solid var(--sp-line-strong);
        border-radius: var(--sp-r-sm); height: 24px; padding: 0 6px;
      }
      button { cursor: pointer; }
      select { flex: 1; min-width: 0; }
      input:focus, select:focus { outline: 1px solid var(--sp-accent); border-color: var(--sp-accent); }
      .dim { flex: 1; min-width: 0; display: flex; align-items: center; height: 24px; background: var(--sp-field); border: 1px solid var(--sp-line-strong); border-radius: var(--sp-r-sm); }
      .dim:focus-within { border-color: var(--sp-accent); }
      .dim i { padding: 0 2px 0 7px; font: var(--sp-fs-xs) var(--sp-mono); font-style: normal; color: var(--sp-text-dim); }
      .dim input { flex: 1; min-width: 0; width: 100%; border: none; background: none; font: var(--sp-fs-sm) var(--sp-mono); outline: none; }
      .ib { width: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center; flex: none; color: var(--sp-text-dim); }
      .ib:hover { color: var(--sp-text-strong); }
      .file { font: var(--sp-fs-sm) var(--sp-mono); color: var(--sp-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .meta { font: var(--sp-fs-sm) var(--sp-mono); color: var(--sp-text); }
      .actions { display: flex; justify-content: flex-end; padding: 4px 0 2px; }
      .actions:empty { display: none; }
      button.danger { background: transparent; border-color: transparent; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
      button.danger:hover { color: var(--sp-danger); border-color: var(--sp-line-strong); }
      .hint { color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
      .missing { padding: 2px 0 2px 72px; color: var(--sp-warn); font-size: var(--sp-fs-sm); overflow-wrap: anywhere; }
      .missing:empty { display: none; }
      .missing code { font: var(--sp-fs-xs) var(--sp-mono); }
      button.write { height: auto; min-height: 24px; padding: 3px 8px; font-size: var(--sp-fs-sm); color: var(--sp-text-strong); }
      button.write:disabled { cursor: default; color: var(--sp-text-dim); }
      `,
    ),
    h("div", { class: "fp" }, h("div", { class: "head" }, kindIcon, name, meta), app, comp),
  );
  // Buttons and dropdowns never keep focus (Tab and Esc are Spark's).
  r.addEventListener("click", (e) => {
    const b = (e.composedPath()[0] as Element).closest?.("button");
    if (b && r.activeElement === b) b.blur();
  });
  let shown: Frame | null = null;
  function typed() {
    const nw = parseInt(wIn.value, 10);
    const nh = parseInt(hIn.value, 10);
    if (shown?.kind === "app" && nw > 0 && nh > 0) setSize(shown, nw, nh);
    else apply();
  }
  for (const input of [wIn, hIn]) {
    input.addEventListener("change", typed);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" || e.key === "Escape") input.blur();
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const d = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
        input.value = String((parseInt(input.value, 10) || 0) + d);
        typed();
      }
    });
  }
  rotate.addEventListener("click", () => shown?.kind === "app" && setSize(shown, shown.h, shown.w));
  ratio.addEventListener("change", () => {
    if (shown?.kind === "app" && ratio.value !== "") setSize(shown, shown.w, shown.w / RATIOS[Number(ratio.value)][1]);
    ratio.blur();
  });
  remove.addEventListener("click", () => shown && removeFrame(shown));
  sampleSel.addEventListener("change", () => {
    if (shown?.kind === "app" && sampleSel.value) setSample(shown, sampleSel.value);
    sampleSel.blur();
  });
  writeSamples.addEventListener("click", () => {
    if (samplesWriting) return;
    samplesWriting = true;
    import.meta.hot?.send("spark:samples-generate", { missing: shown?.missing ?? [] });
    if (shown) this_.update(shown);
  });
  layoutSel.addEventListener("change", () => {
    if (shown?.kind === "component") setLayout(shown, layoutSel.value as Layout);
    layoutSel.blur();
  });
  const this_ = {
    el,
    /** Show the selected frame's values (every apply: cheap, it only sets what changed). */
    update(f: Frame) {
      shown = f;
      if (!el.isConnected) return;
      const isApp = f.kind === "app";
      r.querySelector(".fp")!.className = `fp ${f.kind}`;
      app.style.display = isApp ? "" : "none";
      comp.style.display = isApp ? "none" : "";
      const iconName = isApp ? "app-window" : "component";
      if (kindIcon.dataset.icon !== iconName) {
        kindIcon.dataset.icon = iconName;
        kindIcon.replaceChildren(icon(iconName, 13));
      }
      name.textContent = f.name.textContent || fileTitle(f.file);
      meta.textContent = isApp ? (f.preset === "fill" ? "Fills the canvas" : "") : "";
      if (isApp) {
        device.value = f.preset;
        if (r.activeElement !== wIn) wIn.value = String(f.w);
        if (r.activeElement !== hIn) hIn.value = String(f.h);
        const ri = f.preset === "fill" ? -1 : RATIOS.findIndex(([, x]) => Math.abs(f.w / f.h - x) < 0.01);
        ratio.value = ri < 0 ? "" : String(ri);
        ratio.disabled = rotate.toggleAttribute("disabled", f.preset === "fill");
        remove.style.display = f.id === "app-1" ? "none" : "";
        const names = f.samples ?? [];
        const key = names.join("\n");
        if (sampleSel.dataset.names !== key) {
          sampleSel.dataset.names = key;
          sampleSel.replaceChildren(...names.map((n) => h("option", { value: n }, n)));
        }
        sampleSel.style.display = names.length ? "" : "none";
        if (r.activeElement !== sampleSel) sampleSel.value = f.sampleOn ?? "";
        sampleNone.style.display = names.length ? "none" : "";
        sampleNone.textContent = f.samples ? "None: the app's own backend calls get no answer" : "Loading…";
        const missing = f.missing ?? [];
        missingEl.replaceChildren(...(missing.length ? ["No answer for ", ...missing.flatMap((m, i) => [...(i ? [", "] : []), h("code", {}, m)])] : []));
        const wanted = !!f.samples && (!names.length || missing.length > 0);
        writeSamples.parentElement!.style.display = wanted || samplesWriting ? "" : "none";
        writeSamples.toggleAttribute("disabled", samplesWriting);
        writeSamples.textContent = samplesWriting ? "Claude is writing sample data…" : names.length ? "Answer them with Claude" : "Write sample data with Claude";
      } else {
        file.textContent = f.file.replace(/^\//, "") || "No case files yet";
        file.title = file.textContent;
        layoutSel.value = f.layout;
        compSize.textContent = `${f.w} × ${f.h}`;
      }
    },
  };
  return this_;
}

// ---------------------------------------------------------------------------
// Zoom and pan input on the canvas

canvas.addEventListener(
  "wheel",
  (e) => {
    const we = e as WheelEvent;
    we.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (we.ctrlKey || we.metaKey) zoomByWheel(we, we.clientX - r.left, we.clientY - r.top);
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
  canvas.classList.add("panning");
  // clientX, not screenX: with Windows display scaling screenX can be in
  // device pixels, which overshoots.
  let x = e.clientX;
  let y = e.clientY;
  drag(
    canvas,
    e,
    (ev) => {
      panBy(ev.clientX - x, ev.clientY - y);
      x = ev.clientX;
      y = ev.clientY;
    },
    () => canvas.classList.remove("panning"),
  );
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
  // Not instanceof: the panels' and the Ask popup's fields are made by the
  // frame's client, so they're another window's HTMLElement.
  const t = e.composedPath()[0] as HTMLElement | undefined;
  return !!t && typeof t.tagName === "string" && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

/** Ctrl +, Ctrl -, Ctrl 0, anywhere outside the app. */
function zoomKeyOf(e: KeyboardEvent): "in" | "out" | "reset" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  // By key and by physical key, with or without Shift (Ctrl+Shift+- zooms the page too).
  if (e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd") return "in";
  if (e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract") return "out";
  if (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0") return "reset";
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
// Capture phase, so nothing in the shell that stops the event can let it through.
window.addEventListener("wheel", (e) => (e.ctrlKey || e.metaKey) && e.preventDefault(), { passive: false, capture: true });
// Safari's pinch comes as gesture events, not Ctrl+wheel.
for (const t of ["gesturestart", "gesturechange", "gestureend"]) window.addEventListener(t, (e) => e.preventDefault(), { passive: false, capture: true });

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
/** The frame with an element selected, if any (one at a time). */
let selWin: Window | null = null;
function activate(win: Window) {
  if (activeWin && activeWin !== win) clients.get(activeWin)?.deselect();
  activeWin = win;
  showPanels();
  // Its inspector takes the frame's properties (frameProps).
  clients.get(win)?.refresh?.();
}

/** Only the selected frame's panel shows. */
function showPanels() {
  const win = selected()?.iframe.contentWindow;
  for (const [w, hooks] of clients) {
    hooks.panel.style.display = w === win ? "" : "none";
    if (hooks.changes) hooks.changes.style.display = w === win ? "" : "none";
  }
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
        old.changes?.remove();
        clients.delete(w);
      }
    }
    clients.set(hooks.win, hooks);
    root.insertBefore(hooks.panel, panelEdge.grip);
    if (hooks.changes) changesTab.append(hooks.changes);
    if (frameOf(hooks.win) === selected()) activate(hooks.win);
    else showPanels();
    hooks.setOpen(true);
    hooks.setPicking(edit);
    // Its tree in the Layers tab.
    layers.refresh();
  },
  frameTitle(win) {
    return frameOf(win)?.name.textContent ?? "";
  },
  setChangeCount(n) {
    side.setCount("Changes", n);
  },
  isActive(win) {
    return selected().iframe.contentWindow === win;
  },
  setSelected(win, has, el) {
    if (has) selWin = win;
    else if (selWin === win) selWin = null;
    layers.selected(win, clients.get(win), has ? (el ?? null) : null);
  },
  setHovered(win, el) {
    // One hover on the board: the others drop theirs.
    if (el) for (const [w, hooks] of clients) if (w !== win) hooks.unhover?.();
    layers.hovered(el);
  },
  layersChanged() {
    layers.refresh();
  },
  selectedElsewhere(win) {
    return !!selWin && selWin !== win && clients.has(selWin);
  },
  // The panels are always open on the board.
  setDocked() {},
  chatList: () => chatsHost,
  chatsOpen: () => chatsOpen,
  setChatsOpen,
  chatCount: () => chatList.openCount(),
  samples(win, names, current) {
    const f = frameOf(win);
    if (f?.kind !== "app") return;
    f.samples = names;
    f.sampleOn = current;
    f.missing = [];
    apply();
  },
  missing(win, commands) {
    const f = frameOf(win);
    if (f?.kind !== "app") return;
    f.missing = commands;
    apply();
  },
  frameProps(win) {
    const f = frameOf(win);
    if (!f || f !== selected()) return null;
    props.update(f);
    // Mounted only now, so update it again once it's in the page.
    queueMicrotask(() => props.update(f));
    return props.el;
  },
  wheelZoom(x, y, deltaY) {
    const f = selected();
    zoomByWheel({ deltaY, deltaMode: 0 }, px + (f.x + x) * z, py + (f.y + y) * z);
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
  frameMenu(win) {
    const f = frameOf(win);
    return f ? frameMenuOf(f) : [];
  },
  breakdown(target) {
    parts.setTarget(target as BreakdownTarget);
    side.showTab("Components");
  },
  hasSource(src, from) {
    return !!sourceFrame(src, from);
  },
  goToSource(src, from) {
    const f = sourceFrame(src, from);
    const hooks = f && clients.get(f.iframe.contentWindow!);
    if (!f || !hooks?.selectSource) return;
    selectFrame(f);
    if (!edit) switchMode(true);
    const box = hooks.selectSource(src);
    if (box) bringIntoView(f, box);
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
    const grew = nw > f.w || nh > f.h;
    f.w = nw;
    f.h = nh;
    if (grew && f.placed) {
      pushBelow(f);
      save();
    }
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
      // No browser menu in a frame either, from its first moment (menu.ts).
      blockNativeMenu(w);
      w[GUARD] = true;
      w.addEventListener(
        "wheel",
        (e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          e.stopPropagation();
          zoomByWheel(e, px + (f.x + e.clientX) * z, py + (f.y + e.clientY) * z);
        },
        { passive: false, capture: true },
      );
      w.addEventListener(
        "keydown",
        (e) => {
          if (isSettingsKey(e)) {
            e.preventDefault();
            e.stopPropagation();
            settingsPanel.toggle();
            return;
          }
          const k = zoomKeyOf(e);
          if (!k) return;
          e.preventDefault();
          e.stopPropagation();
          zoomKey(k);
        },
        true,
      );
      for (const t of ["gesturestart", "gesturechange", "gestureend"]) w.addEventListener(t, (e) => e.preventDefault(), { passive: false, capture: true });
      w.addEventListener(
        "pointerdown",
        (e) => {
          blurChrome();
          settingsPanel.close();
          // The middle button only pans (frame.ts): it never selects.
          if (e.button !== 1) selectFrame(f);
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
// Right-click menus (menu.ts). The browser's own menu never shows on the board.

blockNativeMenu(window);

/** What a frame's menu offers besides its client's (Ask Claude): the board's own commands for it. */
function frameMenuOf(f: Frame): MenuEntry[] {
  const apps = frames.filter((x) => x.kind === "app").length;
  return [
    {
      label: "Zoom to frame",
      run: () => {
        selectFrame(f);
        focusFrame(f);
        apply();
      },
    },
    f.kind === "component" && { label: f.stacked ? "Cases in a row" : "Stack cases", run: () => setLayout(f, f.stacked ? "row" : "column") },
    "-",
    f.kind === "app" && { label: "Add frame", run: addApp },
    f.kind === "app" && f.id !== "app-1" && apps > 1 && { label: "Remove frame", danger: true, run: () => removeFrame(f) },
  ];
}

/** A frame's title (or its row in Layers): select it as a whole, in Edit mode, and show its menu. */
function frameContext(f: Frame, x: number, y: number) {
  selectFrame(f);
  const win = f.iframe.contentWindow;
  const hooks = win ? clients.get(win) : undefined;
  if (!hooks?.contextMenu) {
    openMenu(x, y, frameMenuOf(f));
    return;
  }
  if (!edit) switchMode(true);
  hooks.contextMenu(null, x, y);
}

/** The component frame (not `from`'s) that shows the element written at `src`. */
function sourceFrame(src: string, from: Window): Frame | null {
  for (const f of frames) {
    const win = f.iframe.contentWindow;
    if (f.kind !== "component" || !win || win === from) continue;
    try {
      if (clients.get(win)?.hasSource?.(src)) return f;
    } catch {
      // Reloading.
    }
  }
  return null;
}

canvas.addEventListener("contextmenu", (e) => {
  const me = e as MouseEvent;
  me.preventDefault();
  const f = frames.find((x) => x.el.contains(me.target as Node));
  if (f) {
    frameContext(f, me.clientX, me.clientY);
    return;
  }
  openMenu(me.clientX, me.clientY, [
    { label: "Add frame", run: addApp },
    "-",
    { label: "Zoom to fit", run: fitAll },
    { label: "Zoom to 100%", hint: "Ctrl 0", run: () => zoomKey("reset") },
    "-",
    edit ? { label: "View mode", hint: "Tab", run: () => switchMode(false) } : { label: "Edit mode", hint: "Tab", run: () => switchMode(true) },
  ]);
});

// ---------------------------------------------------------------------------
// Chats: every chat with Claude about an element, from the dev server (chats.ts)

type ChatRef = { id: string; key: string; kind?: string };
/** Open a chat on its element: the frame that has it becomes the selected one, in Edit mode. */
function openChat(chat: ChatRef): boolean {
  for (const f of frames) {
    const win = f.iframe.contentWindow;
    const hooks = win ? clients.get(win) : undefined;
    if (!hooks?.findChat?.(chat.key)) continue;
    selectFrame(f);
    if (!edit) switchMode(true);
    // The column goes from the list to the conversation, so its prompt can take focus.
    setChatsOpen(false);
    const box = hooks.openChat?.(chat.key);
    if (box) bringIntoView(f, box);
    return true;
  }
  return false;
}

/** Bring a box in a frame (the frame's own coordinates) into view when it's off screen, at the current zoom. */
function bringIntoView(f: Frame, box: { x: number; y: number; w: number; h: number }) {
  const { cl, cw, ch } = canvasSize();
  const x = px + (f.x + box.x) * z;
  const y = py + (f.y + box.y) * z;
  if (x < cl || y < 0 || x + box.w * z > cl + cw || y + box.h * z > ch) {
    centerOn(f.x + box.x, f.y + box.y, box.w, box.h, z);
    apply();
  }
}
/** Center a box in a frame (the frame's own coordinates) in the canvas, always: at the current zoom, zoomed out if it doesn't fit. */
function centerBox(f: Frame, box: { x: number; y: number; w: number; h: number }) {
  apply();
  const zz = box.w > 0 && box.h > 0 ? Math.min(z, fitZoom(box.w, box.h)) : z;
  centerOn(f.x + f.iframe.offsetLeft + box.x, f.y + f.iframe.offsetTop + box.y, box.w, box.h, zz);
  apply();
}
// Layers: every frame, and the element tree in each (layers.ts), in step with the canvas selection.
const layers = layersTab({
  frames: () =>
    frames.map((f) => {
      const win = f.iframe.contentWindow;
      return {
        id: f.id,
        kind: f.kind,
        name: f.name.textContent || fileTitle(f.file),
        meta: f.meta.textContent ?? "",
        hooks: win ? clients.get(win) : undefined,
        selected: f === selected(),
      };
    }),
  pickFrame: (id) => {
    const f = frames.find((x) => x.id === id);
    if (!f) return;
    selectFrame(f);
    const win = f.iframe.contentWindow;
    const hooks = win ? clients.get(win) : undefined;
    // The frame itself is selected, like a click on its title (from View mode too, which it leaves).
    if (hooks?.selectFrame) {
      if (!edit) switchMode(true);
      hooks.selectFrame();
    } else hooks?.deselect();
    // Selecting never moves the board; double-click (focusFrame) does.
    layers.refresh();
  },
  focusFrame: (id) => {
    const f = frames.find((x) => x.id === id);
    if (!f) return;
    selectFrame(f);
    focusFrame(f);
    apply();
  },
  pickLayer: (id, el) => {
    const f = frames.find((x) => x.id === id);
    const win = f?.iframe.contentWindow;
    const hooks = win ? clients.get(win) : undefined;
    if (!f || !hooks?.selectLayer) return;
    selectFrame(f);
    if (!edit) switchMode(true);
    // Selecting never moves the board; double-click (focusLayer) does.
    hooks.selectLayer(el);
  },
  focusLayer: (id, el) => {
    const f = frames.find((x) => x.id === id);
    const win = f?.iframe.contentWindow;
    const hooks = win ? clients.get(win) : undefined;
    if (!f || !hooks?.selectLayer) return;
    selectFrame(f);
    if (!edit) switchMode(true);
    const box = hooks.selectLayer(el);
    if (box) centerBox(f, box);
  },
  menuFrame: (id, x, y) => {
    const f = frames.find((v) => v.id === id);
    if (f) frameContext(f, x, y);
  },
  menuLayer: (id, el, x, y) => {
    const f = frames.find((v) => v.id === id);
    const win = f?.iframe.contentWindow;
    const hooks = win ? clients.get(win) : undefined;
    if (!f || !hooks?.contextMenu) return;
    selectFrame(f);
    if (!edit) switchMode(true);
    hooks.selectLayer?.(el);
    hooks.contextMenu(el, x, y);
  },
  shown: () => side.shows("Layers"),
});
side.addTab("Layers", layers.el, "layers", "Every frame and the elements in it", () => layers.draw());
// Components: Break down into components (components-tab.ts, breakdown.ts).
/** The elements written at these places ("src/App.tsx:30" or with a column), in one frame. */
function coveredIn(win: Window, covers: string[]): Element[] {
  const out: Element[] = [];
  for (const raw of covers) {
    const m = raw.replace(/^\/+/, "").match(/^(.+?):(\d+)(?::(\d+))?$/);
    if (!m) continue;
    const sel = m[3] ? `[data-spark-src="${CSS.escape(`${m[1]}:${m[2]}:${m[3]}`)}"]` : `[data-spark-src^="${CSS.escape(`${m[1]}:${m[2]}:`)}"]`;
    try {
      out.push(...Array.from(win.document.querySelectorAll(sel)));
    } catch {
      // Reloading.
    }
  }
  return out;
}
function highlightCovers(covers: string[]) {
  const boxes: HTMLElement[] = [];
  for (const f of covers.length ? frames : []) {
    const win = f.iframe.contentWindow;
    if (!win) continue;
    for (const el of coveredIn(win, covers).slice(0, 60)) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      // Clipped to the frame: what scrolled out of it isn't drawn outside it.
      const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top);
      const x1 = Math.min(f.iframe.clientWidth, r.right), y1 = Math.min(f.iframe.clientHeight, r.bottom);
      if (x1 <= x0 || y1 <= y0) continue;
      const b = h("div");
      b.style.cssText = `left: ${f.x + f.iframe.offsetLeft + x0}px; top: ${f.y + f.iframe.offsetTop + y0}px; width: ${x1 - x0}px; height: ${y1 - y0}px;`;
      boxes.push(b);
    }
  }
  coverLayer.replaceChildren(...boxes);
}
/** Select the first element a row stands for, app frames first, in view. */
function revealCovers(covers: string[]) {
  const order = [...frames.filter((f) => f.kind === "app"), ...frames.filter((f) => f.kind !== "app")];
  for (const f of order) {
    const win = f.iframe.contentWindow;
    const hooks = win ? clients.get(win) : undefined;
    const el = win && hooks?.selectLayer ? coveredIn(win, covers)[0] : undefined;
    if (!el || !hooks?.selectLayer) continue;
    selectFrame(f);
    if (!edit) switchMode(true);
    const box = hooks.selectLayer(el);
    if (box) bringIntoView(f, box);
    return;
  }
}
const parts = componentsTab({
  send: (event, data) => import.meta.hot?.send(event, data),
  highlight: highlightCovers,
  reveal: revealCovers,
  wholeApp: () => {
    for (const f of frames) {
      const win = f.iframe.contentWindow;
      const t = f.kind === "app" && win ? clients.get(win)?.breakdownTarget?.() : null;
      if (t) return t as BreakdownTarget;
    }
    return null;
  },
});
side.addTab("Components", parts.el, "component", "Break down into components: plan them with Claude, then build");
let buildingArea: string | null = null;
const showBusy = () => parts.setBusy(runningChat !== null || buildingArea !== null, buildingArea);
import.meta.hot?.on("spark:components", (d: { manifest?: { components?: PlanComponent[] }; why?: string }) => {
  parts.update(d.manifest?.components ?? []);
  side.setCount("Components", parts.todo());
  // A plan just came in (its chat had the tab while Claude worked): the plan is what to look at now.
  if (d.why === "plan") side.showTab("Components");
});
import.meta.hot?.on("spark:components-building", (d: { area?: string | null }) => {
  buildingArea = d.area ?? null;
  showBusy();
});
import.meta.hot?.send("spark:components-get", {});
// Chats: the list lives in the chat column on the right (the selected frame's
// client mounts it, chatList), behind its Chats button; a host of its own, so
// it takes its styles along.
const chatList = chatsTab({ open: openChat, send: (event, data) => import.meta.hot?.send(event, data) });
const chatsHost = document.createElement("spark-chats");
chatsHost.style.cssText = "display: block; height: 100%;";
{
  const r = chatsHost.attachShadow({ mode: "open" });
  r.append(
    h(
      "style",
      {},
      `${THEME}
      :host { all: initial; display: block; height: 100%; }
      * { box-sizing: border-box; }
      button { font: inherit; color: inherit; cursor: pointer; }
      .side-body {
        height: 100%; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--sp-line-strong) transparent;
        color: var(--sp-text); font: var(--sp-fs-md)/1.45 var(--sp-font);
      }
      ${CHATS_STYLE}`,
    ),
    h("div", { class: "side-body" }, chatList.el),
  );
}
let chatsOpen = getState<boolean>("chats-open") === true;
function setChatsOpen(v: boolean) {
  if (v === chatsOpen) return;
  chatsOpen = v;
  setState("chats-open", v);
  for (const hooks of clients.values()) hooks.chatsChanged?.();
}
// Changes: the active frame's change list and Implement changes (each client mounts its own; showPanels picks).
const changesTab = h("div", { class: "changes-side" });
side.addTab("Changes", changesTab, "git-compare", "Pending changes, and Implement changes");
let chatData: ChatRef[] = [];
let runningChat: string | null = null;
const showChats = () => {
  chatList.update(chatData as Parameters<typeof chatList.update>[0], runningChat);
  for (const hooks of clients.values()) hooks.chatsChanged?.();
  showBusy();
};
import.meta.hot?.on("spark:chats", (d: { chats: ChatRef[]; running?: string | null }) => {
  chatData = d.chats;
  if (d.running !== undefined) runningChat = d.running;
  showChats();
});
import.meta.hot?.on("spark:run", (e: { type: string; chat?: string }) => {
  if (e.type === "start") runningChat = e.chat ?? null;
  else if (e.type === "done" || e.type === "error") {
    runningChat = null;
    if (samplesWriting) {
      samplesWriting = false;
      apply();
    }
  }
  else return;
  showChats();
  // A task (the Components view's "Write them with Claude", an Ask with nothing selected) has no element
  // to show its chat on: the chat column's list opens on it, so every run is in sight as it goes.
  if (e.type === "start" && e.chat && chatData.find((c) => c.id === e.chat)?.kind === "task" && chatList.reveal(e.chat)) setChatsOpen(true);
});
import.meta.hot?.send("spark:chats-get", {});
// Claude was busy with another chat: "Write sample data" can be pressed again.
import.meta.hot?.on("spark:busy", () => {
  if (!samplesWriting) return;
  samplesWriting = false;
  apply();
});

// ---------------------------------------------------------------------------
// Start

// An old bookmark of the Components view opens the board.
if (new URL(location.href).searchParams.has("spark")) history_.replaceState(history_.state, "", appUrl());
const loaded = loadSaved();
frames = loaded.apps.map((a) => makeFrame("app", a.id, "", { x: a.x, y: a.y, w: a.w, h: a.h, preset: a.preset, sample: typeof a.sample === "string" ? a.sample : undefined }));
selectedId = loaded.selected;
document.documentElement.append(host);
syncComponents(caseFiles);
window.addEventListener("spark:cases", (e) => syncComponents((e as CustomEvent<string[]>).detail));
side.init();
fitPanels();
// The camera where it was left; the first time, the selected frame in view.
const cam = loaded.camera;
if (cam && [cam.z, cam.x, cam.y].every(Number.isFinite)) {
  z = clampZ(cam.z);
  // Saved when the canvas started right of an open sidebar: the frames stay where they were on screen.
  px = cam.x + (loaded.canvas !== 2 && getState<{ open?: boolean }>("sidebar")?.open === true ? sideEdge.width() : 0);
  py = cam.y;
  savedCamera = JSON.stringify({ z, x: px, y: py });
} else focusFrame(selected());
started = true;
apply();
requestAnimationFrame(guardFrames);
