// The fixture app: a small dawg-like UI that Spark is developed and tested
// against. Run it with `npm run fixture` from the repo root.
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";
import spark from "../../packages/vite-plugin/src/index.ts";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [spark(), react()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: { port: 5179, strictPort: true },
});
