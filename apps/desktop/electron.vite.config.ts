import { cpSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

const alias = {
  "@shared": resolve(import.meta.dirname, "src/shared"),
  // The desktop bundles the core from source, so the packaged app needs no node_modules.
  "@mockix/core": resolve(import.meta.dirname, "../../packages/core/src/index.ts"),
};

/**
 * gRPC server reflection reads its own .proto files at runtime, relative to the
 * bundled chunk (out/main/chunks → out/proto). Copy them there.
 */
const reflectionProtos = (): Plugin => ({
  name: "mockix-reflection-protos",
  closeBundle() {
    const from = resolve(dirname(createRequire(import.meta.url).resolve("@grpc/reflection/package.json")), "build/proto");
    cpSync(from, resolve(import.meta.dirname, "out/proto"), { recursive: true });
  },
});

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [reflectionProtos()],
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    build: {
      externalizeDeps: false,
      rolldownOptions: {
        // The mock host is a second entry: main forks one utilityProcess per running mock.
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          host: resolve(import.meta.dirname, "src/host/index.ts"),
        },
        external: ["electron", /^node:/],
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      // Sandboxed preloads must be a single CommonJS file with no node_modules imports.
      externalizeDeps: false,
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
        external: ["electron"],
      },
    },
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
    // One bundle loaded from disk: chunk size does not matter for a desktop app.
    build: { minify: true, chunkSizeWarningLimit: 4096 },
  },
});
