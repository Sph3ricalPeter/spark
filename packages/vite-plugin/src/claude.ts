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
// One run at a time (runner.ts): runs edit the project's files and apply the
// pending changes, so two at once would trip over each other. Nothing is
// turned away, though: a request while Claude works goes into its chat at
// once, marked `queued`, and runs when its turn comes, in the order asked.
// Just before it runs, `prepare` reads what it needs fresh (the pending
// changes, for one), since runs ahead of it may have changed the project.
import { run, running, stop, type RunEvent, type RunImage } from "./runner.ts";
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
  /** Images the person attached: Claude sees them with the prompt, and `saved` (their names in .spark/images) is what the chat shows. */
  images?: { saved: string[]; send: RunImage[] };
  /** What Claude is told; `resumed` when it carries on the chat's earlier session. */
  prompt: (resumed: boolean) => string;
  kind: "implement" | "ask";
  /** The pending changes Claude may mark applied (APPLIED <id>). */
  ids: string[];
  /**
   * Right before the run starts (it may have waited its turn): read what changed meanwhile and return
   * a fresh prompt and ids, or a string to answer the chat with instead of running (nothing left to do).
   */
  prepare?: () => Promise<Partial<Pick<Job, "prompt" | "ids">> | string | void>;
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
  /** The chat being answered, from the moment its turn comes until Claude's reply is in ("" while it's set up). */
  let current: string | null = null;
  /** Requests waiting their turn, oldest first: the chat, and when its message was written (to find it again). */
  const queue: { id: string; at: number; job: Job }[] = [];

  // A queue lives only as long as the dev server: what was left waiting last time says so.
  void chats.load().then((f) => (f.chats.some((c) => c.queued) ? chats.dropQueued("Spark closed before Claude got to this. Send it again.") : undefined));

  const say = (id: string, text: string, ok: boolean) => chats.update(id, (c) => c.messages.push({ role: "claude", text, ok, at: Date.now() }));
  /**
   * The chat's `queued` mark (whether anything of it still waits) and its messages': a message whose
   * turn came (`started`) moves to the end, so it reads after the reply it waited for.
   */
  const markQueued = (id: string, started?: number) => {
    const waiting = new Set(queue.filter((q) => q.id === id).map((q) => q.at));
    return chats.update(id, (c) => {
      if (waiting.size) c.queued = true;
      else delete c.queued;
      for (const m of c.messages) {
        if (m.role !== "user") continue;
        if (waiting.has(m.at)) m.queued = true;
        else delete m.queued;
      }
      const i = started === undefined ? -1 : c.messages.findIndex((m) => m.role === "user" && m.at === started);
      if (i >= 0) c.messages.push(...c.messages.splice(i, 1));
    });
  };

  /** Claude is free: start the next request in line. */
  async function next() {
    if (current !== null || running()) return;
    const item = queue.shift();
    if (!item) return;
    const { id, at } = item;
    let job = item.job;
    current = "";
    try {
      await markQueued(id, at);
      const fresh = await job.prepare?.();
      if (typeof fresh === "string") {
        await say(id, fresh, true);
        current = null;
        return void next();
      }
      if (fresh) job = { ...job, ...fresh };
      // The chat's session as it is now: a message that waited behind its own chat's run carries on from that reply.
      const chat = (await chats.load()).chats.find((c) => c.id === id);
      go(id, job, chat?.sessionId ?? undefined);
    } catch (err) {
      current = null;
      await say(id, `Spark couldn't start Claude: ${(err as Error).message}`, false).catch(() => {});
      void next();
    }
  }

  function go(id: string, job: Job, resume: string | undefined) {
    current = id;
    run({
      cwd: opts.cwd,
      prompt: job.prompt(!!resume),
      images: job.images?.send,
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
        if (e.type === "error") void say(id, e.text, false).then(next, next);
        else if (e.type === "session") {
          void chats.update(id, (c) => {
            c.sessionId = e.sessionId;
            if (e.model) c.model = e.model;
          });
        } else if (e.type === "done") {
          const done = e.applied.filter((x) => job.ids.includes(x));
          if (done.length) opts.applied(done);
          void (async () => {
            try {
              const text = (await job.reply?.(e)) ?? (e.summary || (e.ok ? "Done." : "Claude stopped."));
              await chats.update(id, (c) => {
                if (e.sessionId) c.sessionId = e.sessionId;
                if (e.model) c.model = e.model;
                c.messages.push({ role: "claude", text, ok: e.ok, at: Date.now() });
              });
              job.then?.(e);
            } finally {
              void next();
            }
          })();
        }
      },
    });
  }

  return {
    /**
     * Ask Claude: the chat it's in gets the request now and the reply when it's done. When Claude is
     * working on something else, the request waits its turn (the chat shows it queued). Returns the chat's id.
     */
    async ask(job: Job): Promise<string> {
      const t = job.topic;
      const { id, at } = "element" in t ? await chats.ask(t.element, t.label, job.request, job.also, job.images?.saved) : await chats.begin(t.kind, t.label, job.request, job.images?.saved);
      queue.push({ id, at, job });
      if (current !== null || running() || queue.length > 1) await markQueued(id);
      void next();
      return id;
    },
    /** Take a chat's waiting requests out of the queue; true when there were any. */
    async cancel(id: string): Promise<boolean> {
      const before = queue.length;
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) queue.splice(i, 1);
      if (queue.length === before) return false;
      await markQueued(id);
      await say(id, "Cancelled before Claude started on it.", false);
      return true;
    },
    /** Claude is running (or about to). */
    busy: () => current !== null || running(),
    /** The chat Claude is answering, or null. */
    running: () => current || null,
    /** The chats with requests waiting, in the order they'll run. */
    queued: () => [...new Set(queue.map((q) => q.id))],
    stop,
  };
}
