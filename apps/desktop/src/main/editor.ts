import { shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { stringify } from "yaml";
import { EditError, ImportError, createMock, deleteMock, deleteRoute, exportOpenApi, importSource, previewTemplate, readRoute, writeImported, writeRoute, type RouteDocument, type RouteDraft } from "@mockix/core";
import type { ImportSummary } from "@shared/ipc";
import { ErrorCodes, type Outcome } from "@shared/rpc";
import type { WorkspaceService } from "./workspace";

const noWorkspace: Outcome<never> = { ok: false, error: { code: ErrorCodes.noWorkspace, message: "No workspace is open" } };

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
      const written = await writeImported(dir, await importSource(text, basename(file), { baseDir: dirname(file) }));
      const r = written.report;
      return { name: written.name, format: r.format, source: r.source, routes: written.routes, responses: r.responses, fromExamples: r.fromExamples, generated: r.generated, warnings: r.warnings, skipped: r.skipped };
    });
    return outcome;
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
