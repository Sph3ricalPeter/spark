// spark-vite-plugin: makes a running React app editable from inside itself.
//
// Dev server only (`apply: "serve"`); production builds are untouched.
// - Tags JSX with source locations (see tag.ts).
// - Injects the Spark client (overlay + docked panel, see client.ts) into
//   index.html.
// - Talks to the client over Vite's own HMR socket, so it works wherever hot
//   reload works, including a Tauri window, and writes what the client sends
//   into `.spark/` in the project root: selection.json and changes.json.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchForWorkspaceRoot, type Plugin } from "vite";
import { tagJsx } from "./tag.ts";

const CLIENT_ID = "/@spark/client";
const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, "client.ts");

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
      if (id === CLIENT_ID) return clientPath;
      return null;
    },

    transform(code, id) {
      const file = id.split("?")[0];
      if (!/\.[jt]sx$/.test(file) || file.includes("/node_modules/")) return null;
      const rel = path.relative(root, file).split(path.sep).join("/");
      const out = tagJsx(code, file, rel);
      return out === null ? null : { code: out, map: null };
    },

    transformIndexHtml() {
      return [{ tag: "script", attrs: { type: "module", src: CLIENT_ID }, injectTo: "body" }];
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
      server.ws.on("spark:changes", (data) => save("changes.json", data));
    },
  };
}
