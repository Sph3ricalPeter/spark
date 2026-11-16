// The launcher wears Spark's own design system, the one the board's panels
// use (packages/vite-plugin/src/theme.ts): the same --sp-* variables, buttons,
// icons and font, so home and an open project look like one app. The board
// sets them on each shadow root's :host; here they go on the document.
import { THEME } from "../../packages/vite-plugin/src/theme.ts";
import { installFont, type FontSubset } from "../../packages/vite-plugin/src/fonts.ts";
import latin from "../../packages/vite-plugin/assets/fonts/inter-latin-wght-normal.woff2?url";
import latinExt from "../../packages/vite-plugin/assets/fonts/inter-latin-ext-wght-normal.woff2?url";

const FONTS: Record<FontSubset, string> = { latin, "latin-ext": latinExt };

export function installTheme() {
  installFont(document, (subset) => FONTS[subset]);
  const style = document.createElement("style");
  style.setAttribute("data-spark", "theme");
  style.textContent = THEME.replace(":host {", ":root {");
  document.head.prepend(style);
}
