import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { dirname, extname, join, resolve } from "node:path";
import { EditError, createMock, setRouteOrder, writeRoute } from "../edit.js";
import { chaosProfilesFor } from "./openapi-extras.js";
import { importHar } from "./har.js";
import { importMockoon } from "./mockoon.js";
import { ImportError, detectFormat, parseSource, type ImportFormat, type ImportReport, type ImportResult, type ImportedMock } from "./model.js";
import { importOpenApi } from "./openapi.js";
import { importPostman } from "./postman.js";

export { DEFAULT_REDACTION, exchangesToRoutes, inferPath, looksLikeId, type ConvertOptions, type Exchange, type RedactionRule } from "./exchanges.js";
export { exportOpenApi, toMockPath, toOpenApiPath } from "./openapi.js";
export { convertPostmanText } from "./postman.js";
export { templateFromSchema } from "./schema-template.js";
export { ImportError, detectFormat, nameFromUrl, parseSource, slugify, type ImportExtras, type ImportFormat, type ImportReport, type ImportResult, type ImportedMock, type ImportedRoute } from "./model.js";
export { PICK_HEADER, PICK_QUERY } from "./openapi-extras.js";

export interface ImportOptions {
  /** Force a format instead of detecting it. */
  format?: ImportFormat;
  /** Path prefix for HAR imports (stripped from recorded paths). */
  prefix?: string;
  /** Folder of the source file: relative .proto paths of Sendix gRPC items resolve from here. */
  baseDir?: string;
}

/** Parses a source file (JSON or YAML) and converts it. Throws ImportError with a reason in Spanish. */
export async function importSource(text: string, fileName: string, options: ImportOptions = {}): Promise<ImportResult> {
  const value = parseSource(text);
  const format = options.format ?? detectFormat(value);
  if (!format) throw new ImportError("No se reconoce el formato: se admite OpenAPI 3/Swagger 2, colección de Postman v2.x, HAR o entorno de Mockoon");
  switch (format) {
    case "openapi": {
      const result = await importOpenApi(value, fileName);
      // Only OpenAPI 3 can be a contract: the checker does not read Swagger 2.
      const v3 = typeof (value as Record<string, unknown>)["openapi"] === "string";
      return v3 ? { ...result, contractSource: { text, fileName } } : result;
    }
    case "postman":
      return withProtos(importPostman(value, fileName), options.baseDir ?? process.cwd());
    case "har":
      return importHar(value, fileName, options.prefix ?? "");
    case "mockoon":
      return importMockoon(value, fileName);
  }
}

/** Reads the .proto files gRPC items point at; a service whose proto cannot be read is left out, with the reason. */
async function withProtos(result: ImportResult, baseDir: string): Promise<ImportResult> {
  const sources = result.mock.protoSources ?? [];
  if (!sources.length) return result;
  const workspaceFiles: Record<string, string> = { ...(result.mock.workspaceFiles ?? {}) };
  const extraFiles = { ...(result.mock.extraFiles ?? {}) };
  for (const s of sources) {
    try {
      workspaceFiles[s.to] = await readFile(resolve(baseDir, s.from), "utf8");
    } catch {
      delete extraFiles[s.extraFile];
      result.report.routes--;
      result.report.skipped.push(`gRPC ${s.service}: no se puede leer ${s.from}; cópialo a ${s.to} y crea ${s.extraFile}`);
    }
  }
  const any = Object.keys(workspaceFiles).length > 0;
  return {
    report: result.report,
    mock: { ...result.mock, extraFiles, workspaceFiles, ...(any ? {} : { grpc: undefined }) },
  };
}

export interface WriteOptions {
  /** Mock name; default the one the importer suggested. A taken name gets -2, -3… */
  name?: string;
  port?: number;
  prefix?: string;
  /** An OpenAPI source is copied to contracts/ and connected to the mock (warn mode) unless this is false. */
  contract?: boolean;
  /** Chaos profiles prepared from the contract's server errors (off until applied) unless this is false. */
  chaos?: boolean;
}

/** A file of the folder with exactly this content, if there is one. */
async function findSame(dir: string, text: string): Promise<string | null> {
  for (const file of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if ((await readFile(join(dir, file), "utf8").catch(() => null)) === text) return file;
  }
  return null;
}

/** A free file name in a workspace folder: the same content is reused, a different one gets -2, -3… */
async function freeFile(dir: string, base: string, ext: string, text: string): Promise<{ file: string; reused: boolean }> {
  for (let n = 1; ; n++) {
    const file = `${n === 1 ? base : `${base}-${n}`}${ext}`;
    const current = await readFile(join(dir, file), "utf8").catch(() => null);
    if (current === null) return { file, reused: false };
    if (current === text) return { file, reused: true };
  }
}

export interface WrittenImport {
  name: string;
  /** Routes written. */
  routes: number;
  /** Routes the editor refused, with the reason (kept in the report). */
  failed: string[];
  report: ImportReport;
}

/** Writes an imported mock into a workspace as mocks/<name>/ (mock.yaml, data/, routes/). */
export async function writeImported(workspaceDir: string, result: ImportResult, options: WriteOptions = {}): Promise<WrittenImport> {
  const mock: ImportedMock = result.mock;
  const report: ImportReport = structuredClone(result.report);
  let existing: string[] = [];
  try {
    existing = await readdir(join(resolve(workspaceDir), "mocks"));
  } catch {
    existing = [];
  }
  const base = options.name ?? mock.name;
  let name = base;
  for (let n = 2; existing.includes(name); n++) name = `${base}-${n}`;

  // Two mocks cannot share a port: without an explicit one, take the next free one.
  let port = options.port ?? mock.port;
  if (options.port === undefined && port !== 0) {
    const used = new Set<number>();
    for (const other of existing) {
      try {
        const settings = parseYaml(await readFile(join(resolve(workspaceDir), "mocks", other, "mock.yaml"), "utf8")) as { port?: unknown };
        if (typeof settings?.port === "number") used.add(settings.port);
      } catch {
        // A mock without a readable mock.yaml does not hold a port.
      }
    }
    while (used.has(port)) port++;
    if (port !== mock.port) report.warnings.push(`El puerto ${mock.port} ya lo usa otro mock del workspace; este usa ${port}`);
  }

  // The contract goes in first, so the mock already finds it when it loads.
  let contractFile: string | null = null;
  if (result.contractSource && options.contract !== false) {
    const ext = /^\.(ya?ml|json)$/i.test(extname(result.contractSource.fileName)) ? extname(result.contractSource.fileName).toLowerCase() : ".yaml";
    const dir = join(resolve(workspaceDir), "contracts");
    await mkdir(dir, { recursive: true });
    // Already in contracts/ (imported from there): connect that file instead of a copy.
    const same = await findSame(dir, result.contractSource.text);
    if (same) contractFile = `contracts/${same}`;
    else {
      const { file, reused } = await freeFile(dir, `${name}.openapi`, ext, result.contractSource.text);
      if (!reused) await writeFile(join(dir, file), result.contractSource.text);
      contractFile = `contracts/${file}`;
    }
  }

  await createMock(workspaceDir, name, port, options.prefix ?? mock.prefix, {
    ...(mock.latency ? { latency: mock.latency } : {}),
    ...(mock.cors === false ? { cors: false } : {}),
    proxy: mock.proxy,
    variables: mock.variables,
    description: `Importado de ${report.source}`,
    ...(mock.grpc ? { grpc: { port: mock.grpc.port } } : {}),
    ...(contractFile ? { contract: { file: contractFile, mode: "warn" as const } } : {}),
  });
  if (report.extras) report.extras.contract = contractFile;

  if (report.extras && options.chaos !== false) {
    const profiles = chaosProfilesFor(name, mock.serverErrors ?? []);
    const dir = join(resolve(workspaceDir), "chaos");
    await mkdir(dir, { recursive: true });
    const { file, reused } = await freeFile(dir, name, ".yaml", profiles.text);
    if (!reused) await writeFile(join(dir, file), profiles.text);
    report.extras.chaos = profiles.names;
  }
  const root = join(resolve(workspaceDir), "mocks", name);
  for (const [rel, text] of Object.entries(mock.workspaceFiles ?? {})) {
    const abs = join(resolve(workspaceDir), rel);
    const current = await readFile(abs, "utf8").catch(() => null);
    if (current !== null && current !== text) {
      report.warnings.push(`${rel} ya existe y es distinto; se deja el que había`);
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    if (current === null) await writeFile(abs, text);
  }
  // WebSocket routes and gRPC services count as routes in the summary.
  let extraWritten = 0;
  for (const [rel, text] of Object.entries(mock.extraFiles ?? {})) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text, { flag: "wx" }).then(
      // Scenarios are not routes; WebSocket routes and gRPC services are.
      () => (rel.startsWith("scenarios/") ? undefined : extraWritten++),
      () => report.skipped.push(`no se pudo escribir ${rel} (ya existe)`),
    );
  }
  if (mock.files && Object.keys(mock.files).length) {
    await mkdir(join(root, "files"), { recursive: true });
    for (const [file, bytes] of Object.entries(mock.files)) await writeFile(join(root, "files", file), bytes);
  }
  if (Object.keys(mock.buckets).length) {
    await mkdir(join(root, "data"), { recursive: true });
    for (const [bucket, value] of Object.entries(mock.buckets)) await writeFile(join(root, "data", `${bucket}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
  const failed: string[] = [];
  const order: string[] = [];
  let written = 0;
  for (const route of mock.routes) {
    try {
      const file = await writeRoute(workspaceDir, name, route.draft, null, route.folder);
      order.push(route.draft.id ?? file.replace(/^routes\//, "").replace(/\.yaml$/, "").toLowerCase());
      written++;
    } catch (err) {
      const reason = err instanceof EditError ? (err.issues.map((i) => `${i.path}: ${i.message}`).join("; ") || err.message) : String(err);
      failed.push(`${route.draft.method ?? ""} ${route.draft.path}: ${reason}`.trim());
    }
  }
  if (failed.length) report.skipped.push(...failed.map((f) => `no se pudo escribir ${f}`));
  // Keep the source's order: the first route that matches answers, as in the original.
  if (order.length > 1) await setRouteOrder(workspaceDir, name, order);
  return { name, routes: written + extraWritten, failed, report };
}

export { importHar, importMockoon, importOpenApi, importPostman };
