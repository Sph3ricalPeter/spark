# Standalone Spark: migration plan

Status: shelved draft. The standalone pivot was dropped before this plan was
reviewed, so nothing here has been checked by a second reader and nothing in
it is scheduled. Written against `dev` at `96d7e58`. It turns
`docs/standalone-architecture.md` into ordered work, starting from the code
that exists today. Read that document first for the why; this one is the how
and the order.

## 1. Summary

**First milestone (M1), the one to come back to Peter with:** a "spark dev"
build where Peter opens a sample hero web page that Claude built through
Spark's MCP server, tweaks it by hand in a Figma-style editor, and Claude can
read those exact tweaks back and propose further changes that appear live.

**Decisions made here** (section 2 has the reasoning):

1. The document logic is TypeScript (`packages/core`), not Rust. Decided.
2. The standalone editor is new code in the app's own frontend (React and
   Zustand, like the launcher), laid out as in the Figma-style redesign
   mockups. The Vite/React mode keeps today's editor, untouched and frozen
   apart from bug fixes, until M5.
3. Everything except a thin Rust layer runs and is tested in a plain browser
   and in Node, because the implementing agent works on Linux with no Windows
   machine. Windows-only behaviour is covered by a smoke test in CI.
4. The work is additive. A design document is a second project kind next to
   Vite projects, so `dev` stays shippable after every push and Peter's
   install keeps updating.

**Milestones**

| | Milestone | Peter can |
|---|---|---|
| M1 | Hero page build | Open the sample, tweak it by hand, have Claude read the tweaks and propose changes over MCP |
| M2 | Controls and the rest of the redesign | Remap any shortcut in Settings, use quick actions, the eyedropper, Ask Claude inside Spark |
| M3 | Components in full | Variants, props, insert from Assets, push overrides up, review AI changes one by one |
| M4 | Port to a Tauri 2 app | Port the design to code, look-only changes with no agent run, screenshot-checked |
| M5 | Vite mode and more targets | Decide Vite mode's future; Unity UI Toolkit, then uGUI |

**What Peter has to do** is in section 8. In short: let "spark dev" update
itself, open the sample from the launcher, and run `claude` in the project
folder when he wants Claude connected live.

## 2. Decisions for this migration

### 2.1 TypeScript core (settles architecture D2)

`packages/core` holds the schema, store, ops, undo, instance resolution,
diff, validation and the MCP tool handlers, with no DOM and no Node imports.
`packages/targets/web` holds the node-to-HTML/CSS translation that both the
canvas and the export use. The reasons are in the architecture document. One
more matters for the migration itself: the same code runs in Node, so the
implementing agent can drive the real MCP server, build the sample through
it, render it and test it on Linux today, without the Windows app. A Rust
core could not be exercised end to end from the cloud session.

The repo's TypeScript settings (`erasableSyntaxOnly`, `.ts` import
extensions) already let Node run the source directly, with no build step.

### 2.2 A new editor, in React, in the app

The architecture document said "one editor, two hosts" and proposed moving
and splitting `client.ts` and `shell.ts`. For the migration that order is
wrong, for three reasons found in the code:

- Little of today's editor can be reused without first refactoring it.
  `client.ts` (2,607 lines) mixes the overlay, the whole inspector and the
  React/CSSOM lookups. `shell.ts` builds its frames from the app's dev-server
  URL and imports `/@spark/cases` from Vite. `variables.ts`, `css.ts`,
  `page.ts`, `changes.ts` and `reorder.ts` are about CSS rules and React
  fibers. Only `fields.ts`, `theme.ts`, `markdown.ts` and parts of
  `sidebar.ts` are free of that, about 1,100 of 7,000 lines.
- The redesign replaces the layout anyway: left panel with Layers, Assets and
  Changes, right panel with Design, Code and Chat, a floating bottom toolbar.
- The plugin's files are shipped as raw TypeScript and copied into each
  project's `.spark/plugin`. Moving shared modules out of that folder changes
  how Vite mode loads, which risks the mode that works today for no gain in
  M1.

So the standalone editor is written new, against the engine, in `src/editor`:
React components and Zustand for panels and chrome, plain imperative
TypeScript for the canvas (renderer, overlay, camera, input router, tools).
The existing files are the specification for behaviour that already feels
right, and the port should copy their constants and rules: number scrubbing
and the color picker (`fields.ts`), zoom steps and wheel handling
(`shell.ts`), selection colors by role, the box-model display on Alt, the
"edits apply to" chain (`client.ts`).

The host adapter seam from the architecture stays in the design: the new
editor talks to an interface, and the document engine is its first
implementation. Whether Vite mode later becomes a second implementation or an
importer is M5's decision. Until then Vite mode is frozen: bug fixes only, no
redesign, its hard-coded shortcuts stay.

### 2.3 Built to be tested without Windows

| Layer | Runs in | Tested by |
|---|---|---|
| `packages/core`, `packages/targets/web` | Node and any browser | Unit tests (Vitest), golden HTML/CSS, screenshot tests with Playwright |
| MCP handlers | Node (headless) and the app window | A scripted MCP client over stdio |
| Editor (`src/editor`) | The app window, and a plain browser against the dev host | Playwright end-to-end tests in CI on Linux |
| Host commands | Rust in the app, Node in the dev host | The same contract tests against both |
| Windows-only: windows, capabilities, the shim's stdio, WebView2 | The built app | A smoke run of the built exe in the Windows CI job |

The **dev host** is a small Node server (a Vite dev plugin) that implements
the host's commands over HTTP and a WebSocket: read and write project files,
watch the folder, bridge MCP. The editor picks its host at startup: Tauri
commands inside the app, the dev host in a browser. This is what lets the
agent open the editor at `http://localhost:5178/?doc=examples/hero.spark` in
Playwright, click a node, change a padding and check the file on disk.

### 2.4 One set of MCP handlers, two ways in

- **In the app:** `spark.exe mcp <folder>` is a stdio shim built into the app
  binary. It branches before Tauri starts, reads `<folder>/.spark/host.json`
  (port and token, written by the app while the project is open), connects to
  a loopback socket and relays lines. The host passes each request to the
  project window, where the engine answers. If the project is not open in
  Spark, the shim answers with a clear error. Starting the app headless comes
  in M4.
- **In Node:** `npm run mcp -- <folder>` runs the same handlers. If the app
  has the project open it relays to it, exactly like the shim. Otherwise it
  loads the folder itself and works headless. This is for the cloud agent, CI
  and tests.

The architecture document said "local pipe". A loopback TCP socket with a
token file is used instead because it needs only the standard library and can
be tested on Linux. It can be swapped later without changing anything above
it.

The MCP protocol is handled by hand (`initialize`, `tools/list`,
`tools/call`, `ping`): about a hundred lines with no dependency, so it runs
in the webview and in Node alike.

### 2.5 `dev` stays shippable

Every push to `dev` becomes Peter's next "spark dev" update. So: nothing in
`packages/vite-plugin` or the Vite path of `project.rs` changes in M1 to M4
except bug fixes; the launcher gains entries, it does not lose any; new Rust
commands are added next to the old ones; a half-built editor is reachable
only by opening a design project. Run the checks in `.claude/release.md`
before each push, as the repo already requires.

## 3. Where today's code ends up

| Today | In the migration | When |
|---|---|---|
| `src-tauri/src/lib.rs` | Gains the `mcp` branch before Tauri starts, new commands, a capability for document windows | M1 |
| `src-tauri/src/project.rs` | Keeps the Vite path as is. A new `document.rs` opens, creates and saves design projects | M1 |
| `src/components/Launcher.tsx`, `projects-store.ts` | "New design project" and "Open sample" next to "Open folder"; recents remember the kind | M1 |
| `src/components/TitleBar.tsx`, `UpdateIndicator.tsx`, updater store | Reused by the document window as they are | M1 |
| `src/tokens.css` | Extended with the redesign's values; the editor uses only tokens | M1 |
| `packages/vite-plugin/src/fields.ts` | Ported to React widgets with the same behaviour; the original stays for Vite mode | M1 |
| `shell.ts` | Camera, zoom steps, wheel and pinch rules, frame titles and the grid ported into `src/editor/canvas`; the original stays | M1 |
| `client.ts` | Specification for selection, handles, text editing, the edit chain. Not moved | M1 to M3 |
| `changes.ts` | Its `Change` model and prefab chain become ops and overrides keyed by node id in `packages/core` | M1, M3 |
| `reorder.ts` | Drag-to-reorder ported onto ops (a move is one op) | M1 |
| `variables.ts`, `page.ts`, `css.ts`, `tag.ts`, `gallery.ts`, `frame.ts`, `mode.ts` | Stay Vite-only | M5 decides |
| `runner.ts`, `prompt.ts`, `chats.ts` | Model for a Rust runner in the host with new prompts; the Node copy stays for Vite mode | M2 |
| `sidebar.ts`, `markdown.ts` | Chats list and Markdown rendering ported to React | M2 |
| `theme.ts` | Icons reused (Lucide paths); the `--sp-*` variables stay Vite-only | M1 |
| `.spark/changes.json`, `selection.json`, `chats.json` | Unchanged for Vite projects. Design projects have their own files (section 6.1) | n/a |
| `examples/fixture` | Stays the Vite test app. `examples/hero.spark` joins it | M1 |
| CI (`ci.yml`) | Adds `npm test`, the Playwright run and the Windows smoke step | M1 |

## 4. Repo layout after M1

```
packages/
  core/src/            schema, ids, store, ops, undo, resolve, diff, validate, profiles
  core/src/mcp/        protocol and tool handlers
  core/bin/            spark-mcp entry for Node
  targets/web/src/     node to HTML and CSS; the web profile
  vite-plugin/         unchanged
src/
  components/, stores/ launcher, title bar, updater (today)
  editor/              the standalone editor
    canvas/            renderer, overlay, camera, input router, tools (no React)
    actions/           action registry, keymap, presets
    panels/            layers, design, changes, variables (React)
    host/              HostApi, tauri host, dev host client
src-tauri/src/         lib.rs, project.rs (Vite), document.rs, mcp_bridge.rs, mcp_shim.rs
scripts/               dev-host (Vite plugin), render.mjs, mcp-call.mjs
examples/hero.spark/   the sample design
examples/hero-build/   the op batches that build it through MCP
e2e/                   Playwright tests
```

`packages/*` are folders with path aliases (`@spark/core`,
`@spark/targets-web`), not npm workspaces; the repo has one `package.json`
and that stays. `packages/core` gets its own tsconfig without the DOM library
so a DOM import fails the type check.

## 5. Milestone 1: the hero page build

### 5.1 Scope

**Must**

- Format v0 and the engine: frames, text, rectangles, images, auto layout and
  free placement, fills, stroke, radius, opacity, one shadow, typography,
  variables with modes, pages, and components with instances and
  instance-level overrides (no variants yet).
- The web translation and a DOM renderer; frames drawn in same-origin iframes
  on a board with pan and zoom.
- Editor: select, hover, parent and child navigation, the Layers panel
  (select, rename), the Design tab (position, size with fixed, hug and fill,
  auto layout, fill, stroke, radius, opacity, typography, bind a variable),
  edit text in place, resize by handles, drag to reorder in auto layout,
  delete, duplicate, undo and redo, "edits apply to: this one or all" for
  instances with an override marker and reset.
- Action registry, input router and the Figma keymap preset loaded from
  `keymap.json`. Every shortcut in the editor goes through it from the first
  commit. (The Settings screen that edits it is M2; until then a hand-edited
  `keymap.json` already remaps.)
- MCP: the tools in section 6.4, in the app through the shim and in Node.
  Proposals show in the Changes tab with Accept and Reject for the whole
  proposal.
- Launcher: New design project, Open sample. The sample is bundled with the
  app.
- The sample hero page, built through MCP (section 6.6).

**Should** (cut these first if the gate is at risk)

- Create tools: Frame, Rectangle, Text.
- The Variables panel (edit values, switch mode).
- A linear gradient fill.
- Reload when the folder changes on disk.
- A second, phone-width frame of the hero.

**Not in M1:** variants and component props, the Assets panel, multi-select
and alignment, Code and Chat tabs, Ask Claude inside Spark, the shortcuts
screen, quick actions, the eyedropper, per-op review, hand-edit marks,
porting to a target, screenshot compare, Unity, importing a Vite app.

### 5.2 Slices, in order

Each slice ends with a push to `dev` that leaves it working.

**Slice 0: scaffolding.** Path aliases, the `packages/core` tsconfig, Vitest,
Playwright and an `e2e` folder, `npm test` in CI.
*Done when:* an empty test of each kind passes in CI.

**Slice 1: the engine.** Schema v0 with runtime validation (one definition
gives the TypeScript types, the validator and the JSON Schema that MCP tools
publish), short stable ids, the normalized store, ops with inverses,
transactions, undo and redo per author, instance resolution with overrides,
the structural diff, load and save through a small file interface.
*Done when:* unit tests cover every op and its inverse, a round trip of load
and save is byte-stable (sorted keys, unknown fields kept), and
`diff(a, apply(a, ops))` returns those ops' net effect.

**Slice 2: the web translation.** A pure function from a resolved node to an
element description and CSS; variables as custom properties with one block
per mode; a DOM applier; `scripts/render.mjs` that renders a node to a PNG
with Playwright.
*Done when:* a conformance document using every v0 feature has golden
HTML/CSS and golden screenshots in the test suite.

**Slice 3: MCP in Node, and the sample.** The protocol, the tool handlers,
`npm run mcp`, `scripts/mcp-call.mjs`. Then build `examples/hero.spark` by
sending the op batches in `examples/hero-build/` through the server, and
render it.
*Done when:* `npm run sample:hero` rebuilds the sample from an empty project
through MCP alone, the result matches the committed sample, and its render is
attached to the thread for Peter.

**Slice 4: the host.** `document.rs` (create, open, read, write atomically,
`host.json`), the document window and its capability, the launcher entries,
the sample as a bundled resource, and the dev host in Node with the same
contract.
*Done when:* contract tests pass against both hosts, and the app opens a
design project into a window that shows its name (the editor can still be a
placeholder). This is the first build Peter could open.

**Slice 5: the editor.** In this order, each usable on its own: board and
renderer (view the sample, pan, zoom); selection, hover and Layers; the
action registry, router and keymap; the Design tab writing ops; text editing,
resize, reorder, delete, duplicate, undo; instances and overrides; then the
"should" items.
*Done when:* the end-to-end tests in section 5.3 pass in a browser against
the dev host.

**Slice 6: MCP in the app.** The loopback bridge, the shim branch in
`main.rs`, proposals in the Changes tab, `get_selection`, `get_changes`, and
`.mcp.json` written into the project folder with the app's own exe path.
*Done when:* the Windows smoke step passes in CI (section 9).

### 5.3 The gate

M1 is done when all of these hold:

1. End to end, in CI: open the sample, change the headline text, a padding, a
   fill bound to a variable, the size of the image and the order of two
   cards; `get_changes` over MCP returns exactly those five changes, each
   with node id, property, from and to, and marked as made by hand.
2. End to end, in CI: an MCP client proposes a change; it appears in Changes;
   Accept applies it to the canvas and the files; undo removes it as one
   step; Reject leaves no trace.
3. Editing an instance changes only that instance; editing the component
   changes every instance; reset removes the override.
4. The Windows build is green, the smoke step passes, and the `dev-build`
   prerelease carries the build.
5. Peter has opened the sample in his install and tweaked it. Until this one
   is true the milestone is "ready for Peter", not done.

## 6. Contracts to fix early

These are the interfaces other work depends on. Settle them in slice 1 to 3
and change them only by adding.

### 6.1 Files of a design project

As in the architecture document, with these M1 specifics: `spark.json`
(format version, name, applied migrations), `variables.json`,
`pages/<Name>.json`, `components/<Name>.json`, `assets/`, and a git-ignored
`.spark/` holding `journal.jsonl`, `proposals/`, `baselines/`,
`selection.json`, `board.json` (camera and panel state) and `host.json`.
`targets/` and `provenance.json` arrive in M4 and M3.

### 6.2 Nodes and ops

A node has `id`, `kind`, `name`, `parent` with its order key, and typed
groups of properties: `layout` (mode, direction, gap, padding, align,
justify, wrap), `size` (per axis: fixed, hug or fill, with value, min, max),
`position` (free placement), `fills`, `stroke`, `radius`, `opacity`,
`shadow`, `text` (content, family, size, weight, line height, letter spacing,
align), `image` (asset, fit). Any value can be a literal or
`{ "var": "<variable id>" }`.

Ops: `node.insert` (takes a whole subtree, so an agent can add a section in
one op, with temporary ids the server replaces and reports back),
`node.remove`, `node.move`, `node.set` (one property path such as
`layout.gap`), `component.create` (from a node), `instance.create`,
`override.set`, `override.clear`, `variable.create`, `variable.set`,
`variable.remove`, `page.create`. Variant and prop ops come in M3.

### 6.3 HostApi

The one interface between the editor and whatever hosts it:

| Call | Does |
|---|---|
| `openProject(folder)` | Returns every document file's content and the project's settings |
| `writeFiles(changes)` | Writes or deletes files atomically |
| `readAsset(path)` | Bytes of an asset, shown through a blob URL |
| `onExternalChange(fn)` | Folder changed on disk |
| `onMcpRequest(fn)`, `mcpRespond(id, body)` | The MCP bridge |
| `loadKeymap()`, `saveKeymap(json)` | The user's `keymap.json` |
| `appInfo()` | Version and channel |

### 6.4 MCP tools in M1

`get_document`, `get_page`, `get_node`, `get_variables`, `get_selection`,
`get_profile`, `propose_changes(ops, title, reasoning)`, `get_proposal(id)`,
`get_changes(baseline)`, `mark_synced(baseline)`.

A **baseline** is a named snapshot, which is the architecture's per-target
sync point made general. M1 has one, `agent`: `get_changes("agent")` is
everything that changed since Claude last called `mark_synced("agent")`, with
the journal saying which changes were made by hand. In M4 each target is a
baseline with an adapter attached.

Writes are always proposals. The Node entry has an `--auto-accept` flag for
building samples and tests, where nobody is there to review. The app has no
such switch.

### 6.5 Actions and keymap

As in the architecture document, section 6, with the redesign's action list
(`Shortcuts.dc.html` in the mockup) as the starting set. Two notes for
document projects: Tab is "next sibling", and there is no View or Interact
mode because a design has no behaviour to click through. The router calls
`preventDefault` on the webview's own chords (reload, print, find) so they
cannot fire instead of Spark's.

### 6.6 The sample

A marketing hero for a made-up product, at 1440 wide: a nav bar (logo, three
links, a button), a headline and subhead, a primary and a secondary button,
an image, and a row of three feature cards. It must show what Spark is for:

- Components that nest: `Button`, `NavBar` (contains a `Button` instance),
  `FeatureCard`.
- An instance override: the secondary button is a `Button` with its fill and
  text color overridden.
- Variables: colors, a spacing scale, radii and type sizes, with a light and
  a dark mode.
- Auto layout throughout, so resizing the frame reflows it.

It is built by sending op batches through the MCP server, never by writing
the JSON by hand, so the build is also the end-to-end test of the MCP path.

## 7. After M1

Each milestone has a gate Peter can check himself.

**M2: controls and the rest of the redesign.** The Settings screen with
Keyboard shortcuts (click a key to change it, conflict warning with swap,
presets, import and export, only changes saved), quick actions, the
eyedropper (picks the variable when the fill is bound), the canvas menu,
multi-select with align and distribute, Layers drag to reparent, pages, the
Code tab showing the translation of the selection, and the Chat tab with a
runner in the host: `claude -p` with Spark's MCP tools only, chats per
element as today.
*Gate:* Peter remaps the eyedropper, restarts, and it holds; he asks Claude
in Spark to change the hero and reviews the proposal.

**M3: components in full.** Variants and props (boolean, text, swap, slot),
the Assets panel and Insert component, push overrides up the chain, reset,
detach, component frames on the board, per-op review with tweak, hand-edit
marks (`provenance.json`), stale-proposal conflicts, outside changes shown as
a changeset.
*Gate:* a `Button` with three variants edited at each step of the chain
behaves like today's prefab chain does in Vite mode.

**M4: port to a Tauri 2 app.** The Tauri 2 profile and "Won't port", export
of tokens, styles and views, `targets/` with mapping and a baseline per
target, look-only changes ported with no agent run, the port run for wiring,
capture and screenshot compare, the CLI (`export`, `status`, `check`,
`port`), headless start.
*Gate:* the hero page ported into a blank Tauri 2 app matches Spark's render;
changing a color in Spark lands in the app in one click.

**M5: Vite mode and more targets.** Decide with Peter: Vite mode adopts the
new editor (served as a built bundle by the plugin, with a React/CSS host
adapter) or becomes an importer into design documents. Then Unity UI Toolkit
and uGUI, each with a profile, a translator, a driver and a conformance
document.

## 8. What Peter has to do

1. **Have "spark dev" installed.** It is, if the title bar says "spark dev".
   If not, the installer is `spark-dev-setup.exe` on the
   [`dev-build` prerelease](https://github.com/Sph3ricalPeter/spark/releases/tag/dev-build).
2. **Take the update.** "spark dev" checks every 10 minutes. When the update
   button in the title bar turns green, click it and choose Restart now.
   Spark never restarts on its own.
3. **Open the sample.** Launcher, Open sample, Hero page, and pick where to
   save it. From then on it is an ordinary folder he can put under git.
4. **To connect Claude live, optional:** with the project open in Spark, run
   `claude` in the project folder and approve the `spark` MCP server the
   first time. Spark writes the `.mcp.json` that makes this work. Or approve
   a Remote Control session when the thread asks, and the thread's Claude
   does the same thing on his machine.

Nothing else: design projects need no Node, no dev server and no setup.

Builds reach Peter only from `dev`. The implementing thread therefore pushes
to `dev`, as the repo's conventions say, after the checks pass.

## 9. Checking Windows without a Windows machine

The agent cannot run the app. Three things stand in for that:

1. **Most code never needs Windows.** The engine, translation, MCP handlers
   and the whole editor run in Node and a browser, where CI tests them.
2. **A smoke step in the Windows CI job.** After the build, run the built exe
   with `--smoke <sample folder>`: it opens the document window, waits for
   the engine to report ready, makes one MCP round trip through
   `spark.exe mcp` with piped stdio (list tools, read the document), saves a
   screenshot as a build artifact and exits with a status code. This covers
   window creation, the capability file, the content security policy with
   iframes and blob URLs, the loopback bridge and the shim. GitHub's Windows
   runners have the WebView2 runtime.
3. **Peter, last.** Gate item 5. If something only fails on his machine, a
   Remote Control session lets the thread read logs there.

## 10. Risks

| Risk | What happens | Guard |
|---|---|---|
| M1 is too big | Peter waits weeks for the first build | The must and should split; slices that each ship; slice 4 already gives him a build to open |
| A GUI exe as the MCP shim | Stdio may not reach a Windows GUI-subsystem process in some launch paths | The smoke step tests exactly this. Fallback: a small console binary next to the app, as dawg ships `dawg-cli.exe` |
| Two hosts drift (Rust and Node) | Works in tests, fails in the app | One contract test suite run against both; keep the host to file and socket calls with no logic |
| The new editor loses behaviour the old one got right | Scrubbing, zoom, selection feel worse than today | Port from the named files and constants, not from memory; e2e tests for scrub, zoom and reorder |
| Text renders differently in the export later | 1:1 breaks at M4 | The canvas uses the export's own translation from M1, and the conformance screenshots include wrapped text |
| Format churn after Peter has projects | His files stop loading | Version and forward migrations from the first commit; unknown fields kept; the sample is a migration test |
| Vite mode rots while frozen | Peter's current workflow breaks unnoticed | Its files are not touched; the fixture stays in CI's type check and build |
| Content security policy blocks the canvas | Blank frames in the app only | Covered by the smoke screenshot; images go through blob URLs, which the policy already allows |

## 11. What changed from the architecture document

- **Editor reuse.** New editor in React in the app, instead of moving and
  splitting the plugin's editor. Vite mode is frozen until M5.
- **Step 1 dropped.** Actions and keymap are not retrofitted onto the old
  editor. They are built into the new one from its first commit.
- **Socket, not pipe.** Loopback TCP with a token for the MCP bridge.
- **The shim is the app binary** in M1; a separate console binary only if the
  smoke test shows it is needed, and for the wider CLI in M4.
- **Baselines** generalize per-target sync points, so `get_changes` works in
  M1 before any target exists.
- **Order.** Phase 0's "port to a blank Tauri app" moves to M4, because
  Peter's first milestone is the editor and MCP loop. The risk Phase 0 was
  guarding against, a format that cannot port, is held down by drawing the
  canvas with the export's own translation from the start.
