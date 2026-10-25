import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests run from source: @mockix/core resolves to its TypeScript, so no build is needed.
export default defineConfig({
  resolve: {
    alias: {
      "@mockix/core": resolve(import.meta.dirname, "packages/core/src/index.ts"),
      "@shared": resolve(import.meta.dirname, "apps/desktop/src/shared"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/desktop/test/unit/**/*.test.ts"],
    environment: "node",
  },
});
