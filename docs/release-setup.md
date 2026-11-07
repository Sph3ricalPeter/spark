# Release and deploy setup

Ported from [dawg](https://github.com/Sph3ricalPeter/dawg). spark is a Tauri 2
+ React desktop app for Windows that updates itself.

## How it works

| Trigger | Workflow | Result |
| --- | --- | --- |
| Push to `dev`/`main` | `ci.yml` | typecheck, lint, build; `cargo fmt`/`clippy`/`test`; Windows "spark dev" installer as a build artifact |
| Push to `dev` (with signing key) | `ci.yml` | signed `x.y.z-dev.<run>` build published to the rolling [`dev-build`](https://github.com/Sph3ricalPeter/spark/releases/tag/dev-build) prerelease; installed "spark dev" copies update from it |
| Tag `v*.*.*` | `release.yml` | signed Windows installer, `.sig` and `latest.json` published as GitHub Release "spark vX.Y.Z"; installed spark copies update from it |

Two apps install side by side: **spark** (`com.sph3ricalpeter.spark`, release
channel) and **spark dev** (`com.sph3ricalpeter.spark.dev`, dev channel). Local
and debug builds never self-update (`updates_enabled` in `src-tauri/src/lib.rs`).

In the app, the title bar's update button shows where the updater stands:
download arrow (click to check), spinner, a ring filling while it downloads,
then a green arrow with a dot when an update is ready. Clicking that opens
what's new with **Restart now**. The updater never restarts on its own.
"spark dev" checks every 10 minutes, spark every hour.

## Versioning

- Dev builds: CI stamps `<version>-dev.<run number>` on every push to `dev`,
  so nothing to do.
- Releases: bump the version in `package.json`, `src-tauri/tauri.conf.json`
  and `Cargo.toml`, then tag `v<x.y.z>` (see `.claude/release.md`).

## Signing key

spark has its own updater key pair (made with `npx @tauri-apps/cli signer
generate -w ~/.tauri/spark.key`). The public half is `plugins.updater.pubkey`
in `tauri.conf.json`; the private key and its password live only in the repo
secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
(Settings → Secrets and variables → Actions) and in Peter's `~/.tauri`.

Without the secrets CI still builds the installer, but doesn't publish dev
updates, and `release.yml` refuses to run. Never change the pubkey once spark
is installed anywhere: it strands every copy. Rotating the key means a new
pubkey here plus new secrets, and reinstalling by hand.

## Later

- macOS needs a `macos-latest` build and Apple signing/notarization.
- spark's MCP server, once it exists, should ship next to the app like
  `dawg-cli.exe` (`beforeBundleCommand` plus NSIS hooks in dawg).
