// The launcher wears Spark's own design system, the one the board's panels
// use (packages/vite-plugin/src/theme.ts): the same --sp-* variables, buttons,
// icons and font, so home and an open project look like one app. The board
// sets them on each shadow root's :host; here they go on the document.
import { THEME } from "../../packages/vite-plugin/src/theme.ts";
import { installFont } from "../../packages/vite-plugin/src/fonts.ts";

/** Every bundled font file (fonts.ts), by its name: Vite copies them into the launcher's build. */
const FONTS = Object.fromEntries(
  Object.entries(import.meta.glob<string>("../../packages/vite-plugin/assets/fonts/*.woff2", { query: "?url", import: "default", eager: true })).map(([p, url]) => [
    p.split("/").pop()!,
    url,
  ]),
);

export function installTheme() {
  installFont(document, (file) => FONTS[file] ?? "");
  const style = document.createElement("style");
  style.setAttribute("data-spark", "theme");
  style.textContent = THEME.replace(":host {", ":root {");
  document.head.prepend(style);
}
