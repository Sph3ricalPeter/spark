# spark

AI-native design tool: a bridge between visual design and real CSS/React UI
components. Designs are trees of nested components (like Unity prefabs); a
person hand-edits, and AI reads the exact diff through MCP and applies it.

Windows desktop app: Tauri 2 (`src-tauri`) + React/TypeScript (`src`, Vite,
Zustand). Release and deploy are ported from dawg and described in
`docs/release-setup.md` and `.claude/release.md`.

## Layout

- `src-tauri`: the app crate (`spark`). `lib.rs` has the release/dev channel
  logic (`updates_enabled`) and registers the updater only for builds that
  may self-update. `project.rs` opens a project folder (launcher, or
  `spark <folder>`): it copies the Vite plugin (bundled as the `plugin/`
  resource) into `<project>/.spark/plugin`, starts the project's own Vite
  with `.spark/vite.config.mjs` (the project's config plus the plugin), and
  opens the dev server in a window of its own; closing it stops the server.
- `src`: the UI. Design tokens in `src/tokens.css`, never literals in
  `src/styles.css` or components. `stores/updater-store.ts` checks, downloads
  and installs updates; `components/UpdateIndicator.tsx` is the title-bar
  button; `components/TitleBar.tsx` is the frameless window's title bar;
  `components/Launcher.tsx` and `stores/projects-store.ts` are the main
  window: open a folder, recent projects.

- `packages/vite-plugin`: `spark-vite-plugin`, added to an app's
  `vite.config.ts` to make it editable from inside itself (dev server only).
  `tag.ts` adds `data-spark-src` / `data-spark-comp` to DOM elements and
  `data-spark-call` to component call sites; `client.ts` is the overlay and
  docked panel (Shadow DOM, no React; Alt+S). View mode (default) leaves the
  app usable; edit mode (Tab or Alt+E; the View/Edit island in the canvas bar shows which) picks elements, Esc steps back out to view.
  Spark's own buttons and dropdowns never keep focus: Tab and Esc are
  always Spark's shortcuts except while typing in a text field.
  Edit mode has selection handles to resize,
  double-click to edit text in place, and the property editor built from
  `fields.ts` (scrubbable numbers, dropdowns, color swatches);
  `css.ts` reads matched rules, authored values and tokens; `changes.ts` is
  the changelog and its live previews: an override lives on a step of
  the element's chain, prefab style: the component itself (base), its
  variants (variant props read from the fiber, `variant="ghost"`, then
  `ghost small`), or this one instance (owner path with list keys). Edits go
  to the element's own variant by default (the inspector's chain picks
  another), text to the one instance; each override can be moved along the
  chain or to a CSS rule; tokens are always global;
  `reorder.ts` drags an element along its flex/grid parent (previewed
  with CSS `order`, recorded as a "children-order" override on the parent);
  `shell.ts` is the board: an infinite canvas (zoom, pan) of frames, each an
  iframe with its own client: app frames at device sizes ("+ Frame" adds
  more) and one component frame per `*.spark.tsx`, sized to its cases and
  draggable by its title; the board keeps the clients in step (one mode,
  the selected frame's panel, one change list and undo history), and view
  mode focuses the selected frame. Its left sidebar (`sidebar.ts`) has the
  Chats and Changes tabs (each with a bar button); the change list and
  Implement changes live in Changes, out of the inspector's way. `frame.ts` is its side in the app and
  `mode.ts` decides which page is which;
  `runner.ts` runs the local `claude -p` for "Implement changes" and the
  Ask Claude box on the selection, with prompts in `prompt.ts` (Claude ends
  with `APPLIED <id>` / `SKIPPED <id>: why` lines);
  `gallery.ts` renders a component frame (`?spark=components&file=…`;
  the board lists the files through `/@spark/cases`): a `*.spark.tsx` next to a component exports one
  function per case, rendered alone with the app's global CSS and React;
  an optional root `spark.setup.tsx` exports a default wrapper and `tauri`
  fakes for `invoke`; the empty view has Claude write the files;
  `theme.ts` is Spark's own design system (`--sp-*` variables on each
  shadow root's :host: Inter via `fonts.ts`, served from `assets/fonts`,
  a 4-step font scale, 3 radii, a spacing scale, colors) plus inlined Lucide
  icons; style Spark's UI with those, not literals;
  `index.ts` injects the client and saves `.spark/selection.json` and
  `.spark/changes.json` (versioned: Claude and the MCP server read it, so
  fields are only ever added). Plan: the "Spark:
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
