// The board's System tab: set up the app's design system step by step.
//
// Overview is the design system checklist: sample data, each foundation's
// token coverage and checks, interaction states, and how far the components
// are. First comes Sample data: the scan only sees what the app renders, and
// an app with no backend shows its empty states, so the frames need sample
// data (sample.ts) first, ideally one frame per sample. Then one
// step per foundation, in the order a design system is built: colors, type,
// spacing, radius, shadows. Each step shows the tokens the app already has
// and the ones Spark suggests from the values it uses (system.ts scans an app
// frame); the person unticks, renames and applies, and Claude rewrites the
// CSS to use them. The last step is Components: Break down
// (components-tab.ts), which builds on the tokens. Every step can be run
// again; the scan always shows what's left.
import { h } from "./fields.ts";
import { icon } from "./theme.ts";
import { getState, setState } from "./state.ts";
import type { Category, CategoryReport, Suggestion, SystemScan } from "./system.ts";

type Step = "overview" | "data" | Category | "components";
const STEPS: Step[] = ["overview", "data", "color", "type", "space", "radius", "shadow", "components"];

const META: Record<Step, { title: string; short: string; about: string }> = {
  overview: {
    title: "Design system",
    short: "Overview",
    about:
      "A design system starts with five foundations, each a small set of named tokens: colors, type, spacing, radius and shadows. Components are built on them. Go through the steps in order, sample data first so the app shows everything it can; Spark suggests tokens from the values the app already uses, and Claude switches the code over to them.",
  },
  data: {
    title: "Sample data",
    short: "Data",
    about:
      "Spark scans what the app renders. Without data the app shows its empty states, and most of its styles never show up: the lists, the cards, the errors. Give it sample data first (a mock backend in spark.setup.tsx), and put each sample on a frame of its own so the scan sees all of them.",
  },
  color: { title: "Colors", short: "Colors", about: "Every color the app paints with, as named roles: background, surface, text, muted text, border, accent, danger. Components use a role, never a hex value." },
  type: { title: "Type", short: "Type", about: "One or two font families, a short scale of sizes and a few weights. Everything that sets text picks from them." },
  space: { title: "Spacing", short: "Spacing", about: "One scale for padding, margins and gaps, on a 4px grid. Values off the grid are merged into the nearest step (that moves things by a pixel or two, so those start unticked)." },
  radius: { title: "Radius", short: "Radius", about: "A few corner radii (small, medium, large, full) instead of a new one per element." },
  shadow: { title: "Shadows", short: "Shadows", about: "A few elevation levels for things that float above the page: menus, dialogs, toasts." },
  components: { title: "Components", short: "Components", about: "" },
};

export const SYSTEM_STYLE = `
  .ds { display: flex; flex-direction: column; min-height: 100%; }
  .ds-steps { display: flex; flex-wrap: wrap; gap: 4px; padding: 10px 12px; border-bottom: 1px solid var(--sp-line); }
  .ds-step {
    display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border: none; border-radius: var(--sp-r-sm);
    background: var(--sp-field); color: var(--sp-text-dim); font: 500 var(--sp-fs-sm)/1 var(--sp-font); cursor: pointer;
  }
  .ds-step:hover { color: var(--sp-text-strong); }
  .ds-step.on { background: var(--sp-line-strong); color: var(--sp-text-strong); }
  .ds-step .n { font: var(--sp-fs-xs) var(--sp-mono); color: var(--sp-text-dim); }
  .ds-step .ok { color: var(--sp-component); display: inline-flex; }
  .ds-step .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--sp-warn); }
  .ds-head { padding: 12px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--sp-line); }
  .ds-title { display: flex; align-items: baseline; gap: 8px; font: 600 var(--sp-fs-lg)/1.2 var(--sp-font); color: var(--sp-text-strong); }
  .ds-title .of { margin-left: auto; font: var(--sp-fs-xs) var(--sp-mono); color: var(--sp-text-dim); }
  .ds-about { color: var(--sp-text-dim); font-size: var(--sp-fs-sm); line-height: 1.5; }
  .ds-bar { height: 4px; border-radius: 2px; background: var(--sp-field); overflow: hidden; }
  .ds-bar > i { display: block; height: 100%; background: var(--sp-component); }
  .ds-checks { display: flex; flex-direction: column; gap: 4px; }
  .ds-check { display: flex; gap: 6px; align-items: flex-start; font-size: var(--sp-fs-sm); color: var(--sp-text); }
  .ds-check .i { flex: none; width: 14px; height: 14px; margin-top: 1px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; }
  .ds-check.ok .i { color: var(--sp-component); }
  .ds-check:not(.ok) .i::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--sp-warn); }
  .ds-check .d { color: var(--sp-text-dim); }
  .ds-sec { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-bottom: 1px solid var(--sp-line); background: var(--sp-surface); font-weight: 600; color: var(--sp-text-strong); }
  .ds-sec .n { margin-left: auto; font: var(--sp-fs-xs) var(--sp-mono); color: var(--sp-text-dim); font-weight: 400; }
  .ds-row { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 5px 12px; border-bottom: 1px solid var(--sp-line); }
  .ds-row:hover { background: var(--sp-surface); }
  .ds-row.off { opacity: .55; }
  .ds-sw { flex: none; width: 18px; height: 18px; border-radius: 4px; box-shadow: inset 0 0 0 1px var(--sp-line-strong); }
  .ds-sws { flex: none; display: flex; }
  .ds-sws .ds-sw + .ds-sw { margin-left: -6px; }
  .ds-val { min-width: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--sp-fs-xs) var(--sp-mono); color: var(--sp-text); }
  .ds-to { flex: none; color: var(--sp-text-dim); display: inline-flex; }
  .ds-name {
    flex: 1; min-width: 0; height: 22px; padding: 0 6px; border: 1px solid transparent; border-radius: var(--sp-r-sm); background: var(--sp-field);
    color: var(--sp-text-strong); font: var(--sp-fs-xs) var(--sp-mono); outline: none;
  }
  .ds-name:focus { border-color: var(--sp-accent); }
  .ds-name.existing { background: none; color: var(--sp-component); padding: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 22px; }
  .ds-uses { flex: none; font: var(--sp-fs-xs) var(--sp-mono); color: var(--sp-text-dim); }
  .ds-look { flex: none; font-size: var(--sp-fs-xs); color: var(--sp-warn); }
  .ds-box {
    flex: none; box-sizing: border-box; width: 14px; min-width: 14px; height: 14px; padding: 0; display: inline-flex; align-items: center; justify-content: center;
    border: 1.5px solid var(--sp-line-strong); border-radius: 3px; background: none; color: var(--sp-text-strong); cursor: pointer;
  }
  .ds-box.on { background: var(--sp-accent); border-color: var(--sp-accent); }
  .ds-empty { padding: 14px 12px; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); line-height: 1.5; }
  .ds-ov { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--sp-line); cursor: pointer; }
  .ds-ov:hover { background: var(--sp-surface); }
  .ds-ov .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .ds-ov .top { display: flex; align-items: baseline; gap: 6px; }
  .ds-ov .nm { font-weight: 600; color: var(--sp-text-strong); }
  .ds-ov .pc { margin-left: auto; font: var(--sp-fs-xs) var(--sp-mono); color: var(--sp-text-dim); }
  .ds-ov .d { color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
  .ds-frame { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sp-text-strong); }
  .ds-pick {
    flex: none; max-width: 50%; height: 22px; padding: 0 4px; border: 1px solid transparent; border-radius: var(--sp-r-sm);
    background: var(--sp-field); color: var(--sp-text-strong); font: var(--sp-fs-xs) var(--sp-font);
  }
  .ds-ov .d.warn { color: var(--sp-warn); }
  .ds-foot { position: sticky; bottom: 0; margin-top: auto; padding: 10px 12px; border-top: 1px solid var(--sp-line); background: var(--sp-bg); display: flex; flex-wrap: wrap; gap: 6px; }
`;

export type SystemDeps = {
  /** Scan the app (its first app frame); null when none is loaded. */
  scan: () => SystemScan | null;
  send: (event: string, data: unknown) => void;
  /** Outline the elements these rules and inline styles style; [] clears. */
  highlight: (places: { selector: string }[]) => void;
  /** The Components step's content (Break down). */
  components: HTMLElement;
  /** How far the components are: done of all planned and existing. */
  componentsProgress: () => { done: number; all: number };
  /** The app frames and their sample data. */
  data: () => DataInfo;
  /** Run that app frame on this sample. */
  setSample: (frame: string, sample: string) => void;
  /** Claude writes sample data, or answers the calls nothing answers yet (the Data row's button). */
  writeSamples: () => void;
  /** Add an app frame for each sample no frame runs on. */
  everySample: () => void;
};

export type DataFrame = {
  id: string;
  name: string;
  /** The samples spark.setup has (undefined: the frame hasn't loaded yet). */
  samples?: string[];
  /** The one it runs on (null: none). */
  sample: string | null;
  /** The app's calls that no sample answers. */
  missing: string[];
};
export type DataInfo = { frames: DataFrame[]; writing: boolean };

/** A sample named like an empty state: fine to have, but not the only one to scan. */
const EMPTYISH = /empty|blank|none|nothing|zero|fresh|first.?run|onboard|new.?user/i;

type DataStatus = { ok: boolean; loading: boolean; checks: { label: string; ok: boolean; detail: string }[]; all: string[]; shown: string[]; missing: string[] };

function dataStatus(d: DataInfo): DataStatus {
  const loading = d.frames.some((f) => f.samples === undefined);
  const all = [...new Set(d.frames.flatMap((f) => f.samples ?? []))];
  const shown = [...new Set(d.frames.map((f) => f.sample).filter((s): s is string => !!s))];
  const missing = [...new Set(d.frames.flatMap((f) => f.missing))];
  const full = shown.filter((s) => !EMPTYISH.test(s));
  const checks = [
    {
      label: "Sample data",
      ok: all.length > 0,
      detail: all.length ? `${all.length} sample${all.length === 1 ? "" : "s"}: ${all.join(", ")}` : loading ? "Loading…" : "None: the app's own backend calls get no answer, so it shows its empty states",
    },
    {
      label: "Every call answered",
      ok: !missing.length,
      detail: missing.length ? `No answer for ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ` and ${missing.length - 4} more` : ""}: those parts stay empty` : "Nothing the app called went unanswered",
    },
    {
      label: "Not only empty states",
      ok: !shown.length || full.length > 0,
      detail: shown.length && !full.length ? `The frames run on ${shown.join(", ")}, which looks like an empty state` : "A frame runs on data that fills the app",
    },
    {
      label: "Every sample on a frame",
      ok: all.every((s) => shown.includes(s)),
      detail: all.every((s) => shown.includes(s)) ? (all.length ? "The scan sees all of them" : "Nothing to show yet") : `Not on the board, so not scanned: ${all.filter((s) => !shown.includes(s)).join(", ")}`,
    },
  ];
  return { ok: checks.every((c) => c.ok), loading, checks, all, shown, missing };
}

type Choice = { on: boolean; name: string };

export function systemTab(deps: SystemDeps) {
  const el = h("div", { class: "ds" });
  const saved = getState<{ step?: Step }>("system");
  let step: Step = saved?.step && STEPS.includes(saved.step) ? saved.step : "overview";
  let scan: SystemScan | null = null;
  let busy = false;
  let dataTimer: ReturnType<typeof setTimeout> | undefined;
  /** The person's choices on suggestions, by suggestion id + its values (a rescan keeps them while the values are the same). */
  const choices = new Map<string, Choice>();
  const keyOf = (s: Suggestion) => `${s.id}|${s.values.join(",")}`;
  const choice = (s: Suggestion): Choice => {
    const k = keyOf(s);
    let c = choices.get(k);
    if (!c) choices.set(k, (c = { on: !s.changesLook, name: s.name }));
    return c;
  };

  const pct = (r: CategoryReport) => (r.uses ? Math.round((r.tokenUses / r.uses) * 100) : 100);
  const allOk = (r: CategoryReport) => r.checks.every((c) => c.ok);

  function rescan() {
    try {
      scan = deps.scan();
    } catch (err) {
      console.warn("[spark] design system scan failed", err);
      scan = null;
    }
  }

  function go(s: Step) {
    step = s;
    setState("system", { step });
    deps.highlight([]);
    if (s !== "components") rescan();
    render();
    el.closest(".side-body")?.scrollTo({ top: 0 });
  }

  function stepper() {
    const bar = h("div", { class: "ds-steps", role: "tablist" });
    STEPS.forEach((s, i) => {
      const r = scan && s !== "overview" && s !== "data" && s !== "components" ? scan.categories[s] : null;
      const ok = s === "data" ? (dataStatus(deps.data()).ok ? true : false) : r ? allOk(r) : null;
      const mark = ok === null ? null : ok ? h("span", { class: "ok" }, icon("check", 11)) : h("span", { class: "dot" });
      const b = h("button", { class: `ds-step${s === step ? " on" : ""}`, role: "tab", title: META[s].title }, i ? h("span", { class: "n" }, String(i)) : null, META[s].short, mark);
      b.addEventListener("click", () => go(s));
      bar.append(b);
    });
    return bar;
  }

  function checksEl(r: CategoryReport) {
    return h(
      "div",
      { class: "ds-checks" },
      ...r.checks.map((c) => h("div", { class: `ds-check${c.ok ? " ok" : ""}` }, h("span", { class: "i" }, c.ok ? icon("check", 11) : null), h("span", {}, `${c.label}: `, h("span", { class: "d" }, c.detail)))),
    );
  }

  function swatches(cat: Category, values: string[]) {
    if (cat !== "color") return null;
    return h("span", { class: "ds-sws" }, ...values.slice(0, 4).map((v) => h("span", { class: "ds-sw", style: `background: ${v.replace(/[;"]/g, "")}` })));
  }

  function overview() {
    const parts: HTMLElement[] = [h("div", { class: "ds-head" }, h("div", { class: "ds-title" }, META.overview.title), h("div", { class: "ds-about" }, META.overview.about))];
    // Sample data first: what the scan below is worth depends on it.
    const ds = dataStatus(deps.data());
    const bad = ds.checks.find((x) => !x.ok);
    const dp = ds.all.length ? Math.round((ds.shown.filter((s) => ds.all.includes(s)).length / ds.all.length) * 100) : 0;
    const dataRow = h(
      "div",
      { class: "ds-ov", title: "Open the Sample data step" },
      h("span", { class: `ds-check${ds.ok ? " ok" : ""}` }, h("span", { class: "i" }, ds.ok ? icon("check", 11) : null)),
      h(
        "div",
        { class: "main" },
        h("div", { class: "top" }, h("span", { class: "nm" }, META.data.title), h("span", { class: "pc" }, ds.all.length ? `${ds.shown.length} of ${ds.all.length} on the board` : "none")),
        h("div", { class: "ds-bar" }, h("i", { style: `width: ${dp}%` })),
        h("div", { class: `d${bad ? " warn" : ""}` }, bad ? `${bad.label}: ${bad.detail}. The scans below miss what only shows with data.` : "Done"),
      ),
      icon("chevron-right", 13),
    );
    dataRow.addEventListener("click", () => go("data"));
    parts.push(dataRow);
    if (!scan) {
      parts.push(h("div", { class: "ds-empty" }, "Open an app frame on the board to scan the app."));
      return parts;
    }
    for (const c of ["color", "type", "space", "radius", "shadow"] as Category[]) {
      const r = scan.categories[c];
      const bad = r.checks.find((x) => !x.ok);
      const p = pct(r);
      const row = h(
        "div",
        { class: "ds-ov", title: `Open the ${META[c].title} step` },
        h("span", { class: `ds-check${allOk(r) ? " ok" : ""}` }, h("span", { class: "i" }, allOk(r) ? icon("check", 11) : null)),
        h(
          "div",
          { class: "main" },
          h("div", { class: "top" }, h("span", { class: "nm" }, META[c].title), h("span", { class: "pc" }, `${r.tokens.length} token${r.tokens.length === 1 ? "" : "s"} · ${p}%`)),
          h("div", { class: "ds-bar" }, h("i", { style: `width: ${p}%` })),
          h("div", { class: "d" }, bad ? `${bad.label}: ${bad.detail}` : r.suggestions.length ? `${r.suggestions.length} suggestion${r.suggestions.length === 1 ? "" : "s"} left` : "Done"),
        ),
        icon("chevron-right", 13),
      );
      row.addEventListener("click", () => go(c));
      parts.push(row);
    }
    // Interaction states, per kind of control.
    const s = scan.states;
    const stateChecks = [
      { label: "Hover", ok: s.hover === s.kinds, detail: `${s.hover} of ${s.kinds} kinds of control have a hover style` },
      { label: "Focus", ok: s.focus === s.kinds, detail: `${s.focus} of ${s.kinds} have a visible focus style` },
      { label: "Disabled", ok: s.disabled === s.disabledKinds, detail: `${s.disabled} of ${s.disabledKinds} buttons and fields have a disabled style` },
    ];
    parts.push(
      h("div", { class: "ds-sec" }, "States", h("span", { class: "n" }, "buttons, links, fields")),
      h(
        "div",
        { class: "ds-head", title: s.missing.length ? `Missing:\n${s.missing.join("\n")}` : "" },
        h("div", { class: "ds-checks" }, ...stateChecks.map((c) => h("div", { class: `ds-check${c.ok ? " ok" : ""}` }, h("span", { class: "i" }, c.ok ? icon("check", 11) : null), h("span", {}, `${c.label}: `, h("span", { class: "d" }, c.detail))))),
        s.missing.length ? h("div", { class: "ds-about" }, `Ask Claude to add the missing ones on a component's frame, or in its Break down build. Missing: ${s.missing.slice(0, 4).join(", ")}${s.missing.length > 4 ? "…" : ""}`) : null,
      ),
    );
    const cp = deps.componentsProgress();
    const comp = h(
      "div",
      { class: "ds-ov", title: "Open the Components step" },
      h("span", { class: `ds-check${cp.all && cp.done === cp.all ? " ok" : ""}` }, h("span", { class: "i" }, cp.all && cp.done === cp.all ? icon("check", 11) : null)),
      h(
        "div",
        { class: "main" },
        h("div", { class: "top" }, h("span", { class: "nm" }, "Components"), h("span", { class: "pc" }, cp.all ? `${cp.done} of ${cp.all}` : "not planned")),
        h("div", { class: "ds-bar" }, h("i", { style: `width: ${cp.all ? Math.round((cp.done / cp.all) * 100) : 0}%` })),
        h("div", { class: "d" }, cp.all ? "Built or already a component, of those planned" : "Break the app down into components once the foundations are in"),
      ),
      icon("chevron-right", 13),
    );
    comp.addEventListener("click", () => go("components"));
    parts.push(comp);
    return parts;
  }

  function data() {
    const d = deps.data();
    const ds = dataStatus(d);
    const parts: HTMLElement[] = [
      h(
        "div",
        { class: "ds-head" },
        h("div", { class: "ds-title" }, META.data.title, h("span", { class: "of" }, ds.all.length ? `${ds.shown.length} of ${ds.all.length} on the board` : "")),
        h("div", { class: "ds-about" }, META.data.about),
        h("div", { class: "ds-checks" }, ...ds.checks.map((c) => h("div", { class: `ds-check${c.ok ? " ok" : ""}` }, h("span", { class: "i" }, c.ok ? icon("check", 11) : null), h("span", {}, `${c.label}: `, h("span", { class: "d" }, c.detail))))),
      ),
      h("div", { class: "ds-sec" }, "App frames", h("span", { class: "n" }, String(d.frames.length))),
    ];
    for (const f of d.frames) {
      const names = f.samples ?? [];
      let pick: HTMLElement;
      if (names.length) {
        const sel = h("select", { class: "ds-pick", title: "The sample this frame's app runs on; picking one starts it over on it" }, ...names.map((n) => h("option", { value: n }, n))) as HTMLSelectElement;
        sel.value = f.sample ?? "";
        sel.addEventListener("change", () => {
          deps.setSample(f.id, sel.value);
          sel.blur();
        });
        pick = sel;
      } else pick = h("span", { class: "ds-val" }, f.samples ? "no sample data" : "loading…");
      parts.push(
        h(
          "div",
          { class: "ds-row", title: f.missing.length ? `No answer for ${f.missing.join(", ")}` : "" },
          h("span", { class: "ds-frame" }, f.name),
          pick,
          f.sample && EMPTYISH.test(f.sample) ? h("span", { class: "ds-look", title: "Looks like an empty state" }, "empty") : null,
          f.missing.length ? h("span", { class: "ds-look", title: `No answer for ${f.missing.join(", ")}` }, `${f.missing.length} unanswered`) : null,
        ),
      );
    }
    // Write or complete the data, or put the samples on the board; then on to the foundations.
    const foot = h("div", { class: "ds-foot" });
    const need = !ds.loading && (!ds.all.length || ds.missing.length > 0);
    if (need || d.writing) {
      const write = h(
        "button",
        { class: "sp-btn primary wide", title: "Claude writes a mock backend for the app in spark.setup.tsx (a chat in Chats)" },
        icon("braces", 13),
        d.writing ? "Claude is writing sample data…" : ds.all.length ? `Answer ${ds.missing.length} call${ds.missing.length === 1 ? "" : "s"} with Claude` : "Write sample data with Claude",
      ) as HTMLButtonElement;
      write.disabled = d.writing || busy;
      write.addEventListener("click", () => deps.writeSamples());
      foot.append(write);
    }
    const unshown = ds.all.filter((s) => !ds.shown.includes(s));
    if (unshown.length) {
      const every = h("button", { class: `sp-btn${need || d.writing ? "" : " primary wide"}`, title: `Add an app frame for ${unshown.join(", ")}` }, icon("plus", 13), `Frame for each sample (${unshown.length})`);
      every.addEventListener("click", () => deps.everySample());
      foot.append(every);
    }
    const nextBtn = h("button", { class: "sp-btn", title: `Next: ${META.color.title}` }, "Next", icon("chevron-right", 13));
    nextBtn.addEventListener("click", () => go("color"));
    foot.append(nextBtn);
    parts.push(foot);
    return parts;
  }

  function foundation(c: Category) {
    const parts: HTMLElement[] = [];
    if (!scan) return [h("div", { class: "ds-empty" }, "Open an app frame on the board to scan the app.")];
    const r = scan.categories[c];
    const p = pct(r);
    parts.push(
      h(
        "div",
        { class: "ds-head" },
        h("div", { class: "ds-title" }, META[c].title, h("span", { class: "of" }, `${p}% through tokens`)),
        h("div", { class: "ds-bar" }, h("i", { style: `width: ${p}%` })),
        h("div", { class: "ds-about" }, META[c].about),
        checksEl(r),
      ),
    );
    // What it has.
    parts.push(h("div", { class: "ds-sec" }, "Tokens", h("span", { class: "n" }, String(r.tokens.length))));
    if (!r.tokens.length) parts.push(h("div", { class: "ds-empty" }, "None yet."));
    for (const t of [...r.tokens].sort((a, b) => b.uses - a.uses)) {
      parts.push(h("div", { class: "ds-row", title: `${t.selector} in ${t.file ?? "?"}` }, swatches(c, [t.value]), h("span", { class: "ds-name existing" }, t.name), h("span", { class: "ds-val" }, t.value), h("span", { class: "ds-uses" }, `${t.uses}×`)));
    }
    // What Spark suggests.
    parts.push(h("div", { class: "ds-sec" }, "Suggested", h("span", { class: "n" }, `${r.suggestions.length} · ${r.literals} literal value${r.literals === 1 ? "" : "s"}`)));
    if (!r.suggestions.length) parts.push(h("div", { class: "ds-empty" }, r.uses ? "Every value goes through a token." : "The app doesn't set any of these yet."));
    for (const s of r.suggestions) {
      const ch = choice(s);
      const box = h("button", { class: `ds-box${ch.on ? " on" : ""}`, title: ch.on ? "Ticked: Apply switches these to the token" : "Unticked: Apply leaves these as they are" }, ch.on ? icon("check", 11) : null);
      box.addEventListener("click", () => {
        ch.on = !ch.on;
        render();
      });
      const name = s.existing
        ? h("span", { class: "ds-name existing", title: "Already a token: Apply uses it here" }, s.existing)
        : (h("input", { class: "ds-name", value: ch.name, spellcheck: "false", title: "The new token's name" }) as HTMLInputElement);
      if (name instanceof HTMLInputElement) {
        name.addEventListener("keydown", (e) => e.stopPropagation());
        name.addEventListener("input", () => {
          let v = name.value.trim().replace(/[^\w-]/g, "-");
          if (v && !v.startsWith("--")) v = `--${v.replace(/^-+/, "")}`;
          ch.name = v;
        });
      }
      const row = h(
        "div",
        { class: `ds-row${ch.on ? "" : " off"}`, title: `${s.values.join(", ")} → ${s.value}\n${s.uses} use${s.uses === 1 ? "" : "s"}: ${[...new Set(s.places.map((x) => x.selector))].slice(0, 8).join(", ")}` },
        box,
        swatches(c, s.values),
        h("span", { class: "ds-val" }, s.values.join(", ")),
        h("span", { class: "ds-to" }, icon("chevron-right", 11)),
        name,
        s.changesLook ? h("span", { class: "ds-look", title: `Merges near values into ${s.value}: they'll look slightly different` }, "≈") : null,
        h("span", { class: "ds-uses" }, `${s.uses}×`),
      );
      row.addEventListener("mouseenter", () => deps.highlight(s.places));
      row.addEventListener("mouseleave", () => deps.highlight([]));
      parts.push(row);
    }
    // Apply, rescan, next.
    const picked = r.suggestions.filter((s) => choice(s).on);
    const apply = h("button", { class: "sp-btn primary wide", title: "Claude defines the new tokens and uses them in place of these values" }, icon("braces", 13), picked.length ? `Apply ${picked.length} with Claude` : "Nothing ticked") as HTMLButtonElement;
    apply.disabled = busy || !picked.length;
    apply.addEventListener("click", () => {
      if (busy || !scan) return;
      const existing = new Set(scan.categories[c].tokens.map((t) => t.name));
      const items = picked.map((s) => {
        const name = s.existing ?? choice(s).name;
        return { id: s.id, name, create: !s.existing && !existing.has(name), value: s.value, values: s.values, places: s.places };
      });
      deps.send("spark:system-apply", { step: META[c].title, home: scan.home, items });
    });
    const again = h("button", { class: "sp-btn", title: "Scan the app again" }, icon("rotate-ccw", 13));
    again.addEventListener("click", () => {
      rescan();
      render();
    });
    const next = STEPS[STEPS.indexOf(c) + 1];
    const nextBtn = h("button", { class: "sp-btn", title: `Next: ${META[next].title}` }, "Next", icon("chevron-right", 13));
    nextBtn.addEventListener("click", () => go(next));
    parts.push(h("div", { class: "ds-foot" }, apply, again, nextBtn));
    return parts;
  }

  function render() {
    // Typing a token's name: a rescan or a run update doesn't take the field away.
    const active = (el.getRootNode() as Document | ShadowRoot).activeElement;
    if (active && el.contains(active) && active.classList.contains("ds-name")) return;
    const body = step === "overview" ? overview() : step === "data" ? data() : step === "components" ? [deps.components] : foundation(step);
    el.replaceChildren(stepper(), ...body);
  }
  render();

  return {
    el,
    /** The tab came into view: scan again (the code may have changed). */
    shown() {
      if (step !== "components") rescan();
      render();
    },
    /** Claude applied tokens: scan again once the CSS has reloaded. */
    applied() {
      setTimeout(() => {
        rescan();
        render();
      }, 1200);
    },
    go,
    /** The app frames or their samples changed: scan again, they render other things now. */
    framesChanged() {
      if (step === "components") return;
      if (dataTimer) clearTimeout(dataTimer);
      dataTimer = setTimeout(() => {
        rescan();
        render();
      }, 300);
    },
    setBusy(b: boolean) {
      if (busy === b) return;
      busy = b;
      render();
    },
    /** How many suggestions are left over all foundations (the tab's count). */
    left: () => (scan ? (["color", "type", "space", "radius", "shadow"] as Category[]).reduce((n, c) => n + (scan!.categories[c].suggestions.length ? 1 : 0), 0) : 0),
  };
}
