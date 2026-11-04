// spark-vite-plugin: makes a running React app editable from inside itself.
//
// Dev server only (`apply: "serve"`); production builds are untouched.
// - Tags JSX with source locations (see tag.ts).
// - Injects the Spark client (overlay + docked panel, see client.ts) into
//   index.html.
// - Talks to the client over Vite's own HMR socket, so it works wherever hot
//   reload works, including a Tauri window, and writes what the client sends
//   into `.spark/` in the project root.
import { mkdir, writeFile } from "node:fs/promises";
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
      server.ws.on("spark:hello", (_data, client) => {
        client.send("spark:ready", { root: path.basename(root) });
      });
      // The current selection, for the MCP server's get_selection (milestone 3).
      server.ws.on("spark:select", async (data) => {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "selection.json"), JSON.stringify(data, null, 2) + "\n");
      });
    },
  };
}
