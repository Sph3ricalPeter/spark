// Spark's Settings panel (settings.ts has the settings): under the title
// bar's gear or Ctrl+,, on the board (shell.ts) and on the start screen
// (titlebar.ts launcherTitleBar). Looks (theme, accent, fonts, text size)
// and the canvas (zoom speeds, glide, grid). Every change shows at once, and
// on the board the panel leaves the canvas usable, so a zoom speed can be
// tried while it's set. Drawn with THEME's variables in whatever shadow root
// it's put in, with settingsStyle.
import { h } from "./fields.ts";
import { icon } from "./theme.ts";
import { ACCENTS, THEMES, TEXT_SCALE, cleanFamily, getSetting, hasSettings, onSettings, resetSettings, setSetting, zoomSpeed, type ThemeName } from "./settings.ts";

/** The panel's styles; `top` is the title bar's height. */
export function settingsStyle(top: number) {
  return `
    /* The title bar's gear. */
    .gear {
      display: inline-flex; align-items: center; justify-content: center; flex: none; width: 28px; height: 26px; padding: 0;
      border: 1px solid transparent; border-radius: var(--sp-r-sm); background: transparent; color: var(--sp-text-dim); cursor: pointer;
    }
    .gear:hover, .gear.on { background: var(--sp-field); color: var(--sp-text-strong); }
    /* Its fields, as the board's (wherever the panel is mounted). */
    .settings button, .settings select, .settings input.custom {
      font: inherit; color: inherit; background: var(--sp-field); border: 1px solid var(--sp-line-strong);
      border-radius: var(--sp-r-sm); height: 26px; padding: 0 8px; flex: none; box-sizing: border-box;
    }
    .settings button { cursor: pointer; min-width: 26px; }
    .settings button:disabled { opacity: .4; cursor: default; }
    .settings select { padding: 0 4px; }
    .settings input.custom:focus, .settings select:focus { outline: 1px solid var(--sp-accent); border-color: var(--sp-accent); }
    .settings {
      position: fixed; top: ${top + 6}px; right: 8px; z-index: 2147483647; width: 360px; max-height: calc(100vh - ${top + 14}px);
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
  `;
}

/** Ctrl+, opens Settings, like most apps. */
export function isSettingsKey(e: KeyboardEvent) {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "," || e.code === "Comma");
}

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

/** The Settings panel; `gear` is the button that opens it (lit while it's open), `onChange` runs after any change. */
export function buildSettingsPanel(gear: HTMLElement, onChange?: () => void) {
  const el = h("div", { class: "settings", hidden: "", role: "dialog", "aria-label": "Settings" });
  /** The shadow root (or document) it's in, for which field has focus. */
  const scope = () => el.getRootNode() as Document | ShadowRoot;
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
      if (scope().activeElement !== sel) sel.value = known ? v : "custom";
      custom.hidden = known && sel.value !== "custom";
      if (!known && scope().activeElement !== custom) custom.value = v;
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
      if (scope().activeElement !== input) input.value = String(opts.toInput(opts.get()));
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
    if (scope().activeElement !== anyColor) anyColor.value = a;
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
    onChange?.();
  });

  const api = {
    el,
    get open() {
      return !el.hidden;
    },
    show() {
      draw();
      // Last in its parent, so over whatever mounted since (the board's panels and their edges).
      el.parentNode?.append(el);
      el.hidden = false;
      gear.classList.add("on");
    },
    close() {
      el.hidden = true;
      gear.classList.remove("on");
    },
    toggle() {
      if (api.open) api.close();
      else api.show();
    },
  };
  return api;
}

