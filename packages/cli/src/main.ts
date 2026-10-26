import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { stringify } from "yaml";
import {
  Contract,
  ImportError,
  WorkspaceExistsError,
  allProblems,
  checkMockResponses,
  contractCoverage,
  exportOpenApi,
  importSource,
  isWorkspace,
  loadWorkspace,
  writeExampleWorkspace,
  writeImported,
  type ImportFormat,
} from "@mockix/core";
import { HELP, parseCli } from "./args.js";
import { convertCommand, recordCommand, replayCommand } from "./record.js";
import { mcpCommand } from "./mcp.js";
import { formatProblem, serveWorkspace } from "./serve.js";

export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

async function validate(dir: string, failOnViolation: boolean, io: Io): Promise<number> {
  const load = await loadWorkspace(dir);
  const problems = allProblems(load);
  if (problems.length === 0) {
    const routes = load.mocks.reduce((n, m) => n + (m.config?.routes.length ?? 0), 0);
    const live = load.mocks.reduce((n, m) => n + (m.config?.realtime.length ?? 0), 0);
    const services = load.mocks.reduce((n, m) => n + (m.config?.grpc?.services.length ?? 0), 0);
    const extras = [live ? `${live} de tiempo real` : null, services ? (services === 1 ? "1 servicio gRPC" : `${services} servicios gRPC`) : null].filter(Boolean);
    io.out(
      `Workspace válido: ${load.mocks.length === 1 ? "1 mock" : `${load.mocks.length} mocks`}, ${routes === 1 ? "1 ruta" : `${routes} rutas`}${extras.length ? `, ${extras.join(" y ")}` : ""}.`,
    );
    // The mock's own responses against its contract: a mock that drifted from the API it imitates.
    let drifted = 0;
    for (const m of load.mocks) {
      if (!m.config?.contract) continue;
      const contract = new Contract(m.config.contract.document);
      const coverage = contractCoverage(m.config, contract);
      const checked = checkMockResponses(m.config, contract);
      const outside = new Set(checked.filter((p) => p.operation === null).map((p) => p.routeId)).size;
      const drift = checked.filter((p) => p.operation !== null);
      drifted += drift.length;
      io.out(
        `Contrato de ${m.name} (${m.config.contract.file}): ${coverage.filter((c) => c.routeId).length} de ${coverage.length} operaciones con mock${outside ? `, ${outside === 1 ? "1 ruta" : `${outside} rutas`} fuera del contrato` : ""}${drift.length ? `, ${drift.length === 1 ? "1 respuesta no cumple" : `${drift.length} respuestas no cumplen`}` : ""}.`,
      );
      for (const p of drift) io.err(`  Aviso: ${p.method} ${p.path} → ${p.responseId} (${p.status}): ${p.message}`);
    }
    return failOnViolation && drifted > 0 ? 2 : 0;
  }
  const files = new Set(problems.map((p) => p.file)).size;
  io.err(`${problems.length === 1 ? "1 problema" : `${problems.length} problemas`} en ${files === 1 ? "1 archivo" : `${files} archivos`}:`);
  for (const p of problems) io.err(formatProblem(p));
  return 1;
}

async function init(dir: string, io: Io): Promise<number> {
  try {
    const files = await writeExampleWorkspace(dir);
    io.out(`Workspace de ejemplo creado en ${resolve(dir)} (${files.length} archivos).`);
    io.out(`Siguiente paso: mockix serve ${dir === "." ? "" : dir}`.trimEnd());
    return 0;
  } catch (err) {
    if (err instanceof WorkspaceExistsError) {
      io.err(`mockix: ${resolve(dir)} ya es un workspace de Mockix; no se ha tocado nada.`);
      return 1;
    }
    throw err;
  }
}

async function importFile(command: { file: string; dir: string; format: ImportFormat | null; name: string | null; port: number | null; prefix: string | null; contract: boolean; chaos: boolean }, io: Io): Promise<number> {
  const load = await loadWorkspace(command.dir);
  if (!(await isWorkspace(command.dir))) {
    io.err(`mockix: ${resolve(command.dir)} no es un workspace de Mockix (crea uno con «mockix init»)`);
    return 1;
  }
  let text: string;
  try {
    text = await readFile(command.file, "utf8");
  } catch {
    io.err(`mockix: no se puede leer ${command.file}`);
    return 1;
  }
  try {
    const result = await importSource(text, basename(command.file), {
      baseDir: dirname(resolve(command.file)),
      ...(command.format ? { format: command.format } : {}),
      ...(command.prefix ? { prefix: command.prefix } : {}),
    });
    const written = await writeImported(command.dir, result, {
      ...(command.name ? { name: command.name } : {}),
      ...(command.port !== null ? { port: command.port } : {}),
      ...(command.prefix !== null ? { prefix: command.prefix } : {}),
      contract: command.contract,
      chaos: command.chaos,
    });
    const r = written.report;
    io.out(`Mock "${written.name}" creado desde ${r.format} (${r.source}).`);
    io.out(`  ${written.routes} rutas, ${r.responses} respuestas: ${r.fromExamples} de ejemplos, ${r.generated} generadas.`);
    const x = r.extras;
    if (x) {
      if (x.selectable) io.out(`  Elegir respuesta: ${x.selectable} respuestas de error responden con la cabecera X-Mockix-Respuesta: <código> o ?mockix_respuesta=<código>.`);
      if (x.contract) io.out(`  Contrato: ${x.contract}, conectado en modo avisar.`);
      for (const c of x.crud) io.out(`  Datos: data/${c.bucket}.json (${c.items} registros) con CRUD en ${c.path}.`);
      for (const s of x.scenarios) io.out(`  Escenario deducido: ${s.id}, del campo ${s.field} (${s.states.join(" → ")}), ${s.transitions} transiciones. Revísalo.`);
      if (x.chaos.length) io.out(`  Caos preparado (apagado): ${x.chaos.join(", ")}.`);
      for (const n of x.notes) io.out(`  Nota: ${n}`);
    }
    for (const w of r.warnings) io.out(`  Aviso: ${w}`);
    for (const s of r.skipped) io.out(`  Omitido: ${s}`);
    io.out(`Siguiente paso: mockix serve ${command.dir === "." ? "" : command.dir} -m ${written.name}`.replace("  ", " "));
    return written.failed.length ? 1 : 0;
  } catch (err) {
    if (err instanceof ImportError) {
      io.err(`mockix: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

async function exportMock(command: { dir: string; mock: string; out: string | null }, io: Io): Promise<number> {
  const load = await loadWorkspace(command.dir);
  const mock = load.mocks.find((m) => m.name === command.mock);
  if (!mock) {
    io.err(`mockix: no hay ningún mock "${command.mock}"`);
    return 1;
  }
  if (!mock.config) {
    io.err(`mockix: el mock "${command.mock}" tiene problemas; corrígelos antes de exportar (mockix validate)`);
    return 1;
  }
  const yaml = stringify(exportOpenApi(mock.config), { lineWidth: 0 });
  if (command.out) {
    await writeFile(command.out, yaml);
    io.out(`OpenAPI 3.1 de "${command.mock}" escrito en ${command.out}.`);
  } else io.out(yaml.trimEnd());
  return 0;
}

/**
 * Runs the CLI. Resolves with the exit code once the command is done; for
 * `serve`, that is when `stop` aborts (Ctrl+C in the real binary).
 */
export async function main(argv: readonly string[], io: Io, stop: AbortSignal): Promise<number> {
  const parsed = parseCli(argv);
  if (!parsed.ok) {
    io.err(`mockix: ${parsed.message}`);
    io.err("Prueba «mockix --help».");
    return 1;
  }
  const { command } = parsed;
  switch (command.kind) {
    case "help":
      io.out(HELP.trimEnd());
      return 0;
    case "version":
      io.out(VERSION);
      return 0;
    case "init":
      return init(command.dir, io);
    case "validate":
      return validate(command.dir, command.failOnViolation, io);
    case "import":
      return importFile(command, io);
    case "export":
      return exportMock(command, io);
    case "record":
      return recordCommand(command, io, stop, `Mockix/${VERSION}`);
    case "convert":
      return convertCommand(command, io);
    case "replay":
      return replayCommand(command, io, stop, `Mockix/${VERSION}`);
    case "mcp":
      return mcpCommand(command, io, stop, VERSION);
    case "serve": {
      const adminToken = command.adminToken ?? process.env["MOCKIX_ADMIN_TOKEN"] ?? null;
      if (adminToken !== null && adminToken.length < 12) {
        io.err("mockix: MOCKIX_ADMIN_TOKEN necesita al menos 12 caracteres");
        return 1;
      }
      return serveWorkspace({ ...command, adminToken, serverHeader: `Mockix/${VERSION}` }, io, stop);
    }
  }
}
