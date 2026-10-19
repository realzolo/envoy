import { defineConfig } from "drizzle-kit";

// V1 is a complete snapshot. Do not generate incremental migrations before release.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/platform/database/schema/index.ts",
  schemaFilter: ["public"],
});
