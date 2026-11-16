// The chats: every conversation with Claude, kept in `.spark/chats.json`.
// Dev server side (Node). Runs reach it only through claude.ts.
//
// Each chat is one Claude session (its id is resumed by later prompts) about
// one element (its key, see client.ts chatKey). An element can have many
// chats over time; the open one is the one the popup shows, and "New chat"
// closes it (it stays in the Chats list, and can be opened again).
// "Resolve" archives a chat: it leaves the Chats list for the Resolved view,
// where it can be read and reopened. Chats are never deleted.
//
// chats.json is read by people and tools, so fields are only ever added.
// Version 1 (a map of element key to one chat) is read and upgraded.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ChatMessage = {
  role: "user" | "claude";
  text: string;
  ok?: boolean;
  at: number;
  /** The other elements picked with the chat's own (Shift+click) when this was asked, by label ("h2 in Card"). */
  with?: string[];
  /** Images the person attached (pasted or dropped), by file name in `.spark/images` (served at /@spark/images/<name>). */
  images?: string[];
};

export type Chat = {
  /** Spark's own id for the chat. */
  id: string;
  /** The element it's about (client.ts chatKey). */
  key: string;
  /** What the element was called when last asked about ("h2 in Card"). */
  label: string;
  /** The Claude session later prompts resume; null until the first reply. */
  sessionId: string | null;
  /** The model that last answered (claude-sonnet-5-5). */
  model?: string;
  messages: ChatMessage[];
  created: number;
  updated: number;
  /** "New chat" closed it: it no longer shows in the element's popup. */
  closed?: boolean;
  /** "Resolve" archived it: it's only in the Chats tab's Resolved view (and closed) until it's reopened. */
  resolved?: boolean;
  /** A chat with no element (key `<kind>:<id>`): "implement" is an Implement changes run, "task" any other run
   * (the Components view's "Write them with Claude", an Ask with nothing selected). Absent: an element's chat. */
  kind?: ChatKind;
};

export type ChatKind = "implement" | "task";

export type ChatFile = { version: 2; chats: Chat[] };

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function chatStore(dir: string, broadcast: (file: ChatFile) => void) {
  const file = path.join(dir, "chats.json");
  /** Chats re-filed under a new element key, so a reply in flight lands with its element. */
  const movedTo = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<ChatFile> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch {
      return { version: 2, chats: [] };
    }
    const r = raw as Partial<ChatFile> & Record<string, unknown>;
    if (r.version === 2 && Array.isArray(r.chats)) return r as ChatFile;
    // Version 1: { [key]: { sessionId, label, model, messages } }.
    const chats: Chat[] = [];
    for (const [key, v] of Object.entries(r)) {
      const c = v as Partial<Chat> | null;
      if (!c || !Array.isArray(c.messages)) continue;
      const at = c.messages.at(-1)?.at ?? Date.now();
      chats.push({ id: newId(), key, label: c.label ?? "", sessionId: c.sessionId ?? null, model: c.model, messages: c.messages, created: c.messages[0]?.at ?? at, updated: at });
    }
    return { version: 2, chats };
  }

  /** Change chats.json, one change at a time, and tell every client. */
  function change<T>(fn: (f: ChatFile) => T): Promise<T> {
    const run = async () => {
      const f = await load();
      const out = fn(f);
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify(f, null, 2) + "\n");
      broadcast(f);
      return out;
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  const resolve = (key: string) => {
    for (let n = 0; movedTo.has(key) && n < 20; n++) key = movedTo.get(key)!;
    return key;
  };
  const openOn = (f: ChatFile, key: string) => f.chats.filter((c) => c.key === key && !c.closed).at(-1);

  return {
    load,
    /** The element's open chat, made if there's none, with the person's message added (and the other elements it's about). */
    ask: (key: string, label: string | undefined, text: string, also?: string[], images?: string[]) =>
      change((f) => {
        key = resolve(key);
        let c = openOn(f, key);
        if (!c) {
          c = { id: newId(), key, label: label ?? "", sessionId: null, messages: [], created: Date.now(), updated: Date.now() };
          f.chats.push(c);
        }
        if (label) c.label = label;
        c.messages.push({ role: "user", text, at: Date.now(), ...(also?.length ? { with: also } : {}), ...(images?.length ? { images } : {}) });
        c.updated = Date.now();
        return { id: c.id, sessionId: c.sessionId };
      }),
    /** A chat of its own, with no element (one Implement changes run, one task), with what was asked. */
    begin: (kind: ChatKind, label: string, text: string, images?: string[]) =>
      change((f) => {
        const id = newId();
        const now = Date.now();
        f.chats.push({ id, key: `${kind}:${id}`, label, kind, sessionId: null, messages: [{ role: "user", text, at: now, ...(images?.length ? { images } : {}) }], created: now, updated: now });
        return id;
      }),
    /** Change one chat by id. */
    update: (id: string, fn: (c: Chat) => void) =>
      change((f) => {
        const c = f.chats.find((x) => x.id === id);
        if (!c) return;
        fn(c);
        c.updated = Date.now();
      }),
    /** "New chat": close the element's open chat; the next prompt starts a new one. */
    close: (key: string) =>
      change((f) => {
        for (const c of f.chats) if (c.key === resolve(key)) c.closed = true;
      }),
    /** Open a chat from the list again (or a resolved one, back into the list): it becomes its element's open chat. */
    reopen: (id: string) =>
      change((f) => {
        const c = f.chats.find((x) => x.id === id);
        if (!c) return;
        for (const x of f.chats) if (x.key === c.key && x !== c) x.closed = true;
        c.closed = false;
        delete c.resolved;
        // Last among its element's chats, so it's the open one.
        f.chats = [...f.chats.filter((x) => x !== c), c];
      }),
    /** "Resolve": archive a chat. It closes, leaves the Chats list for the Resolved view, and keeps everything. */
    resolve: (id: string) =>
      change((f) => {
        const c = f.chats.find((x) => x.id === id);
        if (!c) return;
        c.closed = true;
        c.resolved = true;
      }),
    /** An element's key changed (Claude's edit moved its lines): its chats follow. */
    move: (from: string, to: string) =>
      change((f) => {
        if (from === to) return;
        movedTo.set(from, to);
        for (const c of f.chats) if (c.key === from) c.key = to;
      }),
  };
}
