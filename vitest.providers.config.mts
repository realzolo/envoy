import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Provider protocol tests mock transport and never mutate a database.
export default defineConfig({
  test: { environment: "node", include: ["tests/providers/**/*.test.ts"] },
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } }
});
