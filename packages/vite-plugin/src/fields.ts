// The panel's input widgets, Figma style.
//
// - number: drag the label (or the field's left edge) to scrub; Alt drags
//   slower for precision, Shift steps ×10; Arrow Up/Down nudge one step
//   (Shift ×10). Steps are whole pixels (and %, deg, ms…); only em/rem and
//   unitless values (opacity, line-height) step in decimals. Typing any CSS
//   value (auto, var(--x), 50%, 13.5px) still works.
// - select: a dropdown of a property's keyword values.
// - color: a swatch that opens token swatches and a color picker.
//
// Every widget calls `onValue(value, final)`: `final` is false while a drag
// is in progress (preview only) and true once the value is settled.

import { icon } from "./theme.ts";

export type OnValue = (value: string, final: boolean) => void;

type Child = Node | string | null | false | undefined;

export function h(tag: string, props: Record<string, string | boolean | ((e: Event) => void)> = {}, ...children: Child[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "function") el.addEventListener(k, v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/** Keys typed into a field stay in the field, not the app's shortcuts. */
function keepKeys(el: HTMLElement) {
  el.addEventListener("keydown", (e) => e.stopPropagation());
  el.addEventListener("keyup", (e) => e.stopPropagation());
}

const NUM = /^(-?\d*\.?\d+)([a-z%]*)$/i;

function parse(v: string): { n: number; unit: string } | null {
  const m = v.trim().match(NUM);
  return m ? { n: parseFloat(m[1]), unit: m[2] } : null;
}

/** Snap to the step's grid, so scrubbing 13.5px lands on 14px, not 14.5px. */
function fmt(n: number, unit: string, step: number) {
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return `${Number((Math.round(n / step) * step).toFixed(decimals))}${unit}`;
}

/**
 * The smallest step for a value in `unit`: whole units for px and the like;
 * decimals only where a whole unit is a big jump (em, rem) or the value has
 * no unit (opacity, line-height, flex-grow), which use the field's own step.
 */
function stepFor(unit: string, fieldStep: number) {
  if (unit === "em" || unit === "rem") return 0.05;
  if (unit === "") return fieldStep;
  return 1;
}

/** `n` moved by `delta`, landing on the step grid (13.5px + 1 is 14px, − 1 is 13px). */
function nudge(n: number, delta: number, one: number) {
  const v = (n + delta) / one;
  return (delta > 0 ? Math.floor(v + 1e-9) : Math.ceil(v - 1e-9)) * one;
}

/** Pixels of drag per step: Alt slows the drag, it never makes the step smaller. */
const PX_PER_STEP = 2;
const PX_PER_STEP_FINE = 8;

export type NumberOpts = {
  /** The computed value, to scrub from when the typed one isn't a plain number (auto, var(--x)). */
  computed: string;
  /** Step per pixel of drag and per arrow press. */
  step?: number;
  /** Unit for a number typed without one. */
  unit?: string;
  min?: number;
  changed?: boolean;
  /** A short label shown inside the field (T, R, B, L). */
  label?: string;
  /** Keywords the property takes instead of a number (auto, normal…), offered in the unit dropdown. */
  keywords?: string[];
};

/** Units offered in a field's dropdown; a value's own unit is added when it isn't here. */
const UNITS = ["px", "%", "em", "rem", "vw", "vh"];
/** For a unitless field that also takes lengths (line-height: 1.4, 20px, 1.2em). */
const UNITS_UNITLESS = ["", "px", "em", "%"];
/** Keywords go in the same dropdown, after the units, with this prefix in its value. */
const KW = "=";

/**
 * A number with its unit in a dropdown on the right: the input holds only the
 * number, so one click selects it and you just type the new value.
 *
 * Properties that also take keywords (line-height: normal, width: auto,
 * margin: auto…) list them in the same dropdown, under the units: picking
 * one replaces the number with the keyword; typing a number or picking a unit
 * brings the number back. Anything else (var(--x), calc(…)) can still be
 * typed, and the dropdown shows "–" for it.
 */
export function numberField(value: string, opts: NumberOpts, onValue: OnValue): HTMLElement {
  const step = opts.step ?? 1;
  const unitDefault = opts.unit ?? "px";
  const keywords = opts.keywords ?? [];
  const parsed = parse(value);
  const units = unitDefault === "" ? UNITS_UNITLESS : UNITS;
  // A unitless field with no keywords (opacity) has no dropdown.
  const noDropdown = unitDefault === "" && keywords.length === 0 && (!parsed || parsed.unit === "");
  /** The last number's unit, kept while a keyword is shown so a number comes back in it. */
  let unit = parsed ? parsed.unit || unitDefault : unitDefault;

  const input = h("input", { value: parsed ? String(parsed.n) : value, spellcheck: "false" }) as HTMLInputElement;
  const grip = h("span", { class: "grip", title: "Drag to change · Alt: slower · Shift: ×10" }, opts.label ?? "↔");
  const unitBtn = h("button", { class: "unit", type: "button", title: keywords.length ? "Unit or keyword" : "Unit" });
  /** What the dropdown shows for the input as it is now. */
  const selection = () => {
    const v = input.value.trim();
    if (parse(v)) return unit;
    if (keywords.includes(v)) return KW + v;
    return null;
  };
  const unitItems = (): MenuItem[] => {
    const list = [...units];
    if (!list.includes(unit)) list.unshift(unit);
    return [
      ...list.map((u) => ({ value: u, label: u === "" ? "x" : u, hint: u === "" ? "no unit" : undefined })),
      ...keywords.map((k) => ({ value: KW + k, label: k, group: "Keyword" })),
    ];
  };
  const fillUnits = () => {
    const sel = selection();
    // A keyword is already in the input, and var()/calc() have no unit: the button shrinks to a caret.
    const caret = sel === null || sel.startsWith(KW);
    unitBtn.replaceChildren(caret ? icon("chevron-down", 12) : sel === "" ? "x" : sel);
    unitBtn.classList.toggle("caret", caret);
    wrap.classList.toggle("kw", sel !== null && sel.startsWith(KW));
  };
  const wrap = h("label", { class: `num${opts.changed ? " changed" : ""}` }, grip, input, !noDropdown && unitBtn);
  menuButton(unitBtn, wrap, unitItems, selection, (pick) => pickUnit(pick), "right");
  keepKeys(input);

  /** The field's whole CSS value. */
  const full = () => {
    const p = parse(input.value);
    if (!p) return input.value.trim();
    return `${p.n}${p.unit || (noDropdown ? "" : unit)}`;
  };
  /** Show `v`: a number goes in the input and its unit in the dropdown. */
  const show = (v: string) => {
    const p = parse(v);
    input.value = p ? String(p.n) : v;
    if (p && (p.unit || noDropdown)) unit = p.unit;
    if (!noDropdown) fillUnits();
  };
  show(value);
  const current = () => parse(full()) ?? parse(opts.computed) ?? { n: 0, unit: unitDefault };
  const clamp = (n: number) => (opts.min !== undefined ? Math.max(opts.min, n) : n);

  // One click puts the whole number up for replacing: select it on focus,
  // and don't let that click's mouseup drop the selection to a caret.
  let hasFocus = false;
  let clicked = false;
  input.addEventListener("mousedown", () => (clicked = !hasFocus));
  input.addEventListener("focus", () => {
    hasFocus = true;
    input.select();
  });
  input.addEventListener("blur", () => (hasFocus = false));
  input.addEventListener("mouseup", (e) => {
    if (clicked) e.preventDefault();
    clicked = false;
  });

  input.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.key === "Enter") {
      input.blur();
    } else if (k.key === "ArrowUp" || k.key === "ArrowDown") {
      k.preventDefault();
      const { n, unit: cu } = current();
      const u = cu || (noDropdown ? "" : unit);
      const one = stepFor(u, step);
      const s = one * (k.shiftKey ? 10 : 1);
      const v = fmt(clamp(nudge(n, k.key === "ArrowUp" ? s : -s, one)), u, one);
      show(v);
      input.select();
      onValue(v, true);
    }
  });
  input.addEventListener("change", () => {
    const v = full();
    show(v);
    onValue(v, true);
  });
  const pickUnit = (pick: string) => {
    let v: string;
    if (pick.startsWith(KW)) {
      v = pick.slice(KW.length);
    } else {
      // Same number, new unit; from a keyword, start at the computed number.
      // A unitless line-height from "normal" starts at its usual 1.2.
      const p = parse(input.value) ?? parse(opts.computed) ?? { n: pick === "" ? 1.2 : 0, unit: pick };
      unit = pick;
      v = `${p.n}${pick}`;
    }
    show(v);
    onValue(v, true);
  };

  grip.addEventListener("pointerdown", (e) => {
    const p = e as PointerEvent;
    p.preventDefault();
    grip.setPointerCapture(p.pointerId);
    const start = current();
    const x0 = p.clientX;
    const first = full();
    let last = first;
    const u = start.unit || (noDropdown ? "" : unit);
    const one = stepFor(u, step);
    // Steps accumulate from each move, so pressing or releasing Alt or Shift
    // mid-drag changes the rate from there on without a jump.
    let n = start.n;
    let px = x0;
    let carry = 0;
    const move = (ev: PointerEvent) => {
      carry += (ev.clientX - px) / (ev.altKey ? PX_PER_STEP_FINE : PX_PER_STEP);
      px = ev.clientX;
      const steps = Math.trunc(carry);
      if (!steps) return;
      carry -= steps;
      n = clamp(nudge(n, steps * one * (ev.shiftKey ? 10 : 1), one));
      const v = fmt(n, u, one);
      if (v !== last) {
        last = v;
        show(v);
        onValue(v, false);
      }
    };
    const up = () => {
      grip.removeEventListener("pointermove", move as EventListener);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      if (last !== first) onValue(last, true);
    };
    grip.addEventListener("pointermove", move as EventListener);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  return wrap;
}

/**
 * A property's keyword values in a Spark-styled menu (not the native list,
 * which ignores the theme). `hints` add a dim note to an option (700: Bold).
 */
export function selectField(value: string, options: string[], changed: boolean, onValue: OnValue, hints: Record<string, string> = {}): HTMLElement {
  const all = options.includes(value) || !value ? options : [value, ...options];
  let current = value;
  const text = h("span", { class: "sel-v" });
  const hint = h("span", { class: "sel-h" });
  const btn = h("button", { class: `select${changed ? " changed" : ""}`, type: "button" }, text, hint, icon("chevron-down", 12));
  const show = () => {
    text.textContent = current;
    hint.textContent = hints[current] ?? "";
  };
  show();
  const wrap = h("div", { class: "sel" }, btn);
  menuButton(
    btn,
    wrap,
    () => all.map((o) => ({ value: o, label: o, hint: hints[o] })),
    () => current,
    (v) => {
      current = v;
      show();
      onValue(v, true);
    },
    "left",
  );
  return wrap;
}

export function textField(value: string, changed: boolean, onValue: OnValue): HTMLElement {
  const input = h("input", { value, spellcheck: "false", class: changed ? "changed" : "" }) as HTMLInputElement;
  keepKeys(input);
  input.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && input.blur());
  input.addEventListener("change", () => onValue(input.value.trim(), true));
  return input;
}

// ---------------------------------------------------------------------------
// Menu: Spark's own dropdown list

export type MenuItem = { value: string; label: string; hint?: string; group?: string };

/**
 * Make `btn` open a menu of `items()` under `parent` (which must be
 * positioned). Arrow keys move, Enter picks, Esc closes (Spark's own Esc
 * handling closes the open popover first).
 */
export function menuButton(
  btn: HTMLElement,
  parent: HTMLElement,
  items: () => MenuItem[],
  current: () => string | null,
  pick: (value: string) => void,
  align: "left" | "right",
) {
  const open = () => {
    const pop = h("div", { class: `popover menu ${align}`, tabindex: "-1", role: "listbox" });
    const list = items();
    const now = current();
    let group: string | undefined;
    const rows: HTMLElement[] = [];
    for (const it of list) {
      if (it.group && it.group !== group) pop.append(h("div", { class: "menu-group" }, it.group));
      group = it.group;
      const row = h(
        "button",
        { class: `menu-item${it.value === now ? " on" : ""}`, type: "button", role: "option" },
        h("span", { class: "menu-check" }, it.value === now && icon("check", 12)),
        h("span", { class: "menu-label" }, it.label),
        it.hint ? h("span", { class: "menu-hint" }, it.hint) : null,
      );
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        closePopover();
        pick(it.value);
      });
      row.addEventListener("pointermove", () => activate(rows.indexOf(row)));
      rows.push(row);
      pop.append(row);
    }
    let active = Math.max(0, list.findIndex((it) => it.value === now));
    const activate = (i: number) => {
      rows[active]?.classList.remove("active");
      active = (i + rows.length) % rows.length;
      rows[active]?.classList.add("active");
      rows[active]?.scrollIntoView({ block: "nearest" });
    };
    pop.addEventListener("keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === "ArrowDown" || k === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        activate(active + (k === "ArrowDown" ? 1 : -1));
      } else if (k === "Home" || k === "End") {
        e.preventDefault();
        e.stopPropagation();
        activate(k === "Home" ? 0 : rows.length - 1);
      } else if (k === "Enter" || k === " ") {
        e.preventDefault();
        e.stopPropagation();
        rows[active]?.click();
      }
    });
    pop.addEventListener("keyup", (e) => e.stopPropagation());
    // Inside a field's <label>, a click on the menu mustn't focus the field.
    pop.addEventListener("click", (e) => e.preventDefault());
    if (!showPopover(parent, pop)) return;
    btn.classList.add("open");
    new MutationObserver((_, obs) => {
      if (pop.isConnected) return;
      btn.classList.remove("open");
      obs.disconnect();
    }).observe(parent, { childList: true });
    activate(active);
    pop.focus({ preventScroll: true });
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    open();
  });
  btn.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  });
}

// ---------------------------------------------------------------------------
// Color

export type Token = { name: string; value: string };

/** rgb()/rgba() as the shorter hex designers read (#ececec, #4f8cff80); anything else as is. */
export function displayColor(value: string): string {
  const m = value.trim().match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (!m) return value;
  const hex = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  let out = "#" + [m[1], m[2], m[3]].map((x) => hex(Number(x))).join("");
  if (m[4] !== undefined) {
    const a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a < 1) out += hex(a * 255);
  }
  return out;
}

/** A checkerboard under translucent colors, so alpha shows. */
const CHECKER = "repeating-conic-gradient(#808080 0 25%, #c8c8c8 0 50%) 0 0 / 8px 8px";

function paintSwatch(el: HTMLElement, color: string) {
  el.style.background = `linear-gradient(${color}, ${color}), ${CHECKER}`;
}

/** Any CSS color as 0–255 RGB plus 0–1 alpha (the browser parses it). */
function rgbaOf(color: string): [number, number, number, number] {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [0, 0, 0, 1];
  ctx.fillStyle = "#000";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let hue = 0;
  if (d) hue = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [(hue * 60 + 360) % 360, max ? d / max : 0, max];
}

function hexOf(r: number, g: number, b: number, a: number): string {
  const x = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return "#" + x(r) + x(g) + x(b) + (a < 1 ? x(a * 255) : "");
}

/**
 * Spark's color picker: saturation/brightness, hue and alpha, a hex field
 * (#rrggbbaa when translucent) and an opacity %. Emits hex while dragging
 * (`final` false) and on release or a typed value (`final` true).
 */
export function colorPicker(initial: string, onPick: (hex: string, final: boolean) => void): HTMLElement {
  const [r0, g0, b0, a0] = rgbaOf(initial);
  let [hue, sat, val] = rgbToHsv(r0, g0, b0);
  let alpha = Math.round(a0 * 100) / 100;

  const sv = h("div", { class: "cp-sv" });
  const svKnob = h("div", { class: "cp-knob" });
  sv.append(svKnob);
  const hueBar = h("div", { class: "cp-bar cp-hue" });
  const hueKnob = h("div", { class: "cp-thumb" });
  hueBar.append(hueKnob);
  const alphaBar = h("div", { class: "cp-bar cp-alpha" });
  const alphaFill = h("div", { class: "cp-fill" });
  const alphaKnob = h("div", { class: "cp-thumb" });
  alphaBar.append(alphaFill, alphaKnob);
  const hex = h("input", { class: "cp-hex", spellcheck: "false", title: "Hex (#rrggbbaa with alpha)" }) as HTMLInputElement;
  const pct = h("input", { class: "cp-pct", title: "Opacity %" }) as HTMLInputElement;
  keepKeys(hex);
  keepKeys(pct);

  const current = () => {
    const [r, g, b] = hsvToRgb(hue, sat, val);
    return hexOf(r, g, b, alpha);
  };
  const paint = (fields = true) => {
    const [r, g, b] = hsvToRgb(hue, sat, val);
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${hue} 100% 50%)`;
    svKnob.style.left = `${sat * 100}%`;
    svKnob.style.top = `${(1 - val) * 100}%`;
    hueKnob.style.left = `${(hue / 360) * 100}%`;
    alphaFill.style.background = `linear-gradient(to right, rgb(${r} ${g} ${b} / 0), rgb(${r} ${g} ${b}))`;
    alphaKnob.style.left = `${alpha * 100}%`;
    if (fields) {
      hex.value = current();
      pct.value = `${Math.round(alpha * 100)}%`;
    }
  };
  const emit = (final: boolean) => {
    paint();
    onPick(current(), final);
  };

  /** Drag on an area: `at` gets the pointer's position in it as 0–1. */
  const drag = (area: HTMLElement, at: (x: number, y: number) => void) => {
    area.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      area.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const r = area.getBoundingClientRect();
        at(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
      };
      move(e);
      emit(false);
      const onMove = (ev: PointerEvent) => {
        move(ev);
        emit(false);
      };
      const onUp = () => {
        area.removeEventListener("pointermove", onMove);
        area.removeEventListener("pointerup", onUp);
        area.removeEventListener("pointercancel", onUp);
        emit(true);
      };
      area.addEventListener("pointermove", onMove);
      area.addEventListener("pointerup", onUp);
      area.addEventListener("pointercancel", onUp);
    });
  };
  drag(sv, (x, y) => {
    sat = x;
    val = 1 - y;
  });
  drag(hueBar, (x) => {
    hue = Math.min(359.9, x * 360);
  });
  drag(alphaBar, (x) => {
    alpha = Math.round(x * 100) / 100;
  });

  hex.addEventListener("keydown", (e) => {
    if (e.key === "Enter") hex.blur();
  });
  hex.addEventListener("change", () => {
    const v = hex.value.trim();
    const css = /^[0-9a-f]{3,8}$/i.test(v) ? `#${v}` : v;
    if (!CSS.supports("color", css)) return paint();
    const [r, g, b, a] = rgbaOf(css);
    [hue, sat, val] = rgbToHsv(r, g, b);
    alpha = Math.round(a * 100) / 100;
    emit(true);
  });
  pct.addEventListener("keydown", (e) => {
    if (e.key === "Enter") pct.blur();
  });
  pct.addEventListener("change", () => {
    const n = parseFloat(pct.value);
    if (Number.isNaN(n)) return paint();
    alpha = Math.min(100, Math.max(0, n)) / 100;
    emit(true);
  });

  paint();
  return h("div", { class: "cp" }, sv, hueBar, alphaBar, h("div", { class: "cp-fields" }, hex, pct));
}

let openPopover: HTMLElement | null = null;
/** Show `pop` inside `parent` as the one open popover (toggles off when it's already this parent's). */
export function showPopover(parent: HTMLElement, pop: HTMLElement): boolean {
  const mine = openPopover?.parentElement === parent;
  closePopover();
  if (mine) return false;
  pop.addEventListener("click", (e) => e.stopPropagation());
  parent.append(pop);
  openPopover = pop;
  revealPopover(pop);
  return true;
}
/** Scroll a popover into view, but only inside the panel's own scroller: anywhere else
 * (the Ask popup) scrollIntoView would scroll the app or the board's canvas. */
function revealPopover(pop: HTMLElement) {
  const scroller = pop.closest(".body");
  if (!scroller) return;
  const r = pop.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  if (r.bottom > s.bottom) scroller.scrollTop += r.bottom - s.bottom + 8;
}
/** Runs once when the open popover closes (the color picker commits its edit then). */
let onPopoverClose: (() => void) | null = null;

export function closePopover(): boolean {
  if (!openPopover) return false;
  openPopover.remove();
  openPopover = null;
  const done = onPopoverClose;
  onPopoverClose = null;
  // After whatever closed it (often a re-render) has finished.
  if (done) setTimeout(done);
  return true;
}

export function colorField(
  value: string,
  computed: string,
  tokens: Token[],
  changed: boolean,
  onValue: OnValue,
): HTMLElement {
  const swatch = h("button", { class: "swatch", title: "Pick a color", type: "button" });
  paintSwatch(swatch, computed);
  const text = textField(displayColor(value), changed, onValue) as HTMLInputElement;
  const wrap = h("div", { class: "color" }, swatch, text);

  swatch.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasMine = openPopover?.dataset.owner === "1" && openPopover.parentElement === wrap;
    closePopover();
    if (wasMine) return;

    const pop = h("div", { class: "popover" });
    pop.dataset.owner = "1";
    pop.addEventListener("click", (ev) => ev.stopPropagation());
    const set = (v: string, css: string, final: boolean) => {
      text.value = v;
      paintSwatch(swatch, css);
      onValue(v, final);
    };

    if (tokens.length) {
      // The swatches have no room for names: the title names the one under the pointer (else the one in use).
      const bound = tokens.find((t) => value === `var(${t.name})`);
      const name = h("span", { class: "pop-name" });
      const say = (t: Token | undefined) => {
        name.replaceChildren(...(t ? [h("code", {}, t.name), h("span", {}, t.value)] : []));
      };
      say(bound);
      pop.append(h("div", { class: "pop-title" }, h("span", {}, "Variables"), name));
      const grid = h("div", { class: "swatches" });
      grid.addEventListener("pointerleave", () => say(bound));
      for (const t of tokens) {
        const b = h("button", { class: `swatch${t === bound ? " on" : ""}`, title: `${t.name}  ${t.value}` });
        b.addEventListener("pointerenter", () => say(t));
        paintSwatch(b, t.value);
        b.addEventListener("click", () => {
          set(`var(${t.name})`, t.value, true);
          closePopover();
        });
        grid.append(b);
      }
      pop.append(grid);
    }

    // Picking previews live; the edit is saved when the popover closes (saving re-renders the panel).
    let picked: string | null = null;
    pop.append(
      h("div", { class: "pop-title" }, "Custom"),
      colorPicker(computed, (hex) => {
        picked = hex;
        set(hex, hex, false);
      }),
    );

    wrap.append(pop);
    openPopover = pop;
    onPopoverClose = () => {
      if (picked !== null) onValue(picked, true);
    };
    revealPopover(pop);
  });
  return wrap;
}

/** Custom properties on :root whose values are colors. */
export function colorTokens(skip: (n: Node) => boolean): Token[] {
  const out = new Map<string, string>();
  const cs = getComputedStyle(document.documentElement);
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.ownerNode && skip(sheet.ownerNode)) continue;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule) || !/(^|,)\s*(:root|html)\s*($|,)/.test(rule.selectorText)) continue;
      for (const prop of Array.from(rule.style)) {
        if (!prop.startsWith("--")) continue;
        const v = cs.getPropertyValue(prop).trim();
        if (v && CSS.supports("color", v) && !/^-?\d/.test(v)) out.set(prop, v);
      }
    }
  }
  return [...out].map(([name, value]) => ({ name, value }));
}
