/**
 * Builds the npm package of the CLI in packages/cli/npm/: one bundle with the
 * core inside (dist/bin.js) and the third-party packages as dependencies,
 * pinned to the versions the repo uses. `--pack` also runs npm pack.
 *
 *   node packages/cli/scripts/bundle.mjs [--pack]
 */
import { execSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { build } from "rolldown";

const root = resolve(import.meta.dirname, "../../..");
const out = join(root, "packages/cli/npm");
const read = async (p) => JSON.parse(await readFile(join(root, p), "utf8"));
const [core, cli] = await Promise.all([read("packages/core/package.json"), read("packages/cli/package.json")]);
const dependencies = Object.fromEntries(
  Object.entries({ ...core.dependencies, ...cli.dependencies })
    .filter(([name]) => name !== "@mockix/core")
    .sort(([a], [b]) => a.localeCompare(b)),
);

await rm(out, { recursive: true, force: true });
await build({
  input: join(root, "packages/cli/src/bin.ts"),
  platform: "node",
  resolve: {
    alias: { "@mockix/core": join(root, "packages/core/src/index.ts") },
    extensionAlias: { ".js": [".ts", ".js"] },
  },
  // Everything from node_modules stays a dependency; only our own code is bundled.
  external: (id) => !id.startsWith(".") && !isAbsolute(id) && !id.startsWith("@mockix/core") && !/^[A-Za-z]:[\/]/.test(id),
  output: { dir: join(out, "dist"), format: "esm", entryFileNames: "bin.js", chunkFileNames: "[name]-[hash].js" },
  logLevel: "warn",
});

await writeFile(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "@fulerbdev/mockix",
      version: cli.version,
      description: "Simulador de APIs local primero: HTTP, WebSocket, Socket.IO y gRPC, con contrato OpenAPI, escenarios, caos, grabación y servidor MCP.",
      author: cli.author,
      license: cli.license,
      type: "module",
      bin: { mockix: "dist/bin.js" },
      files: ["dist", "README.md"],
      engines: { node: ">=22" },
      keywords: ["mock", "api", "openapi", "websocket", "socket.io", "grpc", "mcp", "testing"],
      dependencies,
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  join(out, "README.md"),
  `# Mockix (CLI)

Simulador de APIs local primero. Sirve los mocks de un workspace de Mockix desde la terminal, en CI o en Docker.

\`\`\`bash
npm i -g @fulerbdev/mockix    # instala el comando mockix
mockix init mi-proyecto       # workspace de ejemplo
mockix serve mi-proyecto      # sirve sus mocks y recarga al guardar
mockix validate mi-proyecto   # revisa todos los archivos
mockix mcp mi-proyecto        # servidor MCP por stdio para agentes
mockix --help
\`\`\`

Requiere Node ${"22"} o superior.
`,
);
await cp(join(root, "docs/logo.svg"), join(out, "logo.svg")).catch(() => undefined);
console.log(`npm package in ${out}`);

if (process.argv.includes("--pack")) {
  await mkdir(join(root, "release"), { recursive: true });
  execSync(`npm pack --pack-destination "${join(root, "release")}"`, { cwd: out, stdio: "inherit" });
}
