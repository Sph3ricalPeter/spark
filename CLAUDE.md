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
  may self-update.
- `src`: the UI. Design tokens in `src/tokens.css`, never literals in
  `src/styles.css` or components. `stores/updater-store.ts` checks, downloads
  and installs updates; `components/UpdateIndicator.tsx` is the title-bar
  button; `components/TitleBar.tsx` is the frameless window's title bar.

- `packages/vite-plugin`: `spark-vite-plugin`, added to an app's
  `vite.config.ts` to make it editable from inside itself (dev server only).
  `tag.ts` adds `data-spark-src` / `data-spark-comp` to DOM elements and
  `data-spark-call` to component call sites; `client.ts` is the overlay and
  docked panel (Shadow DOM, no React; Alt+S). View mode (default) leaves the
  app usable; edit mode (Tab or Alt+E; the View/Edit island in the canvas bar shows which) picks elements, Esc steps back out to view.
  Edit mode has selection handles to resize,
  double-click to edit text in place, and the property editor built from
  `fields.ts` (scrubbable numbers, dropdowns, color swatches);
  `css.ts` reads matched rules, authored values and tokens; `changes.ts` is
  the changelog and its live previews: every edit starts as an override on
  exactly one instance (owner path with list keys) and can be applied
  upstream, Unity-prefab style, to any owning component or the original,
  or moved to a CSS rule; tokens are always global;
  `reorder.ts` drags an element along its flex/grid parent (previewed
  with CSS `order`, recorded as a "children-order" override on the parent);
  `shell.ts` is the viewport canvas (zoom, pan, device sizes) the app runs
  inside as an iframe, with `frame.ts` its side in the app and `mode.ts`
  deciding which page is which;
  `runner.ts` runs the local `claude -p` for "Implement changes" and the
  Ask Claude box on the selection, with prompts in `prompt.ts` (Claude ends
  with `APPLIED <id>` / `SKIPPED <id>: why` lines);
  `gallery.ts` is the Components view (App / Components in the canvas bar,
  `?spark=components`): every `*.spark.tsx` next to a component exports one
  function per case, rendered alone with the app's global CSS and React;
  an optional root `spark.setup.tsx` exports a default wrapper and `tauri`
  fakes for `invoke`; the empty view has Claude write the files;
  `theme.ts` is Spark's own design system (`--sp-*` variables on each
  shadow root's :host: Manrope via `fonts.ts`, served from `assets/fonts`,
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
