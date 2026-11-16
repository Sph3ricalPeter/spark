# spark

AI-native design tool: a bridge between visual design and real CSS/React UI
components. Designs are trees of nested components (like Unity prefabs); a
person hand-edits, and AI reads the exact diff through MCP and applies it.

Windows desktop app: Tauri 2 (`src-tauri`) + TypeScript (`src`, Vite); Spark's
whole UI, the start screen included, is in `packages/vite-plugin`. Release and deploy are ported from dawg and described in
`docs/release-setup.md` and `.claude/release.md`.

## Layout

- `src-tauri`: the app crate (`spark`). `lib.rs` has the release/dev channel
  logic (`updates_enabled`) and registers the updater only for builds that
  may self-update. `project.rs` opens a project folder (launcher, or
  `spark <folder>`): it copies the Vite plugin (bundled as the `plugin/`
  resource, with TypeScript 6's `lib/typescript.js` as
  `plugin/vendor/typescript.cjs`: `tag.ts` parses with that, never the
  project's TypeScript, since TypeScript 7 has no JS API and JS apps have
  none; keep Spark's `typescript` devDependency on 6.x) into
  `<project>/.spark/plugin`, starts the project's own Vite
  with `.spark/vite.config.mjs` (the project's config plus the plugin), and
  shows the dev server in Spark's one window (`main`), in place of the
  launcher: `start_project` starts it (one project runs at a time),
  `show_project` navigates the window there, and the board's home button
  emits `spark://home` to come back (the project keeps running).
  The window is frameless: the title bar is one component, `titlebar.ts`,
  the board's bar with a project open and home's (`home.ts` mounts
  `launcherTitleBar`) (drag, double-click maximizes, window
  buttons, the update button).
  `update.rs` is the one updater: the title bar asks over
  `spark://update-check` / `spark://update-install` events, answered with
  `spark://update-state`; installing still only follows a click.
  `capabilities/project.json` lets that window on the dev server's origin
  use the system dialogs, read-only window/event/path calls and the title
  bar's window calls; `mode.ts` `borrowTauri` routes the board's frames'
  Tauri calls (`route`): plugin commands to Spark (never the title bar's,
  `boardOnly`) and the app's own commands to spark.setup fakes and the
  frame's sample data (`sample.ts`) or an error. On Windows WebView2 gives
  every frame Tauri of its own (read-only `__TAURI_INTERNALS__`, talking to
  Spark's Rust), so there it intercepts the frame's IPC `fetch` instead
  (`interceptIpc`); elsewhere it lends the frame the top window's Tauri.
- `src`: only `main.ts`, the glue between Spark's own page and Tauri (folder
  picker, `start_project`/`show_project`, the recent list in localStorage,
  `settings_read`/`settings_write`, the font files). The start screen itself
  is `packages/vite-plugin/src/home.ts` (`startHome`), drawn like the board:
  a shadow root with THEME, the board's title bar, the same settings (read
  before it shows). Never add UI, CSS or a design system to `src/`: that's
  how home kept drifting from the board.

- `packages/vite-plugin`: `spark-vite-plugin`, added to an app's
  `vite.config.ts` to make it editable from inside itself (dev server only).
  `tag.ts` adds `data-spark-src` / `data-spark-comp` to DOM elements and
  `data-spark-call` to component call sites; `client.ts` is the overlay and
  docked panel (Shadow DOM, no React; Alt+S). View mode (default) leaves the
  app usable; edit mode (Tab or Alt+E; the View/Edit switch in the board's bottom toolbar shows which) picks elements; Esc steps out (popover, selection) but never leaves edit mode, only Tab or Alt+E switch back to view.
  Going to view mode parks the edit selection (`parked`, keys, multi-select
  included) and coming back to edit mode selects it again (`unpark`), minus
  elements gone meanwhile; on the board only in the still-selected frame.
  Spark's own buttons and dropdowns never keep focus: Tab and Esc are
  always Spark's shortcuts except while typing in a text field.
  Shift+click adds to the selection (the first pick leads: inspector,
  handles and the Ask popup stay on it; Ask Claude sends them all).
  Besides elements, edit mode selects the whole frame (click its title on
  the board, which also leaves View mode, an empty spot, or Arrow Up past the outermost element) and a
  component frame's variant boxes (`data-spark-case` from `gallery.ts`):
  no style fields, just Ask Claude with chats of their own
  (`@frame:<frame id>`, `@case:<file>#<export>` keys, `target` in the prompt).
  Edit mode has selection handles to resize,
  double-click to edit text in place, and the property editor built from
  `fields.ts` (scrubbable numbers, dropdowns, color swatches), which opens
  with every element's size row (W and H, Figma style: width/height edits,
  then the kind's `ESSENTIALS`);
  `css.ts` reads matched rules, authored values and tokens; `changes.ts` is
  the changelog and its live previews: an override lives on a step of
  the element's chain, prefab style: the component itself (base), its
  variants (variant props read from the fiber, `variant="ghost"`, then
  `ghost small`), or this one instance (owner path with list keys). Like Unity
  prefabs, changes flow only down: an edit in an app frame is an override
  on that one instance by default and reaches the component only through an
  explicit apply upstream; editing a case in a component frame edits the
  component's own variant (or base), which every instance gets; each override can be moved along the
  chain or to a CSS rule; tokens are always global;
  `icons.ts` is icons: a click picks a whole `<svg>` (also inside a disabled
  button, which gets no click), tag.ts marks icon-library components
  (`data-spark-icon="lucide-react:Undo2"`), the inspector names the icon and
  Swap opens a picker of the app's own inline icons and the project's icon
  libraries (`/@spark/icons?lib=…`, rendered with the app's React); a swap is
  an "icon" override previewed as a CSS mask;
  `reorder.ts` drags an element along its flex/grid parent (previewed
  with CSS `order`, recorded as a "children-order" override on the parent);
  `shell.ts` is the board: an infinite canvas (zoom, pan) of frames, each an
  iframe with its own client: app frames at device sizes ("+ Frame" adds
  more) and one component frame per `*.spark.tsx`, sized to its cases and
  draggable by its title; the board keeps the clients in step (one mode,
  the selected frame's panel, one change list and undo history), and view
  mode leaves every frame usable, the selected one outlined dashed. Its layout is Figma's: a slim title bar, the
  floating bottom toolbar (View/Edit, + Frame, device, zoom), and three always-shown panels that
  cover the window-wide canvas instead of pushing it (resizing one crops the view, never moves the
  camera; only a Fill frame reflows): on the left the sidebar, on the right the selected frame's
  inspector and, rightmost, its chat with Claude (the client's Ask box as a column, about the
  selection or, with nothing selected, the whole frame). The inspector shows the frame's own
  properties (device, size, ratio; a component frame's layout) from `ShellApi.frameProps` when
  the frame or nothing is selected. Its left sidebar (`sidebar.ts`) has the
  Layers (`layers.ts`: every frame and its element tree, Figma style, in
  step with the canvas selection both ways; the client names the tree
  through `ClientHooks.layers`), System (the design system wizard, below) and Changes tabs (a tab strip at its top). The
  Chats list (`chatsTab`, in its own shadow root) is in the chat column instead, behind its
  Chats button (`ShellApi.chatList`/`chatsOpen`, remembered as `chats-open`); every chat opens in the
  column: an element's on its element, one with no element (an Implement changes run, a task such as
  Write sample data, which opens there as it starts) as it is (`ClientHooks.showChat`, until
  something is selected or Close), and a reply carries on its session; images pasted, dropped
  or picked into the chat box go with the message (`spark:ask` `images`, saved as
  `.spark/images/<hash>`, served at `/@spark/images/`, a chat message's `images`; runner.ts sends
  them as stream-json image blocks; `dragDropEnabled: false` leaves file drops to the page, and
  menu.ts `blockFileDrops` keeps a stray drop from opening the file); chats are never
  deleted: "Resolve" archives one into the list's Resolved view (`resolved` in chats.json), where it can be read and reopened; the change list and
  Implement changes live in Changes, out of the inspector's way; the inspector's
  "Changes here" section (`changesHere`) lists just the pending ones in the
  selection's subtree, with the same rows and Implement for only those. `frame.ts` is its side in the app and
  `mode.ts` decides which page is which;
  `menu.ts` is the right-click menus (Figma style, drawn by the board so
  they're never clipped by a zoomed frame) and blocks the browser's own
  context menu everywhere except text fields and selected text: the
  client's menu on elements, variant boxes and frames (Ask Claude, select
  parent, copy/paste style, reset edits, go to main component, delete), the
  board's on the canvas and frame titles, Layers rows and Chats rows;
  `claude.ts` is the one way Spark runs Claude: every run (Implement
  changes, Ask Claude on the selection, the Components view's "Write them
  with Claude", anything new) goes through its `ask` and is a chat in the
  Chats list (`chats.ts`, `.spark/chats.json`), an element's chat or one of
  its own (`kind` "implement" / "task"); never call `runner.ts` (the local
  `claude -p`) directly. Prompts are in `prompt.ts` (Claude ends
  with `APPLIED <id>` / `SKIPPED <id>: why` lines);
  `gallery.ts` renders a component frame (`?spark=components&file=…`;
  the board lists the files through `/@spark/cases`): a `*.spark.tsx` next to a component exports one
  function per case, rendered alone with the app's global CSS and React
  (each case's box contains its absolute/fixed parts and grows to hold them,
  and the overlays a case portals out, a Radix or floating-ui popover, menu or
  select, found by its open trigger: the frame's page is bigger than the frame
  (`roomFor` in shell.ts: the cases plus room right and below, only growing,
  never sized by the overlays, since Radix closes a select on resize), so
  overlays open unsqueezed, and the frame, cut to its size by `.view`, grows to
  show them; the client clamps to `ShellApi.view`, not the window);
  a component frame hugs its cases unless its right/bottom edge is dragged or
  W/H typed in its inspector (the cases wrap to a set width), and a variant
  box resizes from its handles in edit mode or its inspector's box W/H
  ("hug" fits it); both are board-only (`sizes` in the board state,
  `ShellApi.boxSizes`/`setCaseSize`), never written to the app, and "Fit to
  content" (inspector, frame menu, double-click an edge) clears them;
  an optional root `spark.setup.tsx` exports a default wrapper and `tauri`
  fakes for `invoke`; the empty view has Claude write the files;
  `sample.ts` is sample data, the app frames' mock backend: spark.setup's
  `samples` export names states (command → fake, or a function returning
  them so they keep state), installed by `/@spark/samples` before the app
  runs; each app frame picks one in its inspector's Data row (reloads it with
  `?spark-sample=`, saved in the board state), and calls nothing answers are
  listed there (`noAnswer`, `ShellApi.missing`) with "Write sample data /
  Answer them with Claude" (`samplesPrompt`);
  The System tab (`system-tab.ts`) is the design system wizard: Overview (the
  design system checklist: sample data, each foundation's token coverage and
  checks, hover/focus/disabled states per kind of control, components done),
  then Sample data (the scan only sees what's rendered, so: samples written,
  every call answered, not only empty states, a frame per sample, with Write
  sample data and "Frame for each sample"), then one
  step per foundation, colors, type, spacing, radius, shadows (`system.ts`
  scans an app frame's CSSOM and the inline styles and controls of every app
  frame through `ClientHooks.scanSystem(others)`,
  clusters the literal values into suggested tokens, existing ones first,
  near values merged and marked ≈ and unticked), Apply sends the ticked ones
  (`spark:system-apply`, `tokensPrompt` in breakdown.ts) for Claude to define
  and use; every step rescans, so it's rerunnable. Its last step is Components:
  Break down into components (a frame's, variant's or element's menu, or the
  Ask box's component button) opens it
  (`components-tab.ts`): pick a depth (regions, + parts, + primitives), Plan
  (Claude writes `.spark/components.plan.json`, merged into the versioned
  `.spark/components.json`, the project's record of its components:
  exists / planned / built / skipped), untick or rename, hover a row to outline
  its elements, then Build: the ticked ones, one chat per area, Primitives first,
  marked built from `APPLIED <id>` lines. `breakdown.ts` has the rulebook
  (`RULES`; a project adds its own in `spark.rules.md`, which wins), the
  prompts and the record; re-running continues from what's recorded;
  `theme.ts` is Spark's own design system (`--sp-*` variables on each
  shadow root's :host: Inter via `fonts.ts`, served from `assets/fonts`
  with the other bundled open fonts Settings offers (`UI_FONTS`, `MONO_FONTS`),
  a 4-step font scale, 3 radii, a spacing scale, colors), the shared
  buttons (`.sp-btn`, `.primary` for the action that matters, Claude's
  included: Plan, Build, Implement changes, Write sample data) plus inlined
  Lucide icons; style Spark's UI with those, not literals; home (`home.ts`)
  uses the same;
  `index.ts` turns Vite's full reloads into `spark:full-reload` (wrapping
  `server.ws.send`) and `/@spark/reload`, first on every page, reloads only
  the frames, never the shell: an edit to main.tsx or index.html, or a new
  prebundled dependency, never reloads Spark's window; `.spark/` is out of
  the watcher. It injects the client and saves `.spark/selection.json` and
  `.spark/changes.json` (versioned: Claude and the MCP server read it, so
  fields are only ever added). Remembered UI (the board's frames, sizes,
  positions and camera, the panel, sidebar and inspector sections) lives in
  the project's `.spark/state.json`: `state.ts` reads it before a page starts
  (`getState`/`setState`, one key per feature, listed at its top) and
  `state-file.ts` writes it. Never localStorage: each open is a new dev
  server port, so a new, empty origin. Spark's own settings, the same in every
  project (theme, accent, fonts, text size, zoom speeds, glide, grid), live in
  `settings.json` in Spark's config folder (`project.rs` passes it as
  `SPARK_SETTINGS_DIR`; `~/.spark` outside Spark): `settings.ts` reads them
  and puts the looks on each page's root as `--spu-*` variables, which
  `THEME` reads under its defaults; the Settings panel (`settings-panel.ts`,
  the title bar's gear or Ctrl+,, on the board and the start screen) edits
  them. The start screen has no dev server, so it reads and writes the same
  file through `src-tauri/src/settings.rs` (`settings_read`/`settings_write`,
  via `connectSettings`); both sides re-read the file before every write. Plan: the "Spark:
  plan" Claude Doc.
- `examples/fixture`: a small dawg-like app to develop Spark against
  (`npm run fixture`, port 5179).

## Conventions

- **No PRs, fast iteration**: commit and push straight to
  `dev`; you are the reviewer, so run the checks in `.claude/release.md` and
  make CI green before moving on. Releases are checkpoints cut from `dev` with
  the user-level release skill; `main` only moves at release time,
  fast-forwarded.
- **Commits**: conventional (`feat:`, `fix:`, `refactor:`, `chore:` …); release
  notes are built from `feat`/`fix` subjects.
- **Updates reach every install**, so saved-file format and MCP tool shapes
  stay backward compatible, and the updater never restarts the app on its own.
- **Channels**: the release app id is `com.sph3ricalpeter.spark`; "spark dev"
  (`com.sph3ricalpeter.spark.dev`) updates from the rolling `dev-build`
  prerelease on every push to `dev`, so keep `dev` working.
