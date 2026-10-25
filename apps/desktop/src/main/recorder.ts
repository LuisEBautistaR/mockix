import { EventEmitter } from "node:events";
import { shell } from "electron";
import {
  DEFAULT_REDACTION,
  RecordingWriter,
  convertRecording,
  listRecordings,
  mergeIntoMock,
  nameFromUrl,
  planMerge,
  readRecording,
  recordingPath,
  writeImported,
  type Exchange,
  type RecordingMeta,
} from "@mockix/core";
import { ErrorCodes, type Outcome } from "@shared/rpc";
import type { ExchangeSummary, ImportSummary, RecordingPlan, RecordingPreview, RecordingStatus } from "@shared/ipc";
import { HostProcess } from "./host-process";
import type { WorkspaceService } from "./workspace";

type Events = { status: [RecordingStatus]; exchange: [ExchangeSummary] };

const summarize = (ex: Exchange, index: number): ExchangeSummary => ({ index, at: ex.at ?? 0, method: ex.method, url: ex.url, status: ex.status, binary: ex.binary });

/**
 * One recording at a time: a proxy in its own host process forwards to the
 * real API and hands every exchange to main, which appends it to
 * <workspace>/.mockix/recordings/<file>.jsonl (local, never in git).
 */
export class Recorder extends EventEmitter<Events> {
  readonly #workspace: WorkspaceService;
  readonly #hostEntry: string;
  readonly #log: (message: string, detail?: unknown) => void;
  #host: HostProcess | null = null;
  #writer: RecordingWriter | null = null;
  #status: RecordingStatus = { active: null };

  constructor(workspace: WorkspaceService, hostEntry: string, log: (message: string, detail?: unknown) => void) {
    super();
    this.#workspace = workspace;
    this.#hostEntry = hostEntry;
    this.#log = log;
  }

  get status(): RecordingStatus {
    return structuredClone(this.#status);
  }

  #set(status: RecordingStatus): void {
    this.#status = status;
    this.emit("status", this.status);
  }

  async list(): Promise<RecordingMeta[]> {
    const dir = this.#workspace.state.dir;
    return dir ? listRecordings(dir) : [];
  }

  async start(target: string, port: number): Promise<Outcome<RecordingStatus>> {
    const dir = this.#workspace.state.dir;
    if (!dir) return { ok: false, error: { code: ErrorCodes.noWorkspace, message: "No workspace is open" } };
    if (this.#host) return { ok: false, error: { code: ErrorCodes.alreadyRunning, message: "A recording is already running" } };
    const writer = new RecordingWriter(dir, target);
    const host = new HostProcess({ entry: this.#hostEntry, serviceName: "Mockix: grabación", testMode: false, log: (m, d) => this.#log(`[grabación] ${m}`, d) });
    this.#host = host;
    this.#writer = writer;
    host.on("event", (event) => {
      if (event.stream !== "mock" || event.name !== "exchange") return;
      const ex = event.data as Exchange;
      void writer.add(ex);
      if (this.#status.active) this.#set({ active: { ...this.#status.active, count: writer.count } });
      this.emit("exchange", summarize(ex, writer.count - 1));
    });
    host.start();
    const outcome = await host.call("mock.start", {
      definition: { name: "grabacion", port, routes: [], cors: false, proxy: { target, keepPrefix: true, insecure: false, headers: {} } },
      record: true,
    });
    if (!outcome.ok) {
      this.#host = null;
      this.#writer = null;
      await host.stop();
      return outcome;
    }
    this.#set({ active: { file: writer.file.split(/[\\/]/).pop()!, target, url: outcome.value.url, count: 0, startedAt: Date.now() } });
    return { ok: true, value: this.status };
  }

  async stop(): Promise<Outcome<{ file: string | null; count: number }>> {
    const host = this.#host;
    const writer = this.#writer;
    this.#host = null;
    this.#writer = null;
    if (host) {
      if (host.status.state === "ready") await host.call("mock.stop", {}, 5_000);
      await host.stop();
    }
    await writer?.flush();
    const file = this.#status.active?.file ?? null;
    this.#set({ active: null });
    return { ok: true, value: { file, count: writer?.count ?? 0 } };
  }

  async #read(file: string): Promise<{ target: string; exchanges: Exchange[] }> {
    return readRecording(recordingPath(this.#workspace.state.dir!, file));
  }

  async exchanges(file: string): Promise<Outcome<ExchangeSummary[]>> {
    if (!this.#workspace.state.dir) return { ok: false, error: { code: ErrorCodes.noWorkspace, message: "No workspace is open" } };
    try {
      return { ok: true, value: (await this.#read(file)).exchanges.map(summarize) };
    } catch (err) {
      return { ok: false, error: { code: ErrorCodes.notFound, message: err instanceof Error ? err.message : String(err) } };
    }
  }

  async plan(file: string, into: string | null, prefix: string): Promise<Outcome<RecordingPlan>> {
    const load = this.#workspace.current;
    if (!load) return { ok: false, error: { code: ErrorCodes.noWorkspace, message: "No workspace is open" } };
    try {
      const { target, exchanges } = await this.#read(file);
      const redaction = load.redaction ?? DEFAULT_REDACTION;
      const result = convertRecording(exchanges, { name: suggestName(target), source: file, prefix, redaction });
      const config = into ? (load.mocks.find((m) => m.name === into)?.config ?? null) : null;
      return {
        ok: true,
        value: { suggestedName: result.mock.name, items: planMerge(config, result, exchanges, prefix), warnings: result.report.warnings, redaction },
      };
    } catch (err) {
      return { ok: false, error: { code: ErrorCodes.notFound, message: err instanceof Error ? err.message : String(err) } };
    }
  }

  /** One exchange as recorded (raw) and as it would go into the mock (redacted). */
  async preview(file: string, index: number, prefix: string): Promise<Outcome<RecordingPreview>> {
    const load = this.#workspace.current;
    if (!load) return { ok: false, error: { code: ErrorCodes.noWorkspace, message: "No workspace is open" } };
    try {
      const { exchanges } = await this.#read(file);
      const ex = exchanges[index];
      if (!ex) return { ok: false, error: { code: ErrorCodes.notFound, message: "No such exchange" } };
      const single = convertRecording([ex], { name: "x", source: file, prefix, redaction: load.redaction ?? DEFAULT_REDACTION });
      const route = single.mock.routes[0]!;
      const body = route.draft.responses?.[0]?.body;
      return {
        ok: true,
        value: {
          method: ex.method,
          url: ex.url,
          status: ex.status,
          route: `${route.draft.method} ${route.draft.path}`,
          requestHeaders: ex.requestHeaders,
          responseHeaders: ex.responseHeaders,
          rawBody: ex.binary ? null : ex.responseBody,
          mockBody: body?.kind === "inline" ? body.text : body?.kind === "file" ? `(archivo ${body.path})` : "",
        },
      };
    } catch (err) {
      return { ok: false, error: { code: ErrorCodes.notFound, message: err instanceof Error ? err.message : String(err) } };
    }
  }

  async convert(file: string, target: { name: string } | { into: string }, prefix: string): Promise<Outcome<ImportSummary>> {
    const dir = this.#workspace.state.dir;
    const load = this.#workspace.current;
    if (!dir || !load) return { ok: false, error: { code: ErrorCodes.noWorkspace, message: "No workspace is open" } };
    try {
      const { target: api, exchanges } = await this.#read(file);
      const result = convertRecording(exchanges, { name: "name" in target ? target.name : suggestName(api), source: file, prefix, redaction: load.redaction ?? DEFAULT_REDACTION });
      let summary: ImportSummary;
      if ("into" in target) {
        const config = load.mocks.find((m) => m.name === target.into)?.config;
        if (!config) return { ok: false, error: { code: ErrorCodes.hasProblems, message: `Mock "${target.into}" has problems or does not exist` } };
        const merged = await mergeIntoMock(dir, target.into, config, result);
        summary = {
          name: target.into,
          format: "recording",
          source: file,
          routes: merged.newRoutes,
          responses: merged.appended,
          fromExamples: merged.appended,
          generated: 0,
          warnings: [...result.report.warnings, ...(merged.unchanged ? [`${merged.unchanged} rutas ya tenían esas respuestas`] : [])],
          skipped: merged.failed,
        };
      } else {
        const written = await writeImported(dir, result, { name: target.name, prefix });
        const r = written.report;
        summary = { name: written.name, format: "recording", source: file, routes: written.routes, responses: r.responses, fromExamples: r.fromExamples, generated: r.generated, warnings: r.warnings, skipped: r.skipped };
      }
      await this.#workspace.reload();
      return { ok: true, value: summary };
    } catch (err) {
      return { ok: false, error: { code: ErrorCodes.handlerFailed, message: err instanceof Error ? err.message : String(err) } };
    }
  }

  async remove(file: string): Promise<Outcome<null>> {
    const dir = this.#workspace.state.dir;
    if (!dir) return { ok: false, error: { code: ErrorCodes.noWorkspace, message: "No workspace is open" } };
    if (this.#status.active?.file === file) return { ok: false, error: { code: ErrorCodes.alreadyRunning, message: "Stop the recording first" } };
    await shell.trashItem(recordingPath(dir, file));
    return { ok: true, value: null };
  }
}

const suggestName = (target: string) => nameFromUrl(target, "grabacion");
