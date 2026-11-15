// The board's Components tab (sidebar.ts): Break down into components.
//
// Pick what to break down (Break down… on a frame, a variant box or an
// element, or the whole app from here), how deep (regions, parts, down to
// primitives), and Plan: Claude writes the plan into .spark/components.json
// (breakdown.ts), which this tab shows as a tree per area of concern. Untick
// what shouldn't be split, double-click a name to rename it, hover a row to see
// its elements on the canvas, then Build: the ticked ones, one area at a time,
// Primitives first. Running it again continues: built and existing components
// stay, only what's left is proposed.
import { h } from "./fields.ts";
import { icon } from "./theme.ts";

type Level = "region" | "part" | "primitive";
type Status = "exists" | "planned" | "built" | "skipped";
export type PlanComponent = {
  id: string;
  name: string;
  level: Level;
  status: Status;
  area: string;
  parent: string | null;
  file: string | null;
  covers: string[];
  variants: Record<string, string[]>;
  states: string[];
  inline: string[];
  why: string;
  note?: string;
};
export type Depth = "regions" | "parts" | "primitives";
export type BreakdownTarget = { label: string; kind: "frame" | "case" | "element"; src?: string | null; comp?: string | null; file?: string | null; outline?: string };

export const COMPONENTS_STYLE = `
  .bd { display: flex; flex-direction: column; min-height: 100%; }
  .bd-head { padding: 12px; border-bottom: 1px solid var(--sp-line); display: flex; flex-direction: column; gap: 10px; }
  .bd-label { color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
  .bd-target { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .bd-target .chip {
    display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 24px; padding: 0 8px; border-radius: var(--sp-r-sm);
    background: color-mix(in srgb, var(--sp-component) 18%, var(--sp-field)); color: var(--sp-text-strong); font-weight: 600;
  }
  .bd-target .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bd-target .none { color: var(--sp-text-dim); }
  .bd-seg { display: flex; padding: 2px; gap: 2px; border-radius: var(--sp-r-md); background: var(--sp-field); }
  .bd-seg button {
    flex: 1; height: 24px; border: none; border-radius: var(--sp-r-sm); background: none; color: var(--sp-text-dim);
    font: 500 var(--sp-fs-sm)/1 var(--sp-font); cursor: pointer;
  }
  .bd-seg button:hover { color: var(--sp-text-strong); }
  .bd-seg button.on { background: var(--sp-line-strong); color: var(--sp-text-strong); }
  .bd-hint { color: var(--sp-text-dim); font-size: var(--sp-fs-sm); }
  .bd-check { display: flex; align-items: center; gap: 6px; color: var(--sp-text); font-size: var(--sp-fs-sm); cursor: pointer; }
  .bd-row-btns { display: flex; gap: 6px; }
  .bd-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 12px; border: none;
    border-radius: var(--sp-r-md); background: var(--sp-field); color: var(--sp-text-strong); font: 600 var(--sp-fs-md)/1 var(--sp-font); cursor: pointer;
  }
  .bd-btn.primary { background: var(--sp-accent); color: var(--sp-text-strong); flex: 1; }
  .bd-btn:disabled { opacity: .5; cursor: default; }
  .bd-btn:not(:disabled):hover { filter: brightness(1.12); }
  .bd-sum { padding: 8px 12px; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); border-bottom: 1px solid var(--sp-line); }
  .bd-empty { padding: 16px 14px; color: var(--sp-text-dim); line-height: 1.5; }
  .bd-area { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 8px 0 12px; border-bottom: 1px solid var(--sp-line); background: var(--sp-surface); }
  .bd-area .nm { flex: 1; min-width: 0; font-weight: 600; color: var(--sp-text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bd-area .n { color: var(--sp-text-dim); font: var(--sp-fs-xs) var(--sp-mono); }
  .bd-area .go { height: 22px; padding: 0 8px; font-size: var(--sp-fs-xs); }
  .bd-area.now .nm::after { content: " · building"; color: var(--sp-component); font-weight: 500; }
  .bd-item { display: flex; gap: 8px; padding: 7px 12px 7px calc(12px + var(--d, 0) * 14px); border-bottom: 1px solid var(--sp-line); cursor: default; }
  .bd-item:hover { background: var(--sp-surface); }
  .bd-item.skipped .name { color: var(--sp-text-dim); text-decoration: line-through; }
  .bd-box {
    flex: none; box-sizing: border-box; width: 14px; min-width: 14px; height: 14px; margin-top: 2px; display: inline-flex; align-items: center; justify-content: center; padding: 0;
    border: 1.5px solid var(--sp-line-strong); border-radius: 3px; background: none; color: var(--sp-text-strong); cursor: pointer;
  }
  .bd-box.on { background: var(--sp-accent); border-color: var(--sp-accent); }
  .bd-box.done { background: none; border-color: transparent; color: var(--sp-component); cursor: default; }
  .bd-main { flex: 1; min-width: 0; }
  .bd-top { display: flex; align-items: baseline; gap: 6px; }
  .bd-item .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--sp-text-strong); outline: none; }
  .bd-item .name[contenteditable] { box-shadow: 0 1px 0 var(--sp-accent); overflow: visible; }
  .bd-lv { flex: none; padding: 0 5px; border-radius: var(--sp-r-sm); font: 500 var(--sp-fs-xs)/16px var(--sp-font); background: var(--sp-field); color: var(--sp-text-dim); }
  .bd-st { flex: none; margin-left: auto; font-size: var(--sp-fs-xs); color: var(--sp-text-dim); }
  .bd-st.built, .bd-st.exists { color: var(--sp-component); }
  .bd-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .bd-chip { padding: 0 5px; border-radius: var(--sp-r-sm); background: var(--sp-field); color: var(--sp-text); font: var(--sp-fs-xs)/16px var(--sp-font); }
  .bd-chip.state { color: var(--sp-text-dim); }
  .bd-why { margin-top: 3px; color: var(--sp-text-dim); font-size: var(--sp-fs-sm); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .bd-item:hover .bd-why { -webkit-line-clamp: unset; }
  .bd-note { margin-top: 3px; color: var(--sp-warn); font-size: var(--sp-fs-sm); }
  .bd-foot { position: sticky; bottom: 0; margin-top: auto; padding: 10px 12px; border-top: 1px solid var(--sp-line); background: var(--sp-bg); display: flex; gap: 6px; }
`;

export type ComponentsDeps = {
  send: (event: string, data: unknown) => void;
  /** Outline these elements on the canvas (covers: "src/App.tsx:30" or with a column); [] clears. */
  highlight: (covers: string[]) => void;
  /** Select the first of these elements on the board, in view. */
  reveal: (covers: string[]) => void;
  /** The whole app, as a target, from the first app frame (null when none is loaded). */
  wholeApp: () => BreakdownTarget | null;
};

const LEVEL_WORD: Record<Level, string> = { region: "Region", part: "Part", primitive: "Primitive" };
const STATUS_WORD: Record<Status, string> = { exists: "exists", planned: "to build", built: "built", skipped: "skipped" };

export function componentsTab(deps: ComponentsDeps) {
  const el = h("div", { class: "bd" });
  let target: BreakdownTarget | null = null;
  let depth: Depth = "parts";
  let wide = true;
  let list: PlanComponent[] = [];
  /** Claude is running something (any chat); a plan or build can't start. */
  let busy = false;
  let building: string | null = null;
  let renaming: string | null = null;

  const edit = (edits: { id: string; name?: string; status?: Status }[]) => deps.send("spark:components-edit", { edits });

  function head() {
    const chip = target
      ? h("span", { class: "chip", title: target.src ?? target.file ?? target.label }, icon("component", 12), h("span", {}, target.label))
      : h("span", { class: "none" }, "Nothing picked");
    const whole = h("button", { class: "bd-btn", title: "Break down the whole app, from its first app frame" }, "Whole app");
    whole.addEventListener("click", () => {
      target = deps.wholeApp();
      render();
    });
    const seg = h("div", { class: "bd-seg", role: "radiogroup" });
    for (const [d, label, title] of [
      ["regions", "Regions", "The big areas only: title bar, editor, dialogs"],
      ["parts", "+ Parts", "Regions, and the pieces with their own job inside them"],
      ["primitives", "+ Primitives", "Everything, down to the small atoms reused across the app"],
    ] as const) {
      const b = h("button", { class: d === depth ? "on" : "", title, role: "radio", "aria-checked": String(d === depth) }, label);
      b.addEventListener("click", () => {
        depth = d;
        render();
      });
      seg.append(b);
    }
    const box = h("input", { type: "checkbox" }) as HTMLInputElement;
    box.checked = wide;
    box.addEventListener("change", () => (wide = box.checked));
    const check = h("label", { class: "bd-check", title: "Primitives (buttons, pills, menus) are usually shared by several regions: look for them across the whole app" }, box, "Find primitives across the whole app");
    const plan = h("button", { class: "bd-btn primary", title: "Claude plans the components (nothing in the code changes yet)" }, icon("layers", 13), "Plan") as HTMLButtonElement;
    plan.disabled = !target || busy;
    plan.addEventListener("click", () => {
      if (!target || busy) return;
      deps.send("spark:breakdown-plan", { target, depth, wholeApp: depth === "primitives" && wide });
    });
    const stop = busy ? h("button", { class: "bd-btn", title: "Stop Claude (and the areas still to build)" }, "Stop") : null;
    stop?.addEventListener("click", () => deps.send("spark:stop", {}));
    return h(
      "div",
      { class: "bd-head" },
      h("div", { class: "bd-label" }, "Break down"),
      h("div", { class: "bd-target" }, chip, whole),
      target ? null : h("div", { class: "bd-hint" }, "Right-click a frame, a variant or an element and pick Break down into components, or start from the whole app."),
      seg,
      depth === "primitives" ? check : null,
      h("div", { class: "bd-row-btns" }, plan, stop),
    );
  }

  /** Every component under `parent` in this area, depth first, with how deep it sits. */
  function ordered(area: PlanComponent[]): { c: PlanComponent; d: number }[] {
    const ids = new Set(area.map((c) => c.id));
    const out: { c: PlanComponent; d: number }[] = [];
    const walk = (parent: string | null, d: number) => {
      for (const c of area) {
        const p = c.parent && ids.has(c.parent) ? c.parent : null;
        if (p !== parent || out.some((o) => o.c === c)) continue;
        out.push({ c, d });
        walk(c.id, d + 1);
      }
    };
    walk(null, 0);
    // Anything in a loop of parents: at the end, flat.
    for (const c of area) if (!out.some((o) => o.c === c)) out.push({ c, d: 0 });
    return out;
  }

  function row(c: PlanComponent, d: number) {
    const pick = c.status === "planned" || c.status === "skipped";
    const box = h("button", { class: `bd-box${c.status === "planned" ? " on" : ""}${pick ? "" : " done"}`, title: pick ? (c.status === "planned" ? "Ticked: Build makes it. Untick to keep it as it is." : "Unticked: Build leaves it. Tick to build it.") : c.status === "built" ? "Built" : "Already a component" });
    if (c.status === "planned") box.append(icon("check", 11));
    if (!pick) box.append(icon("check", 13));
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!pick) return;
      c.status = c.status === "planned" ? "skipped" : "planned";
      edit([{ id: c.id, status: c.status }]);
      render();
    });
    const name = h("span", { class: "name", title: "Double-click to rename" }, c.name);
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (!pick) return;
      renaming = c.id;
      name.setAttribute("contenteditable", "plaintext-only");
      name.focus();
      getSelection()?.selectAllChildren(name);
    });
    const finish = (save: boolean) => {
      if (renaming !== c.id) return;
      renaming = null;
      const v = (name.textContent ?? "").trim().replace(/[^A-Za-z0-9_$]/g, "");
      name.removeAttribute("contenteditable");
      if (save && v && v !== c.name) {
        c.name = v;
        edit([{ id: c.id, name: v }]);
      }
      render();
    };
    name.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") finish(false);
    });
    name.addEventListener("blur", () => finish(true));
    const chips = [
      ...Object.entries(c.variants).map(([k, v]) => h("span", { class: "bd-chip", title: `Variant prop ${k}` }, `${k}: ${v.join(" · ")}`)),
      ...c.states.map((s) => h("span", { class: "bd-chip state", title: "State" }, s)),
    ];
    const r = h(
      "div",
      { class: `bd-item ${c.status}`, style: `--d: ${d}`, title: [c.file, c.inline.length ? `Stays inline: ${c.inline.join("; ")}` : ""].filter(Boolean).join("\n") },
      box,
      h(
        "div",
        { class: "bd-main" },
        h("div", { class: "bd-top" }, name, h("span", { class: "bd-lv" }, LEVEL_WORD[c.level]), h("span", { class: `bd-st ${c.status}` }, STATUS_WORD[c.status])),
        chips.length ? h("div", { class: "bd-chips" }, ...chips) : null,
        c.why ? h("div", { class: "bd-why" }, c.why) : null,
        c.note ? h("div", { class: "bd-note" }, `Last build skipped it: ${c.note}`) : null,
      ),
    );
    r.addEventListener("mouseenter", () => deps.highlight(c.covers));
    r.addEventListener("mouseleave", () => deps.highlight([]));
    r.addEventListener("click", () => deps.reveal(c.covers));
    return r;
  }

  function render() {
    if (renaming) return;
    const areas: string[] = [];
    for (const c of list) if (!areas.includes(c.area)) areas.push(c.area);
    areas.sort((a, b) => (a === "Primitives" ? -1 : b === "Primitives" ? 1 : 0));
    const todo = list.filter((c) => c.status === "planned").length;
    const count = (s: Status) => list.filter((c) => c.status === s).length;
    const parts: (HTMLElement | null)[] = [head()];
    if (!list.length) {
      parts.push(h("div", { class: "bd-empty" }, "No plan yet. Pick a depth and Plan: Claude lists the components it would make, following Spark's rules (and your spark.rules.md). Nothing in the code changes until you Build."));
    } else {
      parts.push(h("div", { class: "bd-sum" }, `${list.length} components · ${count("exists") + count("built")} done · ${todo} to build${count("skipped") ? ` · ${count("skipped")} skipped` : ""}`));
      for (const area of areas) {
        const inArea = list.filter((c) => c.area === area);
        const left = inArea.filter((c) => c.status === "planned").length;
        const go = left ? (h("button", { class: "bd-btn go", title: `Build the ${left} ticked in ${area}` }, "Build") as HTMLButtonElement) : null;
        if (go) {
          go.disabled = busy;
          go.addEventListener("click", () => deps.send("spark:breakdown-build", { areas: [area] }));
        }
        parts.push(h("div", { class: `bd-area${building === area ? " now" : ""}` }, h("span", { class: "nm" }, area), h("span", { class: "n" }, `${inArea.length - left}/${inArea.length}`), go));
        for (const { c, d } of ordered(inArea)) parts.push(row(c, d));
      }
      const all = h("button", { class: "bd-btn primary", title: "Build every ticked component, one area at a time, Primitives first" }, icon("component", 13), todo ? `Build ${todo} ticked` : "Nothing to build") as HTMLButtonElement;
      all.disabled = busy || !todo;
      all.addEventListener("click", () => deps.send("spark:breakdown-build", {}));
      parts.push(h("div", { class: "bd-foot" }, all));
    }
    el.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
  }
  render();

  return {
    el,
    /** Break down this (from a frame's, a variant's or an element's Break down…). */
    setTarget(t: BreakdownTarget) {
      target = t;
      // A whole frame starts at regions; one element, at its parts.
      if (t.kind === "frame" && !list.length) depth = "regions";
      render();
    },
    update(components: PlanComponent[]) {
      list = components;
      render();
    },
    setBusy(b: boolean, area: string | null) {
      busy = b;
      building = area;
      render();
    },
    /** How many are ticked to build (the tab's count). */
    todo: () => list.filter((c) => c.status === "planned").length,
  };
}
