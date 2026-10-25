/**
 * MCP for agents in the desktop: Streamable HTTP on 127.0.0.1 with a bearer
 * token, off by default. Tools that write wait for the user's approval in the
 * UI (or a "trust this session" switch), and every call is audited, in the UI
 * and in <workspace>/.mockix/mcp-audit.jsonl.
 */
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, loadWorkspace, type ApprovalRequest, type AuditEntry, type ChaosReport, type ContractReport, type McpBackend, type RequestLogEntry, type ScenarioEvent, type ScenarioView } from "@mockix/core";
import type { AgentsState, PendingApproval } from "@shared/ipc";
import type { LogStore } from "./log-store";
import type { MockManager } from "./mock-manager";
import type { Recorder } from "./recorder";
import type { WorkspaceService } from "./workspace";

const APPROVAL_TIMEOUT_MS = 120_000;
const AUDIT_KEEP = 200;
const MAX_BODY = 10 * 1024 * 1024;

/** The MCP tools on top of the desktop's own services: mocks run in their hosts, edits reload the workspace. */
class DesktopBackend implements McpBackend {
  constructor(
    readonly workspace: string,
    private readonly services: { workspace: WorkspaceService; mocks: MockManager; logs: LogStore; recorder: Recorder },
  ) {}

  load() {
    return loadWorkspace(this.workspace);
  }

  async status() {
    return this.services.mocks.list().map((m) => ({ name: m.id, state: m.state, url: m.url, prefix: m.prefix, grpcPort: m.grpcPort }));
  }

  async start(name: string) {
    const outcome = await this.services.mocks.start(name);
    if (!outcome.ok) throw new Error(outcome.error.message);
    return { url: outcome.value.url ?? "" };
  }

  async stop(name: string) {
    const outcome = await this.services.mocks.stop(name);
    if (!outcome.ok) throw new Error(outcome.error.message);
  }

  async logs(name: string, limit: number) {
    return this.services.logs.recent(name, limit).requests as unknown as RequestLogEntry[];
  }

  async #call<T>(name: string, run: () => Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>): Promise<T> {
    if (!this.services.mocks.isRunning(name)) throw new Error(`${name} no está en marcha: usa start_mock`);
    const outcome = await run();
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.value as T;
  }

  async scenarios(name: string) {
    return (await this.#call<{ views: ScenarioView[] }>(name, () => this.services.mocks.call(name, "mock.scenarios", {}))).views;
  }

  setScenario(name: string, id: string, key: string, state: string) {
    return this.#call<ScenarioEvent>(name, () => this.services.mocks.call(name, "mock.scenarioSet", { id, key, state }));
  }

  chaos(name: string) {
    return this.#call<ChaosReport>(name, () => this.services.mocks.call(name, "mock.chaos", {}));
  }

  async setChaos(name: string, profile: string | null | undefined) {
    await this.#call(name, () => this.services.mocks.call(name, "mock.chaosSet", profile === undefined ? { reset: true } : { profile }));
    return this.chaos(name);
  }

  contract(name: string) {
    return this.#call<ContractReport | null>(name, () => this.services.mocks.call(name, "mock.contract", {}));
  }

  async recordStart(target: string, port: number) {
    const outcome = await this.services.recorder.start(target, port);
    if (!outcome.ok) throw new Error(outcome.error.message);
    const active = outcome.value.active!;
    return { url: active.url, file: active.file };
  }

  async recordStop() {
    if (!this.services.recorder.status.active) return null;
    const outcome = await this.services.recorder.stop();
    return outcome.ok && outcome.value.file ? { file: outcome.value.file, count: outcome.value.count } : null;
  }

  async changed() {
    await this.services.workspace.reload();
  }
}

type Events = { changed: [AgentsState] };

export interface AgentsSettings {
  enabled: boolean;
  port: number;
  token: string;
}

export class AgentsService extends EventEmitter<Events> {
  readonly #services: { workspace: WorkspaceService; mocks: MockManager; logs: LogStore; recorder: Recorder };
  readonly #version: string;
  readonly #save: (s: AgentsSettings) => Promise<void>;
  #settings: AgentsSettings;
  #server: Server | null = null;
  #port: number | null = null;
  #trust = false;
  #pending = new Map<string, { request: PendingApproval; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  #audit: AuditEntry[] = [];
  #error: string | null = null;

  constructor(
    services: { workspace: WorkspaceService; mocks: MockManager; logs: LogStore; recorder: Recorder },
    options: { version: string; settings: Partial<AgentsSettings>; save: (s: AgentsSettings) => Promise<void> },
  ) {
    super();
    this.#services = services;
    this.#version = options.version;
    this.#save = options.save;
    this.#settings = { enabled: options.settings.enabled ?? false, port: options.settings.port ?? 0, token: options.settings.token || randomBytes(24).toString("base64url") };
  }

  get state(): AgentsState {
    return {
      enabled: this.#settings.enabled,
      running: this.#server !== null,
      url: this.#port ? `http://127.0.0.1:${this.#port}/mcp` : null,
      token: this.#settings.token,
      trustSession: this.#trust,
      pending: [...this.#pending.values()].map((p) => p.request),
      audit: [...this.#audit],
      error: this.#error,
    };
  }

  #changed(): void {
    this.emit("changed", this.state);
  }

  async init(): Promise<void> {
    if (this.#settings.enabled) await this.#listen();
  }

  async setEnabled(enabled: boolean): Promise<AgentsState> {
    this.#settings.enabled = enabled;
    if (enabled) await this.#listen();
    else await this.#close();
    await this.#save(this.#settings);
    this.#changed();
    return this.state;
  }

  async rotateToken(): Promise<AgentsState> {
    this.#settings.token = randomBytes(24).toString("base64url");
    await this.#save(this.#settings);
    this.#changed();
    return this.state;
  }

  setTrust(trust: boolean): AgentsState {
    this.#trust = trust;
    if (trust) for (const id of [...this.#pending.keys()]) this.decide(id, "approve");
    this.#changed();
    return this.state;
  }

  decide(id: string, decision: "approve" | "reject" | "trust"): boolean {
    const p = this.#pending.get(id);
    if (!p) return false;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    if (decision === "trust") this.#trust = true;
    p.resolve(decision !== "reject");
    this.#changed();
    return true;
  }

  async #approve(request: ApprovalRequest): Promise<boolean> {
    if (this.#trust) return true;
    const id = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.decide(id, "reject"), APPROVAL_TIMEOUT_MS);
      this.#pending.set(id, { request: { id, at: Date.now(), tool: request.tool, summary: request.summary, input: JSON.stringify(request.input, null, 2).slice(0, 4000) }, resolve, timer });
      this.#changed();
    });
  }

  #record(entry: AuditEntry): void {
    this.#audit.unshift(entry);
    if (this.#audit.length > AUDIT_KEEP) this.#audit.length = AUDIT_KEEP;
    const dir = this.#services.workspace.state.dir;
    if (dir) void mkdir(join(dir, ".mockix"), { recursive: true }).then(() => appendFile(join(dir, ".mockix", "mcp-audit.jsonl"), `${JSON.stringify({ ...entry, via: "escritorio" })}\n`)).catch(() => undefined);
    this.#changed();
  }

  #authorized(req: IncomingMessage): boolean {
    const auth = req.headers.authorization ?? "";
    const given = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "");
    const want = Buffer.from(this.#settings.token);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, message: string) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp") return reply(404, "Not found: use /mcp");
    // DNS rebinding: only local pages (or no browser at all) may talk to this server.
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return reply(403, "Origin not allowed");
    if (!this.#authorized(req)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="mockix-mcp"');
      return reply(401, "Invalid or missing token");
    }
    const dir = this.#services.workspace.state.dir;
    if (!dir) return reply(503, "No workspace is open in Mockix");
    if (req.method !== "POST") return reply(405, "Stateless server: POST only");

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > MAX_BODY) return reply(413, "Request too large");
      chunks.push(c);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return reply(400, "Invalid JSON");
    }
    const server = createMcpServer(new DesktopBackend(dir, this.#services), {
      name: "mockix",
      version: this.#version,
      approve: (r) => this.#approve(r),
      audit: (e) => this.#record(e),
    });
    // Stateless (no session ids): every POST is a request of its own.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(req, res, body);
  }

  async #listen(): Promise<void> {
    if (this.#server) return;
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: err instanceof Error ? err.message : String(err) }, id: null }));
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.#settings.port, "127.0.0.1", () => resolve());
      });
    } catch (err) {
      // The remembered port is taken: take any free one.
      if (this.#settings.port !== 0) {
        this.#settings.port = 0;
        return this.#listen();
      }
      this.#error = err instanceof Error ? err.message : String(err);
      this.#changed();
      return;
    }
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
    this.#error = null;
    if (this.#settings.port !== this.#port) {
      this.#settings.port = this.#port;
      await this.#save(this.#settings);
    }
    this.#changed();
  }

  async #close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    for (const id of [...this.#pending.keys()]) this.decide(id, "reject");
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }

  async stop(): Promise<void> {
    await this.#close();
  }
}
