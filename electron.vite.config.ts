import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const r = (p: string) => resolve(import.meta.dirname, p);

// everything outside the renderer ships cjs: a sandboxed preload cannot be esm, and
// utilityProcess + native addons are least surprising under require()
const cjs = { format: "cjs" as const, entryFileNames: "[name].cjs" };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // the compute worker is a utilityProcess entry, not an import of main
        input: { index: r("src/main/index.ts"), worker: r("src/worker/index.ts") },
        output: cjs,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: r("src/preload/index.ts") }, output: cjs },
    },
  },
  renderer: {
    root: r("src/renderer"),
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": r("src/renderer/src") } },
    build: { rollupOptions: { input: r("src/renderer/index.html") } },
  },
});
