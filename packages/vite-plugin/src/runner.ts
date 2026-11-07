// Runs the local Claude CLI on the project, for "Implement changes" and
// "Ask Claude" in the panel. Dev server side (Node).
//
// One run at a time. The prompt goes in on stdin; `--output-format
// stream-json` comes back as one JSON event per line, which we boil down to
// short progress lines for the panel. File edits are allowed without asking
// (`--permission-mode acceptEdits`); anything else Claude wants to run is
// denied, since nobody is there to approve it.
//
// Claude ends its reply with `APPLIED <id>` / `SKIPPED <id>: why` lines, one
// per change it was given; those decide which changes are marked applied.
//
// Every run is a Claude session; "done" carries its id, and `resume` carries
// on in an earlier one (the Ask popup's chat on an element).
import { spawn, type ChildProcess } from "node:child_process";

export type RunEvent =
  | { type: "start"; kind: "implement" | "ask"; ids: string[]; chat?: string }
  | { type: "log"; text: string }
  | { type: "done"; ok: boolean; applied: string[]; skipped: { id: string; why: string }[]; summary: string; cost?: number; sessionId?: string; chat?: string }
  | { type: "error"; text: string };

let current: ChildProcess | null = null;

export const running = () => current !== null;

export function stop() {
  current?.kill();
}

/** Short, human lines for the panel from one stream-json event. */
function describe(ev: Record<string, unknown>): string[] {
  if (ev.type !== "assistant") return [];
  const msg = ev.message as { content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] } | undefined;
  const out: string[] = [];
  for (const part of msg?.content ?? []) {
    if (part.type === "text" && part.text?.trim()) out.push(part.text.trim().split("\n")[0].slice(0, 200));
    if (part.type === "tool_use") {
      const input = part.input ?? {};
      const file = (input.file_path ?? input.path ?? input.pattern ?? "") as string;
      out.push(`${part.name}${file ? ` ${String(file).split(/[\\/]/).slice(-2).join("/")}` : ""}`);
    }
  }
  return out;
}

export function parseVerdicts(text: string) {
  const applied = [...text.matchAll(/^\s*APPLIED\s+(\S+)/gm)].map((m) => m[1]);
  const skipped = [...text.matchAll(/^\s*SKIPPED\s+(\S+?):?\s+(.*)$/gm)].map((m) => ({ id: m[1], why: m[2].trim() }));
  return { applied, skipped };
}

export function run(opts: { cwd: string; prompt: string; kind: "implement" | "ask"; ids: string[]; resume?: string; emit: (e: RunEvent) => void }) {
  if (current) {
    opts.emit({ type: "error", text: "Claude is already running." });
    return;
  }
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
  // A session id is a UUID; anything else never reaches the command line (it goes through a shell on Windows).
  if (opts.resume && /^[\w-]+$/.test(opts.resume)) args.push("--resume", opts.resume);
  // claude is claude.cmd on Windows, which needs a shell to start.
  const child = spawn("claude", args, { cwd: opts.cwd, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
  current = child;
  opts.emit({ type: "start", kind: opts.kind, ids: opts.ids });

  let buf = "";
  let result = "";
  let cost: number | undefined;
  let sessionId: string | undefined;
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof ev.session_id === "string") sessionId = ev.session_id;
      if (ev.type === "result") {
        result = typeof ev.result === "string" ? ev.result : "";
        cost = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined;
      }
      for (const text of describe(ev)) opts.emit({ type: "log", text });
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  child.on("error", (err) => {
    current = null;
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    opts.emit({ type: "error", text: missing ? "The claude CLI isn't installed or isn't on PATH." : err.message });
  });
  child.on("close", (code) => {
    if (current !== child) return;
    current = null;
    const { applied, skipped } = parseVerdicts(result);
    const ok = code === 0;
    const summary = result
      .split("\n")
      .filter((l) => !/^\s*(APPLIED|SKIPPED)\b/.test(l))
      .join("\n")
      .trim();
    opts.emit({ type: "done", ok, applied, skipped, summary: ok ? summary : stderr.trim().slice(-500) || `claude exited with ${code}`, cost, sessionId });
  });
  child.stdin.end(opts.prompt);
}
