// The prompts Spark gives Claude. Dev server side.
import type { Change } from "./changes.ts";

const HOW = `How to read a change:
- level "token": set the design token \`property\` to \`to\` where it's defined (\`file\`, rule \`selector\`).
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
- property "text": the element's text becomes \`to\`. The literal may be in the element's JSX or passed in from a
  call site further up (a prop or children); change it where it's written.
- property "children-order": the element's children are shown in the order \`children.order\` (indices into the
  current children); reorder the JSX, or the list they're rendered from.
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
};

export function askPrompt(request: string, selection: AskSelection | null, pending: Change[]): string {
  const sel = selection
    ? `The person has this element selected in the running app:
${JSON.stringify(selection, null, 2)}
\`src\` is the file:line:col of its JSX, \`comp\` the component it's written in, \`owners\` the components above it
(innermost first) with the line that renders each.`
    : "Nothing is selected.";
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
