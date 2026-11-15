// The project's UI state, the pages' side: how the board and the panels were
// left, read back the next time the project opens. The dev server keeps it in
// `.spark/state.json` (state-file.ts); this module fetches it before anything
// that imports it runs, then keeps a copy in step.
//
// Remembered UI belongs here, not in localStorage: Spark opens each project
// on a new port, and localStorage is per origin, so it started empty every
// time. Keys, and what they hold:
//   board      shell.ts: app frames (id, x, y, w, h, preset), moved component
//              frames, row/stacked layouts, the selected frame, the camera
//   panel-open client.ts: the inspector is docked open
//   sections   client.ts: which inspector sections are unfolded
//   sidebar    sidebar.ts: the left sidebar is open, and on which tab
// A new key is added to this list and to LEGACY if it had a localStorage one.
// Values are JSON; the file is read by people too, so shapes only grow.

export type StateKey = "board" | "panel-open" | "sections" | "sidebar";

const ENDPOINT = "/@spark/state";

/**
 * Where each key lived in localStorage before. Read once when the project's
 * file doesn't have the key yet, so a dev server on a fixed port (the
 * fixture) keeps what it had.
 */
const LEGACY: Partial<Record<StateKey, () => unknown>> = {
  board: () => json("spark:board"),
  "panel-open": () => flag("spark:open"),
  sections: () => json("spark:sections"),
  sidebar: () => {
    const open = flag("spark:sidebar");
    const tab = localStorage.getItem("spark:sidebar-tab");
    return open === undefined && tab === null ? undefined : { open: !!open, tab: tab ?? "" };
  },
};

function json(key: string): unknown {
  const raw = localStorage.getItem(key);
  return raw === null ? undefined : JSON.parse(raw);
}

function flag(key: string): boolean | undefined {
  const raw = localStorage.getItem(key);
  return raw === null ? undefined : raw === "1";
}

let values: Record<string, unknown> = {};
try {
  const res = await fetch(ENDPOINT, { cache: "no-store" });
  if (res.ok) values = ((await res.json()) as Record<string, unknown> | null) ?? {};
} catch {
  // No Spark dev server behind the page: nothing remembered, nothing saved.
}

/** The saved value for `key`, or undefined. */
export function getState<T>(key: StateKey): T | undefined {
  if (key in values) return values[key] as T;
  try {
    return LEGACY[key]?.() as T | undefined;
  } catch {
    return undefined;
  }
}

const pending = new Map<StateKey, ReturnType<typeof setTimeout>>();

/**
 * Remember `value` for `key` (undefined forgets it). `delay` gathers a burst
 * of changes, like a zoom gesture, into one save.
 */
export function setState(key: StateKey, value: unknown, delay = 0) {
  // Every frame reports the same panel state as it starts: only changes are sent.
  if (!pending.has(key) && JSON.stringify(values[key]) === JSON.stringify(value)) return;
  values[key] = value;
  clearTimeout(pending.get(key));
  const send = () => {
    pending.delete(key);
    import.meta.hot?.send("spark:state", { key, value: values[key] });
  };
  if (delay > 0) pending.set(key, setTimeout(send, delay));
  else send();
}

// Another frame saved something: later reads here see it too.
import.meta.hot?.on("spark:state", (d: { key: string; value: unknown }) => {
  if (pending.has(d.key as StateKey)) return;
  if (d.value === undefined || d.value === null) delete values[d.key];
  else values[d.key] = d.value;
});
