import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/e2e",
});
