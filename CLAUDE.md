# spark

AI-native design tool: a bridge between visual design and real CSS/React UI
components. Designs are trees of nested components (like Unity prefabs); a
person hand-edits, and AI reads the exact diff through MCP and applies it.

The stack isn't decided yet. Release and deploy are ported from dawg and
described in `docs/release-setup.md` and `.claude/release.md`.

## Conventions

- **No PRs, fast iteration** (once `dev` exists): commit and push straight to
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
