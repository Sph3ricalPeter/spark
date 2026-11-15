// Sample data: what the app's own backend calls answer on the board.
//
// Spark runs the app's frontend only. Its backend (a Tauri app's Rust
// commands, called with `invoke`) doesn't run here, so a screen that waits
// for data from it stays empty. `spark.setup.tsx` at the project root fills
// in for it:
//
//   // Every frame: commands whose answer never changes.
//   export const tauri = { app_info: () => ({ version: "1.0.0" }) };
//   // Named states, each its own fakes; the first is the default.
//   export const samples = {
//     Empty: { session_state: () => null },
//     "WAV loaded": { session_state: () => wav, peaks: () => wave.buffer },
//     // A function: called once when the frame loads, so its fakes can keep
//     // state between calls (open, edit, undo) or seed what the app reads
//     // at startup.
//     Editing: () => {
//       let s = wav;
//       return { session_state: () => s, apply: ({ command }) => (s = edit(s, command)) };
//     },
//   };
//
// An app frame picks its sample in the inspector, which reloads the frame with
// `?spark-sample=<name>` (shell.ts); without one it gets the first. Component
// frames (gallery.ts) get the first too. Fakes are asked before anything else
// (mode.ts borrowTauri), so `plugin:` commands such as the system dialogs stay
// Spark's real ones unless a sample fakes them on purpose. The `/@spark/samples`
// module (index.ts) installs them in app frames, before the app's own code runs.
import { mode, noAnswer, shell, type TauriFakes } from "./mode.ts";

/** The address parameter that names an app frame's sample. */
export const SAMPLE_PARAM = "spark-sample";

export type Sample = TauriFakes | (() => TauriFakes);
/** What spark.setup exports that matters here. */
export type Setup = { default?: unknown; tauri?: TauriFakes; samples?: Record<string, Sample> };

/** The samples' names, in the order they're written. */
export function sampleNames(setup: Setup | undefined): string[] {
  const s = setup?.samples;
  return s && typeof s === "object" ? Object.keys(s) : [];
}

/**
 * Answer the app's own `invoke` calls with the setup's `tauri` fakes and the
 * sample named `wanted` (unknown or null: the first). Returns the sample used.
 */
export function installSample(setup: Setup | undefined, wanted: string | null): string | null {
  const names = sampleNames(setup);
  const name = wanted !== null && names.includes(wanted) ? wanted : (names[0] ?? null);
  const fakes: TauriFakes = { ...(setup?.tauri ?? {}) };
  if (name !== null) {
    const sample = setup!.samples![name];
    try {
      Object.assign(fakes, typeof sample === "function" ? sample() : sample);
    } catch (e) {
      console.error(`[spark] The "${name}" sample in spark.setup failed to start:`, e);
    }
  }
  if (!Object.keys(fakes).length) return name;
  window.__sparkTauriFakes = fakes;
  fakeTauri(fakes);
  return name;
}

/**
 * Inside Spark's window the frame already has Tauri (mode.ts borrowTauri),
 * which asks the fakes first. In a plain browser there's none: fake the rest
 * too, so the app's calls reach the fakes.
 */
function fakeTauri(fakes: TauriFakes) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (w.__TAURI_INTERNALS__) return;
  let next = 1;
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: () => next++,
    invoke: async (cmd: string, args: unknown) => {
      if (cmd in fakes) return fakes[cmd](args);
      // Events: listening succeeds and nothing ever arrives.
      if (cmd.startsWith("plugin:event|")) return next++;
      if (!cmd.startsWith("plugin:")) noAnswer(cmd);
      throw new Error(`spark.setup: no fake for Tauri command "${cmd}"`);
    },
  };
}

/** An app frame: install its sample and tell the board which ones there are (its inspector lists them). */
export function startAppSample(setup: Setup | undefined) {
  const name = installSample(setup, new URLSearchParams(location.search).get(SAMPLE_PARAM));
  if (mode === "frame") shell?.samples?.(window, sampleNames(setup), name);
}
