// The panel's input widgets, Figma style.
//
// - number: drag the label (or the field's left edge) to scrub; Alt for fine
//   steps, Shift for big ones; Arrow Up/Down nudge the same way. Typing any
//   CSS value (auto, var(--x), 50%) still works.
// - select: a dropdown of a property's keyword values.
// - color: a swatch that opens token swatches and a color picker.
//
// Every widget calls `onValue(value, final)`: `final` is false while a drag
// is in progress (preview only) and true once the value is settled.

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

function fmt(n: number, unit: string, step: number) {
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return `${Number(n.toFixed(decimals))}${unit}`;
}

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
};

export function numberField(value: string, opts: NumberOpts, onValue: OnValue): HTMLElement {
  const step = opts.step ?? 1;
  const unitDefault = opts.unit ?? "px";
  const input = h("input", { value, spellcheck: "false" }) as HTMLInputElement;
  const grip = h("span", { class: "grip", title: "Drag to change · Alt: fine · Shift: ×10" }, opts.label ?? "↔");
  const wrap = h("label", { class: `num${opts.changed ? " changed" : ""}` }, grip, input);
  keepKeys(input);

  const current = () => parse(input.value) ?? parse(opts.computed) ?? { n: 0, unit: unitDefault };
  const clamp = (n: number) => (opts.min !== undefined ? Math.max(opts.min, n) : n);
  const normalize = (v: string) => {
    const p = parse(v);
    // "12" means 12px for a length.
    return p && !p.unit && unitDefault ? `${p.n}${unitDefault}` : v.trim();
  };

  input.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.key === "Enter") {
      input.blur();
    } else if (k.key === "ArrowUp" || k.key === "ArrowDown") {
      k.preventDefault();
      const { n, unit } = current();
      const s = step * (k.altKey ? 0.1 : 1) * (k.shiftKey ? 10 : 1);
      input.value = fmt(clamp(n + (k.key === "ArrowUp" ? s : -s)), unit || unitDefault, s);
      onValue(input.value, true);
    }
  });
  input.addEventListener("change", () => {
    input.value = normalize(input.value);
    onValue(input.value, true);
  });

  grip.addEventListener("pointerdown", (e) => {
    const p = e as PointerEvent;
    p.preventDefault();
    grip.setPointerCapture(p.pointerId);
    const start = current();
    const x0 = p.clientX;
    let last = input.value;
    const move = (ev: PointerEvent) => {
      const s = step * (ev.altKey ? 0.1 : 1) * (ev.shiftKey ? 10 : 1);
      const n = clamp(start.n + (ev.clientX - x0) * s);
      last = fmt(n, start.unit || unitDefault, s);
      if (last !== input.value) {
        input.value = last;
        onValue(last, false);
      }
    };
    const up = () => {
      grip.removeEventListener("pointermove", move as EventListener);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      if (last !== value) onValue(last, true);
    };
    grip.addEventListener("pointermove", move as EventListener);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  return wrap;
}

export function selectField(value: string, options: string[], changed: boolean, onValue: OnValue): HTMLElement {
  const sel = h("select", { class: changed ? "changed" : "" }) as HTMLSelectElement;
  const all = options.includes(value) || !value ? options : [value, ...options];
  for (const o of all) sel.append(h("option", { value: o, selected: o === value }, o));
  keepKeys(sel);
  sel.addEventListener("change", () => onValue(sel.value, true));
  return sel;
}

export function textField(value: string, changed: boolean, onValue: OnValue): HTMLElement {
  const input = h("input", { value, spellcheck: "false", class: changed ? "changed" : "" }) as HTMLInputElement;
  keepKeys(input);
  input.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && input.blur());
  input.addEventListener("change", () => onValue(input.value.trim(), true));
  return input;
}

// ---------------------------------------------------------------------------
// Color

export type Token = { name: string; value: string };

/** "#rrggbb" for any CSS color the browser understands (alpha dropped), for <input type=color>. */
function toHex(color: string): string {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return "#000000";
  probe.fillStyle = "#000";
  probe.fillStyle = color;
  const v = probe.fillStyle;
  if (v.startsWith("#")) return v;
  const m = v.match(/\d+(\.\d+)?/g);
  if (!m) return "#000000";
  return "#" + m.slice(0, 3).map((x) => Math.round(Number(x)).toString(16).padStart(2, "0")).join("");
}

let openPopover: HTMLElement | null = null;
export function closePopover(): boolean {
  if (!openPopover) return false;
  openPopover.remove();
  openPopover = null;
  return true;
}

export function colorField(
  value: string,
  computed: string,
  tokens: Token[],
  changed: boolean,
  onValue: OnValue,
): HTMLElement {
  const swatch = h("button", { class: "swatch", title: "Pick a color" });
  swatch.style.background = computed;
  const text = textField(value, changed, onValue) as HTMLInputElement;
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
      swatch.style.background = css;
      onValue(v, final);
    };

    if (tokens.length) {
      pop.append(h("div", { class: "pop-title" }, "Tokens"));
      const grid = h("div", { class: "swatches" });
      for (const t of tokens) {
        const b = h("button", { class: `swatch${value === `var(${t.name})` ? " on" : ""}`, title: `${t.name}  ${t.value}` });
        b.style.background = t.value;
        b.addEventListener("click", () => {
          set(`var(${t.name})`, t.value, true);
          closePopover();
        });
        grid.append(b);
      }
      pop.append(grid);
    }

    pop.append(h("div", { class: "pop-title" }, "Custom"));
    const picker = h("input", { type: "color", value: toHex(computed) }) as HTMLInputElement;
    picker.addEventListener("input", () => set(picker.value, picker.value, false));
    picker.addEventListener("change", () => set(picker.value, picker.value, true));
    pop.append(picker);

    wrap.append(pop);
    openPopover = pop;
    pop.scrollIntoView({ block: "nearest" });
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
