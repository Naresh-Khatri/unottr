import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // migrate.ts resolves this off __dirname, which does not exist under vitest's esm loader
    env: { UNOTTR_MIGRATIONS_DIR: resolve(import.meta.dirname, "drizzle") },
  },
});
