import { EventEmitter } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { Faker, base, en, es, es_MX } from "@faker-js/faker";
import { BucketStore } from "./buckets.js";
import { ChaosTracker, chaosAt, decide, timeIn, type ChaosDecision, type ChaosReport } from "./chaos.js";
import { Contract, ContractTracker, contractJUnit, type ContractReport, type Violation } from "./contract.js";
import { ScenarioEngine, type ScenarioEvent, type ScenarioView } from "./scenarios.js";
import { createRealtime, type MessageLogEntry } from "./realtime.js";
import { GrpcStartError, startGrpc, type GrpcController } from "./grpc.js";
import { compilePath, stripPrefix, type Params, type PathMatcher } from "./path.js";
import { seededRandom } from "./random.js";
import { testRules, type RequestContext } from "./rules.js";
import { parseMock, type MockConfig, type RuntimeCallback, type RuntimeResponse, type RuntimeRoute } from "./runtime.js";
import { TemplateEngine, TemplateError, type TemplateDeps } from "./template.js";
import type { Exchange } from "./import/exchanges.js";

export type RequestKind = "route" | "crud" | "proxy" | "preflight" | "none";

export interface CapturedMessage {
  headers: Record<string, string>;
  /** UTF-8 text of the body, cut at the capture limit. Empty for binary bodies. */
  body: string;
  truncated: boolean;
  binary: boolean;
}

/** One served request, as shown in the live log. */
export interface RequestLogEntry {
  /** Sequence number within this mock run, starting at 1. */
  seq: number;
  /** Epoch ms when the request arrived. */
  at: number;
  method: string;
  /** Path and query exactly as received. */
  url: string;
  status: number;
  durationMs: number;
  kind: RequestKind;
  /** Matched route and response, or null when none matched. */
  routeId: string | null;
  responseId: string | null;
  /** Simulated latency included in durationMs. */
  latencyMs: number;
  /** Credentials (Authorization, Cookie, API keys…) are replaced by "[redactado]". */
  request: CapturedMessage;
  response: CapturedMessage;
  /** Template or proxy failure behind a 500/502. */
  error: string | null;
  /** Where the time went, in order: the "strata" of the request. */
  timings: RequestTimings;
  /** What broke the OpenAPI contract (request and the mock's own response). Empty without a contract. */
  violations: Violation[];
  /** What the chaos profile did to this request, or null when none applies. */
  chaos: ChaosDecision | null;
}

export interface RequestTimings {
  /** Reading the request body. */
  receiveMs: number;
  /** Matching routes, rules and rendering templates (for the proxy: waiting for the real API). */
  processMs: number;
  /** Simulated latency (mock, route and response). */
  latencyMs: number;
  /** Chaos effects (M7). */
  chaosMs: number;
  /** Writing the response until the last byte left. */
  sendMs: number;
}

/** A webhook the mock sent after answering. */
export interface CallbackLogEntry {
  /** seq of the request that triggered it. */
  requestSeq: number;
  at: number;
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  error: string | null;
}

export type MockErrorCode = "PORT_IN_USE" | "ADDRESS_UNAVAILABLE" | "PERMISSION_DENIED" | "TLS_INVALID" | "START_FAILED";

export class MockStartError extends Error {
  readonly code: MockErrorCode;
  constructor(code: MockErrorCode, message: string) {
    super(message);
    this.name = "MockStartError";
    this.code = code;
  }
}

export type UpdateResult = { applied: true } | { applied: false; reason: "restart-required" };

type Events = { request: [RequestLogEntry]; callback: [CallbackLogEntry]; scenario: [ScenarioEvent]; message: [MessageLogEntry] };

export interface MockHandle extends EventEmitter<Events> {
  readonly name: string;
  readonly host: string;
  /** The port actually bound (resolved when the definition asked for 0). */
  readonly port: number;
  readonly url: string;
  readonly routeCount: number;
  /** Port of the gRPC server, or null when the mock has none. */
  readonly grpcPort: number | null;
  /** Open WebSocket and Socket.IO connections by route id. */
  connections(): Record<string, number>;
  /** Swaps routes and settings in place. Name, host, port and TLS need a restart. */
  update(definition: unknown): UpdateResult;
  /** Most recent requests, newest first (the control API serves the same list). */
  logs(limit?: number): RequestLogEntry[];
  /** Buckets back to their seed, counters and variables back to the files, scenarios back to their initial state. */
  reset(): void;
  /** Contract violations counted since start (or the last clear); null without a contract. */
  contract(): ContractReport | null;
  clearContract(): void;
  /** Scenario definitions with their live instances. */
  scenarios(): ScenarioView[];
  scenarioEvents(limit?: number): ScenarioEvent[];
  /** Forces an instance into a state. Throws for an unknown scenario or state. */
  setScenario(id: string, key: string, state: string): ScenarioEvent;
  resetScenarios(id?: string): void;
  /** The chaos timeline now, and what it did in the last minute. */
  chaos(): ChaosReport;
  /** Replaces the mock's profile until the next start (null: no chaos; undefined: back to mock.yaml). Throws for an unknown profile. */
  setChaos(profile: string | null | undefined): void;
  pauseChaos(paused: boolean): void;
  /** Back to t = 0. */
  restartChaos(): void;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Value of the Server header on every response. */
  serverHeader?: string;
  /** Same seed, same random choices and same fake data, request after request. */
  seed?: number;
  /** Source of randomness for the random mode and helpers; overrides `seed` for that purpose. */
  random?: () => number;
  /** Clock for templates (tests). */
  now?: () => number;
  /** Enables the control API under /__mockix/ for requests with `Authorization: Bearer <token>`. */
  adminToken?: string | null;
  /** Request bodies above this size get 413. Default 10 MB. */
  maxBodyBytes?: number;
  /** How much of each body the log keeps. Default 64 KB. */
  captureBytes?: number;
  /**
   * Called with every request the proxy forwarded, in full (headers and bodies
   * as they were, up to maxBodyBytes): what recording stores. Raw data: it may
   * contain credentials, so it belongs in .mockix/, never in the workspace.
   */
  onProxied?: (exchange: Exchange) => void;
}

interface CompiledRoute {
  route: RuntimeRoute;
  match: PathMatcher;
  /** CRUD routes also answer on <path>/:key. */
  item: PathMatcher | null;
}

const JSON_TYPE = "application/json; charset=utf-8";
const NO_ROUTE_HEADERS = { "Content-Type": JSON_TYPE, "X-Mockix": "no-route" };
const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS";
const ADMIN_PREFIX = "/__mockix";
const LOG_KEEP = 500;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key", "x-auth-token"]);
const TEXT_TYPE = /^(text\/|application\/(json|xml|x-www-form-urlencoded|javascript|problem\+json|yaml|graphql)|image\/svg)|\+json|\+xml/i;

const PROBLEM_TYPE = "application/problem+json; charset=utf-8";
/** A "timeout" request is held this long at most, then its connection is closed. */
const CHAOS_HOLD_MS = 120_000;

function buildContract(config: MockConfig): Contract | null {
  if (!config.contract) return null;
  try {
    return new Contract(config.contract.document);
  } catch {
    // The loader already reported it; a mock without a usable contract just serves.
    return null;
  }
}

const compile = (config: MockConfig): CompiledRoute[] =>
  config.routes.map((route) => ({
    route,
    match: compilePath(route.path),
    item: route.crud ? compilePath(`${route.path.replace(/\/$/, "")}/:__key`) : null,
  }));

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      try {
        out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      }
    }
  }
  return out;
}

function parseQuery(search: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(search.keys())) {
    const all = search.getAll(key);
    out[key] = all.length === 1 ? all[0]! : all;
  }
  return out;
}

function parseBody(raw: string, contentType: string | undefined): unknown {
  if (!raw) return undefined;
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (type === "application/x-www-form-urlencoded") return parseQuery(new URLSearchParams(raw));
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

function flatHeaders(headers: IncomingHttpHeaders | Record<string, string | number | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = SECRET_HEADERS.has(k.toLowerCase()) ? "[redactado]" : Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function capture(headers: Record<string, string>, body: Buffer | string | null, limit: number): CapturedMessage {
  const type = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  const buf = body === null ? Buffer.alloc(0) : typeof body === "string" ? Buffer.from(body) : body;
  const binary = buf.length > 0 && type !== "" && !TEXT_TYPE.test(type);
  return {
    headers,
    body: binary ? "" : buf.subarray(0, limit).toString("utf8"),
    truncated: !binary && buf.length > limit,
    binary,
  };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function hostAllowed(url: URL, allow: readonly string[]): boolean {
  return allow.some((a) => a === url.host || a === url.hostname);
}

/** Starts serving a mock. Validates the definition first; rejects with MockStartError when it cannot listen. */
export async function startMock(definition: unknown, options: StartOptions = {}): Promise<MockHandle> {
  let config = parseMock(definition);
  let routes = compile(config);
  const serverHeader = options.serverHeader ?? "Mockix";
  const random = options.random ?? (options.seed === undefined ? Math.random : seededRandom(options.seed));
  const maxBody = options.maxBodyBytes ?? 10 * 1024 * 1024;
  const captureLimit = options.captureBytes ?? 64 * 1024;
  const adminToken = options.adminToken ?? null;
  const events = new EventEmitter<Events>();
  const hits = new Map<string, number>();
  const sequence = new Map<string, number>();
  const recent: RequestLogEntry[] = [];
  let seq = 0;

  const now = options.now ?? Date.now;
  let checker = buildContract(config);
  const tracker = new ContractTracker();
  const machines = new ScenarioEngine(config.scenarios, now, (e) => events.emit("scenario", e));
  // Timed transitions reach listeners on time; reads catch up on their own anyway.
  let ticker: NodeJS.Timeout | null = null;
  const syncTicker = () => {
    if (machines.hasTimers && !ticker) {
      ticker = setInterval(() => machines.tick(), 1000);
      ticker.unref();
    } else if (!machines.hasTimers && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
  syncTicker();

  // Chaos draws from its own stream, so adding chaos never changes the fake data of a seeded run.
  const chaosRandom = options.seed === undefined ? Math.random : seededRandom(options.seed + 7919);
  const chaosTracker = new ChaosTracker();
  let chaosStart = now();
  let chaosPaused = false;
  let chaosOverride: string | null | undefined;
  const defaultProfile = () => (chaosOverride !== undefined ? chaosOverride : config.chaos.profile);
  const chaosActive = () => defaultProfile() !== null || config.routes.some((r) => typeof r.chaos === "string");
  const chaosFor = (route: RuntimeRoute | null): ChaosDecision | null => {
    if (chaosPaused) return null;
    const name = route && route.chaos !== undefined ? route.chaos : defaultProfile();
    const profile = name ? config.chaos.profiles[name] : undefined;
    return profile ? decide(profile, timeIn(profile, now() - chaosStart), chaosRandom) : null;
  };

  const faker = new Faker({ locale: [es_MX, es, en, base] });
  if (options.seed !== undefined) faker.seed(options.seed);
  const buckets = new BucketStore(config.buckets);
  const deps: TemplateDeps = {
    faker,
    random,
    now,
    buckets,
    vars: new Map(Object.entries(config.variables)),
    env: config.env,
  };
  const engine = new TemplateEngine(deps);

  function corsHeaders(req: IncomingMessage): Record<string, string> {
    if (!config.cors) return {};
    const origin = req.headers.origin;
    return origin
      ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Access-Control-Expose-Headers": "*", Vary: "Origin" }
      : { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "*" };
  }

  function pick(route: RuntimeRoute, ctx: RequestContext): RuntimeResponse | null {
    const list = route.responses;
    switch (route.mode) {
      case "random":
        return list[Math.min(list.length - 1, Math.floor(random() * list.length))]!;
      case "sequential": {
        const n = sequence.get(route.id) ?? 0;
        sequence.set(route.id, n + 1);
        return list[n % list.length]!;
      }
      default: {
        const hit = list.find((r) => r.rules && testRules(r.rules, ctx));
        if (hit) return hit;
        // Fallback: no rule matched, so the request moves on to the next route (or the proxy).
        return route.mode === "fallback" ? null : (list.find((r) => r.default) ?? list[0]!);
      }
    }
  }

  function sendCallbacks(callbacks: RuntimeCallback[], ctx: RequestContext, local: Map<string, unknown>, requestSeq: number): void {
    for (const cb of callbacks) {
      setTimeout(() => {
        void (async () => {
          const at = Date.now();
          const started = performance.now();
          let url = cb.url;
          const log = (patch: Partial<CallbackLogEntry>) =>
            events.emit("callback", { requestSeq, at, method: cb.method, url, status: null, durationMs: Math.round(performance.now() - started), error: null, ...patch });
          try {
            url = engine.render(cb.url, ctx, local);
            const target = new URL(url);
            if (!hostAllowed(target, config.callbackHosts)) {
              log({ error: `host no permitido: añade "${target.host}" a callbacks.allow en mock.yaml` });
              return;
            }
            const headers = Object.fromEntries(Object.entries(cb.headers).map(([k, v]) => [k, engine.render(v, ctx, local)]));
            const body = cb.body === null ? undefined : engine.render(cb.body, ctx, local);
            if (body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
              headers["Content-Type"] = body.trim().startsWith("{") || body.trim().startsWith("[") ? JSON_TYPE : "text/plain; charset=utf-8";
            }
            const init: RequestInit = { method: cb.method, headers, signal: AbortSignal.timeout(10_000), redirect: "manual" };
            if (body !== undefined && cb.method !== "GET") init.body = body;
            const res = await fetch(target, init);
            await res.arrayBuffer().catch(() => undefined);
            log({ status: res.status });
          } catch (err) {
            log({ error: err instanceof Error ? err.message : String(err) });
          }
        })();
      }, cb.delayMs);
    }
  }

  function crud(route: RuntimeRoute, method: string, key: string | undefined, ctx: RequestContext, fullPath: string): { status: number; headers: Record<string, string>; body: string } {
    const { bucket, key: field } = route.crud!;
    const list = (Array.isArray(buckets.get(bucket)) ? buckets.get(bucket) : []) as Array<Record<string, unknown>>;
    const json = (status: number, value: unknown, extra: Record<string, string> = {}) => ({ status, headers: { "Content-Type": JSON_TYPE, ...extra }, body: value === undefined ? "" : JSON.stringify(value) });
    const findIndex = (k: string) => list.findIndex((x) => x && typeof x === "object" && String(x[field]) === k);
    const body = ctx.body.parsed;
    const isObject = body !== null && typeof body === "object" && !Array.isArray(body);
    const allow = key === undefined ? "GET, HEAD, POST" : "GET, HEAD, PUT, PATCH, DELETE";

    if (key === undefined) {
      if (method === "GET" || method === "HEAD") {
        const { page, limit, sort, order, ...filters } = ctx.query;
        let items = list.filter((x) => Object.entries(filters).every(([k, v]) => String(x?.[k]) === String(Array.isArray(v) ? v[0] : v)));
        if (typeof sort === "string") {
          const dir = order === "desc" ? -1 : 1;
          items = [...items].sort((a, b) => (String(a?.[sort] ?? "") < String(b?.[sort] ?? "") ? -dir : String(a?.[sort] ?? "") > String(b?.[sort] ?? "") ? dir : 0));
          if (items.every((x) => typeof x?.[sort] === "number")) items.sort((a, b) => ((a[sort] as number) - (b[sort] as number)) * dir);
        }
        const total = items.length;
        if (typeof limit === "string" && /^\d+$/.test(limit)) {
          const size = Math.max(1, Number(limit));
          const p = typeof page === "string" && /^\d+$/.test(page) ? Math.max(1, Number(page)) : 1;
          items = items.slice((p - 1) * size, p * size);
        }
        const envelope = route.crud!.list;
        const value = envelope ? { [envelope.items]: items, ...(envelope.total ? { [envelope.total]: total } : {}) } : items;
        return json(200, value, { "X-Total-Count": String(total) });
      }
      if (method === "POST") {
        if (!isObject) return json(400, { error: "El cuerpo debe ser un objeto JSON" });
        const item: Record<string, unknown> = { ...(body as Record<string, unknown>) };
        if (item[field] === undefined || item[field] === null || item[field] === "") item[field] = faker.string.uuid();
        if (findIndex(String(item[field])) !== -1) return json(409, { error: "Ya existe", [field]: item[field] });
        buckets.set(bucket, [...list, item]);
        return json(201, item, { Location: `${fullPath.replace(/\/$/, "")}/${encodeURIComponent(String(item[field]))}` });
      }
      return json(405, { error: "Método no permitido" }, { Allow: allow });
    }

    const index = findIndex(key);
    if (method === "GET" || method === "HEAD") return index === -1 ? json(404, { error: "No existe", [field]: key }) : json(200, list[index]);
    if (method === "DELETE") {
      if (index === -1) return json(404, { error: "No existe", [field]: key });
      buckets.set(bucket, list.filter((_, i) => i !== index));
      return { status: 204, headers: {}, body: "" };
    }
    if (method === "PUT" || method === "PATCH") {
      if (index === -1) return json(404, { error: "No existe", [field]: key });
      if (!isObject) return json(400, { error: "El cuerpo debe ser un objeto JSON" });
      const current = list[index]!;
      const next = method === "PUT" ? { ...(body as Record<string, unknown>), [field]: current[field] } : { ...current, ...(body as Record<string, unknown>), [field]: current[field] };
      buckets.set(bucket, list.map((x, i) => (i === index ? next : x)));
      return json(200, next);
    }
    return json(405, { error: "Método no permitido" }, { Allow: allow });
  }

  /** Streams the request to the real API and its answer back. `done` runs before the response ends, so the log entry sees it. */
  async function proxy(
    req: IncomingMessage,
    res: ServerResponse,
    raw: Buffer,
    targetPath: string,
    cors: Record<string, string>,
    done: (captured: CapturedMessage, error: string | null) => void,
    onHeaders: () => void = () => {},
  ): Promise<void> {
    const p = config.proxy!;
    const target = new URL(p.target + targetPath);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    Object.assign(headers, p.headers);
    if (raw.length) headers["content-length"] = String(raw.length);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<void>((resolve) => {
      const upstream = send(target, { method: req.method, headers, rejectUnauthorized: !p.insecure, timeout: 30_000 }, (up) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
        for (const [k, v] of Object.entries(cors)) if (!Object.keys(outHeaders).some((h) => h.toLowerCase() === k.toLowerCase())) outHeaders[k] = v;
        onHeaders();
        res.writeHead(up.statusCode ?? 502, outHeaders);
        const keep = options.onProxied ? maxBody : captureLimit;
        const chunks: Buffer[] = [];
        let size = 0;
        up.on("data", (c: Buffer) => {
          if (size < keep) chunks.push(c);
          size += c.length;
          res.write(c);
        });
        up.on("end", () => {
          const all = Buffer.concat(chunks);
          const cap = capture(flatHeaders(up.headers), all, captureLimit);
          done({ ...cap, truncated: cap.truncated || (!cap.binary && size > captureLimit) }, null);
          res.end();
          if (options.onProxied && size <= maxBody) {
            const type = String(up.headers["content-type"] ?? "");
            const binary = all.length > 0 && type !== "" && !TEXT_TYPE.test(type);
            const plain = (h: IncomingHttpHeaders) => Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]));
            options.onProxied({
              method: req.method ?? "GET",
              url: req.url ?? "/",
              requestHeaders: plain(req.headers),
              requestBody: raw.toString("utf8"),
              status: up.statusCode ?? 502,
              responseHeaders: plain(up.headers),
              responseBody: binary ? "" : all.toString("utf8"),
              binary,
              responseBytes: binary ? new Uint8Array(all.buffer, all.byteOffset, all.byteLength) : undefined,
              at: Date.now(),
            });
          }
          resolve();
        });
        up.on("error", (err) => {
          done(capture({}, null, captureLimit), err.message);
          res.destroy(err);
          resolve();
        });
      });
      upstream.on("timeout", () => upstream.destroy(new Error("La API real no respondió en 30 s")));
      upstream.on("error", (err) => {
        const body = JSON.stringify({ error: "Proxy error", target: target.origin, detail: err.message });
        done(capture({ "content-type": JSON_TYPE }, body, captureLimit), err.message);
        if (!res.headersSent) res.writeHead(502, { ...NO_ROUTE_HEADERS, "X-Mockix": "proxy-error", ...cors });
        res.end(body);
        resolve();
      });
      upstream.end(raw);
    });
  }

  function admin(req: IncomingMessage, res: ServerResponse, path: string, raw: Buffer): void {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store" });
      res.end(value === undefined ? "" : JSON.stringify(value));
    };
    const method = req.method ?? "GET";
    if (path === "/health" && method === "GET") return json(200, { status: "ok", mock: config.name, routes: config.routes.length });
    // Without a token the control API does not exist.
    if (!adminToken) return json(404, { error: "No route in this mock", method, path: ADMIN_PREFIX + path });
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), adminToken)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="mockix"');
      return json(401, { error: "Token de control no válido" });
    }
    let body: unknown;
    try {
      body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
    } catch {
      return json(400, { error: "El cuerpo debe ser JSON" });
    }
    const bucket = /^\/buckets\/([a-z0-9][a-z0-9-]{0,63})(\/reset)?$/.exec(path);
    const scenario = /^\/scenarios\/([a-z0-9][a-z0-9-]{0,63})(?:\/(reset)|\/instances\/([^/]+))$/.exec(path);
    const variable = /^\/vars\/([A-Za-z_][A-Za-z0-9_.-]*)$/.exec(path);

    if (path === "/logs" && method === "GET") {
      const limit = Number(new URL(req.url ?? "", "http://x").searchParams.get("limit") ?? 100);
      return json(200, recent.slice(0, Math.max(1, Math.min(LOG_KEEP, limit || 100))));
    }
    if (path === "/logs" && method === "DELETE") {
      recent.length = 0;
      return json(204, undefined);
    }
    if (path === "/buckets" && method === "GET") return json(200, buckets.names());
    if (bucket && !bucket[2] && method === "GET") return buckets.has(bucket[1]!) ? json(200, buckets.get(bucket[1]!)) : json(404, { error: "No existe el bucket" });
    if (bucket && !bucket[2] && method === "PUT") {
      buckets.set(bucket[1]!, body ?? null);
      return json(200, buckets.get(bucket[1]!));
    }
    if (bucket && bucket[2] && method === "POST") {
      buckets.reset(bucket[1]!);
      return json(200, buckets.get(bucket[1]!) ?? null);
    }
    if (path === "/vars" && method === "GET") return json(200, Object.fromEntries(deps.vars));
    if (variable && method === "PUT") {
      const value = body !== null && typeof body === "object" && "value" in body ? (body as { value: unknown }).value : body;
      deps.vars.set(variable[1]!, String(value ?? ""));
      return json(200, { [variable[1]!]: deps.vars.get(variable[1]!) });
    }
    if (path === "/reset" && method === "POST") {
      handle.reset();
      return json(200, { reset: true });
    }
    if (path === "/contract" && method === "GET") {
      const report = handle.contract();
      if (!report || !checker) return json(404, { error: "Este mock no tiene contrato" });
      if (new URL(req.url ?? "", "http://x").searchParams.get("format") === "junit") {
        res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" });
        res.end(contractJUnit([{ report, operations: checker.operations }]));
        return;
      }
      return json(200, report);
    }
    if (path === "/contract" && method === "DELETE") {
      tracker.clear();
      return json(204, undefined);
    }
    if (path === "/chaos" && method === "GET") return json(200, handle.chaos());
    if (path === "/chaos" && method === "PUT") {
      const profile = body !== null && typeof body === "object" && "profile" in body ? (body as { profile: unknown }).profile : body;
      try {
        handle.setChaos(profile === undefined || profile === "" ? undefined : profile === null ? null : String(profile));
      } catch (err) {
        return json(400, { error: err instanceof Error ? err.message : String(err) });
      }
      return json(200, handle.chaos());
    }
    if ((path === "/chaos/pause" || path === "/chaos/resume") && method === "POST") {
      handle.pauseChaos(path === "/chaos/pause");
      return json(200, handle.chaos());
    }
    if (path === "/chaos/restart" && method === "POST") {
      handle.restartChaos();
      return json(200, handle.chaos());
    }
    if (path === "/scenarios" && method === "GET") return json(200, machines.snapshot());
    if (path === "/scenarios/events" && method === "GET") return json(200, machines.recent());
    if (path === "/scenarios/reset" && method === "POST") {
      machines.reset();
      return json(200, { reset: true });
    }
    if (scenario && scenario[2] && method === "POST") {
      machines.reset(scenario[1]!);
      return json(200, { reset: scenario[1] });
    }
    if (scenario && scenario[3] && method === "PUT") {
      const state = body !== null && typeof body === "object" && "state" in body ? String((body as { state: unknown }).state) : typeof body === "string" ? body : "";
      try {
        return json(200, machines.set(scenario[1]!, decodeURIComponent(scenario[3]), state));
      } catch (err) {
        return json(400, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    return json(404, { error: "No existe ese recurso de control", method, path: ADMIN_PREFIX + path });
  }

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const at = Date.now();
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const parsedUrl = new URL(url, "http://mock");
    res.setHeader("Server", serverHeader);

    const raw = await readBody(req, maxBody);
    const received = performance.now();
    let processed: number | null = null;
    let slept = 0;
    let writing: number | null = null;
    if (parsedUrl.pathname === ADMIN_PREFIX || parsedUrl.pathname.startsWith(`${ADMIN_PREFIX}/`)) {
      admin(req, res, parsedUrl.pathname.slice(ADMIN_PREFIX.length) || "/", raw ?? Buffer.alloc(0));
      return;
    }

    const cors = corsHeaders(req);
    const requestCapture = capture(flatHeaders(req.headers), raw, captureLimit);
    let kind: RequestKind = "none";
    let routeId: string | null = null;
    let responseId: string | null = null;
    let latencyMs = 0;
    let responseCapture: CapturedMessage = capture({}, null, captureLimit);
    let error: string | null = null;
    let after: (() => void) | null = null;
    let checking = false;
    let operation: string | null = null;
    let violations: Violation[] = [];
    let transitions: ScenarioEvent[] = [];
    let chaosDecision: ChaosDecision | null = null;
    let chaosSlept = 0;
    let trickling = false;
    let finalized = false;
    const closed = new AbortController();
    res.once("close", () => closed.abort());
    /** One log entry per request: on finish, or on close for the connections chaos cut or held. */
    const finalize = (status: number) => {
      if (finalized) return;
      finalized = true;
      const done = performance.now();
      const round = (n: number) => Math.max(0, Math.round(n * 10) / 10);
      const sendFrom = writing ?? done;
      const timings: RequestTimings = {
        receiveMs: round(received - started),
        processMs: round((processed ?? sendFrom) - received),
        latencyMs: round(slept),
        chaosMs: round(chaosSlept + (trickling ? done - sendFrom : 0)),
        sendMs: trickling ? 0 : round(done - sendFrom),
      };
      const entry: RequestLogEntry = {
        seq: ++seq,
        at,
        method,
        url,
        status,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
        kind,
        routeId,
        responseId,
        latencyMs,
        request: requestCapture,
        response: responseCapture,
        error,
        timings,
        violations,
        chaos: chaosDecision,
      };
      recent.unshift(entry);
      if (recent.length > LOG_KEEP) recent.length = LOG_KEEP;
      if (checking) tracker.record(entry, violations);
      if (chaosDecision || chaosActive()) chaosTracker.record({ seq: entry.seq, at, method, url, path: parsedUrl.pathname, routeId, decision: chaosDecision });
      events.emit("request", entry);
      for (const t of transitions) {
        if (t.trigger.kind !== "request") continue;
        t.trigger.seq = entry.seq;
        t.trigger.status = entry.status;
      }
      machines.announce(transitions);
      after?.();
    };
    res.once("finish", () => finalize(res.statusCode));

    /**
     * Decides the chaos for this request. A cut or held connection ends the
     * request here (true); otherwise the extra latency is waited and an
     * injected error, if any, is left in chaosDecision for the caller.
     */
    const chaosGate = async (route: RuntimeRoute | null): Promise<boolean> => {
      chaosDecision = chaosFor(route);
      if (!chaosDecision) return false;
      if (chaosDecision.drop || chaosDecision.timeout) {
        processed ??= performance.now();
        error = chaosDecision.drop ? "caos: conexión cortada sin respuesta" : "caos: sin respuesta";
        res.once("close", () => finalize(0));
        if (chaosDecision.drop) req.socket.destroy();
        else {
          const hold = setTimeout(() => req.socket.destroy(), CHAOS_HOLD_MS);
          res.once("close", () => clearTimeout(hold));
        }
        return true;
      }
      if (chaosDecision.latencyMs > 0) {
        processed ??= performance.now();
        const t = performance.now();
        await sleep(chaosDecision.latencyMs, closed.signal);
        chaosSlept = performance.now() - t;
      }
      return closed.signal.aborted;
    };
    const chaosError = (): boolean => {
      if (chaosDecision?.error == null) return false;
      write(chaosDecision.error, { "Content-Type": JSON_TYPE, "X-Mockix": "chaos" }, JSON.stringify({ error: "Error simulado por el perfil de caos", status: chaosDecision.error, profile: chaosDecision.profile }));
      return true;
    };

    /** Simulated latency, measured (the client may hang up early). */
    const wait = async (ms: number) => {
      processed ??= performance.now();
      const t = performance.now();
      await sleep(ms, closed.signal);
      slept = performance.now() - t;
    };

    const write = (status: number, headers: Record<string, string>, body: string | Uint8Array | null) => {
      processed ??= performance.now();
      writing = performance.now();
      const all = { ...cors, ...headers };
      const injected = chaosDecision?.error != null && status === chaosDecision.error;
      if (checking && operation && config.contract?.responses && checker && (kind === "route" || kind === "crud") && !injected) {
        violations.push(...checker.checkResponse(operation, status, all, body instanceof Uint8Array ? null : body));
      }
      res.writeHead(status, all);
      responseCapture = capture(flatHeaders(all), body === null ? null : typeof body === "string" ? body : Buffer.from(body), captureLimit);
      const payload = method === "HEAD" || body === null ? null : typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
      const speed = chaosDecision?.trickleKBps ?? null;
      if (!payload || !speed || payload.length === 0) {
        res.end(payload ?? undefined);
        return;
      }
      // Slow body: a slice every 100 ms at the profile's speed.
      trickling = true;
      const step = Math.max(1, Math.round((speed * 1024) / 10));
      let offset = 0;
      const tick = setInterval(() => {
        if (closed.signal.aborted) return clearInterval(tick);
        const next = payload.subarray(offset, offset + step);
        offset += next.length;
        if (offset >= payload.length) {
          clearInterval(tick);
          res.end(next);
        } else res.write(next);
      }, 100);
    };

    if (raw === null) {
      res.setHeader("Connection", "close");
      write(413, { "Content-Type": JSON_TYPE }, JSON.stringify({ error: "Request body too large", limitBytes: maxBody }));
      return;
    }

    const text = raw.toString("utf8");
    const local = stripPrefix(config.prefix, parsedUrl.pathname);
    const base = {
      method,
      path: local ?? parsedUrl.pathname,
      query: parseQuery(parsedUrl.searchParams),
      headers: req.headers,
      cookies: parseCookies(req.headers.cookie),
      body: { raw: text, parsed: parseBody(text, req.headers["content-type"]) },
    };

    const preflight = method === "OPTIONS" && config.cors && Boolean(req.headers["access-control-request-method"]);
    if (checker && config.contract && config.contract.mode !== "off" && local !== null && !preflight) {
      checking = true;
      const checked = checker.checkRequest({ ...base, path: local });
      operation = checked.operation;
      violations = checked.violations;
      if (violations.length && config.contract.mode === "strict") {
        write(
          400,
          { "Content-Type": PROBLEM_TYPE, "X-Mockix": "contract-violation" },
          JSON.stringify({
            type: "about:blank",
            title: "La petición no cumple el contrato",
            status: 400,
            detail: violations[0]!.message,
            operation: operation ?? `${method} ${local}`,
            contract: config.contract.file,
            violations: violations.map((v) => ({ where: v.where, message: v.message })),
          }),
        );
        return;
      }
    }
    if (local !== null && machines.size) transitions = machines.onRequest(base, url);

    if (local !== null) {
      for (const { route, match, item } of routes) {
        if (route.crud) {
          let params: Params | null = match(local);
          let key: string | undefined;
          if (!params && item) {
            params = item(local);
            key = params?.["__key"];
          }
          if (!params) continue;
          kind = "crud";
          routeId = route.id;
          latencyMs = config.latencyMs + route.latencyMs;
          if (await chaosGate(route)) return;
          await wait(latencyMs);
          if (closed.signal.aborted || chaosError()) return;
          const crudCtx: RequestContext = { ...base, params, requestNumber: 0 };
          crudCtx.state = machines.view(crudCtx);
          const r = crud(route, method, key, crudCtx, parsedUrl.pathname);
          write(r.status, r.headers, r.body || null);
          return;
        }

        const methodOk = route.method === "ANY" || route.method === method || (method === "HEAD" && route.method === "GET");
        if (!methodOk) continue;
        const params = match(local);
        if (!params) continue;
        const number = (hits.get(route.id) ?? 0) + 1;
        hits.set(route.id, number);
        const ctx: RequestContext = { ...base, params, requestNumber: number };
        ctx.state = machines.view(ctx);
        const response = pick(route, ctx);
        if (!response) continue;

        kind = "route";
        routeId = route.id;
        responseId = response.id;
        latencyMs = config.latencyMs + route.latencyMs + response.latencyMs;
        const vars = new Map<string, unknown>();
        let headers = response.headers;
        let body: string | Uint8Array | null = response.body ? (response.body.kind === "text" ? response.body.text : response.body.data) : null;
        if (response.template) {
          try {
            if (typeof body === "string") body = engine.render(body, ctx, vars);
            headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, engine.render(v, ctx, vars)]));
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            write(500, { "Content-Type": JSON_TYPE, "X-Mockix": "template-error" }, JSON.stringify({ error: "Template error", route: route.id, response: response.id, detail: error }));
            return;
          }
        }
        if (await chaosGate(route)) return;
        await wait(latencyMs);
        if (closed.signal.aborted || chaosError()) return;
        if (response.callbacks.length) after = () => sendCallbacks(response.callbacks, ctx, vars, seq);
        write(response.status, headers, body);
        return;
      }
    }

    if (preflight) {
      kind = "preflight";
      write(204, {
        "Access-Control-Allow-Methods": CORS_METHODS,
        "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] ?? "*",
        "Access-Control-Max-Age": "600",
      }, null);
      return;
    }

    if (config.proxy) {
      kind = "proxy";
      latencyMs = config.latencyMs;
      if (await chaosGate(null)) return;
      await wait(latencyMs);
      if (closed.signal.aborted || chaosError()) return;
      // A proxied answer streams as it comes: no slow body.
      const decided = chaosDecision as ChaosDecision | null;
      if (decided) decided.trickleKBps = null;
      processed = null;
      const path = (config.proxy.keepPrefix || local === null ? parsedUrl.pathname : local) + parsedUrl.search;
      await proxy(
        req,
        res,
        raw,
        path,
        cors,
        (captured, err) => {
          processed ??= performance.now();
          responseCapture = captured;
          error = err;
        },
        () => {
          processed = performance.now();
          writing = processed;
        },
      );
      return;
    }

    if (await chaosGate(null)) return;
    if (chaosError()) return;
    write(404, NO_ROUTE_HEADERS, JSON.stringify({ error: "No route in this mock", method, path: parsedUrl.pathname }));
  }

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    serve(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": JSON_TYPE });
      res.end(JSON.stringify({ error: "Mock failed", detail: err instanceof TemplateError || err instanceof Error ? err.message : String(err) }));
    });
  };

  let server: Server;
  try {
    server = config.tls ? createHttpsServer({ cert: config.tls.cert, key: config.tls.key }, listener) : createHttpServer(listener);
  } catch (err) {
    throw new MockStartError("TLS_INVALID", `The TLS certificate or key is not valid: ${err instanceof Error ? err.message : String(err)}`);
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => reject(toStartError(err, config));
    server.once("error", onError);
    server.listen(config.port, config.host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const realtime = createRealtime(server, {
    config: () => config,
    engine,
    state: (ctx) => machines.view(ctx),
    log: (e) => events.emit("message", e),
    captureBytes: captureLimit,
  });
  const grpcDeps = { engine, faker, state: (ctx: RequestContext) => machines.view(ctx), log: (e: MessageLogEntry) => events.emit("message", e), captureBytes: captureLimit };
  let grpcServer: GrpcController | null = null;
  if (config.grpc) {
    try {
      grpcServer = await startGrpc(config.grpc, config.host, config.tls, grpcDeps);
    } catch (err) {
      await realtime.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      throw new MockStartError(err instanceof GrpcStartError ? err.code : "START_FAILED", err instanceof Error ? err.message : String(err));
    }
  }
  let grpcReload: Promise<void> = Promise.resolve();
  const grpcShape = (c: MockConfig) => (c.grpc ? `${c.grpc.port}|${c.grpc.tls}` : "none");

  const { port } = server.address() as AddressInfo;
  const urlHost = config.host.includes(":") ? `[${config.host}]` : config.host;
  const scheme = config.tls ? "https" : "http";
  let stopping: Promise<void> | null = null;

  const handle = Object.assign(events, {
    name: config.name,
    host: config.host,
    port,
    url: `${scheme}://${urlHost}:${port}`,
    get routeCount() {
      return config.routes.length;
    },
    get grpcPort() {
      return grpcServer?.port ?? null;
    },
    connections() {
      return realtime.connections();
    },
    update(next: unknown): UpdateResult {
      const parsed = parseMock(next);
      const sameTls = JSON.stringify(parsed.tls) === JSON.stringify(config.tls);
      const samePort = parsed.port === config.port || parsed.port === port;
      if (parsed.name !== config.name || parsed.host !== config.host || !samePort || !sameTls || grpcShape(parsed) !== grpcShape(config)) {
        return { applied: false, reason: "restart-required" };
      }
      const grpcChanged = JSON.stringify(parsed.grpc) !== JSON.stringify(config.grpc);
      const varsChanged = JSON.stringify(parsed.variables) !== JSON.stringify(config.variables);
      const contractChanged = parsed.contract?.file !== config.contract?.file || JSON.stringify(parsed.contract?.document) !== JSON.stringify(config.contract?.document);
      config = { ...parsed, port: config.port };
      if (contractChanged) {
        checker = buildContract(config);
        tracker.clear();
      }
      machines.update(config.scenarios);
      syncTicker();
      realtime.update();
      if (grpcChanged && config.grpc) {
        // New services or answers: the gRPC server starts again on the same port.
        const next = { ...config.grpc, port: grpcServer?.port ?? config.grpc.port };
        grpcReload = grpcReload.then(async () => {
          await grpcServer?.stop();
          grpcServer = await startGrpc(next, config.host, config.tls, grpcDeps).catch(() => null);
        });
      }
      if (typeof chaosOverride === "string" && !config.chaos.profiles[chaosOverride]) chaosOverride = undefined;
      routes = compile(config);
      buckets.reseed(config.buckets);
      deps.env = config.env;
      if (varsChanged) {
        deps.vars.clear();
        for (const [k, v] of Object.entries(config.variables)) deps.vars.set(k, v);
      }
      // Counters survive for routes that still exist.
      const ids = new Set(config.routes.map((r) => r.id));
      for (const map of [hits, sequence]) for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
      return { applied: true };
    },
    logs(limit = 100): RequestLogEntry[] {
      return recent.slice(0, limit);
    },
    reset(): void {
      buckets.reset();
      hits.clear();
      sequence.clear();
      machines.reset();
      chaosStart = now();
      chaosTracker.clear();
      deps.vars.clear();
      for (const [k, v] of Object.entries(config.variables)) deps.vars.set(k, v);
    },
    contract(): ContractReport | null {
      if (!checker || !config.contract) return null;
      return tracker.report({ mock: config.name, file: config.contract.file, mode: config.contract.mode, operations: checker.operations.length });
    },
    clearContract(): void {
      tracker.clear();
    },
    scenarios(): ScenarioView[] {
      return machines.snapshot();
    },
    scenarioEvents(limit?: number): ScenarioEvent[] {
      return machines.recent(limit);
    },
    setScenario(id: string, key: string, state: string): ScenarioEvent {
      return machines.set(id, key, state);
    },
    resetScenarios(id?: string): void {
      machines.reset(id);
    },
    chaos(): ChaosReport {
      const name = defaultProfile();
      const profile = name ? config.chaos.profiles[name] : undefined;
      const tMs = profile ? Math.round(timeIn(profile, now() - chaosStart)) : 0;
      return {
        profile: name,
        override: chaosOverride,
        paused: chaosPaused,
        tMs,
        cycleMs: profile?.cycleMs ?? 0,
        level: profile ? chaosAt(profile, tMs) : null,
        ...chaosTracker.stats(now()),
      };
    },
    setChaos(profile: string | null | undefined): void {
      if (typeof profile === "string" && !config.chaos.profiles[profile]) throw new Error(`No existe el perfil de caos "${profile}"`);
      chaosOverride = profile;
      chaosStart = now();
    },
    pauseChaos(paused: boolean): void {
      chaosPaused = paused;
    },
    restartChaos(): void {
      chaosStart = now();
      chaosTracker.clear();
    },
    stop(): Promise<void> {
      if (ticker) clearInterval(ticker);
      ticker = null;
      stopping ??= Promise.all([realtime.stop(), grpcReload.then(() => grpcServer?.stop())]).then(() => new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Keep-alive sockets would otherwise hold the port open.
        server.closeAllConnections();
      }));
      return stopping;
    },
  }) as MockHandle;
  return handle;
}

function toStartError(err: NodeJS.ErrnoException, config: MockConfig): MockStartError {
  const where = `${config.host}:${config.port}`;
  switch (err.code) {
    case "EADDRINUSE":
      return new MockStartError("PORT_IN_USE", `Port ${config.port} is already in use (${where})`);
    case "EADDRNOTAVAIL":
      return new MockStartError("ADDRESS_UNAVAILABLE", `Address ${config.host} is not available on this machine`);
    case "EACCES":
      return new MockStartError("PERMISSION_DENIED", `Not allowed to listen on ${where}`);
    default:
      return new MockStartError("START_FAILED", err.message);
  }
}
