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
    /* Type: Manrope for UI, the system monospace for values and code. */
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
    /* The selection's box model, like browser devtools. */
    --sp-margin: #f6a04d59;
    --sp-padding: #7ccf6a59;
    --sp-link: #8fb4ff;
    --sp-warn: #d9a441;
    --sp-danger: #e5534b;
  }
  /* Native dropdown lists are drawn by the browser: dark, like the rest of
     Spark, and never transparent text from the select they open from. */
  select { color-scheme: dark; }
  select option, select optgroup { background-color: var(--sp-field); color: var(--sp-text); font-style: normal; }
  .icon { flex: none; vertical-align: -2px; }
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
  "app-window": ["M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M10 4v4", "M2 8h20", "M6 4v4"],
  "rotate-ccw": ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  braces: [
    "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1",
    "M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1",
  ],
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
