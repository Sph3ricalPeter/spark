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
//   chats.json: the Ask chats, each one Claude session about one element (chats.ts),
//   and state.json: how the board and panels were left (state-file.ts, state.ts).
// - Keeps Spark's own settings, the same for every project, in settings.json
//   in Spark's config folder (settings.ts).
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchForWorkspaceRoot, type Plugin } from "vite";
import { ICON_LIBRARY, tagJsx } from "./tag.ts";
import type { Change, ChangeLog } from "./changes.ts";
import { askPrompt, followupPrompt, galleryPrompt, implementPrompt, samplesPrompt, type AskSelection } from "./prompt.ts";
import { claude } from "./claude.ts";
import { chatStore } from "./chats.ts";
import { settingsStore, stateStore } from "./state-file.ts";
import { buildAreas, buildPrompt, manifestStore, planPrompt, rulesFor, tokensPrompt, type BreakdownTarget, type Depth, type TokenItem } from "./breakdown.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULES: Record<string, string> = {
  "/@spark/client": path.join(here, "client.ts"),
  "/@spark/shell": path.join(here, "shell.ts"),
  "/@spark/mode": path.join(here, "mode.ts"),
  "/@spark/gallery": path.join(here, "gallery.ts"),
  "/@spark/sample": path.join(here, "sample.ts"),
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

/** One icon library's icons for the icon picker (`?lib=lucide-react`). */
const ICONS = "/@spark/icons";
const ICONS_ID = "\0spark-icons:";
/** An app frame's sample data (sample.ts): spark.setup's fakes, installed before the app runs. */
const SAMPLES = "/@spark/samples";
const SAMPLES_ID = "\0spark-samples";
const SETUP_GLOB = `import.meta.glob(["/spark.setup.{tsx,jsx,ts,js}"], { eager: true })`;
const SAMPLES_MODULE = [
  `import { startAppSample } from "/@spark/sample";`,
  `startAppSample(Object.values(${SETUP_GLOB})[0]);`,
].join("\n");

/** The icon libraries the project depends on. */
const ICON_LIBS = "/@spark/icon-libs";
const ICON_LIBS_ID = "\0spark-icon-libs";
/** The project's name (its folder's), for the board's title bar. */
const PROJECT = "/@spark/project";
const PROJECT_ID = "\0spark-project";

/** The icon libraries in the nearest package.json's dependencies, at or above `root`. */
function projectIconLibraries(root: string): string[] {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const file = path.join(dir, "package.json");
    if (existsSync(file)) {
      try {
        const pkg = JSON.parse(readFileSync(file, "utf8"));
        const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
        // Only flat libraries: a subpath one (react-icons/fa) is offered once an icon from it is used.
        return deps.filter((d) => ICON_LIBRARY.test(d) && d !== "@mui/icons-material");
      } catch {
        return [];
      }
    }
    if (path.dirname(dir) === dir) return [];
  }
}

/**
 * An icon library for the picker (client.ts): its icons' names, and their
 * markup, rendered with the app's own React into a detached node. Aliases
 * (lucide's `Undo2`, `Undo2Icon`, `LucideUndo2`) count once, by their shortest name.
 */
function iconsModule(lib: string) {
  return [
    `import * as lib from ${JSON.stringify(lib)};`,
    `import { Component, createElement } from "react";`,
    `import { createRoot } from "react-dom/client";`,
    `const byIcon = new Map();`,
    `for (const [k, v] of Object.entries(lib)) {`,
    `  if (!/^[A-Z]/.test(k) || !v || !(typeof v === "function" || (typeof v === "object" && "$$typeof" in v))) continue;`,
    `  const had = byIcon.get(v);`,
    `  if (!had || k.length < had.length) byIcon.set(v, k);`,
    `}`,
    `export const names = [...byIcon.values()].sort();`,
    // One export that isn't an icon (a provider, a base component) mustn't break the rest.
    `class Guard extends Component { state = { failed: false }; static getDerivedStateFromError() { return { failed: true }; } render() { return this.state.failed ? null : this.props.children; } }`,
    `export function render(list) {`,
    `  return new Promise((resolve) => {`,
    `    const box = document.createElement("div");`,
    `    const root = createRoot(box);`,
    `    const done = (n) => {`,
    `      if (!n) return;`,
    `      const out = {};`,
    `      list.forEach((name, i) => { const svg = n.children[i]?.querySelector("svg"); if (svg) out[name] = svg.outerHTML; });`,
    `      resolve(out);`,
    `      setTimeout(() => root.unmount());`,
    `    };`,
    `    root.render(createElement("div", { ref: done }, list.map((name) => createElement("span", { key: name }, createElement(Guard, null, lib[name] ? createElement(lib[name]) : null)))));`,
    `  });`,
    `}`,
  ].join("\n");
}

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
    // An app frame gets its sample data first (sample.ts); a broken spark.setup never keeps the app from starting.
    `  const app = view`,
    `    ? import(${JSON.stringify(`${COMPONENTS}?entry=${encodeURIComponent(src)}`)})`,
    `    : import(${JSON.stringify(SAMPLES)}).catch((e) => console.error("[spark] spark.setup failed to load:", e)).then(() => import(${JSON.stringify(src)}));`,
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
    `const setup = Object.values(${SETUP_GLOB})[0];`,
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
      // The icon picker imports the project's icon libraries: prebundle them up
      // front, so opening it doesn't make Vite discover them and reload the page.
      const icons = projectIconLibraries(path.resolve(config.root ?? process.cwd()));
      return {
        server: { fs: { allow: [searchForWorkspaceRoot(config.root ?? process.cwd()), here] } },
        ...(icons.length ? { optimizeDeps: { include: icons } } : {}),
      };
    },

    configResolved(config) {
      root = config.root;
    },

    resolveId(id) {
      if (id in MODULES) return MODULES[id];
      if (id === CASES) return CASES_ID;
      if (id === SAMPLES) return SAMPLES_ID;
      if (id === ICON_LIBS) return ICON_LIBS_ID;
      if (id === PROJECT) return PROJECT_ID;
      if (id.startsWith(`${ICONS}?lib=`)) {
        const lib = decodeURIComponent(id.slice(ICONS.length + 5));
        return ICON_LIBRARY.test(lib) ? ICONS_ID + lib : null;
      }
      if (id.startsWith(`${ENTRY}?src=`)) return ENTRY_ID + decodeURIComponent(id.slice(ENTRY.length + 5));
      if (id.startsWith(`${COMPONENTS}?entry=`)) return COMPONENTS_ID + decodeURIComponent(id.slice(COMPONENTS.length + 7));
      return null;
    },

    load(id) {
      if (id === CASES_ID) return CASES_MODULE;
      if (id === SAMPLES_ID) return SAMPLES_MODULE;
      if (id === ICON_LIBS_ID) return `export default ${JSON.stringify(projectIconLibraries(root))};`;
      if (id === PROJECT_ID) return `export const name = ${JSON.stringify(path.basename(root))};`;
      if (id.startsWith(ICONS_ID)) return iconsModule(id.slice(ICONS_ID.length));
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
        if (!/^inter-[\w-]+\.woff2$/.test(name)) return next();
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
      // The project's UI state (state.ts): every page reads it before it starts.
      const state = stateStore(dir);
      server.middlewares.use("/@spark/state", (req, res, next) => {
        if (req.method !== "GET") return next();
        state.values().then(
          (values) => {
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify(values));
          },
          () => next(),
        );
      });
      server.ws.on("spark:state", async (data: { key?: unknown; value?: unknown }, from) => {
        if (typeof data?.key !== "string") return;
        await state.set(data.key, data.value);
        // The other frames keep their copies in step; the sender has it already.
        for (const c of server.ws.clients) if (c !== from) c.send("spark:state", { key: data.key, value: data.value ?? null });
      });
      // Spark's own settings (settings.ts), the same in every project: in
      // Spark's config folder (project.rs passes it), or ~/.spark outside Spark.
      const settings = settingsStore(process.env.SPARK_SETTINGS_DIR || path.join(os.homedir(), ".spark"));
      server.middlewares.use("/@spark/settings", (req, res, next) => {
        if (req.method !== "GET") return next();
        settings.values().then(
          (values) => {
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify(values));
          },
          () => next(),
        );
      });
      server.ws.on("spark:settings", async (data: { key?: unknown; value?: unknown }, from) => {
        if (typeof data?.key !== "string") return;
        settings.set(data.key, data.value);
        for (const c of server.ws.clients) if (c !== from) c.send("spark:settings", { key: data.key, value: data.value ?? null });
      });
      server.httpServer?.once("close", () => void Promise.all([state.close(), settings.close()]));
      server.ws.on("spark:hello", async (_data, client) => {
        let changes = null;
        try {
          changes = JSON.parse(await readFile(path.join(dir, "changes.json"), "utf8"));
        } catch {
          // No changes yet.
        }
        client.send("spark:ready", { name: path.basename(root), root: root.split(path.sep).join("/"), changes, chats: (await chats.load()).chats, runningChat: ai.running() });
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

      const chats = chatStore(dir, (f) => server.ws.send("spark:chats", { chats: f.chats }));

      // Claude, from the panel: "Implement changes" and "Ask Claude".
      const loadLog = async (): Promise<ChangeLog> => {
        try {
          return JSON.parse(await readFile(path.join(dir, "changes.json"), "utf8"));
        } catch {
          return { version: 1, changes: [] };
        }
      };
      /** One change in a line: padding-left: 8px → 30px (the "ghost" variant of Button). */
      const changeLine = (c: Change) => {
        const what =
          c.property === "text"
            ? `text "${c.from}" → "${c.to}"`
            : c.property === "removed"
              ? `remove <${c.element.tag}>`
              : c.property === "children-order"
                ? "reorder children"
                : `${c.property}: ${c.from || "unset"} → ${c.to}`;
        const where = c.level === "token" ? "variable" : c.level === "component" ? (c.selector ?? "") : (c.instance?.appliesTo ?? "").split(":")[0];
        return `${what}${where ? ` (${where})` : ""}`;
      };
      const implementRequest = (pending: Change[]) =>
        `Implement ${pending.length} change${pending.length === 1 ? "" : "s"}:\n\n${pending.map((c) => `- ${changeLine(c)}`).join("\n")}`;

      // Every Claude run goes through here, and each one is a chat (claude.ts).
      const ai = claude({
        cwd: root,
        chats,
        broadcast: (e) => server.ws.send("spark:run", e),
        // Mark what Claude applied, against the latest log (edits may have arrived meanwhile).
        applied: (ids) =>
          void loadLog().then(async (log) => {
            for (const id of ids) appliedIds.add(id);
            for (const c of log.changes) if (ids.includes(c.id)) c.status = "applied";
            await save("changes.json", log);
            server.ws.send("spark:log", log);
          }),
      });
      /** Claude is busy with another chat: the one who asked hears so (nothing was recorded). */
      const busy = (client: { send: (event: string, payload?: unknown) => void }) => (id: string | null) => {
        if (id === null) client.send("spark:busy", { chat: ai.running() });
      };

      server.ws.on("spark:implement", async (data: { ids?: string[] }, client) => {
        const log = await loadLog();
        const pending = log.changes.filter((c) => c.status === "pending" && (!data?.ids || data.ids.includes(c.id)));
        if (pending.length === 0) return;
        // The run is a chat in the Chats list: the changes asked for, then Claude's result.
        const what = new Map(pending.map((c) => [c.id, changeLine(c)]));
        await ai
          .ask({
            topic: { kind: "implement", label: "Implement changes" },
            request: implementRequest(pending),
            prompt: () => implementPrompt(pending),
            kind: "implement",
            ids: pending.map((c) => c.id),
            reply: (e) => {
              const bits = [`${e.applied.length} applied · ${e.skipped.length} skipped`, ...(e.cost !== undefined ? [`$${e.cost.toFixed(2)}`] : [])];
              const skipped = e.skipped.map((x) => `- Skipped ${what.get(x.id) ?? x.id}: ${x.why}`).join("\n");
              return [e.summary || (e.ok ? "Done." : "Claude stopped."), skipped, `_${bits.join(" · ")}_`].filter(Boolean).join("\n\n");
            },
          })
          .then(busy(client));
      });
      // Ask Claude, from the popup on an element: the element's open chat (by its
      // `chat` key), one Claude session that later prompts resume (chats.ts).
      // With no element, a chat of its own.
      // `others`: more elements picked with Shift+click; the chat stays the first one's.
      server.ws.on("spark:ask", async (data: { request: string; selection: AskSelection | null; chat?: string; others?: AskSelection[] }, client) => {
        if (ai.busy()) return busy(client)(null);
        const pending = (await loadLog()).changes.filter((c) => c.status === "pending");
        await ai
          .ask({
            topic: data.chat ? { element: data.chat, label: data.selection?.label } : { kind: "task", label: data.selection?.label || "Ask Claude" },
            request: data.request,
            also: data.others?.map((o) => o.label || o.comp || o.tag),
            prompt: (resumed) => (resumed ? followupPrompt : askPrompt)(data.request, data.selection, pending, data.others),
            kind: "ask",
            ids: pending.map((c) => c.id),
          })
          .then(busy(client));
      });
      // The board's Chats list asks for the list when it loads.
      server.ws.on("spark:chats-get", async (_d, client) => client.send("spark:chats", { chats: (await chats.load()).chats, running: ai.running() }));
      // "New chat": the element's open chat closes (it stays in the Chats list).
      server.ws.on("spark:chat-new", (data: { chat: string }) => chats.close(data.chat));
      // The Chats list: open an earlier (or resolved) chat again, or resolve one (archive it; Claude can't be answering it).
      server.ws.on("spark:chat-open", (data: { id: string }) => chats.reopen(data.id));
      server.ws.on("spark:chat-resolve", (data: { id: string }) => (ai.running() === data.id ? undefined : chats.resolve(data.id)));
      // A chat's element moved (Claude's edit shifted its lines): its chats follow it.
      server.ws.on("spark:chat-move", (data: { from: string; to: string }) => chats.move(data.from, data.to));
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
      // The empty Components view: Claude writes the *.spark.tsx files, in a chat of its own.
      server.ws.on("spark:gallery-generate", (_d, client) =>
        ai
          .ask({
            topic: { kind: "task", label: "Components" },
            request: "Write the Components view's case files (*.spark.tsx) for this project's components.",
            prompt: () => galleryPrompt(),
            kind: "ask",
            ids: [],
          })
          .then(busy(client)),
      );
      // An app frame's "Write sample data with Claude": spark.setup.tsx's samples (sample.ts), in a chat of its own.
      server.ws.on("spark:samples-generate", (d: { missing?: unknown }, client) =>
        ai
          .ask({
            topic: { kind: "task", label: "Sample data" },
            request: "Write sample data for the app's backend calls, so the board's frames can show its screens.",
            prompt: () => samplesPrompt(Array.isArray(d?.missing) ? d.missing.filter((m): m is string => typeof m === "string").slice(0, 50) : []),
            kind: "ask",
            ids: [],
          })
          .then(busy(client)),
      );
      // Break down into components (breakdown.ts): a plan Claude writes, reviewed in the board's
      // Components tab, then built one area at a time. .spark/components.json is the record.
      const parts = manifestStore(dir, (m, why) => server.ws.send("spark:components", { manifest: m, why }));
      /** The areas still to build in this Build run, the one building first; null when none is running. */
      let building: string[] | null = null;
      const buildState = () => ({ area: building?.[0] ?? null, left: building?.length ?? 0 });
      const sendBuilding = () => server.ws.send("spark:components-building", buildState());
      server.ws.on("spark:components-get", async (_d, client) => {
        client.send("spark:components", { manifest: await parts.load() });
        client.send("spark:components-building", buildState());
      });
      server.ws.on("spark:components-edit", (d: { edits?: Parameters<typeof parts.edit>[0] }) => (Array.isArray(d?.edits) ? parts.edit(d.edits) : undefined));
      server.ws.on("spark:breakdown-plan", async (d: { target?: BreakdownTarget; depth?: Depth; wholeApp?: boolean }, client) => {
        if (ai.busy()) return busy(client)(null);
        const t = d?.target;
        if (!t || typeof t.label !== "string") return;
        const target: BreakdownTarget = {
          label: t.label.slice(0, 120),
          kind: t.kind === "frame" || t.kind === "case" ? t.kind : "element",
          src: typeof t.src === "string" ? t.src : null,
          comp: typeof t.comp === "string" ? t.comp : null,
          file: typeof t.file === "string" ? t.file : null,
          outline: typeof t.outline === "string" ? t.outline.slice(0, 40_000) : undefined,
        };
        const depth: Depth = d.depth === "regions" || d.depth === "primitives" ? d.depth : "parts";
        const words = { regions: "regions only", parts: "regions and parts", primitives: "down to primitives" }[depth];
        const [rules, manifest] = await Promise.all([rulesFor(root), parts.load()]);
        await parts.dropPlan();
        await ai
          .ask({
            topic: { kind: "task", label: `Break down ${target.label}` },
            request: `Plan how to break down ${target.label} into components, ${words}${d.wholeApp ? ", with primitives from the whole app" : ""}.`,
            prompt: () => planPrompt({ rules, target, depth, wholeApp: !!d.wholeApp, manifest, planFile: ".spark/components.plan.json" }),
            kind: "ask",
            ids: [],
            reply: async (e) => {
              const r = await parts.takePlan();
              const summary = e.summary || (e.ok ? "" : "Claude stopped.");
              if (!r) return `${summary}\n\n_No plan came back, so nothing changed._`.trim();
              return `${summary}\n\n_Planned ${r.planned} component${r.planned === 1 ? "" : "s"} (${r.added} new). Review them in the Components tab, then Build._`.trim();
            },
          })
          .then(busy(client));
      });
      /** Build the next area in the queue, each its own chat; the queue stops at the first that fails or is stopped. */
      const buildNext = async (): Promise<void> => {
        const area = building?.[0];
        if (!area) {
          building = null;
          return sendBuilding();
        }
        const m = await parts.load();
        const todo = m.components.filter((c) => c.area === area && c.status === "planned");
        if (!todo.length) {
          building!.shift();
          return buildNext();
        }
        const rules = await rulesFor(root);
        const ids = todo.map((c) => c.id);
        const chat = await ai.ask({
          topic: { kind: "task", label: `Build ${area}` },
          request: `Build ${todo.length} component${todo.length === 1 ? "" : "s"} in ${area}: ${todo.map((c) => c.name).join(", ")}.`,
          prompt: () => buildPrompt({ rules, area, todo, manifest: m }),
          kind: "ask",
          ids: [],
          reply: async (e) => {
            const applied = e.applied.filter((x) => ids.includes(x));
            const skipped = e.skipped.filter((x) => ids.includes(x.id));
            await parts.built(applied, skipped);
            const name = (id: string) => todo.find((c) => c.id === id)?.name ?? id;
            const lines = skipped.map((x) => `- Skipped ${name(x.id)}: ${x.why}`).join("\n");
            return [e.summary || (e.ok ? "Done." : "Claude stopped."), lines, `_${applied.length} built · ${skipped.length} skipped${e.cost !== undefined ? ` · $${e.cost.toFixed(2)}` : ""}_`].filter(Boolean).join("\n\n");
          },
          then: (e) => {
            if (!building) return sendBuilding();
            if (!e.ok) building = null;
            else building.shift();
            void buildNext();
          },
        });
        if (chat === null) building = null;
        sendBuilding();
      };
      server.ws.on("spark:breakdown-build", async (d: { areas?: string[] }, client) => {
        if (ai.busy() || building) return busy(client)(null);
        const areas = buildAreas(await parts.load()).filter((a) => !Array.isArray(d?.areas) || d.areas.includes(a));
        if (!areas.length) return;
        building = areas;
        await buildNext();
      });
      // The System tab's token steps: Claude defines the chosen tokens and uses them in place of the literals.
      server.ws.on("spark:system-apply", async (d: { step?: string; home?: { file: string | null; selector: string } | null; items?: TokenItem[] }, client) => {
        if (ai.busy() || building) return busy(client)(null);
        const items = (Array.isArray(d?.items) ? d.items : [])
          .filter((i) => i && typeof i.id === "string" && typeof i.name === "string" && /^--[\w-]+$/.test(i.name))
          .map((i) => ({ ...i, values: Array.isArray(i.values) ? i.values.slice(0, 20) : [], places: Array.isArray(i.places) ? i.places.slice(0, 60) : [] }));
        if (!items.length) return;
        const step = typeof d.step === "string" ? d.step.slice(0, 40) : "Tokens";
        const made = items.filter((i) => i.create).length;
        await ai
          .ask({
            topic: { kind: "task", label: `Design system: ${step}` },
            request: `Use ${items.length} ${step.toLowerCase()} token${items.length === 1 ? "" : "s"}${made ? ` (${made} new)` : ""}: ${items.map((i) => i.name).join(", ")}.`,
            prompt: () => tokensPrompt({ step, home: d.home ?? null, items }),
            kind: "ask",
            ids: [],
            reply: (e) => {
              const ok = e.applied.filter((x) => items.some((i) => i.id === x)).length;
              const skipped = e.skipped.filter((x) => items.some((i) => i.id === x.id));
              const name = (id: string) => items.find((i) => i.id === id)?.name ?? id;
              return [e.summary || (e.ok ? "Done." : "Claude stopped."), skipped.map((x) => `- Skipped ${name(x.id)}: ${x.why}`).join("\n"), `_${ok} applied · ${skipped.length} skipped${e.cost !== undefined ? ` · $${e.cost.toFixed(2)}` : ""}_`].filter(Boolean).join("\n\n");
            },
            then: () => server.ws.send("spark:system-applied", {}),
          })
          .then(busy(client));
      });
      server.ws.on("spark:stop", () => {
        // Stopping a build stops the areas after it too.
        building = null;
        ai.stop();
      });
      server.ws.on("spark:run-state", (_d, client) => client.send("spark:run-state", { running: ai.busy(), chat: ai.running() }));
    },
  };
}
