# Release config

Read by the user-level `release` skill. Overrides its generic defaults.
Ported from dawg; the parts marked **(once the app exists)** assume the
Tauri + React + Rust layout dawg uses and need revisiting if spark's stack
turns out different.

## Version
**(once the app exists)** Lives in three files that must match:
- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`: stamped on the installer and
  compared by the updater against `latest.json`. `release.yml` refuses a tag
  that doesn't match it.
- `Cargo.toml` (workspace root) → `[workspace.package] version`

Bump:
```bash
npm version <x.y.z> --no-git-tag-version   # package.json + package-lock.json
# edit src-tauri/tauri.conf.json and Cargo.toml by hand
cargo check --workspace                    # rewrites the spark entries in Cargo.lock
```
Stage all five: `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`,
`Cargo.toml`, `Cargo.lock`.

Bump commit message: `chore: bump version to <x.y.z>` (no `release:` prefix;
release notes are built from `feat`/`fix` subjects only).

## Branch and deploy
Work is committed straight to `dev`, no pull requests. Releases ship from
`main`, fast-forward only:
```bash
git checkout main && git merge dev --ff-only   # refuses? fetch; still refuses → investigate, never force
git tag -a v<x.y.z> -m "spark v<x.y.z>"
git push origin main dev --follow-tags
git checkout dev
```
Never push straight to `main` with new commits.

Pushing the `v*.*.*` tag runs `.github/workflows/release.yml`:
1. Checks the tag matches `tauri.conf.json`, the updater pubkey is set and the
   signing secret exists.
2. Builds Windows x64 only (NSIS `spark_<x.y.z>_x64-setup.exe`), signed for
   the updater, and publishes a **GitHub Release** "spark vX.Y.Z" with the
   installer, its `.sig` and `latest.json`.
3. Release body is the top 5 `feat:` then `fix:` subjects in
   `<prev tag>..<tag>`; the tag message is not the user-facing note.

Pushing `main` and `dev` also runs `ci.yml`. Every push to `dev` publishes a
signed `x.y.z-dev.<run>` "spark dev" build to the rolling `dev-build`
prerelease, which installed "spark dev" copies update from.

## Checks
```bash
npm run typecheck && npm run lint && npm run build
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```
Run whichever half exists. Before a release, install a local test build
(`npm run build:dev`, installs as "spark dev" next to the real app) and try
what changed.

## Classifier
Conventional commits (`feat:` → minor, `fix:` → patch, `refactor:`/`docs:`/`chore:`
→ patch). Bump minor for any `feat:`, patch otherwise. Pre-1.0: no majors.

## Commit convention
`<type>: <imperative subject>`, types `feat`, `fix`, `refactor`, `perf`, `docs`,
`test`, `chore`, `ci`.

## Breaker checks
- **Installed copies auto-update** from `latest.json`, so a bad release reaches
  every install. Anything that would lose work is a blocker.
- **Design file format**: once spark saves documents, changes must be
  additive and bump the format version; older files must still open.
- **MCP tools**: tool names and argument shapes stay backward compatible;
  agents cache them. This matters more in spark than in dawg, since the MCP
  diff/apply loop is the product.
- **Updater**: never restarts on its own; `install()` only runs from a
  "Restart to update" click. Changing the updater pubkey strands every
  existing install.
- **CSP** in `tauri.conf.json`: a new origin works in `tauri dev` but is
  blocked in the bundled app if not listed.

## Verify
```bash
gh run list --limit 3                      # Release + CI green; on failure: gh run view <id> --log-failed
gh release view v<x.y.z> --json assets --jq '.assets[].name'   # -setup.exe, -setup.exe.sig, latest.json
curl -sL https://github.com/Sph3ricalPeter/spark/releases/latest/download/latest.json | grep '"version"'
```
The release workflow takes about 10 to 15 minutes. A failed release: fix,
delete the tag locally and on origin, re-tag.

## After release
- Running copies find the update within an hour (or right away from a
  "Check for updates" action), download it quietly and show "Restart to update".
