import { shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { stringify } from "yaml";
import { EditError, ImportError, createMock, deleteMock, deleteRoute, exportOpenApi, importSource, previewTemplate, readRoute, writeImported, writeRoute, type ImportResult, type RouteDocument, type RouteDraft, type WrittenImport } from "@mockix/core";
import type { ContractPreview, FromContractOptions, ImportSummary } from "@shared/ipc";
import { ErrorCodes, type Outcome } from "@shared/rpc";
import type { WorkspaceService } from "./workspace";

const noWorkspace: Outcome<never> = { ok: false, error: { code: ErrorCodes.noWorkspace, message: "No workspace is open" } };

function summary(written: WrittenImport): ImportSummary {
  const r = written.report;
  return {
    name: written.name,
    format: r.format,
    source: r.source,
    routes: written.routes,
    responses: r.responses,
    fromExamples: r.fromExamples,
    generated: r.generated,
    warnings: r.warnings,
    skipped: r.skipped,
    ...(r.extras ? { extras: r.extras } : {}),
  };
}

function fromError(err: unknown): Outcome<never> {
  if (err instanceof ImportError) return { ok: false, error: { code: "IMPORT_FAILED", message: err.message } };
  if (err instanceof EditError) {
    const detail = err.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("\n");
    return { ok: false, error: { code: err.code, message: detail || err.message } };
  }
  return { ok: false, error: { code: ErrorCodes.handlerFailed, message: err instanceof Error ? err.message : String(err) } };
}

/**
 * Edits the open workspace on disk through the core's editing functions. The
 * watcher then reloads the files, so running mocks pick up every change the
 * same way as an edit made in a text editor.
 */
export class WorkspaceEditor {
  readonly #workspace: WorkspaceService;

  constructor(workspace: WorkspaceService) {
    this.#workspace = workspace;
  }

  async #run<T>(fn: (dir: string) => Promise<T>): Promise<Outcome<T>> {
    const dir = this.#workspace.state.dir;
    if (!dir) return noWorkspace;
    try {
      const value = await fn(dir);
      // Reload now instead of waiting for the watcher, so the UI sees the change at once.
      await this.#workspace.reload();
      return { ok: true, value };
    } catch (err) {
      return fromError(err);
    }
  }

  async read(mock: string, routeId: string): Promise<Outcome<RouteDocument>> {
    const dir = this.#workspace.state.dir;
    if (!dir) return noWorkspace;
    try {
      return { ok: true, value: await readRoute(dir, mock, routeId) };
    } catch (err) {
      return fromError(err);
    }
  }

  write(mock: string, routeId: string | null, draft: RouteDraft, folder: string): Promise<Outcome<{ file: string; id: string }>> {
    return this.#run(async (dir) => {
      const file = await writeRoute(dir, mock, draft, routeId, folder);
      const id = draft.id ?? file.replace(/^routes\//, "").replace(/\.yaml$/, "").toLowerCase();
      return { file, id };
    });
  }

  remove(mock: string, routeId: string): Promise<Outcome<{ file: string }>> {
    // To the OS trash, not a permanent delete: an accidental click can be undone.
    return this.#run(async (dir) => ({ file: await deleteRoute(dir, mock, routeId, (abs) => shell.trashItem(abs)) }));
  }

  /** The whole mock to the OS trash, like a route: it can be restored from there. */
  removeMock(name: string): Promise<Outcome<{ removed: string[] }>> {
    return this.#run(async (dir) => ({ removed: await deleteMock(dir, name, (abs) => shell.trashItem(abs)) }));
  }

  createMock(name: string, port: number, prefix: string): Promise<Outcome<null>> {
    return this.#run(async (dir) => {
      await createMock(dir, name, port, prefix);
      return null;
    });
  }

  /** Imports a file (format detected) as a new mock of the workspace. */
  async importFile(file: string): Promise<Outcome<ImportSummary>> {
    const outcome = await this.#run(async (dir) => {
      const text = await readFile(file, "utf8");
      return summary(await writeImported(dir, await importSource(text, basename(file), { baseDir: dirname(file) })));
    });
    return outcome;
  }

  /** The contract picked in «Nuevo mock», kept in main: the renderer never hands a path back. */
  #picked: { result: ImportResult } | null = null;

  /** Reads an OpenAPI contract for a new mock and suggests its name, port and prefix. */
  async pickContract(file: string): Promise<Outcome<ContractPreview>> {
    const dir = this.#workspace.state.dir;
    if (!dir) return noWorkspace;
    try {
      const text = await readFile(file, "utf8");
      const result = await importSource(text, basename(file), { baseDir: dirname(file) });
      if (result.report.format !== "openapi") {
        return { ok: false, error: { code: "NOT_A_CONTRACT", message: "Ese archivo no es un contrato OpenAPI. Para colecciones de Postman, HAR o Mockoon usa «Importar»." } };
      }
      this.#picked = { result };
      const used = new Set((this.#workspace.current?.mocks ?? []).flatMap((m) => (m.config ? [m.config.port] : [])));
      let port = result.mock.port;
      while (used.has(port)) port++;
      const title = result.report.source.replace(/\s*\([^)]*\)$/, "");
      return { ok: true, value: { fileName: basename(file), title, name: result.mock.name, port, prefix: result.mock.prefix, operations: result.report.routes, connectable: result.contractSource !== undefined } };
    } catch (err) {
      return fromError(err);
    }
  }

  /** Creates the mock from the picked contract: routes, CRUD, scenarios, the contract connected and chaos prepared. */
  createFromContract(options: FromContractOptions): Promise<Outcome<ImportSummary>> {
    const picked = this.#picked;
    if (!picked) return Promise.resolve({ ok: false, error: { code: "NO_CONTRACT", message: "Elige primero un contrato" } });
    return this.#run(async (dir) => {
      const written = await writeImported(dir, picked.result, options);
      this.#picked = null;
      return summary(written);
    });
  }

  /** Writes a mock as OpenAPI 3.1 YAML. */
  async exportOpenApi(mock: string, file: string): Promise<Outcome<{ file: string }>> {
    const loaded = this.#workspace.current?.mocks.find((m) => m.name === mock);
    if (!loaded?.config) return { ok: false, error: { code: ErrorCodes.hasProblems, message: "The mock has problems; fix them to export" } };
    try {
      await writeFile(file, stringify(exportOpenApi(loaded.config), { lineWidth: 0 }));
      return { ok: true, value: { file } };
    } catch (err) {
      return fromError(err);
    }
  }

  /** Renders a body template with a sample request (params = "1") and a fixed seed. */
  preview(mock: string, method: string, pattern: string, text: string): Outcome<{ text: string }> {
    const loaded = this.#workspace.current?.mocks.find((m) => m.name === mock);
    if (!loaded?.config) return { ok: false, error: { code: ErrorCodes.hasProblems, message: "The mock has problems; fix them to preview" } };
    const params: Record<string, string> = {};
    for (const m of pattern.matchAll(/:([A-Za-z0-9_]+)/g)) params[m[1]!] = "1";
    const path = pattern.startsWith("^") ? "/" : pattern.replace(/:([A-Za-z0-9_]+)/g, "1").replace(/\*$/, "");
    try {
      const out = previewTemplate(text, loaded.config, {
        method: method === "ANY" ? "GET" : method,
        path,
        query: {},
        headers: {},
        cookies: {},
        params,
        body: { raw: "", parsed: undefined },
        requestNumber: 1,
      });
      return { ok: true, value: { text: out } };
    } catch (err) {
      return { ok: false, error: { code: "TEMPLATE_ERROR", message: err instanceof Error ? err.message : String(err) } };
    }
  }
}
