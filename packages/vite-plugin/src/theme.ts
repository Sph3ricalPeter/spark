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
    --sp-link: #8fb4ff;
    --sp-warn: #d9a441;
    --sp-danger: #e5534b;
  }
  .icon { flex: none; vertical-align: -2px; }
  button:has(> .icon:only-child) { display: inline-flex; align-items: center; justify-content: center; }
`;

const ICONS = {
  x: ["M18 6 6 18", "m6 6 12 12"],
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
