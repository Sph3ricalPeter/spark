# Release and deploy setup

Ported from [dawg](https://github.com/Sph3ricalPeter/dawg) (`dev` branch). spark
has no app code yet, so this is the pipeline waiting for the app. CI is already
live and switches each job on as its piece lands (see the comment at the top of
`.github/workflows/ci.yml`).

## How it works

| Trigger | Workflow | Result |
| --- | --- | --- |
| PR, push to `dev`/`main` | `ci.yml` | typecheck, lint, build; `cargo fmt`/`clippy`/`test`; Windows "spark dev" installer as a build artifact |
| Push to `dev` (with signing key) | `ci.yml` | signed `x.y.z-dev.<run>` build published to the rolling `dev-build` prerelease; installed "spark dev" copies update from it |
| Tag `v*.*.*` | `release.yml` | signed Windows installer, `.sig` and `latest.json` published as GitHub Release "spark vX.Y.Z"; installed spark copies update from it |

Two apps install side by side: **spark** (`com.sph3ricalpeter.spark`, release
channel) and **spark dev** (`com.sph3ricalpeter.spark.dev`, dev channel). Local
and debug builds never self-update. The release procedure itself is in
`.claude/release.md`.

## One-time setup (Peter)

1. Create a `dev` branch from `main` and make it the default branch. Day-to-day
   work goes there; `main` only moves at release time, fast-forwarded.
2. Generate the updater signing key (once the Tauri CLI is installed):
   `npx tauri signer generate -w ~/.tauri/spark.key`
3. Add repo secrets `TAURI_SIGNING_PRIVATE_KEY` (the key file's contents) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Without them CI still builds, it just
   doesn't publish dev updates, and `release.yml` refuses to run.
4. Put the public key into `plugins.updater.pubkey` in `tauri.conf.json`.
   Never change it after the first release: it strands every install.

## What the app needs to bring (once the stack is decided)

The workflows assume dawg's layout. If spark goes Tauri + React + Rust too,
add these with the app:

- `package.json` scripts: `typecheck`, `lint`, `build`, and
  `"build:dev": "tauri build --config src-tauri/tauri.dev.conf.json"`.
- `src-tauri/tauri.conf.json` with `"version"`, `"identifier":
  "com.sph3ricalpeter.spark"`, `bundle.targets: ["nsis"]`,
  `bundle.createUpdaterArtifacts: true`, and:
  ```json
  "plugins": {
    "updater": {
      "pubkey": "REPLACE_WITH_UPDATER_PUBLIC_KEY",
      "endpoints": ["https://github.com/Sph3ricalPeter/spark/releases/latest/download/latest.json"],
      "windows": { "installMode": "passive" }
    }
  }
  ```
- `src-tauri/tauri.dev.conf.json`, merged over it for "spark dev":
  ```json
  {
    "$schema": "https://schema.tauri.app/config/2",
    "productName": "spark dev",
    "identifier": "com.sph3ricalpeter.spark.dev",
    "plugins": {
      "updater": {
        "endpoints": ["https://github.com/Sph3ricalPeter/spark/releases/download/dev-build/latest.json"]
      }
    },
    "bundle": { "createUpdaterArtifacts": false }
  }
  ```
- In the app crate, only register the updater plugin when the build should
  self-update (dawg's `src-tauri/src/lib.rs`):
  ```rust
  const RELEASE_IDENTIFIER: &str = "com.sph3ricalpeter.spark";
  const DEV_IDENTIFIER: &str = "com.sph3ricalpeter.spark.dev";

  fn updates_enabled(app: &tauri::AppHandle) -> bool {
      let id = app.config().identifier.as_str();
      !cfg!(debug_assertions)
          && (id == RELEASE_IDENTIFIER
              || (id == DEV_IDENTIFIER
                  && app.package_info().version.pre.as_str().starts_with("dev.")))
  }
  ```
  and a "Restart to update" UI that calls `install()` only on click.

## Open questions for the planning thread

- **Desktop or web?** dawg is a Windows desktop app, so its deploy is "signed
  NSIS installer + Tauri updater". If spark is (also) a web app, the deploy
  half changes: a static/host deploy on push to `dev` (preview) and on tag
  (production) replaces the installer jobs. `ci.yml`'s frontend job and the
  release-notes job carry over unchanged.
- **Platforms.** Windows x64 only, like dawg. macOS needs a `macos-latest`
  matrix entry and, realistically, Apple signing/notarization.
- **MCP server packaging.** dawg ships `dawg-cli.exe` (CLI + MCP server) next
  to the app via `beforeBundleCommand` and NSIS hooks. spark's MCP server will
  need the same treatment; add an artifact upload for it to the Windows job.
- **Installer hooks.** dawg's `windows/hooks.nsh` (Explorer verbs, file
  association, killing the running MCP exe before update) isn't ported; add a
  spark version once there's a file type to associate.
