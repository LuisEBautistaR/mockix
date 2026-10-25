import { defineConfig } from "vitest/config";

// End-to-end tests of the built CLI (packages/cli/dist): run after `npm run build`.
export default defineConfig({
  test: {
    include: ["packages/cli/test-e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
