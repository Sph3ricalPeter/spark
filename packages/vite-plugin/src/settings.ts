// Spark's own settings: preferences of the person, not of a project, so the
// same in every project Spark opens (the board's Settings dialog, shell.ts,
// behind the title bar's gear or Ctrl+,). The dev server keeps them in
// settings.json in Spark's config folder (index.ts; project.rs tells it
// where), or ~/.spark when the board runs outside Spark (the fixture). Like
// state.ts, read before anything that imports this runs, and never
// localStorage (a new origin every open).
//
// Every page that draws Spark UI imports this (the board, each frame's
// client): it puts the looks in the page's root as `--spu-*` variables,
// which THEME (theme.ts) reads under its own defaults, so every shadow root
// follows, and redoes it when the settings change on any page.
//
// Keys, and what they hold (unset is the default):
//   theme       THEMES below: "dark" (default), "graphite", "midnight", "black"
//   accent      "#rrggbb": buttons, focus, the selected frame
//   font        UI font: a bundled one's id (fonts.ts UI_FONTS; unset is Inter), or
//               any installed family name (Custom)
//   mono-font   values and code: a bundled one's id (MONO_FONTS; unset is the
//               system monospace), or any installed family name
//   text-scale  multiplier of every UI font size (0.85 to 1.4)
//   zoom-speed  shell.ts: `{ wheel?: n, pinch?: n }`, multipliers of the mouse
//               wheel's and the touchpad pinch's zoom (¼ to 4)
//   zoom-glide  false: a wheel notch scrolls or zooms in one jump instead of gliding
//   grid        false: no dot grid on the canvas
// Values are JSON; shapes only grow.
import { MONO_FONT, MONO_FONTS, UI_FONT, UI_FONTS, familyOf, type BundledFont } from "./fonts.ts";

export type ThemeName = "dark" | "graphite" | "midnight" | "black";

export type Settings = {
  theme: ThemeName;
  accent: string;
  font: string;
  "mono-font": string;
  "text-scale": number;
  "zoom-speed": { wheel?: number; pinch?: number };
  "zoom-glide": boolean;
  grid: boolean;
};

type Palette = { bg: string; surface: string; field: string; line: string; "line-strong": string; text: string; "text-dim": string; canvas: string };

/** The themes' colors; "dark" is THEME's own defaults (and the canvas's in shell.ts). */
export const THEMES: Record<ThemeName, { name: string; colors: Palette }> = {
  dark: {
    name: "Dark",
    colors: { bg: "#16171a", surface: "#1d1f23", field: "#23252a", line: "#2a2c31", "line-strong": "#33363c", text: "#d6d8dc", "text-dim": "#8a8f98", canvas: "#0e0f11" },
  },
  graphite: {
    name: "Graphite",
    colors: { bg: "#202124", surface: "#27292d", field: "#2f3136", line: "#373a40", "line-strong": "#43464d", text: "#dcdee2", "text-dim": "#969ba4", canvas: "#18191b" },
  },
  midnight: {
    name: "Midnight",
    colors: { bg: "#131624", surface: "#191d2e", field: "#202538", line: "#272c41", "line-strong": "#323850", text: "#d4d8e6", "text-dim": "#878ea6", canvas: "#0b0d17" },
  },
  black: {
    name: "Black",
    colors: { bg: "#000000", surface: "#0d0d0f", field: "#17171a", line: "#1f2023", "line-strong": "#2b2c30", text: "#d6d8dc", "text-dim": "#8a8f98", canvas: "#000000" },
  },
};

/** The accent swatches; the first is the default. */
export const ACCENTS: [string, string][] = [
  ["Blue", "#4f8cff"],
  ["Violet", "#8b5cf6"],
  ["Pink", "#ec4899"],
  ["Red", "#ef4444"],
  ["Orange", "#f97316"],
  ["Green", "#22c55e"],
  ["Teal", "#14b8a6"],
];

export const TEXT_SCALE = { min: 0.85, max: 1.4 };
/** The zoom speed multipliers' range: 1/4x to 4x, in powers of two on the sliders. */
export const ZOOM_SPEED = { min: 0.25, max: 4 };

/** How far the mouse wheel's or the pinch's zoom goes, ×. */
export function zoomSpeed(kind: "wheel" | "pinch") {
  const v = getSetting("zoom-speed")?.[kind];
  return typeof v === "number" && Number.isFinite(v) ? Math.min(ZOOM_SPEED.max, Math.max(ZOOM_SPEED.min, v)) : 1;
}

const ENDPOINT = "/@spark/settings";

let values: Record<string, unknown> = {};
try {
  const res = await fetch(ENDPOINT, { cache: "no-store" });
  if (res.ok) values = ((await res.json()) as Record<string, unknown> | null) ?? {};
} catch {
  // No Spark dev server behind the page: defaults, nothing saved.
}

/** The saved value for `key`, or undefined. */
export function getSetting<K extends keyof Settings>(key: K): Settings[K] | undefined {
  return values[key] as Settings[K] | undefined;
}

/** Where a change goes: the dev server (the board), or Spark itself (the launcher, connectSettings). */
let save = (key: string, value: unknown) => import.meta.hot?.send("spark:settings", { key, value });

/**
 * For a page with no Spark dev server behind it (the launcher): read and
 * write the settings some other way (Spark's commands, settings.rs).
 */
export async function connectSettings(backend: { load(): Promise<Record<string, unknown>>; save(key: string, value: unknown): void }) {
  save = backend.save;
  try {
    values = (await backend.load()) ?? {};
  } catch {
    // Can't read them: the defaults.
  }
  changed();
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

/** Called whenever a setting changes, here or on another page. */
export function onSettings(fn: () => void) {
  listeners.add(fn);
}

function changed() {
  applyLooks();
  for (const fn of listeners) fn();
}

/** Remember `value` for `key` (undefined forgets it); `delay` gathers a slider drag into one save. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K] | undefined, delay = 0) {
  if (value === undefined) delete values[key];
  else values[key] = value;
  clearTimeout(pending.get(key));
  const send = () => {
    pending.delete(key);
    save(key, values[key] ?? null);
  };
  if (delay > 0) pending.set(key, setTimeout(send, delay));
  else send();
  changed();
}

/** Is anything set (not the defaults)? */
export function hasSettings() {
  return Object.keys(values).length > 0;
}

/** Every setting back to its default. */
export function resetSettings() {
  for (const key of Object.keys(values) as (keyof Settings)[]) setSetting(key, undefined);
}

// Another page changed one.
import.meta.hot?.on("spark:settings", (d: { key: string; value: unknown }) => {
  if (pending.has(d.key)) return;
  if (d.value === undefined || d.value === null) delete values[d.key];
  else values[d.key] = d.value;
  changed();
});

/** A family name as typed, safe inside a quoted CSS string. */
export function cleanFamily(name: string) {
  return name.replace(/["'`;{}<>\\]/g, "").trim();
}

/** The family for a font setting: a bundled font's id (fonts.ts), or any family name typed into Custom. */
function fontFamily(v: unknown, bundled: BundledFont[]) {
  if (typeof v !== "string" || !v) return "";
  const f = bundled.find((b) => b.id === v);
  if (f) return f.id ? familyOf(f) : "";
  // Before the fonts were bundled, "system" meant the system UI font.
  if (v === "system") return "Segoe UI";
  return cleanFamily(v);
}

const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

/** The page's `--spu-*` variables for the current settings (only what isn't the default). */
export function looksCss(): string {
  const vars: string[] = [];
  const theme = THEMES[getSetting("theme") as ThemeName];
  if (theme && getSetting("theme") !== "dark") for (const [k, v] of Object.entries(theme.colors)) vars.push(`--spu-${k}: ${v};`);
  if (getSetting("grid") === false) vars.push("--spu-canvas-dot: transparent;");
  const accent = getSetting("accent");
  if (isColor(accent)) vars.push(`--spu-accent: ${accent};`);
  const font = fontFamily(getSetting("font"), UI_FONTS);
  if (font) vars.push(`--spu-font: "${font}", ${UI_FONT};`);
  const mono = fontFamily(getSetting("mono-font"), MONO_FONTS);
  if (mono) vars.push(`--spu-mono: "${mono}", ${MONO_FONT};`);
  const scale = getSetting("text-scale");
  if (typeof scale === "number" && Number.isFinite(scale) && scale !== 1)
    vars.push(`--spu-text-scale: ${Math.min(TEXT_SCALE.max, Math.max(TEXT_SCALE.min, scale))};`);
  return vars.length ? `:root { ${vars.join(" ")} }` : "";
}

/** Put the looks in this page's root (every page that imports this does, at once). */
function applyLooks() {
  const doc = document;
  let style = doc.querySelector<HTMLStyleElement>("style[data-spark='settings']");
  if (!style) {
    style = doc.createElement("style");
    style.setAttribute("data-spark", "settings");
    (doc.head ?? doc.documentElement).append(style);
  }
  const css = looksCss();
  if (style.textContent !== css) style.textContent = css;
}
applyLooks();
