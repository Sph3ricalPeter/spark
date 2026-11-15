// The prompts Spark gives Claude. Dev server side.
import type { Change } from "./changes.ts";

const HOW = `How to read a change:
- level "token": set the design token \`property\` to \`to\` where it's defined (\`file\`, rule \`selector\`).
  \`from\` "" means it's a new variable: add it to that rule, next to the related ones.
- level "component": in \`file\`, set \`property\` to \`to\` in the CSS rule \`selector\`.
- level "instance": an override. \`element\` is the DOM element that was edited (\`src\` is file:line:col of its JSX,
  \`comp\` the component it's written in). \`instance.path\` lists its owners from that component up to the root, each
  with the line that renders it (\`call\`) and its React key when it's one of a list. \`instance.scope\` says where the
  change belongs, and \`instance.appliesTo\` says it in words:
  - scope null: only this exact instance. When a list key is involved, the change must apply to that item only
    (for example through the item's data, a prop or a condition on the key), not to every item.
  - scope k ≥ 1: in the source of \`path[k].name\`, for every instance it renders through the calls path[0..k-1].
    Usually a prop, className or style at the call site \`path[k-1].call\`.
  - scope 0: in the component \`path[0].name\` itself, for every instance everywhere: its CSS rule or its JSX.
    With \`instance.variant\` (props such as \`{ "variant": "ghost", "small": true }\`), only for that variant of it:
    every instance given those props. Change the styling the component uses for that variant (for example the
    \`.btn.ghost.small\` rule, a variant map, or a condition on those props), adding it if it doesn't exist yet;
    other variants and the base stay as they are.
- property "text": the element's text becomes \`to\`. The literal may be in the element's JSX or passed in from a
  call site further up (a prop or children); change it where it's written.
- property "children-order": the element's children are shown in the order \`children.order\` (indices into the
  current children); reorder the JSX, or the list they're rendered from.
- property "removed": the element is deleted from the design at that scope. Remove its JSX (or, for one item of
  a list or one instance, the data or prop that renders it, or a condition); don't just hide it with CSS.
- property "icon": the \`<svg>\` icon is swapped for another. \`to\` names the new icon: \`library:Icon\` is that export of
  the icon library (\`lucide-react:Redo2\`: import \`Redo2\` from "lucide-react" and render it in its place, keeping its
  props, className and size); \`inline:<file:line:col>\` is the inline \`<svg>\` written there: draw the same icon (copy
  its JSX, including a flip or turn on the svg itself, or reuse its component if the project has one). \`from\` names
  the icon it replaces the same way. \`iconSvg\` is the new icon's markup as it looks, for reference.
- \`from\` is the value before the edit, to help you find the spot. Line numbers may have shifted slightly.`;

const RULES = `Rules:
- Follow the project's conventions (read its CLAUDE.md if there is one). Prefer existing design tokens and CSS
  classes over inline literals: a style override is usually a CSS rule or a modifier class, not a style={{}}.
- Change only what the changes ask for. Don't reformat, rename or refactor anything else.
- Don't run builds, tests or dev servers; the dev server is already running and hot-reloads your edits.`;

function verdicts(ids: string[]) {
  return `End your reply with one line per change, exactly:
APPLIED <id>
or
SKIPPED <id>: <one-line reason>
for these ids: ${ids.join(", ")}.`;
}

export function implementPrompt(changes: Change[]): string {
  return `You are applying visual edits made in Spark, a visual editor running on top of this React app, to the source.
Each change below was previewed live in the running app; make the code produce exactly that.

${HOW}

${RULES}

Changes (JSON):
${JSON.stringify(changes, null, 2)}

${verdicts(changes.map((c) => c.id))}`;
}

export type AskSelection = {
  tag: string;
  classes: string[];
  src: string | null;
  comp: string | null;
  owners: { name: string; call: string | null; key: string | null }[];
  text?: string;
  /** What the popup calls it ("h2 in Card", "App frame", "Primary in Button"). */
  label?: string;
  /** Not one element but a whole frame on Spark's board, or one variant box of a component frame. */
  target?: AskTarget;
};

type Root = { src: string | null; comp: string | null };
export type AskTarget =
  | {
      kind: "frame";
      name: string;
      /** "app": the app's page at one viewport size; "component": a component's cases (gallery). */
      frame: "app" | "component";
      size: { width: number; height: number };
      url?: string;
      /** Component frames: the case file, its component and its cases (exported function names). */
      file?: string | null;
      component?: string | null;
      cases?: string[];
      roots: Root[];
    }
  | { kind: "case"; name: string; file: string; component: string | null; roots: Root[] };

/** How the prompt introduces what's selected. */
function selected(selection: AskSelection): string {
  const t = selection.target;
  const json = JSON.stringify(selection, null, 2);
  if (!t) {
    return `The person has this element selected in the running app:
${json}
\`src\` is the file:line:col of its JSX, \`comp\` the component it's written in, \`owners\` the components above it
(innermost first) with the line that renders each.`;
  }
  const roots = "`target.roots` are the outermost elements it shows: the file:line:col of their JSX (`src`) and the component each is written in (`comp`).";
  if (t.kind === "case") {
    return `The person has one variant box selected in Spark's component frame for ${t.component ?? "a component"}, not a single element:
${json}
It's the case \`target.name\`, a function exported from \`target.file\` that renders the component with the props for this
variant. ${roots} The request is about this variant of the component as a whole: change the component's code or styling
for this variant (and the case's props in \`target.file\` if the request needs it), keeping its other variants as they are.`;
  }
  if (t.frame === "component") {
    return `The person has a whole component frame selected on Spark's board, not a single element:
${json}
It shows every case of ${t.component ?? "a component"}: each is a function exported from \`target.file\` (\`target.cases\`) that
renders the component with the props for one variant. ${roots} The request is about the component as a whole and all of its
variants. To add a variant, support it in the component and add a case for it to \`target.file\`.`;
  }
  return `The person has a whole app frame selected on Spark's board, not a single element:
${json}
It's the app's page (\`target.url\`) shown in a ${t.size.width}×${t.size.height} viewport. ${roots} The request is about the
whole screen as it looks at that size.`;
}

export function askPrompt(request: string, selection: AskSelection | null, pending: Change[], others: AskSelection[] = []): string {
  const sel = !selection
    ? "Nothing is selected."
    : others.length
      ? `The person has ${others.length + 1} elements selected in the running app, and the request is about all of them:
${JSON.stringify([selection, ...others], null, 2)}
For each, \`src\` is the file:line:col of its JSX, \`comp\` the component it's written in, \`owners\` the components above it
(innermost first) with the line that renders each.${[selection, ...others].some((s) => s.target) ? `
One with a \`target\` is not a single element but a whole frame on Spark's board (\`kind\` "frame": an app page at that
viewport size, or a component frame showing every case in \`target.file\`) or one variant box of a component frame
(\`kind\` "case": the case \`target.name\` exported from \`target.file\`); \`target.roots\` are the outermost elements it shows.` : ""}`
      : selected(selection);
  const first = pending.length
    ? `First, apply these pending visual edits from Spark (they're previewed in the app but not in the code yet), so
the code matches what the person sees before you change anything else:

${HOW}

Pending changes (JSON):
${JSON.stringify(pending, null, 2)}

Then do the request.`
    : "";
  return `You are working on this React app from Spark, a visual editor running on top of it. The person asked:

"${request}"

${sel}

${first}

${RULES.replace("- Change only what the changes ask for.", "- Change only what the request (and the pending changes) need.")}
- When you create a component, put it where the project keeps its components, give it its own CSS next to it the way
  the project does, and use it at the original spot so the app looks exactly the same.

End with a one-sentence summary of what you did.${pending.length ? `\n\n${verdicts(pending.map((c) => c.id))}` : ""}`;
}

/** A follow-up in an Ask chat: the session already has the rules and the earlier turns. */
export function followupPrompt(request: string, selection: AskSelection | null, pending: Change[], others: AskSelection[] = []): string {
  const what = selection?.target ? (selection.target.kind === "case" ? "variant" : "frame") : "element";
  const sel = !selection
    ? ""
    : others.length
      ? `\n\nThe person now has ${others.length + 1} elements selected, and this is about all of them (they may have moved since your last turn):\n${JSON.stringify([selection, ...others], null, 2)}`
      : `\n\nThe selected ${what} now (it may have moved since your last turn):\n${JSON.stringify(selection, null, 2)}`;
  const first = pending.length
    ? `\n\nFirst apply these pending visual edits from Spark, as before:\n${JSON.stringify(pending, null, 2)}`
    : "";
  return `The person replied in Spark:

"${request}"${sel}${first}

Same rules as before. End with a one-sentence summary of what you did.${pending.length ? `\n\n${verdicts(pending.map((c) => c.id))}` : ""}`;
}

/** Write the Components view's case files (gallery.ts) for the project's components. */
export function galleryPrompt(): string {
  return `You are working on this React app from Spark, a visual editor running on top of it. Its Components view renders
every component on its own, with mock data, from \`*.spark.tsx\` files. Write those files.

- Find the app's reusable presentational components (where the project keeps its components). Skip pages, the app
  root, providers and anything that only makes sense wired to live state.
- For each one, add \`<Component>.spark.tsx\` next to it. Every exported function is one case: a component that
  renders it alone with realistic props, for example
  \`export const Primary = () => <Button variant="primary">Export</Button>;\`
  Cover its meaningful variants and states in 2 to 5 cases. Export nothing else from the file.
- If a component needs a provider, a router or app-wide CSS that the app's entry (e.g. \`src/main.tsx\`) doesn't import, put it in a
  \`spark.setup.tsx\` at the project root: its default export is a wrapper component \`({ children })\`. If
  components call Tauri's \`invoke\`, export \`tauri\` from it too: an object of command name to a function
  \`(args) => mockResult\`.
- Don't change the components themselves.

${RULES.replace("- Change only what the changes ask for.", "- Only add these files.")}

End with a one-sentence summary of what you wrote.`;
}
