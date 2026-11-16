// Spark's own UI fonts, bundled with the plugin so they work offline: Inter
// (the default) and the other modern open fonts Settings offers for the UI
// and for code (settings.ts), all variable weight, latin and latin-ext. The
// dev server serves the files at /@spark/fonts/ (see index.ts), the launcher
// bundles them (src/main.ts). Each family is registered as "Spark <Name>"
// so it can't match anything the app being edited asks for, even in the
// app's own document; a family's files only download once something uses it.
// Licenses (SIL OFL 1.1) are next to the files, in assets/fonts.
const RANGES = {
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext":
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
};

/** A bundled font: `file` names its files, `<file>-<subset>-wght-normal.woff2`. */
export type BundledFont = { id: string; name: string; file: string };

/** The UI fonts; the first (Inter) is the default. */
export const UI_FONTS: BundledFont[] = [
  { id: "", name: "Inter", file: "inter" },
  { id: "geist", name: "Geist", file: "geist" },
  { id: "manrope", name: "Manrope", file: "manrope" },
  { id: "plus-jakarta-sans", name: "Plus Jakarta Sans", file: "plus-jakarta-sans" },
  { id: "dm-sans", name: "DM Sans", file: "dm-sans" },
  { id: "figtree", name: "Figtree", file: "figtree" },
  { id: "ibm-plex-sans", name: "IBM Plex Sans", file: "ibm-plex-sans" },
];

/** The code fonts (values, code, the zoom level). The default is the system's monospace. */
export const MONO_FONTS: BundledFont[] = [
  { id: "jetbrains-mono", name: "JetBrains Mono", file: "jetbrains-mono" },
  { id: "geist-mono", name: "Geist Mono", file: "geist-mono" },
  { id: "fira-code", name: "Fira Code", file: "fira-code" },
  { id: "source-code-pro", name: "Source Code Pro", file: "source-code-pro" },
];

/** The family a bundled font is registered as. */
export const familyOf = (f: BundledFont) => `Spark ${f.name}`;

/** The font stack for Spark's UI text (monospace stays monospace). */
export const UI_FONT = `"Spark Inter", ui-sans-serif, system-ui, sans-serif`;

/** The monospace stack for values and code. */
export const MONO_FONT = "ui-monospace, SFMono-Regular, Consolas, monospace";

export type FontSubset = keyof typeof RANGES;

/** Every bundled font file's name. */
export const FONT_FILES = [...UI_FONTS, ...MONO_FONTS].flatMap((f) => (Object.keys(RANGES) as FontSubset[]).map((sub) => `${f.file}-${sub}-wght-normal.woff2`));

/** Register the fonts in a document. @font-face doesn't work inside a shadow root, so it goes in the head.
 * `url` is where each file is: the dev server's /@spark/fonts/ on the board, the bundled files in the launcher. */
export function installFont(doc: Document = document, url = (file: string) => `/@spark/fonts/${file}`) {
  if (doc.querySelector("style[data-spark='font']")) return;
  const css = [...UI_FONTS, ...MONO_FONTS]
    .flatMap((f) =>
      Object.entries(RANGES).map(
        ([subset, range]) =>
          `@font-face { font-family: "${familyOf(f)}"; font-style: normal; font-display: swap; font-weight: 100 900; ` +
          `src: url("${url(`${f.file}-${subset}-wght-normal.woff2`)}") format("woff2-variations"); unicode-range: ${range}; }`,
      ),
    )
    .join("\n");
  const style = doc.createElement("style");
  style.setAttribute("data-spark", "font");
  style.textContent = css;
  doc.head.append(style);
}
