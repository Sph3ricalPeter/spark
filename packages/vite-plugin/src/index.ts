// spark-vite-plugin: makes a running React app editable from inside itself.
//
// Dev server only (`apply: "serve"`); production builds are untouched.
// - Tags JSX with source locations (see tag.ts).
// - Rewrites index.html so the page opened is the viewport shell (shell.ts)
//   and the app, with the Spark client (overlay + panel, see client.ts),
//   runs in the shell's iframe. See mode.ts.
// - Talks to the client over Vite's own HMR socket, so it works wherever hot
//   reload works, including a Tauri window, and writes what the client sends
//   into `.spark/` in the project root: selection.json and changes.json.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchForWorkspaceRoot, type Plugin } from "vite";
import { tagJsx } from "./tag.ts";
import type { ChangeLog } from "./changes.ts";
import { askPrompt, implementPrompt, type AskSelection } from "./prompt.ts";
import { run, running, stop, type RunEvent } from "./runner.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULES: Record<string, string> = {
  "/@spark/client": path.join(here, "client.ts"),
  "/@spark/shell": path.join(here, "shell.ts"),
  "/@spark/mode": path.join(here, "mode.ts"),
};
const ENTRY = "/@spark/entry";
const ENTRY_ID = "\0spark-entry:";

/** The app's own `<script type="module" src>` tags. */
const MODULE_SCRIPT = /<script\b(?=[^>]*\btype\s*=\s*["']module["'])[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi;

/**
 * An app entry behind the mode check: the shell page loads the shell instead
 * of the app; the app's iframe loads the app, then the client.
 */
function entryModule(src: string) {
  return [
    `import { mode, borrowTauri } from "/@spark/mode";`,
    `if (mode === "shell") import("/@spark/shell");`,
    `else {`,
    `  borrowTauri();`,
    `  import(${JSON.stringify(src)}).finally(() => import("/@spark/client"));`,
    `}`,
  ].join("\n");
}

export default function spark(): Plugin {
  let root = process.cwd();

  return {
    name: "spark",
    apply: "serve",
    // Before React's plugin turns JSX into function calls.
    enforce: "pre",

    config(config) {
      // The client file may live outside the app (a linked package).
      return {
        server: { fs: { allow: [searchForWorkspaceRoot(config.root ?? process.cwd()), here] } },
      };
    },

    configResolved(config) {
      root = config.root;
    },

    resolveId(id) {
      if (id in MODULES) return MODULES[id];
      if (id.startsWith(`${ENTRY}?src=`)) return ENTRY_ID + decodeURIComponent(id.slice(ENTRY.length + 5));
      return null;
    },

    load(id) {
      if (id.startsWith(ENTRY_ID)) return entryModule(id.slice(ENTRY_ID.length));
      return null;
    },

    transform(code, id) {
      const file = id.split("?")[0];
      if (id.startsWith("\0") || !/\.[jt]sx$/.test(file) || file.includes("/node_modules/")) return null;
      const rel = path.relative(root, file).split(path.sep).join("/");
      const out = tagJsx(code, file, rel);
      return out === null ? null : { code: out, map: null };
    },

    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        let entries = 0;
        const dir = path.posix.dirname(ctx.path);
        const out = html.replace(MODULE_SCRIPT, (tag, src: string) => {
          if (/^([a-z]+:)?\/\//i.test(src) || src.startsWith("/@")) return tag;
          entries++;
          const abs = src.startsWith("/") ? src : path.posix.join(dir, src);
          return `<script type="module" src="${ENTRY}?src=${encodeURIComponent(abs)}"></script>`;
        });
        if (entries) return out;
        // No entry to wrap: no shell, the client docks into the page as is.
        return {
          html,
          tags: [{ tag: "script", attrs: { type: "module", src: "/@spark/client" }, injectTo: "body" }],
        };
      },
    },

    configureServer(server) {
      const dir = path.join(root, ".spark");
      const save = async (name: string, data: unknown) => {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, name), JSON.stringify(data, null, 2) + "\n");
      };
      server.ws.on("spark:hello", async (_data, client) => {
        let changes = null;
        try {
          changes = JSON.parse(await readFile(path.join(dir, "changes.json"), "utf8"));
        } catch {
          // No changes yet.
        }
        client.send("spark:ready", { name: path.basename(root), root: root.split(path.sep).join("/"), changes });
      });
      // The current selection, for the MCP server's get_selection (milestone 3).
      server.ws.on("spark:select", (data) => save("selection.json", data));
      // Every edit, at the level it was made: what Claude applies to the code.
      // Changes Claude applied stay applied, even when a client that hasn't heard yet saves its list.
      const appliedIds = new Set<string>();
      server.ws.on("spark:changes", (data: ChangeLog) => {
        for (const c of data.changes ?? []) if (appliedIds.has(c.id)) c.status = "applied";
        return save("changes.json", data);
      });

      // Claude, from the panel: "Implement changes" and "Ask Claude".
      const loadLog = async (): Promise<ChangeLog> => {
        try {
          return JSON.parse(await readFile(path.join(dir, "changes.json"), "utf8"));
        } catch {
          return { version: 1, changes: [] };
        }
      };
      const start = async (kind: "implement" | "ask", prompt: string, ids: string[]) => {
        const emit = (e: RunEvent) => server.ws.send("spark:run", e);
        run({
          cwd: root,
          prompt,
          kind,
          ids,
          emit: (e) => {
            emit(e);
            if (e.type !== "done" || e.applied.length === 0) return;
            // Mark what Claude applied, against the latest log (edits may have arrived meanwhile).
            void loadLog().then(async (log) => {
              const done = new Set(e.applied.filter((id) => ids.includes(id)));
              for (const id of done) appliedIds.add(id);
              for (const c of log.changes) if (done.has(c.id)) c.status = "applied";
              await save("changes.json", log);
              server.ws.send("spark:log", log);
            });
          },
        });
      };
      server.ws.on("spark:implement", async (data: { ids?: string[] }) => {
        const log = await loadLog();
        const pending = log.changes.filter((c) => c.status === "pending" && (!data?.ids || data.ids.includes(c.id)));
        if (pending.length === 0) return;
        await start("implement", implementPrompt(pending), pending.map((c) => c.id));
      });
      server.ws.on("spark:ask", async (data: { request: string; selection: AskSelection | null }) => {
        const log = await loadLog();
        const pending = log.changes.filter((c) => c.status === "pending");
        await start("ask", askPrompt(data.request, data.selection, pending), pending.map((c) => c.id));
      });
      server.ws.on("spark:stop", () => stop());
      server.ws.on("spark:run-state", (_d, client) => client.send("spark:run-state", { running: running() }));
    },
  };
}
