// Spark's own UI font: Manrope (variable weight), bundled with the plugin so
// it works offline. The dev server serves the files at /@spark/fonts/ (see
// index.ts). The family is registered as "Spark Manrope" so it can't match
// anything the app being edited asks for, even in the app's own document.
const RANGES = {
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext":
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
};

/** The font stack for Spark's UI text (monospace stays monospace). */
export const UI_FONT = `"Spark Manrope", ui-sans-serif, system-ui, sans-serif`;

/** Register the font in a document. @font-face doesn't work inside a shadow root, so it goes in the head. */
export function installFont(doc: Document = document) {
  if (doc.querySelector("style[data-spark='font']")) return;
  const css = Object.entries(RANGES)
    .map(
      ([subset, range]) =>
        `@font-face { font-family: "Spark Manrope"; font-style: normal; font-display: swap; font-weight: 200 800; ` +
        `src: url("/@spark/fonts/manrope-${subset}-wght-normal.woff2") format("woff2-variations"); unicode-range: ${range}; }`,
    )
    .join("\n");
  const style = doc.createElement("style");
  style.setAttribute("data-spark", "font");
  style.textContent = css;
  doc.head.append(style);
}
