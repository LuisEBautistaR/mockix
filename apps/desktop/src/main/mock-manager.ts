import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import protobuf from "protobufjs";
import type { LoadedMock, MockConfig, RuntimeRealtime, WorkspaceLoad } from "@mockix/core";
import { callbackLogSchema, messageLogSchema, requestLogSchema, type HostMethod, type HostParams, type HostResult } from "@shared/host-methods";
import { ErrorCodes, type Outcome } from "@shared/rpc";
import type { GrpcKind, GrpcSummary, MockCallbackEvent, MockMessageEvent, MockRequestEvent, MockState, MockStatus, ProbeResult, RealtimeSummary, RouteSummary, TestRequest } from "@shared/ipc";
import { HostProcess, type HostStatus } from "./host-process";

export interface MockManagerOptions {
  hostEntry: string;
  testMode: boolean;
  log: (message: string, detail?: unknown) => void;
}

interface Entry {
  name: string;
  /** Last version without problems; what (re)starts use. Null if the mock never loaded cleanly. */
  config: MockConfig | null;
  host: HostProcess | null;
  /** What the user asked for; a crashed host is brought back only while this is "running". */
  desired: "running" | "stopped";
  /** Port bound in this run, reused after a crash when the config asks for any free port. */
  boundPort: number | null;
  status: MockStatus;
}

type Events = { status: [MockStatus]; list: [MockStatus[]]; request: [MockRequestEvent]; callback: [MockCallbackEvent]; message: [MockMessageEvent] };

const PROBE_TIMEOUT_MS = 5_000;
const PREVIEW_CHARS = 600;

const summarize = (config: MockConfig | null): RouteSummary[] =>
  config?.routes.map((r) => ({
    id: r.id,
    method: r.method,
    path: r.path,
    mode: r.crud ? "crud" : r.mode,
    statuses: r.responses.map((x) => x.status),
    responses: r.responses.map((x) => x.id),
    file: r.file,
    latencyMs: r.latencyMs,
  })) ?? [];

const bucketSizes = (config: MockConfig | null) =>
  Object.entries(config?.buckets ?? {}).map(([name, v]) => ({ name, size: Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 1 }));

const short = (text: string | null) => (text === null ? "" : text.replace(/\s+/g, " ").trim().slice(0, 80));

function realtimeOf(config: MockConfig | null): RealtimeSummary[] {
  return (config?.realtime ?? []).map((r: RuntimeRealtime) => ({
    id: r.id,
    protocol: r.protocol,
    path: r.path,
    file: r.file,
    description: r.description,
    onConnect: r.onConnect.map((s) => ({ afterMs: s.afterMs, everyMs: s.everyMs, times: s.times, what: s.emit ? `${s.emit} ${short(s.data)}`.trim() : short(s.send), to: s.to })),
    messages: r.messages.map((m) => ({
      id: m.id,
      event: m.event,
      when: m.rules ? m.rules.when.map((w) => `${w.negate ? "no " : ""}${w.target} ${w.op}${w.value === undefined ? "" : ` ${JSON.stringify(w.value)}`}`).join(m.rules.mode === "all" ? " y " : " o ") : m.default ? "por defecto" : "siempre",
      does: [
        m.reply !== null ? `responde ${short(m.reply)}` : null,
        m.broadcast !== null ? `a todos ${short(m.broadcast)}` : null,
        m.ack !== null ? `ack ${short(m.ack)}` : null,
        m.emit ? `emite ${m.emit.event}${m.emit.to === "self" ? "" : ` a ${m.emit.to}`}` : null,
        m.join ? `entra en ${m.join}` : null,
        m.leave ? `sale de ${m.leave}` : null,
        m.close ? `cierra (${m.close.code})` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    })),
    echo: r.echo,
  }));
}

function grpcOf(config: MockConfig | null): GrpcSummary | null {
  if (!config?.grpc) return null;
  return {
    port: config.grpc.port,
    tls: config.grpc.tls,
    reflection: config.grpc.reflection,
    services: config.grpc.services.map((s) => {
      let methods: GrpcSummary["services"][number]["methods"] = [];
      try {
        const svc = protobuf.Root.fromJSON(s.descriptor as protobuf.INamespace).lookupService(s.service);
        methods = Object.values(svc.methods).map((m) => ({
          name: m.name,
          kind: (m.requestStream ? (m.responseStream ? "bidi" : "client") : m.responseStream ? "server" : "unary") as GrpcKind,
          requestType: m.requestType,
          responseType: m.responseType,
          responses: (s.methods[m.name] ?? []).map((r) => r.id),
        }));
      } catch {
        // The loader already checked the service; nothing to show if it went wrong.
      }
      return { service: s.service, file: s.file, proto: s.proto, methods };
    }),
  };
}

const contractOf = (config: MockConfig | null) => (config?.contract ? { file: config.contract.file, mode: config.contract.mode } : null);

/** Runs each mock of the open workspace in its own host process and keeps the UI informed. */
export class MockManager extends EventEmitter<Events> {
  readonly #opts: MockManagerOptions;
  readonly #entries = new Map<string, Entry>();

  constructor(opts: MockManagerOptions) {
    super();
    this.#opts = opts;
  }

  list(): MockStatus[] {
    return [...this.#entries.values()].map((e) => structuredClone(e.status));
  }

  #update(entry: Entry, patch: Partial<MockStatus>): void {
    entry.status = { ...entry.status, ...patch };
    this.emit("status", structuredClone(entry.status));
  }

  #fresh(mock: LoadedMock): Entry {
    const config = mock.config;
    return {
      name: mock.name,
      config,
      host: null,
      desired: "stopped",
      boundPort: null,
      status: {
        id: mock.name,
        name: mock.name,
        state: "stopped",
        host: config?.host ?? "127.0.0.1",
        latencyMs: config?.latencyMs ?? 0,
        buckets: bucketSizes(config),
        proxyTarget: config?.proxy?.target ?? null,
        contract: contractOf(config),
        scenarios: config?.scenarios.map((s) => s.id) ?? [],
        realtime: realtimeOf(config),
        grpc: grpcOf(config),
        grpcPort: null,
        port: config?.port ?? 0,
        prefix: config?.prefix ?? "",
        tls: config?.tls != null,
        url: null,
        routes: summarize(config),
        problems: mock.problems.map((p) => ({ ...p })),
        stale: false,
        startable: config !== null,
        pid: null,
        restarts: 0,
        runningSince: null,
        error: null,
      },
    };
  }

  /** Brings the mocks in line with a (re)loaded workspace: adds, removes and live-updates them. */
  async setWorkspace(load: WorkspaceLoad | null): Promise<void> {
    const mocks = load?.mocks ?? [];
    const names = new Set(mocks.map((m) => m.name));
    for (const [name, entry] of this.#entries) {
      if (!names.has(name)) {
        await this.#halt(entry);
        this.#entries.delete(name);
      }
    }
    const next = new Map<string, Entry>();
    for (const mock of mocks) {
      const entry = this.#entries.get(mock.name);
      if (!entry) {
        next.set(mock.name, this.#fresh(mock));
        continue;
      }
      next.set(mock.name, entry);
      if (!mock.config) {
        // Keep serving the last good version; show what is wrong on disk.
        this.#update(entry, { problems: mock.problems.map((p) => ({ ...p })), stale: entry.desired === "running" });
        continue;
      }
      entry.config = mock.config;
      this.#update(entry, {
        problems: [],
        stale: false,
        startable: true,
        routes: summarize(mock.config),
        latencyMs: mock.config.latencyMs,
        buckets: bucketSizes(mock.config),
        proxyTarget: mock.config.proxy?.target ?? null,
        contract: contractOf(mock.config),
        scenarios: mock.config.scenarios.map((s) => s.id),
        realtime: realtimeOf(mock.config),
        grpc: grpcOf(mock.config),
        prefix: mock.config.prefix,
        tls: mock.config.tls != null,
        host: mock.config.host,
        ...(entry.desired === "running" ? {} : { port: mock.config.port }),
      });
      if (entry.desired === "running" && entry.host?.status.state === "ready") await this.#apply(entry, entry.host);
    }
    // Keep the workspace order.
    this.#entries.clear();
    for (const [name, entry] of next) this.#entries.set(name, entry);
    this.emit("list", this.list());
  }

  #definition(entry: Entry, config: MockConfig): MockConfig {
    return { ...config, port: config.port === 0 && entry.boundPort ? entry.boundPort : config.port };
  }

  async #apply(entry: Entry, host: HostProcess): Promise<void> {
    const outcome = await host.call("mock.update", { definition: this.#definition(entry, entry.config!) });
    if (entry.host !== host) return;
    if (!outcome.ok) {
      entry.desired = "stopped";
      entry.host = null;
      await host.stop();
      this.#update(entry, { state: "failed", error: outcome.error, url: null, pid: null, runningSince: null, stale: false });
      return;
    }
    entry.boundPort = outcome.value.port;
    this.#update(entry, { port: outcome.value.port, url: outcome.value.url, grpcPort: outcome.value.grpcPort, error: null });
  }

  async start(id: string): Promise<Outcome<MockStatus>> {
    const entry = this.#entries.get(id);
    if (!entry) return notFound(id);
    if (entry.desired === "running" && entry.host) return { ok: true, value: structuredClone(entry.status) };
    if (!entry.config) {
      return { ok: false, error: { code: ErrorCodes.hasProblems, message: `Mock "${id}" has problems in its files` } };
    }

    entry.desired = "running";
    entry.boundPort = null;
    this.#update(entry, { state: "starting", error: null, restarts: 0, url: null, pid: null, runningSince: null });

    const host = new HostProcess({
      entry: this.#opts.hostEntry,
      serviceName: `Mockix: ${entry.name}`,
      testMode: this.#opts.testMode,
      log: (m, d) => this.#opts.log(`[${entry.name}] ${m}`, d),
    });
    entry.host = host;
    host.on("status", (s) => this.#onHostStatus(entry, host, s));
    host.on("ready", () => {
      // After a crash the new process starts empty: serve the mock again on the same port.
      if (host.status.restarts > 0 && entry.desired === "running" && entry.host === host) void this.#serve(entry, host);
    });
    host.on("event", (event) => {
      if (event.stream !== "mock") return;
      if (event.name === "request") {
        const parsed = requestLogSchema.safeParse(event.data);
        if (parsed.success) this.emit("request", { mockId: id, entry: parsed.data });
      } else if (event.name === "callback") {
        const parsed = callbackLogSchema.safeParse(event.data);
        if (parsed.success) this.emit("callback", { mockId: id, entry: parsed.data });
      } else if (event.name === "message") {
        const parsed = messageLogSchema.safeParse(event.data);
        if (parsed.success) this.emit("message", { mockId: id, entry: parsed.data });
      }
    });
    host.start();

    const served = await this.#serve(entry, host);
    return served.ok ? { ok: true, value: structuredClone(entry.status) } : served;
  }

  async #serve(entry: Entry, host: HostProcess): Promise<Outcome<void>> {
    const outcome = await host.call("mock.start", { definition: this.#definition(entry, entry.config!) });
    if (entry.host !== host) return { ok: false, error: { code: ErrorCodes.cancelled, message: "The mock was stopped while starting" } };
    if (!outcome.ok) {
      // Could not listen (port taken, bad certificate…): no point keeping the process.
      entry.desired = "stopped";
      entry.host = null;
      await host.stop();
      this.#update(entry, { state: "failed", error: outcome.error, url: null, pid: null, runningSince: null });
      return outcome;
    }
    entry.boundPort = outcome.value.port;
    this.#update(entry, {
      state: "running",
      port: outcome.value.port,
      url: outcome.value.url,
      grpcPort: outcome.value.grpcPort,
      pid: host.status.pid,
      restarts: host.status.restarts,
      runningSince: Date.now(),
      error: null,
    });
    return { ok: true, value: undefined };
  }

  #onHostStatus(entry: Entry, host: HostProcess, s: HostStatus): void {
    if (entry.host !== host || entry.desired !== "running") return;
    const map: Partial<Record<HostStatus["state"], MockState>> = { restarting: "restarting", failed: "failed" };
    const state = map[s.state];
    if (!state) return;
    this.#update(entry, {
      state,
      pid: null,
      restarts: s.restarts,
      runningSince: null,
      error:
        state === "failed"
          ? { code: ErrorCodes.hostExited, message: "The mock host crashed too many times in a row" }
          : s.lastExit
            ? { code: ErrorCodes.hostExited, message: `The mock host exited with code ${s.lastExit.code}` }
            : null,
    });
    if (state === "failed") {
      entry.desired = "stopped";
      entry.host = null;
    }
  }

  async #halt(entry: Entry): Promise<void> {
    const host = entry.host;
    entry.desired = "stopped";
    entry.host = null;
    entry.boundPort = null;
    if (host) {
      // Close the listener cleanly when the host is up; a restarting host is simply killed.
      if (host.status.state === "ready") await host.call("mock.stop", {}, 5_000);
      await host.stop();
    }
  }

  async stop(id: string): Promise<Outcome<MockStatus>> {
    const entry = this.#entries.get(id);
    if (!entry) return notFound(id);
    await this.#halt(entry);
    this.#update(entry, { state: "stopped", url: null, grpcPort: null, pid: null, runningSince: null, stale: false, port: entry.config?.port ?? 0 });
    return { ok: true, value: structuredClone(entry.status) };
  }

  /** Sends a test request to a running mock from main, so the renderer's CSP never has to allow localhost. */
  async send(id: string, test: TestRequest): Promise<Outcome<ProbeResult>> {
    const entry = this.#entries.get(id);
    if (!entry) return notFound(id);
    if (entry.status.state !== "running" || !entry.status.url) {
      return { ok: false, error: { code: ErrorCodes.hostUnavailable, message: `Mock "${id}" is not running` } };
    }
    const url = `${entry.status.url}${entry.status.prefix}${test.path}`;
    const started = performance.now();
    const body = test.body && !["GET", "HEAD"].includes(test.method) ? Buffer.from(test.body) : null;
    const headers: Record<string, string> = { "User-Agent": "Mockix (Probar)", ...(test.headers ?? {}) };
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      headers["Content-Type"] = /^\s*[[{]/.test(test.body!) ? "application/json" : "text/plain; charset=utf-8";
    }
    return new Promise((resolve) => {
      const done = (outcome: Outcome<ProbeResult>) => resolve(outcome);
      const options = { method: test.method, headers, timeout: PROBE_TIMEOUT_MS, ...(entry.config?.tls ? { ca: entry.config.tls.cert, servername: "localhost" } : {}) };
      const req = (url.startsWith("https:") ? httpsRequest : httpRequest)(url, options, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (size < PREVIEW_CHARS * 4) chunks.push(c);
          size += c.length;
        });
        res.on("end", () =>
          done({
            ok: true,
            value: {
              method: test.method,
              url,
              status: res.statusCode ?? 0,
              durationMs: Math.round(performance.now() - started),
              contentType: res.headers["content-type"] ?? null,
              headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")])),
              preview: Buffer.concat(chunks).toString("utf8").slice(0, PREVIEW_CHARS),
            },
          }),
        );
      });
      req.on("timeout", () => req.destroy(new Error(`No answer after ${PROBE_TIMEOUT_MS} ms`)));
      req.on("error", (err) => done({ ok: false, error: { code: ErrorCodes.timeout, message: err.message } }));
      req.end(body ?? undefined);
    });
  }

  /** The configuration a mock runs with (or would start with); null when it never loaded cleanly. */
  configOf(id: string): MockConfig | null {
    return this.#entries.get(id)?.config ?? null;
  }

  /** Calls a method on a running mock's host; HOST_UNAVAILABLE when it is not running. */
  async call<M extends HostMethod>(id: string, method: M, params: HostParams<M>): Promise<Outcome<HostResult<M>>> {
    const entry = this.#entries.get(id);
    if (!entry) return notFound(id);
    if (!entry.host || entry.status.state !== "running") return { ok: false, error: { code: ErrorCodes.hostUnavailable, message: `Mock "${id}" is not running` } };
    return entry.host.call(method, params);
  }

  isRunning(id: string): boolean {
    return this.#entries.get(id)?.status.state === "running";
  }

  /** Test mode only: kills a mock's host process to exercise the restart path. */
  async crashHost(id: string): Promise<Outcome<{ scheduled: true }>> {
    const entry = this.#entries.get(id);
    if (!entry) return notFound(id);
    if (!entry.host) return { ok: false, error: { code: ErrorCodes.hostUnavailable, message: `Mock "${id}" is not running` } };
    return entry.host.call("diagnostics.crash", { exitCode: 3 });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((e) => this.#halt(e)));
  }
}

function notFound(id: string): Outcome<never> {
  return { ok: false, error: { code: ErrorCodes.notFound, message: `No mock named "${id}"` } };
}
