// The one way Spark talks to Claude. Dev server side (Node).
//
// Every Claude run in Spark starts here, and every run is a chat in the
// Chats list (chats.ts): what the person asked goes in first, the session id
// and model as soon as the CLI reports them, then Claude's reply or what went
// wrong. Nothing else imports the runner, so no run can happen outside a chat.
//
// A run is about one of:
// - an element: its open chat, one Claude session that later prompts resume
//   (Ask Claude in the popup);
// - nothing in particular: a chat of its own, with no element (Implement
//   changes, the Components view's "Write them with Claude", an Ask with
//   nothing selected).
//
// One run at a time (runner.ts); `ask` returns null when Claude is busy, and
// nothing is recorded.
import { run, running, stop, type RunEvent } from "./runner.ts";
import type { chatStore, ChatKind } from "./chats.ts";

type Chats = ReturnType<typeof chatStore>;
type Done = Extract<RunEvent, { type: "done" }>;

export type Topic =
  /** An element's open chat (client.ts chatKey), made if there's none. */
  | { element: string; label?: string }
  /** A new chat of its own, with no element. */
  | { kind: ChatKind; label: string };

export type Job = {
  topic: Topic;
  /** What the person asked, as the chat shows it. */
  request: string;
  /** Other elements the request is about besides the chat's own (Shift+click), as the chat shows them. */
  also?: string[];
  /** What Claude is told; `resumed` when it carries on the chat's earlier session. */
  prompt: (resumed: boolean) => string;
  kind: "implement" | "ask";
  /** The pending changes Claude may mark applied (APPLIED <id>). */
  ids: string[];
  /** Claude's reply as the chat shows it; by default its summary. */
  reply?: (done: Done) => string | Promise<string>;
  /** Claude's reply is in the chat: what comes next (another run may start from here). */
  then?: (done: Done) => void;
};

export function claude(opts: {
  cwd: string;
  chats: Chats;
  /** Every run event, to every client (spark:run); start, session and done carry the chat id. */
  broadcast: (e: RunEvent) => void;
  /** Claude applied these changes (already filtered to the run's ids). */
  applied: (ids: string[]) => void;
}) {
  const { chats } = opts;
  /** The chat being answered, from the moment it's asked until Claude's reply is in. */
  let current: string | null = null;

  const say = (id: string, text: string, ok: boolean) => chats.update(id, (c) => c.messages.push({ role: "claude", text, ok, at: Date.now() }));

  function go(id: string, job: Job, resume: string | undefined) {
    current = id;
    run({
      cwd: opts.cwd,
      prompt: job.prompt(!!resume),
      kind: job.kind,
      ids: job.ids,
      resume,
      emit: (e) => {
        // The session is gone (cleared history, another machine): start a new one with the full prompt.
        if (e.type === "done" && !e.ok && resume && /no conversation found|session/i.test(e.summary)) {
          go(id, job, undefined);
          return;
        }
        if (e.type === "done" || e.type === "error") current = null;
        opts.broadcast(e.type === "start" || e.type === "done" || e.type === "session" ? { ...e, chat: id } : e);
        if (e.type === "error") void say(id, e.text, false);
        else if (e.type === "session") {
          void chats.update(id, (c) => {
            c.sessionId = e.sessionId;
            if (e.model) c.model = e.model;
          });
        } else if (e.type === "done") {
          const done = e.applied.filter((x) => job.ids.includes(x));
          if (done.length) opts.applied(done);
          void (async () => {
            const text = (await job.reply?.(e)) ?? (e.summary || (e.ok ? "Done." : "Claude stopped."));
            await chats.update(id, (c) => {
              if (e.sessionId) c.sessionId = e.sessionId;
              if (e.model) c.model = e.model;
              c.messages.push({ role: "claude", text, ok: e.ok, at: Date.now() });
            });
            job.then?.(e);
          })();
        }
      },
    });
  }

  return {
    /** Ask Claude: the chat it's in gets the request now and the reply when it's done. Null when Claude is busy. */
    async ask(job: Job): Promise<string | null> {
      if (current !== null || running()) return null;
      // Taken before the chat is written, so a second request meanwhile is turned away.
      current = "";
      try {
        const t = job.topic;
        const { id, sessionId } = "element" in t ? await chats.ask(t.element, t.label, job.request, job.also) : { id: await chats.begin(t.kind, t.label, job.request), sessionId: null };
        go(id, job, sessionId ?? undefined);
        return id;
      } catch (err) {
        current = null;
        throw err;
      }
    },
    /** Claude is running (or about to). */
    busy: () => current !== null || running(),
    /** The chat Claude is answering, or null. */
    running: () => current || null,
    stop,
  };
}
