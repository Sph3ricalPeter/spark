// The project's UI state: everything about how Spark looked when the project
// was last open, kept in `.spark/state.json`. Dev server side (Node); the
// pages' side is state.ts.
//
// One file per project, next to changes.json and chats.json, because the
// browser's own storage can't hold it: Spark starts each project's dev
// server on a free port, and localStorage belongs to one origin
// (127.0.0.1:<port>), so every reopen started empty.
//
// The file is a flat map of keys (state.ts lists them) to JSON values:
//   { "version": 1, "values": { "board": { … }, "panel-open": true } }
// Keys are only ever added; a key Spark no longer reads is kept as is.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type StateFile = { version: 1; values: Record<string, unknown> };

/** How long writes are gathered before the file is written (zooming sends many). */
const WRITE_DELAY = 250;

/** `name` is the file in `dir`: state.json, or settings.json for Spark's own settings (index.ts). */
export function stateStore(dir: string, name = "state.json") {
  const file = path.join(dir, name);
  let state: Promise<StateFile> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<unknown> = Promise.resolve();

  async function read(): Promise<StateFile> {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as Partial<StateFile> | null;
      if (raw && typeof raw.values === "object" && raw.values) return { version: 1, values: raw.values };
    } catch {
      // No state yet (or a broken file): start empty.
    }
    return { version: 1, values: {} };
  }

  /** The state, read once and then kept in memory: this server is its only writer. */
  const load = () => (state ??= read());

  function flush() {
    timer = null;
    const run = async () => {
      const s = await load();
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify(s, null, 2) + "\n");
    };
    writing = writing.then(run, run).catch(() => {});
  }

  return {
    /** Every value, for a page that's starting. */
    values: async () => (await load()).values,
    /** Set one key (undefined or null removes it); the file is written shortly after. */
    async set(key: string, value: unknown) {
      const s = await load();
      if (value === undefined || value === null) delete s.values[key];
      else s.values[key] = value;
      if (!timer) timer = setTimeout(flush, WRITE_DELAY);
    },
    /** Write now (the dev server is closing). */
    async close() {
      if (timer) {
        clearTimeout(timer);
        flush();
      }
      await writing;
    },
  };
}
