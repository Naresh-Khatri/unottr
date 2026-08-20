import { defineConfig } from "drizzle-kit";

// generate only. never `push` at a live database: drizzle-kit cannot see segments_fts or its
// triggers (0001_fts.sql) and would propose dropping them.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/main/db/schema.ts",
  out: "./drizzle",
});
