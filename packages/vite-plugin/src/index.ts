// spark-vite-plugin: makes a running React app editable from inside itself.
//
// Dev server only (`apply: "serve"`); production builds are untouched.
// - Tags JSX with source locations (see tag.ts).
// - Rewrites index.html so the page opened is the viewport shell (shell.ts)
//   and the app, with the Spark client (overlay + panel, see client.ts),
//   runs in the shell's iframe. See mode.ts.
// - Talks to the client over Vite's own HMR socket, so it works wherever hot
//   reload works, including a Tauri window, and writes what the client sends
//   into `.spark/` in the project root: selection.json and changes.json, and
//   chats.json: the Ask popup's conversations, one Claude session per element.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchForWorkspaceRoot, type Plugin } from "vite";
import { tagJsx } from "./tag.ts";
import type { ChangeLog } from "./changes.ts";
import { askPrompt, followupPrompt, galleryPrompt, implementPrompt, type AskSelection } from "./prompt.ts";
import { run, running, stop, type RunEvent } from "./runner.ts";

/** One Ask popup conversation (.spark/chats.json, by element key). */
type Chat = {
  /** The Claude session later prompts resume; null until the first reply. */
  sessionId: string | null;
  /** What the element was called when last asked about ("h2 in Card"). */
  label: string;
  /** The model that last answered (claude-sonnet-5-5). */
  model?: string;
  messages: { role: "user" | "claude"; text: string; ok?: boolean; at: number }[];
};

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULES: Record<string, string> = {
  "/@spark/client": path.join(here, "client.ts"),
  "/@spark/shell": path.join(here, "shell.ts"),
  "/@spark/mode": path.join(here, "mode.ts"),
  "/@spark/gallery": path.join(here, "gallery.ts"),
};
const ENTRY = "/@spark/entry";
const ENTRY_ID = "\0spark-entry:";
const COMPONENTS = "/@spark/components";
const COMPONENTS_ID = "\0spark-components:";
/** The board's list of case files (shell.ts), live as files come and go. */
const CASES = "/@spark/cases";
const CASES_ID = "\0spark-cases";
const CASES_MODULE = [
  `export default Object.keys(import.meta.glob(["/**/*.spark.{tsx,jsx}", "!**/node_modules/**"]));`,
  `if (import.meta.hot) import.meta.hot.accept((m) => m && window.dispatchEvent(new CustomEvent("spark:cases", { detail: m.default })));`,
].join("\n");

/** Side-effect stylesheet imports (`import "./styles.css"`): the app's global CSS. */
const CSS_IMPORT = /^\s*import\s+["']([^"']+\.(?:css|scss|sass|less|styl)(?:\?[^"']*)?)["']/gm;

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
    // The Components view (gallery.ts) runs in the frame instead of the app.
    `  const view = mode === "frame" && new URLSearchParams(location.search).get("spark") === "components";`,
    `  const app = view ? import(${JSON.stringify(`${COMPONENTS}?entry=${encodeURIComponent(src)}`)}) : import(${JSON.stringify(src)});`,
    `  app.finally(() => import("/@spark/client"));`,
    `}`,
  ].join("\n");
}

/**
 * The Components view for one app entry: the entry's global CSS, the
 * optional spark.setup, every *.spark.tsx, and the app's own React.
 */
async function componentsModule(root: string, entry: string) {
  let css: string[] = [];
  try {
    const code = await readFile(path.join(root, entry), "utf8");
    css = [...code.matchAll(CSS_IMPORT)].map((m) => (m[1].startsWith(".") ? path.posix.join(path.posix.dirname(entry), m[1]) : m[1]));
  } catch {
    // An entry we can't read: no global CSS.
  }
  return [
    `import * as React from "react";`,
    `import { createRoot } from "react-dom/client";`,
    ...css.map((c) => `import ${JSON.stringify(c)};`),
    `import { mountGallery } from "/@spark/gallery";`,
    `const files = import.meta.glob(["/**/*.spark.{tsx,jsx}", "!**/node_modules/**"], { eager: true });`,
    `const setup = Object.values(import.meta.glob(["/spark.setup.{tsx,jsx,ts,js}"], { eager: true }))[0];`,
    `mountGallery({ React, createRoot, files, setup });`,
    // A new or changed case file re-renders the gallery in place.
    `if (import.meta.hot) import.meta.hot.accept();`,
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
      if (id === CASES) return CASES_ID;
      if (id.startsWith(`${ENTRY}?src=`)) return ENTRY_ID + decodeURIComponent(id.slice(ENTRY.length + 5));
      if (id.startsWith(`${COMPONENTS}?entry=`)) return COMPONENTS_ID + decodeURIComponent(id.slice(COMPONENTS.length + 7));
      return null;
    },

    load(id) {
      if (id === CASES_ID) return CASES_MODULE;
      if (id.startsWith(ENTRY_ID)) return entryModule(id.slice(ENTRY_ID.length));
      if (id.startsWith(COMPONENTS_ID)) return componentsModule(root, id.slice(COMPONENTS_ID.length));
      return null;
    },

    transform(code, id) {
      const file = id.split("?")[0];
      if (id.startsWith("\0") || !/\.[jt]sx$/.test(file) || file.includes("/node_modules/")) return null;
      const rel = path.relative(root, file).split(path.sep).join("/");
      let out = tagJsx(code, file, rel);
      // Components view case files: remember the order the cases are written in (gallery.ts).
      if (/\.spark\.[jt]sx$/.test(file)) {
        const names = [...code.matchAll(/^export\s+(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
        out = `${out ?? code}\nexport const __sparkOrder = ${JSON.stringify(names)};\n`;
      }
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
      // Spark's UI font (fonts.ts), bundled so it works offline.
      server.middlewares.use("/@spark/fonts", (req, res, next) => {
        const name = path.basename((req.url ?? "").split("?")[0]);
        if (!/^manrope-[\w-]+\.woff2$/.test(name)) return next();
        readFile(path.join(here, "..", "assets", "fonts", name)).then(
          (buf) => {
            res.setHeader("Content-Type", "font/woff2");
            res.setHeader("Cache-Control", "max-age=31536000, immutable");
            res.end(buf);
          },
          () => next(),
        );
      });
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
        client.send("spark:ready", { name: path.basename(root), root: root.split(path.sep).join("/"), changes, chats: await loadChats() });
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

      const loadChats = async (): Promise<Record<string, Chat>> => {
        try {
          return JSON.parse(await readFile(path.join(dir, "chats.json"), "utf8"));
        } catch {
          return {};
        }
      };
      /** Chats re-filed under a new key (spark:chat-move), so a reply in flight lands in the right one. */
      const movedTo = new Map<string, string>();
      /** chats.json changes one at a time, so a reply and a move never overwrite each other. */
      let chatQueue: Promise<unknown> = Promise.resolve();
      const serial = (fn: () => Promise<void>) => (chatQueue = chatQueue.then(fn, fn));
      const updateChat = (key: string, fn: (c: Chat) => Chat) =>
        serial(async () => {
          for (let n = 0; movedTo.has(key) && n < 20; n++) key = movedTo.get(key)!;
          const chats = await loadChats();
          chats[key] = fn(chats[key] ?? { sessionId: null, label: "", messages: [] });
          await save("chats.json", chats);
          server.ws.send("spark:chat", { key, chat: chats[key] });
        });

      // Claude, from the panel: "Implement changes" and "Ask Claude".
      const loadLog = async (): Promise<ChangeLog> => {
        try {
          return JSON.parse(await readFile(path.join(dir, "changes.json"), "utf8"));
        } catch {
          return { version: 1, changes: [] };
        }
      };
      const start = async (kind: "implement" | "ask", prompt: string, ids: string[], chat?: { key: string; resume?: string; then: (e: RunEvent) => void }) => {
        const emit = (e: RunEvent) => server.ws.send("spark:run", chat && (e.type === "start" || e.type === "done" || e.type === "session") ? { ...e, chat: chat.key } : e);
        runningChat = chat?.key ?? null;
        run({
          cwd: root,
          prompt,
          kind,
          ids,
          resume: chat?.resume,
          emit: (e) => {
            if (e.type === "done" || e.type === "error") runningChat = null;
            emit(e);
            if (e.type === "done" || e.type === "error" || e.type === "session") chat?.then(e);
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
      // Ask Claude, from the popup on an element: a chat per element (its `chat` key),
      // one Claude session that later prompts resume.
      let runningChat: string | null = null;
      server.ws.on("spark:ask", async (data: { request: string; selection: AskSelection | null; chat?: string }) => {
        if (running()) return;
        const log = await loadLog();
        const pending = log.changes.filter((c) => c.status === "pending");
        const ids = pending.map((c) => c.id);
        const key = data.chat;
        if (!key) return start("ask", askPrompt(data.request, data.selection, pending), ids);
        const before = (await loadChats())[key];
        await updateChat(key, (c) => ({ ...c, label: data.selection?.label ?? c.label, messages: [...c.messages, { role: "user", text: data.request, at: Date.now() }] }));
        const answer = (resumed: boolean) => (e: RunEvent) => {
          if (e.type === "error") {
            void updateChat(key, (c) => ({ ...c, messages: [...c.messages, { role: "claude", text: e.text, ok: false, at: Date.now() }] }));
            return;
          }
          if (e.type === "session") {
            if (e.model) void updateChat(key, (c) => ({ ...c, model: e.model }));
            return;
          }
          if (e.type !== "done") return;
          // The session is gone (cleared history, another machine): start a new one with the full prompt.
          if (!e.ok && resumed && /no conversation found|session/i.test(e.summary)) {
            void start("ask", askPrompt(data.request, data.selection, pending), ids, { key, then: answer(false) });
            return;
          }
          void updateChat(key, (c) => ({
            ...c,
            sessionId: e.sessionId ?? c.sessionId,
            model: e.model ?? c.model,
            messages: [...c.messages, { role: "claude", text: e.summary || (e.ok ? "Done." : "Claude stopped."), ok: e.ok, at: Date.now() }],
          }));
        };
        const resume = before?.sessionId ?? undefined;
        const prompt = resume ? followupPrompt(data.request, data.selection, pending) : askPrompt(data.request, data.selection, pending);
        await start("ask", prompt, ids, { key, resume, then: answer(!!resume) });
      });
      // A chat's element moved (Claude's edit shifted its lines): file the chat under its new key.
      server.ws.on("spark:chat-move", (data: { from: string; to: string }) =>
        serial(async () => {
          const chats = await loadChats();
          if (!chats[data.from] || chats[data.to]) return;
          chats[data.to] = chats[data.from];
          delete chats[data.from];
          movedTo.set(data.from, data.to);
          if (runningChat === data.from) runningChat = data.to;
          await save("chats.json", chats);
          server.ws.send("spark:chat", { key: data.from, chat: null, movedTo: data.to });
          server.ws.send("spark:chat", { key: data.to, chat: chats[data.to] });
        }),
      );
      // "New chat" in the popup: forget the element's conversation and its session.
      server.ws.on("spark:chat-reset", async (data: { chat: string }) => {
        if (running() && runningChat === data.chat) return;
        await serial(async () => {
          const chats = await loadChats();
          delete chats[data.chat];
          await save("chats.json", chats);
          server.ws.send("spark:chat", { key: data.chat, chat: null });
        });
      });
      // The empty Components view: Claude writes the *.spark.tsx files.
      // A component frame's case renamed in place (gallery.ts): rename its export.
      server.ws.on("spark:rename-case", async (data: { file: string; from: string; to: string }) => {
        const ident = /^[A-Za-z_$][\w$]*$/;
        if (!/\.spark\.[jt]sx$/.test(data.file) || !ident.test(data.from) || !ident.test(data.to)) return;
        const file = path.join(root, data.file);
        if (path.relative(root, file).startsWith("..")) return;
        const code = await readFile(file, "utf8");
        const decl = new RegExp(`^(export\\s+(?:const|let|function)\\s+)${data.from}\\b`, "m");
        // Only the declaration: the same word elsewhere may be a prop value ("Drums").
        if (!decl.test(code) || new RegExp(`^export\\s+(?:const|let|function)\\s+${data.to}\\b`, "m").test(code)) return;
        await writeFile(file, code.replace(decl, `$1${data.to}`));
      });
      server.ws.on("spark:gallery-generate", () => start("ask", galleryPrompt(), []));
      server.ws.on("spark:stop", () => stop());
      server.ws.on("spark:run-state", (_d, client) => client.send("spark:run-state", { running: running(), chat: running() ? runningChat : null }));
    },
  };
}
