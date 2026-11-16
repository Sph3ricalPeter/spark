// Spark's own design system: the few variables every Spark surface (panel,
// canvas bar, popovers, overlay labels) is styled with. Set on :host of each
// shadow root, so they never reach the app being edited. Add to this list
// only when a value repeats; one-offs stay literal.
//
// Icons: Lucide (lucide.dev, ISC). Outline icons on a 24px grid, drawn with
// currentColor so they follow the text color; inlined here as path data
// (no dependency, works offline). Add an icon by copying its paths from
// lucide's icons/<name>.mjs.
import { UI_FONT } from "./fonts.ts";

export const THEME = `
  :host {
    /* Type: Inter for UI, the system monospace for values and code. */
    --sp-font: ${UI_FONT};
    --sp-mono: ui-monospace, SFMono-Regular, Consolas, monospace;
    --sp-fs-xs: 10px;
    --sp-fs-sm: 11px;
    --sp-fs-md: 12px;
    --sp-fs-lg: 13px;
    /* Radii: fields and buttons, popovers and cards, floating panels. */
    --sp-r-sm: 4px;
    --sp-r-md: 6px;
    --sp-r-lg: 8px;
    /* Spacing. */
    --sp-1: 4px;
    --sp-2: 8px;
    --sp-3: 12px;
    --sp-4: 16px;
    /* Color. */
    --sp-bg: #16171a;
    --sp-surface: #1d1f23;
    --sp-field: #23252a;
    --sp-line: #2a2c31;
    --sp-line-strong: #33363c;
    --sp-text: #d6d8dc;
    --sp-text-dim: #8a8f98;
    --sp-text-strong: #fff;
    --sp-accent: #4f8cff;
    /* Components (Figma's purple): component frames on the board. */
    --sp-component: #a77bff;
    /* An instance of a component, or an element inside one (selection colors). */
    --sp-instance: #ff5fa8;
    /* The selection's box model, like browser devtools. */
    --sp-margin: #f6a04d59;
    --sp-padding: #7ccf6a59;
    --sp-link: #8fb4ff;
    --sp-warn: #d9a441;
    --sp-danger: #e5534b;
    /* The board's canvas, and its dot grid. */
    --sp-canvas: #0e0f11;
    --sp-canvas-dot: #ffffff14;
    /* The spark mark. */
    --sp-brand: #ffd23f;
    /* The window's close button on hover (as Windows draws it). */
    --sp-win-close: #c42b1c;
  }
  /* Native dropdown lists are drawn by the browser: dark, like the rest of
     Spark, and never transparent text from the select they open from. */
  select { color-scheme: dark; }
  select option, select optgroup { background-color: var(--sp-field); color: var(--sp-text); font-style: normal; }
  .icon { flex: none; vertical-align: -2px; }
  /* Spark's buttons, the same in every panel and in the launcher: .sp-btn is a plain one, .primary the action
     that matters (Claude's: Plan, Build, Implement changes, Write sample data; Open folder), .ghost a quiet one,
     .small a compact one, .wide fills its row. */
  .sp-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none; height: 28px; min-width: 0; padding: 0 12px;
    border: none; border-radius: var(--sp-r-md); background: var(--sp-field); color: var(--sp-text-strong);
    font: 600 var(--sp-fs-md)/1 var(--sp-font); white-space: nowrap; cursor: pointer;
  }
  .sp-btn.primary { background: var(--sp-accent); }
  .sp-btn.ghost { background: transparent; color: var(--sp-text-dim); }
  .sp-btn.ghost:not(:disabled):hover { background: var(--sp-field); color: var(--sp-text-strong); }
  .sp-btn.small { height: 22px; padding: 0 8px; font-size: var(--sp-fs-xs); }
  .sp-btn.wide { flex: 1 1 auto; width: 100%; }
  .sp-btn > span { overflow: hidden; text-overflow: ellipsis; }
  .sp-btn:disabled { opacity: .5; cursor: default; }
  .sp-btn:not(:disabled):not(.ghost):hover { filter: brightness(1.12); }
  button:has(> .icon:only-child) { display: inline-flex; align-items: center; justify-content: center; }
`;

const ICONS = {
  "arrow-up": ["m5 12 7-7 7 7", "M12 19V5"],
  component: [
    "M15.536 11.293a1 1 0 0 0 0 1.414l2.376 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z",
    "M2.297 11.293a1 1 0 0 0 0 1.414l2.377 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414L6.088 8.916a1 1 0 0 0-1.414 0z",
    "M8.916 17.912a1 1 0 0 0 0 1.415l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.415l-2.377-2.376a1 1 0 0 0-1.414 0z",
    "M8.916 4.674a1 1 0 0 0 0 1.414l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z",
  ],
  x: ["M18 6 6 18", "m6 6 12 12"],
  plus: ["M5 12h14", "M12 5v14"],
  minus: ["M5 12h14"],
  "app-window": ["M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M10 4v4", "M2 8h20", "M6 4v4"],
  "rotate-ccw": ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  braces: [
    "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1",
    "M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1",
  ],
  "chevron-down": ["m6 9 6 6 6-6"],
  // A rounded corner, for border radius.
  corner: ["M4 20v-8a8 8 0 0 1 8-8h8"],
  type: ["M12 4v16", "M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2", "M9 20h6"],
  square: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"],
  "rectangle-horizontal": ["M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"],
  "text-cursor-input": ["M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1", "M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5", "M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1", "M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7", "M9 7v10"],
  image: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M9 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z", "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"],
  "rows-2": ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M3 12h18"],
  "columns-2": ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M12 3v18"],
  "chevron-right": ["m9 18 6-6-6-6"],
  hash: ["M4 9h16", "M4 15h16", "M10 3 8 21", "M16 3l-2 18"],
  layers: [
    "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z",
    "M22 17.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65",
    "M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65",
  ],
  check: ["M20 6 9 17l-5-5"],
  archive: ["M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8", "M10 12h4"],
  "chevron-left": ["m15 18-6-6 6-6"],
  smile: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "M8 14s1.5 2 4 2 4-2 4-2", "M9 9h.01", "M15 9h.01"],
  "message-circle": ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
  "folder-open": ["m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"],
  "git-compare": ["M21 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0", "M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0", "M13 6h3a2 2 0 0 1 2 2v7", "M11 18H8a2 2 0 0 1-2-2V9"],
} as const;

export type IconName = keyof typeof ICONS;

/** A Lucide icon as an inline SVG element. */
export function icon(name: IconName, size = 14): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", class: "icon", "aria-hidden": "true" })) svg.setAttribute(k, v);
  svg.style.width = svg.style.height = `${size}px`;
  for (const d of ICONS[name]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
