// Break down into components. Dev server side (Node).
//
// Two runs, both chats (claude.ts):
// - Plan: Claude reads the selected frame or element and the source, follows
//   the rulebook (RULES, plus the project's own `spark.rules.md`), and writes
//   the components it would make to `.spark/components.plan.json`. Nothing
//   else changes. The plan is merged into `.spark/components.json`, the
//   project's record of its components: what exists, what's planned, built
//   or skipped. Re-running continues from it: built and existing components
//   stay, only what's left is proposed.
// - Build: the planned components the person kept ticked (the Components tab,
//   components-tab.ts), one area at a time, Primitives first. Claude ends
//   with APPLIED <id> / SKIPPED <id>: why per component, which marks them
//   built (or leaves them planned with a note).
//
// components.json is versioned like changes.json (fields are only ever added):
// Claude, the MCP server and later Spark versions read it.
import { existsSync } from "node:fs";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type Level = "region" | "part" | "primitive";
export type Status = "exists" | "planned" | "built" | "skipped";

export type Component = {
  /** Stable id ("button", "titlebar-transport"); kept when the person renames it. */
  id: string;
  name: string;
  level: Level;
  status: Status;
  /** The area of concern it's built in: "Primitives", or a region's name. */
  area: string;
  /** The component it lives inside, by id, or null at the top. */
  parent: string | null;
  /** Where it is (or will be) written, root-relative. */
  file: string | null;
  /** The markup it replaces or is: "src/App.tsx:30" or "src/App.tsx:30:9", one per place it's used. */
  covers: string[];
  /** Variant props and their values: { variant: ["default", "primary"], size: ["large"] }. */
  variants: Record<string, string[]>;
  /** States worth a case: prop states (open, selected, disabled) and interaction states (hover, pressed, focus). */
  states: string[];
  /** Pieces that stay inline in it, and why, in a few words. */
  inline: string[];
  /** Why it's a component (the rule it meets), in one line. */
  why: string;
  /** Claude's note from the last build when it skipped it. */
  note?: string;
};

export type Manifest = { version: 1; updated: number; components: Component[] };

export type Depth = "regions" | "parts" | "primitives";

export type BreakdownTarget = {
  /** What the person picked, as Spark names it: "App frame", "Clip in Lane". */
  label: string;
  kind: "frame" | "case" | "element";
  src?: string | null;
  comp?: string | null;
  /** Component frames: the case file. */
  file?: string | null;
  /** The element tree under it: one line per tagged element, with its source and component. */
  outline?: string;
};

// ---------------------------------------------------------------------------
// The rulebook

/** Spark's default rules. A project adds its own in `spark.rules.md` at its root; those win. */
export const RULES = `# Spark's component rules

## Levels
- region: a big area of a screen, or an overlay that covers it (title bar, editor, status bar, empty state, a dialog,
  a toast). You'd point at it from across the room.
- part: a piece with its own job inside a region (a transport, a document title, a ruler, a clip, a scrollbar). It has a
  name a designer would say and states worth designing.
- primitive: a small atom reused across regions (Button, ToolButton, Pill, Kbd, Menu, MenuItem, Dialog). Often hiding as
  a CSS class with modifiers (\`.btn.primary\`, \`.btn.ghost\`).

## What becomes a component
A piece becomes a component when ANY of these is true:
1. It repeats: the same structure, or the same CSS class with modifiers, appears in 2 or more places.
2. It has a name a designer would use for it.
3. It has variants or states worth designing (primary or ghost, open or closed, selected, disabled, error).
4. It owns behavior: it opens something, drags, keeps its own state.
5. It's a region of a screen or an overlay.

It STAYS INLINE when it's a layout wrapper with no name (a row, a spacing group), plain text, a single element with no
styling of its own, or when splitting it out would mean passing more than about five pieces of the parent's state
through props. Pieces that only make sense inside one component (a clip's trim handles) stay in it, and its cases
show them. Prefer fewer, honest components to many thin ones.

## Variants, states and cases
- A variant is something chosen where the component is used (\`variant="primary"\`, \`size="large"\`). It's a prop, and
  each value gets a case.
- A prop state is something the app sets (\`open\`, \`selected\`, \`disabled\`, \`dirty\`, \`error\`). Also a prop, also a case each.
- Interaction states (hover, pressed, focus) stay CSS (\`:hover\`, \`:active\`, \`:focus-visible\`). Never add a prop just
  to fake them. List them in "states"; Spark shows them on the component's cases.
- VALUE-ONLY DIFFERENCES ARE NOT VARIANTS. Cases that differ only in a text or number the component displays (0.0 dB,
  +6.0 dB, -12.5 dB; one file name or another) are ONE case with realistic sample data. A case earns its place only when
  something you'd design differs: color, size, layout, which elements show.

## Floating pieces (dropdowns, menus, popovers, tooltips, dialogs)
- What floats is its own component, cased on its own: \`Menu\` with \`MenuItem\`, \`MenuHeader\`, \`MenuSeparator\`.
- What opens it (the trigger) is its own component, with its own variants.
- The owner that wires them together gets Closed and Open cases; Open renders the floating piece in place.
- The floating piece lives next to its owner while only that owner uses it, and is a primitive once a second one does.

## Naming and files
- PascalCase nouns for what it IS, not where it sits: \`Button\`, not \`TitleBarButton\`. Parts only one region has may
  carry its name (\`TrackHeader\`).
- Props: \`variant\` for the look, \`size\` for size, booleans for prop states (\`open\`, \`selected\`, \`disabled\`).
- Cases: the variant or state in one or two words: \`Primary\`, \`Ghost\`, \`Large\`, \`Open\`, \`Disabled\`.
- Files go where the project keeps its components; primitives in a \`ui/\` folder inside it. CSS stays where the project
  keeps it, and class names don't change.

## Done means (every component a build makes)
- The app looks exactly the same as before.
- Every place that markup was used now renders the component; no copies are left.
- A \`<Component>.spark.tsx\` next to it: one exported case per variant value and per prop state (not per sample value),
  rendering THE REAL COMPONENT ONLY, never a copy of its markup. A wrapper is allowed only to give it the context it sits
  in, named \`In<Parent>\` (like \`InClip\`). Interaction states need no cases of their own.
- No behavior changes, and no store state threaded into props just to make cases easier: a component that reads a store
  keeps reading it; \`spark.setup.tsx\` at the project root mocks what the cases need.`;

/** The rules for this project: Spark's, then the project's own (spark.rules.md), which win. */
export async function rulesFor(root: string): Promise<string> {
  const own = path.join(root, "spark.rules.md");
  if (!existsSync(own)) return RULES;
  try {
    const text = (await readFile(own, "utf8")).trim();
    return text ? `${RULES}\n\n# This project's own rules (they win where they differ)\n\n${text}` : RULES;
  } catch {
    return RULES;
  }
}

// ---------------------------------------------------------------------------
// components.json

const LEVELS: Level[] = ["region", "part", "primitive"];
const STATUSES: Status[] = ["exists", "planned", "built", "skipped"];

const str = (v: unknown, d = "") => (typeof v === "string" ? v.trim() : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
const slug = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "component";

/** One component as read from a file Claude or a person wrote: anything off is fixed or dropped. */
function normalize(raw: unknown): Component | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name);
  if (!name) return null;
  const variants: Record<string, string[]> = {};
  if (r.variants && typeof r.variants === "object" && !Array.isArray(r.variants)) {
    for (const [k, v] of Object.entries(r.variants as Record<string, unknown>)) {
      const vals = strs(v);
      if (k.trim() && vals.length) variants[k.trim()] = vals;
    }
  }
  const level = LEVELS.includes(r.level as Level) ? (r.level as Level) : "part";
  return {
    id: slug(str(r.id) || name),
    name,
    level,
    status: STATUSES.includes(r.status as Status) ? (r.status as Status) : "planned",
    area: str(r.area) || (level === "primitive" ? "Primitives" : name),
    parent: str(r.parent) ? slug(str(r.parent)) : null,
    file: str(r.file) || null,
    covers: strs(r.covers),
    variants,
    states: strs(r.states),
    inline: strs(r.inline),
    why: str(r.why),
    ...(str(r.note) ? { note: str(r.note) } : {}),
  };
}

function parseManifest(json: unknown): Manifest {
  const list = json && typeof json === "object" && Array.isArray((json as { components?: unknown }).components) ? (json as { components: unknown[] }).components : [];
  const seen = new Set<string>();
  const components: Component[] = [];
  for (const raw of list) {
    const c = normalize(raw);
    if (!c) continue;
    // Two with one id: the second gets a numbered one.
    let id = c.id;
    for (let n = 2; seen.has(id); n++) id = `${c.id}-${n}`;
    seen.add(id);
    components.push({ ...c, id });
  }
  const updated = Number((json as { updated?: unknown })?.updated);
  return { version: 1, updated: Number.isFinite(updated) ? updated : 0, components };
}

/**
 * The new plan into the record. Components the plan names again keep the
 * person's choices (their name, skipped) and what's done (built, exists);
 * the rest of what Claude says about them is refreshed. Ones it doesn't name stay.
 */
export function merge(old: Manifest, plan: Manifest): Manifest {
  const byId = new Map(old.components.map((c) => [c.id, c]));
  const byName = new Map(old.components.map((c) => [c.name.toLowerCase(), c]));
  const out = [...old.components];
  for (const p of plan.components) {
    const was = byId.get(p.id) ?? byName.get(p.name.toLowerCase());
    if (!was) {
      out.push(p);
      byId.set(p.id, p);
      continue;
    }
    const keep = was.status === "built" || was.status === "skipped" || (was.status === "exists" && p.status !== "exists") ? was.status : p.status;
    Object.assign(was, { ...p, id: was.id, name: was.name, status: keep, note: was.note });
  }
  // A parent the plan named by a name the person changed: point it at the id.
  const ids = new Set(out.map((c) => c.id));
  for (const c of out) if (c.parent && !ids.has(c.parent)) c.parent = out.find((x) => slug(x.name) === c.parent)?.id ?? null;
  return { version: 1, updated: Date.now(), components: out };
}

/** Why the record changed: a plan came in, a build marked some built, the person edited it. */
export type ManifestChange = "plan" | "build" | "edit";

export function manifestStore(dir: string, broadcast: (m: Manifest, why: ManifestChange) => void) {
  const file = path.join(dir, "components.json");
  const planFile = path.join(dir, "components.plan.json");
  async function load(): Promise<Manifest> {
    try {
      return parseManifest(JSON.parse(await readFile(file, "utf8")));
    } catch {
      return { version: 1, updated: 0, components: [] };
    }
  }
  async function save(m: Manifest, why: ManifestChange) {
    await mkdir(dir, { recursive: true });
    m.updated = Date.now();
    await writeFile(file, JSON.stringify(m, null, 2) + "\n");
    broadcast(m, why);
  }
  return {
    file,
    planFile,
    load,
    save,
    /** Before a plan run: no stale plan file left from one that was stopped. */
    dropPlan: () => rm(planFile, { force: true }).catch(() => {}),
    /** The person's edits from the Components tab: names and skipped/planned only. */
    async edit(edits: { id: string; name?: string; status?: Status }[]) {
      const m = await load();
      for (const e of edits) {
        const c = m.components.find((x) => x.id === e.id);
        if (!c) continue;
        if (typeof e.name === "string" && e.name.trim()) c.name = e.name.trim();
        // Only a planned one can be skipped and back; built and existing ones are done.
        if ((e.status === "planned" || e.status === "skipped") && (c.status === "planned" || c.status === "skipped")) c.status = e.status;
      }
      await save(m, "edit");
    },
    /** Take Claude's plan file into the record; the number of components it planned, or null when there's none or it's broken. */
    async takePlan(): Promise<{ planned: number; added: number } | null> {
      let plan: Manifest;
      try {
        plan = parseManifest(JSON.parse(await readFile(planFile, "utf8")));
      } catch {
        return null;
      } finally {
        await rm(planFile, { force: true }).catch(() => {});
      }
      const old = await load();
      const before = new Set(old.components.map((c) => c.id));
      const m = merge(old, plan);
      await save(m, "plan");
      return { planned: plan.components.length, added: m.components.filter((c) => !before.has(c.id)).length };
    },
    /** A build's verdicts: applied ones are built, skipped ones stay planned with Claude's reason. */
    async built(applied: string[], skipped: { id: string; why: string }[]) {
      const m = await load();
      for (const c of m.components) {
        if (applied.includes(c.id)) {
          c.status = "built";
          delete c.note;
        }
        const s = skipped.find((x) => x.id === c.id);
        if (s) c.note = s.why;
      }
      await save(m, "build");
    },
  };
}

/** The areas with something ticked to build, in build order: Primitives first, then as the plan lists them. */
export function buildAreas(m: Manifest): string[] {
  const areas: string[] = [];
  for (const c of m.components) if (c.status === "planned" && !areas.includes(c.area)) areas.push(c.area);
  return areas.sort((a, b) => (a === "Primitives" ? -1 : b === "Primitives" ? 1 : 0));
}

// ---------------------------------------------------------------------------
// The prompts

const DEPTH: Record<Depth, string> = {
  regions: "Regions only: the big areas of what's selected. Don't propose parts or primitives yet.",
  parts: "Regions and parts: the big areas, and the pieces with their own job inside them. Don't propose primitives yet.",
  primitives: "Everything, down to primitives: regions, parts, and the small atoms reused across them.",
};

export function planPrompt(o: { rules: string; target: BreakdownTarget; depth: Depth; wholeApp: boolean; manifest: Manifest; planFile: string }) {
  const t = o.target;
  const what =
    t.kind === "frame"
      ? `the whole app as the person sees it in an app frame ("${t.label}")`
      : t.kind === "case"
        ? `the component frame "${t.label}"${t.file ? ` (case file ${t.file})` : ""}`
        : `the element "${t.label}"${t.src ? `, written at ${t.src}` : ""}${t.comp ? ` in the component ${t.comp}` : ""}`;
  const record = o.manifest.components.length
    ? `The project's record of its components so far (.spark/components.json). Keep their ids. Don't propose again what's
"built" or "exists"; list it with that status if it's under the selection, so the plan is complete:
${JSON.stringify(o.manifest.components.map(({ id, name, level, status, area, parent, file }) => ({ id, name, level, status, area, parent, file })), null, 2)}`
    : "Nothing is recorded yet (.spark/components.json is empty).";
  return `You are planning how to break part of this React app into components, for Spark, a visual design tool running
on top of it. Plan only: read the code, change nothing. Follow these rules exactly:

${o.rules}

# The task

Break down ${what}.
Depth: ${DEPTH[o.depth]}${o.wholeApp && o.depth !== "regions" ? "\nAlso look across the WHOLE app for primitives (repeated CSS classes with modifiers, repeated markup), not only under the selection." : ""}
${t.outline ? `\nThe elements under it as rendered right now (source location, and the component that writes each):\n${t.outline}\n` : ""}
${record}

Components that already exist in the code (an exported React component used where it should be) are listed with
status "exists": they count, so the person sees what's left. A component that exists but breaks the rules (for
example a case file that copies markup instead of rendering the component, or cases that only differ by a value)
is "planned" again, with "why" saying what to fix.

Write the plan as JSON to \`${o.planFile}\` and change no other file:

{
  "version": 1,
  "components": [
    {
      "id": "button",                 // short kebab-case, unique; reuse recorded ids
      "name": "Button",
      "level": "primitive",           // "region" | "part" | "primitive"
      "status": "planned",            // "planned" | "exists"
      "area": "Primitives",           // primitives: "Primitives"; anything else: the name of the region it's in
      "parent": null,                 // id of the component it sits inside, null at the top
      "file": "src/components/ui/Button.tsx",
      "covers": ["src/App.tsx:30", "src/components/Dialogs.tsx:36"],   // file:line of each JSX element it replaces or is
      "variants": { "variant": ["default", "primary", "ghost"], "size": ["default", "large"] },
      "states": ["hover", "pressed", "focus", "disabled"],
      "inline": ["icon slot: one svg, no styling of its own"],
      "why": ".btn with modifiers repeats in 4 files"
    }
  ]
}

List parents before their children. Every component under the selection at the chosen depth is in the list, new or
existing. Then end with two or three sentences: what you'd split, and what you'd keep inline and why.`;
}

export function buildPrompt(o: { rules: string; area: string; todo: Component[]; manifest: Manifest }) {
  const done = o.manifest.components.filter((c) => c.status === "built" || c.status === "exists").map(({ id, name, level, file }) => ({ id, name, level, file }));
  return `You are building components in this React app for Spark, a visual design tool running on top of it. The person
reviewed a plan and kept these components. Build them, following these rules exactly:

${o.rules}

# The task: the "${o.area}" area

Build these, children before parents (a component that uses another comes after it):
${JSON.stringify(o.todo, null, 2)}

Components that already exist, to use instead of copying their markup:
${JSON.stringify(done, null, 2)}

For each one:
1. Write the component in \`file\`, with the variant props and prop states listed. Keep the existing CSS and class names.
2. Use it at every place in \`covers\` (and any other copy of that markup you find), so the app renders exactly as before.
3. Write its \`<Name>.spark.tsx\` next to it, following the case rules above.
4. Keep what's listed in \`inline\` inline.

- Follow the project's conventions (read its CLAUDE.md if there is one).
- Don't run builds, tests or dev servers; the dev server is already running and hot-reloads your edits.
- If one can't be built as planned without changing how the app looks or behaves, skip it and say why.

End with a short summary, then one line per component, exactly:
APPLIED <id>
or
SKIPPED <id>: <one-line reason>
for these ids: ${o.todo.map((c) => c.id).join(", ")}.`;
}
