/**
 * Reads a workspace folder into runtime mock configs, collecting every problem
 * with its file and line instead of stopping at the first one.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { LineCounter, parseDocument, isNode, type Document } from "yaml";
import { z } from "zod";
import { Contract } from "./contract.js";
import {
  CHAOS_DIR,
  MOCK_FILE,
  WORKSPACE_FILE,
  chaosFile,
  grpcFile,
  mockFile,
  realtimeFile,
  routeFile,
  scenarioFile,
  workspaceFile,
  type MockFile,
  type RealtimeFile,
  type RuleOp,
  type RouteFile,
  type WorkspaceFile,
} from "./format.js";
import { loadProto, type LoadedProto } from "./protos.js";
import type {
  MockConfig,
  RuntimeBody,
  RuntimeCallback,
  RuntimeChaosProfile,
  RuntimeContract,
  RuntimeGrpc,
  RuntimeGrpcResponse,
  RuntimeRealtime,
  RuntimeResponse,
  RuntimeRoute,
  RuntimeScenario,
} from "./runtime.js";
import { checkTemplate } from "./template.js";
import { ensureSelfSigned, type TlsPair } from "./tls.js";
import type { RedactionRule } from "./import/exchanges.js";

z.config(z.locales.es());

export interface Problem {
  /** Path relative to the workspace, with forward slashes. */
  file: string;
  line: number | null;
  message: string;
}

export interface LoadedMock {
  name: string;
  /** Absolute path of the mock folder. */
  dir: string;
  /** Null when the mock has problems: it must not be served. */
  config: MockConfig | null;
  problems: Problem[];
}

export interface WorkspaceLoad {
  dir: string;
  mocks: LoadedMock[];
  /** Chaos profiles of chaos/*.yaml, by name. */
  chaos: Record<string, RuntimeChaosProfile>;
  /** Problems that are not about a single mock (missing workspace file, unknown mock names…). */
  problems: Problem[];
  /** The workspace's redaction profile for recordings, or null for the default one. */
  redaction: RedactionRule[] | null;
}

export interface LoadOptions {
  /** Provides the certificate for `tls: true`. Default: a per-workspace self-signed one in .mockix/tls. */
  generatedTls?: (workspaceDir: string) => Promise<TlsPair>;
  /** Where allow-listed environment variables come from. Default: process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** What every mock inherits from the workspace. */
interface Shared {
  variables: Record<string, string>;
  env: Record<string, string>;
  chaos: Record<string, RuntimeChaosProfile>;
}

export function hasProblems(load: WorkspaceLoad): boolean {
  return load.problems.length > 0 || load.mocks.some((m) => m.problems.length > 0);
}

export function allProblems(load: WorkspaceLoad): Problem[] {
  return [...load.problems, ...load.mocks.flatMap((m) => m.problems)];
}

const toPosix = (p: string) => p.split(sep).join("/");

const TEXT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".yml": "application/yaml; charset=utf-8",
};
const BINARY_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".woff2": "font/woff2",
};

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  if (!t || !"{[".includes(t[0]!)) return false;
  // A JSON template: unquoted helpers ({{len …}}) make it invalid JSON until rendered.
  if (t.includes("{{") && "}]".includes(t.at(-1)!)) return true;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; problems: Problem[] };

/** Line (1-based) of the YAML node at `path`, or of the closest parent that exists. */
function lineOf(doc: Document, counter: LineCounter, path: ReadonlyArray<PropertyKey>): number | null {
  for (let n = path.length; n >= 0; n--) {
    const node = n === 0 ? doc.contents : doc.getIn(path.slice(0, n) as Array<string | number>, true);
    if (isNode(node) && node.range) return counter.linePos(node.range[0]).line;
  }
  return null;
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join("");
}

async function parseYaml<S extends z.ZodType>(abs: string, rel: string, schema: S): Promise<Parsed<z.output<S>>> {
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch {
    return { ok: false, problems: [{ file: rel, line: null, message: "no se puede leer el archivo" }] };
  }
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      problems: doc.errors.map((e) => ({ file: rel, line: counter.linePos(e.pos[0]).line, message: `YAML no válido: ${e.message.split("\n", 1)[0]}` })),
    };
  }
  const result = schema.safeParse(doc.toJS());
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    problems: result.error.issues.map((issue) => ({
      file: rel,
      line: lineOf(doc, counter, issue.path),
      message: issue.path.length ? `${formatPath(issue.path)}: ${issue.message}` : issue.message,
    })),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listYaml(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".yaml")) out.push(p);
    }
  }
  await walk(dir);
  return out.sort((a, b) => toPosix(a).localeCompare(toPosix(b)));
}

/** Resolves a body file: relative to the route file, or to the mock folder when it starts with "/". Never outside the mock folder. */
async function readBodyFile(mockDir: string, routeAbs: string, ref: string): Promise<{ ok: true; body: RuntimeBody; type: string | null } | { ok: false; message: string }> {
  if (isAbsolute(ref) && !ref.startsWith("/")) return { ok: false, message: `${ref}: usa una ruta relativa` };
  const target = ref.startsWith("/") ? resolve(mockDir, `.${ref}`) : resolve(routeAbs, "..", ref);
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(target), realpath(mockDir)]);
  } catch {
    return { ok: false, message: `no existe el archivo ${ref}` };
  }
  if (!real.startsWith(realRoot + sep)) return { ok: false, message: `${ref} está fuera de la carpeta del mock` };
  const ext = extname(real).toLowerCase();
  const data = await readFile(real);
  const rel = toPosix(relative(realRoot, real));
  const textType = TEXT_TYPES[ext];
  if (textType) return { ok: true, body: { kind: "text", text: data.toString("utf8") }, type: textType };
  return {
    ok: true,
    body: { kind: "bytes", data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), path: rel },
    type: BINARY_TYPES[ext] ?? "application/octet-stream",
  };
}

/** Message of the first template problem, or null. */
function templateProblem(source: string): string | null {
  try {
    checkTemplate(source);
    return null;
  } catch (err) {
    return `plantilla: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** mocks/<name>/data/*.json → bucket seeds (file name without .json). */
async function readBuckets(mockDir: string, ws: (abs: string) => string): Promise<{ buckets: Record<string, unknown>; problems: Problem[] }> {
  const dir = join(mockDir, "data");
  const buckets: Record<string, unknown> = {};
  const problems: Problem[] = [];
  let entries: string[] = [];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { buckets, problems };
  }
  for (const file of entries) {
    const abs = join(dir, file);
    const name = file.slice(0, -5);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      problems.push({ file: ws(abs), line: null, message: "el nombre del bucket solo puede tener minúsculas, números y guiones" });
      continue;
    }
    const text = await readFile(abs, "utf8");
    try {
      buckets[name] = JSON.parse(text);
    } catch (err) {
      const pos = /position (\d+)/.exec(err instanceof Error ? err.message : "")?.[1];
      const line = pos === undefined ? null : text.slice(0, Number(pos)).split("\n").length;
      problems.push({ file: ws(abs), line, message: "JSON no válido" });
    }
  }
  return { buckets, problems };
}

function headerKey(headers: Record<string, string>, name: string): string | undefined {
  return Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
}

async function buildRoute(
  mockDir: string,
  routeAbs: string,
  relFile: string,
  wsRel: string,
  parsed: RouteFile,
  routesDir: string,
  buckets: Record<string, unknown>,
): Promise<{ route: RuntimeRoute | null; problems: Problem[] }> {
  const problems: Problem[] = [];
  const at = (message: string): Problem => ({ file: wsRel, line: null, message });
  const id = parsed.id ?? toPosix(relative(routesDir, routeAbs)).replace(/\.yaml$/, "").toLowerCase();

  if (parsed.crud) {
    const data = buckets[parsed.crud.bucket];
    if (data === undefined) problems.push(at(`crud.bucket: no existe data/${parsed.crud.bucket}.json en el mock`));
    else if (!Array.isArray(data)) problems.push(at(`crud.bucket: data/${parsed.crud.bucket}.json debe ser una lista para una ruta CRUD`));
    if (problems.length) return { route: null, problems };
    return {
      route: { id, file: relFile, method: "ANY", path: parsed.path, mode: "rules", latencyMs: parsed.latency ?? 0, crud: { bucket: parsed.crud.bucket, key: parsed.crud.key ?? "id", ...(parsed.crud.list ? { list: parsed.crud.list } : {}) }, responses: [] },
      problems,
    };
  }

  const ids = new Set<string>();
  const list = parsed.responses ?? [];
  const defaults = list.filter((r) => r.default).length;
  if (defaults > 1) problems.push(at("solo una respuesta puede ser la de por defecto"));

  const responses: RuntimeResponse[] = [];
  for (const [i, r] of list.entries()) {
    if (ids.has(r.id)) problems.push(at(`responses[${i}].id: "${r.id}" está repetido`));
    ids.add(r.id);
    const headers: Record<string, string> = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k, String(v)]));
    let body: RuntimeBody | null = null;
    let type: string | null = null;
    if (typeof r.body === "string" || (r.body && "inline" in r.body)) {
      const text = typeof r.body === "string" ? r.body : r.body.inline;
      body = { kind: "text", text };
      type = looksLikeJson(text) ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";
    } else if (r.body && "json" in r.body) {
      body = { kind: "text", text: JSON.stringify(r.body.json, null, 2) };
      type = "application/json; charset=utf-8";
    } else if (r.body && "file" in r.body) {
      const read = await readBodyFile(mockDir, routeAbs, r.body.file);
      if (!read.ok) problems.push(at(`responses[${i}].body: ${read.message}`));
      else {
        body = read.body;
        type = read.type;
      }
    }
    if (type && body && !headerKey(headers, "content-type")) headers["Content-Type"] = type;
    const template = r.template ?? true;
    const callbacks: RuntimeCallback[] = (r.callbacks ?? []).map((c) => ({
      url: c.url,
      method: c.method ?? "POST",
      headers: Object.fromEntries(Object.entries(c.headers ?? {}).map(([k, v]) => [k, String(v)])),
      body: c.body === undefined ? null : typeof c.body === "string" ? c.body : JSON.stringify(c.body.json),
      delayMs: c.delay ?? 0,
    }));
    if (template) {
      const sources: Array<[string, string]> = [];
      if (body?.kind === "text") sources.push([`responses[${i}].body`, body.text]);
      for (const [k, v] of Object.entries(headers)) sources.push([`responses[${i}].headers.${k}`, v]);
      callbacks.forEach((c, j) => {
        sources.push([`responses[${i}].callbacks[${j}].url`, c.url]);
        if (c.body) sources.push([`responses[${i}].callbacks[${j}].body`, c.body]);
      });
      for (const [where, source] of sources) {
        const message = templateProblem(source);
        if (message) problems.push(at(`${where}: ${message}`));
      }
    }
    responses.push({
      id: r.id,
      default: defaults === 0 ? i === 0 : r.default === true,
      status: r.status ?? 200,
      headers,
      body,
      latencyMs: r.latency ?? 0,
      rules: r.rules ? { mode: r.rules.mode ?? "all", when: r.rules.when.map((w) => ({ target: w.target, op: w.op, value: w.value, negate: w.negate ?? false })) } : null,
      template,
      callbacks,
    });
  }

  if (problems.length) return { route: null, problems };
  return {
    route: { id, file: relFile, method: parsed.method ?? "GET", path: parsed.path, mode: parsed.mode ?? "rules", latencyMs: parsed.latency ?? 0, crud: null, responses },
    problems,
  };
}

/** The protocol of a route file (ws, socketio), read before validating it with the right schema. */
async function peekProtocol(abs: string): Promise<string | null> {
  try {
    const value = parseDocument(await readFile(abs, "utf8")).get("protocol");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

const payloadText = (p: string | { json: unknown } | undefined): string | null => (p === undefined ? null : typeof p === "string" ? p : JSON.stringify(p.json));
type RuleIn = { target: string; op: RuleOp; value?: unknown; negate?: boolean | undefined };
const toRules = (r: { mode?: "all" | "any" | undefined; when: RuleIn[] } | undefined) =>
  r ? { mode: r.mode ?? ("all" as const), when: r.when.map((w) => ({ target: w.target, op: w.op, value: w.value, negate: w.negate ?? false })) } : null;

function buildRealtime(r: RealtimeFile, relFile: string, wsRel: string, routesDir: string, abs: string): { route: RuntimeRealtime; problems: Problem[] } {
  const problems: Problem[] = [];
  const id = r.id ?? toPosix(relative(routesDir, abs)).replace(/\.yaml$/, "").toLowerCase();
  const template = r.template ?? true;
  const check = (where: string, text: string | null) => {
    if (!template || text === null) return;
    const message = templateProblem(text);
    if (message) problems.push({ file: wsRel, line: null, message: `${where}: ${message}` });
  };
  const defaults = (r.messages ?? []).filter((m) => m.default).length;
  const route: RuntimeRealtime = {
    id,
    file: relFile,
    protocol: r.protocol,
    path: r.path ?? "/",
    description: r.description ?? null,
    onConnect: (r.onConnect ?? []).map((s, i) => {
      const send = payloadText(s.send);
      const data = payloadText(s.data);
      check(`onConnect[${i}]`, send ?? data);
      return { afterMs: s.after ?? 0, everyMs: s.every ?? null, times: s.times ?? null, send, emit: s.emit ?? null, data, to: s.to ?? "self" };
    }),
    messages: (r.messages ?? []).map((m, i) => {
      const reply = payloadText(m.reply);
      const broadcast = payloadText(m.broadcast);
      const ack = payloadText(m.ack);
      const emitData = payloadText(m.emit?.data);
      for (const [k, v] of [["reply", reply], ["broadcast", broadcast], ["ack", ack], ["emit.data", emitData], ["join", m.join ?? null], ["leave", m.leave ?? null]] as const) check(`messages[${i}].${k}`, v);
      return {
        id: m.id,
        default: defaults === 0 ? false : m.default === true,
        event: m.event ?? null,
        rules: toRules(m.rules),
        delayMs: m.delay ?? 0,
        reply,
        broadcast,
        close: m.close ? { code: m.close.code ?? 1000, reason: m.close.reason ?? "" } : null,
        ack,
        emit: m.emit ? { event: m.emit.event, data: emitData, to: m.emit.to ?? "self" } : null,
        join: m.join ?? null,
        leave: m.leave ?? null,
      };
    }),
    echo: r.echo ?? false,
    template,
  };
  return { route, problems };
}

/** mock.yaml → grpc and grpc/*.yaml → services with their protos (each proto is loaded once). */
async function loadGrpc(workspaceDir: string, mockDir: string, ws: (abs: string) => string, settings: MockFile["grpc"], mockYamlRel: string, hasTls: boolean): Promise<{ grpc: RuntimeGrpc | null; problems: Problem[] }> {
  const problems: Problem[] = [];
  const files = await listYaml(join(mockDir, "grpc"));
  if (!settings) {
    if (files.length) problems.push({ file: ws(files[0]!), line: null, message: "hay servicios gRPC pero mock.yaml no tiene grpc: { port: … }" });
    return { grpc: null, problems };
  }
  if (settings.tls && !hasTls) problems.push({ file: mockYamlRel, line: null, message: "grpc.tls: el mock necesita tls (tls: true o su certificado) en mock.yaml" });
  const protos = new Map<string, LoadedProto | null>();
  const services: RuntimeGrpc["services"] = [];
  const seen = new Set<string>();
  for (const abs of files) {
    const rel = ws(abs);
    const parsed = await parseYaml(abs, rel, grpcFile);
    if (!parsed.ok) {
      problems.push(...parsed.problems);
      continue;
    }
    const g = parsed.value;
    if (!protos.has(g.proto)) {
      const loaded = await loadProto(workspaceDir, g.proto);
      if (!loaded.ok) problems.push({ file: rel, line: null, message: `proto: ${loaded.message}` });
      protos.set(g.proto, loaded.ok ? loaded.proto : null);
    }
    const proto = protos.get(g.proto);
    if (!proto) continue;
    let service: { methods: Record<string, unknown> } | null = null;
    try {
      service = proto.root.lookupService(g.service);
    } catch {
      problems.push({ file: rel, line: null, message: `service: ${g.proto} no define el servicio ${g.service}` });
      continue;
    }
    if (seen.has(g.service)) {
      problems.push({ file: rel, line: null, message: `service: ${g.service} ya está en otro archivo de grpc/` });
      continue;
    }
    seen.add(g.service);
    const methods: Record<string, RuntimeGrpcResponse[]> = {};
    for (const [name, def] of Object.entries(g.methods ?? {})) {
      if (!Object.hasOwn(service.methods, name)) {
        problems.push({ file: rel, line: null, message: `methods.${name}: ${g.service} no tiene ese método (${Object.keys(service.methods).join(", ")})` });
        continue;
      }
      const defaults = def.responses.filter((r) => r.default).length;
      methods[name] = def.responses.map((r, i) => {
        const message = r.message === undefined ? null : JSON.stringify(r.message);
        const stream = r.stream ? r.stream.map((s) => ({ message: JSON.stringify(s.message), delayMs: s.delay ?? 0 })) : null;
        for (const text of [message, ...(stream ?? []).map((s) => s.message)]) {
          const problem = text ? templateProblem(text) : null;
          if (problem) problems.push({ file: rel, line: null, message: `methods.${name}.responses[${i}]: ${problem}` });
        }
        return {
          id: r.id,
          default: defaults === 0 ? i === 0 : r.default === true,
          rules: toRules(r.rules),
          delayMs: r.delay ?? 0,
          message,
          stream,
          repeat: r.repeat ?? 1,
          status: r.status ?? "OK",
          details: r.details ?? "",
          metadata: Object.fromEntries(Object.entries(r.metadata ?? {}).map(([k, v]) => [k, String(v)])),
          trailers: Object.fromEntries(Object.entries(r.trailers ?? {}).map(([k, v]) => [k, String(v)])),
        };
      });
    }
    services.push({ file: toPosix(relative(mockDir, abs)), proto: g.proto, service: g.service, descriptor: proto.json, methods });
  }
  return { grpc: { port: settings.port, tls: settings.tls ?? false, reflection: settings.reflection ?? true, services }, problems };
}

/** chaos/*.yaml → profiles by name (unique across files). */
async function loadChaos(workspaceDir: string): Promise<{ profiles: Record<string, RuntimeChaosProfile>; problems: Problem[] }> {
  const profiles: Record<string, RuntimeChaosProfile> = {};
  const problems: Problem[] = [];
  for (const abs of await listYaml(join(workspaceDir, CHAOS_DIR))) {
    const rel = toPosix(relative(workspaceDir, abs));
    const parsed = await parseYaml(abs, rel, chaosFile);
    if (!parsed.ok) {
      problems.push(...parsed.problems);
      continue;
    }
    for (const [name, p] of Object.entries(parsed.value)) {
      if (name === "off") {
        problems.push({ file: rel, line: null, message: 'off: "off" está reservado para quitar el caos; usa otro nombre' });
        continue;
      }
      if (profiles[name]) {
        problems.push({ file: rel, line: null, message: `${name}: el perfil ya existe en ${profiles[name]!.file}` });
        continue;
      }
      const points = p.points.map((pt) => ({
        tMs: pt.t,
        latencyMs: pt.latency ?? 0,
        jitterMs: pt.jitter ?? 0,
        errorRate: pt.errorRate ?? 0,
        errors: Array.isArray(pt.errors) ? pt.errors.map((status) => ({ status, weight: 1 })) : Object.entries(pt.errors ?? {}).map(([status, weight]) => ({ status: Number(status), weight })),
      }));
      profiles[name] = {
        name,
        file: rel,
        description: p.description ?? null,
        loop: p.loop ?? true,
        cycleMs: p.duration ?? points.at(-1)!.tMs,
        points,
        extras: { dropRate: p.extras?.dropRate ?? 0, timeoutRate: p.extras?.timeoutRate ?? 0, trickleKBps: p.extras?.trickleKBps ?? null },
      };
    }
  }
  return { profiles, problems };
}

/** mocks/<name>/scenarios/*.yaml → state machines (id defaults to the file name). */
async function loadScenarios(mockDir: string, ws: (abs: string) => string): Promise<{ scenarios: RuntimeScenario[]; problems: Problem[] }> {
  const problems: Problem[] = [];
  const scenarios: RuntimeScenario[] = [];
  const dir = join(mockDir, "scenarios");
  const seen = new Map<string, string>();
  for (const abs of await listYaml(dir)) {
    const rel = ws(abs);
    const parsed = await parseYaml(abs, rel, scenarioFile);
    if (!parsed.ok) {
      problems.push(...parsed.problems);
      continue;
    }
    const s = parsed.value;
    const id = s.id ?? toPosix(relative(dir, abs)).replace(/\.yaml$/, "").replace(/\//g, "-").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      problems.push({ file: rel, line: null, message: "id: el nombre del escenario solo puede tener minúsculas, números y guiones" });
      continue;
    }
    const other = seen.get(id);
    if (other) {
      problems.push({ file: rel, line: null, message: `id "${id}" repetido (también en ${other})` });
      continue;
    }
    seen.set(id, rel);
    scenarios.push({
      id,
      file: toPosix(relative(mockDir, abs)),
      key: s.key ?? null,
      initial: s.initial,
      states: s.states,
      transitions: s.transitions.map((t) => ({
        from: Array.isArray(t.from) ? t.from : [t.from],
        to: t.to,
        on: t.on ? { method: t.on.method ?? "ANY", path: t.on.path, rules: (t.on.rules ?? []).map((w) => ({ target: w.target, op: w.op, value: w.value, negate: w.negate ?? false })) } : null,
        afterMs: t.after ?? null,
      })),
    });
  }
  return { scenarios, problems };
}

/** Rules that read state.<id> must name a scenario of the mock, and compare against its states. */
function checkStateRules(routes: RuntimeRoute[], scenarios: RuntimeScenario[], routeFileOf: (r: RuntimeRoute) => string): Problem[] {
  const problems: Problem[] = [];
  for (const route of routes) {
    for (const [i, resp] of route.responses.entries()) {
      for (const rule of resp.rules?.when ?? []) {
        if (!rule.target.startsWith("state.")) continue;
        const id = rule.target.slice(6);
        const scenario = scenarios.find((s) => s.id === id);
        const at = (message: string) => problems.push({ file: routeFileOf(route), line: null, message: `responses[${i}].rules: ${message}` });
        if (!scenario) {
          at(`no hay ningún escenario "${id}" en scenarios/`);
          continue;
        }
        const values = rule.op === "equals" ? [rule.value] : rule.op === "in" && Array.isArray(rule.value) ? rule.value : [];
        for (const v of values) if (!scenario.states.includes(String(v))) at(`"${String(v)}" no es un estado de ${id} (${scenario.states.join(", ")})`);
      }
    }
  }
  return problems;
}

/** mock.yaml → contract: reads and bundles the OpenAPI file (inside the workspace) and checks it can be used. */
async function loadContract(workspaceDir: string, mockYamlRel: string, settings: NonNullable<MockFile["contract"]>): Promise<{ contract: RuntimeContract | null; problems: Problem[] }> {
  const at = (message: string): Problem => ({ file: mockYamlRel, line: null, message: `contract: ${message}` });
  if (isAbsolute(settings.file)) return { contract: null, problems: [at("usa una ruta relativa al workspace, como contracts/tienda.openapi.yaml")] };
  const abs = resolve(workspaceDir, settings.file);
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(abs), realpath(workspaceDir)]);
  } catch {
    return { contract: null, problems: [at(`no existe ${settings.file}`)] };
  }
  if (!real.startsWith(realRoot + sep)) return { contract: null, problems: [at(`${settings.file} está fuera del workspace`)] };
  let document: Record<string, unknown>;
  try {
    document = (await SwaggerParser.bundle(real)) as unknown as Record<string, unknown>;
    new Contract(document);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).split("\n", 1)[0]!;
    return { contract: null, problems: [at(`${settings.file}: ${message}`)] };
  }
  return { contract: { file: toPosix(relative(realRoot, real)), mode: settings.mode ?? "warn", responses: settings.responses ?? true, document }, problems: [] };
}

async function loadMock(workspaceDir: string, name: string, opts: LoadOptions, shared: Shared): Promise<LoadedMock> {
  const dir = join(workspaceDir, "mocks", name);
  const ws = (abs: string) => toPosix(relative(workspaceDir, abs));
  const problems: Problem[] = [];
  const mockYaml = join(dir, MOCK_FILE);

  if (!(await exists(mockYaml))) {
    return { name, dir, config: null, problems: [{ file: ws(mockYaml), line: null, message: "falta mock.yaml (puerto y ajustes del mock)" }] };
  }
  const settings = await parseYaml(mockYaml, ws(mockYaml), mockFile);
  if (!settings.ok) problems.push(...settings.problems);

  const data = await readBuckets(dir, ws);
  problems.push(...data.problems);

  const routesDir = join(dir, "routes");
  const routes: RuntimeRoute[] = [];
  const realtime: RuntimeRealtime[] = [];
  const byId = new Map<string, string>();
  for (const abs of await listYaml(routesDir)) {
    const rel = ws(abs);
    const protocol = await peekProtocol(abs);
    if (protocol === "ws" || protocol === "socketio") {
      const live = await parseYaml(abs, rel, realtimeFile);
      if (!live.ok) {
        problems.push(...live.problems);
        continue;
      }
      const built = buildRealtime(live.value, toPosix(relative(dir, abs)), rel, routesDir, abs);
      problems.push(...built.problems);
      const other = byId.get(built.route.id);
      if (other) problems.push({ file: rel, line: null, message: `id "${built.route.id}" repetido (también en ${other})` });
      else {
        byId.set(built.route.id, rel);
        realtime.push(built.route);
      }
      continue;
    }
    const parsed = await parseYaml(abs, rel, routeFile);
    if (!parsed.ok) {
      problems.push(...parsed.problems);
      continue;
    }
    const built = await buildRoute(dir, abs, toPosix(relative(dir, abs)), rel, parsed.value, routesDir, data.buckets);
    problems.push(...built.problems);
    if (!built.route) continue;
    if (parsed.value.chaos !== undefined) {
      if (parsed.value.chaos !== "off" && !shared.chaos[parsed.value.chaos]) problems.push({ file: rel, line: null, message: `chaos: no hay ningún perfil "${parsed.value.chaos}" en chaos/` });
      built.route.chaos = parsed.value.chaos === "off" ? null : parsed.value.chaos;
    }
    const other = byId.get(built.route.id);
    if (other) {
      problems.push({ file: rel, line: null, message: `id "${built.route.id}" repetido (también en ${other})` });
      continue;
    }
    byId.set(built.route.id, rel);
    routes.push(built.route);
  }

  const story = await loadScenarios(dir, ws);
  problems.push(...story.problems);
  problems.push(...checkStateRules(routes, story.scenarios, (r) => ws(join(dir, r.file))));

  if (!settings.ok) return { name, dir, config: null, problems };
  const s = settings.value;

  // Chaos: the mock's profile, then folders (deepest first) for routes without their own.
  const chaosSettings = typeof s.chaos === "string" ? { profile: s.chaos, folders: {} as Record<string, string> } : { profile: s.chaos?.profile, folders: s.chaos?.folders ?? {} };
  for (const name of [chaosSettings.profile, ...Object.values(chaosSettings.folders)]) {
    if (name && name !== "off" && !shared.chaos[name]) problems.push({ file: ws(mockYaml), line: null, message: `chaos: no hay ningún perfil "${name}" en chaos/` });
  }
  const folders = Object.entries(chaosSettings.folders).sort((a, b) => b[0].length - a[0].length);
  for (const route of routes) {
    if (route.chaos !== undefined) continue;
    const folder = route.file.replace(/^routes\//, "").split("/").slice(0, -1).join("/");
    const hit = folders.find(([f]) => folder === f || folder.startsWith(`${f}/`));
    if (hit) route.chaos = hit[1] === "off" ? null : hit[1];
  }

  // Two WebSocket routes on one path, or two files on one Socket.IO namespace, would shadow each other.
  for (const proto of ["ws", "socketio"] as const) {
    const paths = new Map<string, string>();
    for (const r of realtime.filter((x) => x.protocol === proto)) {
      const other = paths.get(r.path);
      if (other) problems.push({ file: ws(join(dir, r.file)), line: null, message: `path: ${r.path} ya lo usa ${other}` });
      else paths.set(r.path, r.file);
    }
  }
  const grpc = await loadGrpc(workspaceDir, dir, ws, s.grpc, ws(mockYaml), s.tls !== undefined && s.tls !== false);
  problems.push(...grpc.problems);

  let contract: RuntimeContract | null = null;
  if (s.contract) {
    const loaded = await loadContract(workspaceDir, ws(mockYaml), s.contract);
    problems.push(...loaded.problems);
    contract = loaded.contract;
  }

  // Explicit order first (mock.yaml → order), then the rest by file path.
  const ordered: RuntimeRoute[] = [];
  for (const id of s.order ?? []) {
    const route = routes.find((r) => r.id === id);
    if (!route) problems.push({ file: ws(mockYaml), line: null, message: `order: no hay ninguna ruta con id "${id}"` });
    else if (!ordered.includes(route)) ordered.push(route);
  }
  for (const r of routes) if (!ordered.includes(r)) ordered.push(r);

  let tls: TlsPair | null = null;
  if (s.tls === true) {
    tls = await (opts.generatedTls ?? ensureSelfSigned)(workspaceDir);
  } else if (s.tls && typeof s.tls === "object") {
    try {
      const [cert, key] = await Promise.all([readFile(resolve(dir, s.tls.cert), "utf8"), readFile(resolve(dir, s.tls.key), "utf8")]);
      tls = { cert, key };
    } catch {
      problems.push({ file: ws(mockYaml), line: null, message: "tls: no se pueden leer el certificado o la clave" });
    }
  }

  if (problems.length) return { name, dir, config: null, problems };
  return {
    name,
    dir,
    problems,
    config: {
      name,
      host: s.host ?? "127.0.0.1",
      port: s.port,
      prefix: s.prefix ?? "",
      cors: s.cors ?? true,
      latencyMs: s.latency ?? 0,
      tls,
      routes: ordered,
      variables: { ...shared.variables, ...Object.fromEntries(Object.entries(s.variables ?? {}).map(([k, v]) => [k, String(v)])) },
      env: shared.env,
      buckets: data.buckets,
      proxy: s.proxy
        ? {
            target: s.proxy.target.replace(/\/+$/, ""),
            keepPrefix: s.proxy.keepPrefix ?? false,
            insecure: s.proxy.insecure ?? false,
            headers: Object.fromEntries(Object.entries(s.proxy.headers ?? {}).map(([k, v]) => [k, String(v)])),
          }
        : null,
      callbackHosts: s.callbacks?.allow ?? [],
      scenarios: story.scenarios,
      contract,
      realtime,
      grpc: grpc.grpc,
      chaos: {
        profiles: shared.chaos,
        profile: chaosSettings.profile && chaosSettings.profile !== "off" ? chaosSettings.profile : null,
        folders: Object.fromEntries(Object.entries(chaosSettings.folders).map(([f, p]) => [f, p === "off" ? null : p])),
      },
    },
  };
}

/** True when the folder has a mockix.workspace.yaml (valid or not: its problems are a load's business). */
export async function isWorkspace(dir: string): Promise<boolean> {
  return exists(join(resolve(dir), WORKSPACE_FILE));
}

/** Loads every mock of a workspace. Never throws for content problems: they are returned. */
export async function loadWorkspace(dir: string, opts: LoadOptions = {}): Promise<WorkspaceLoad> {
  const root = resolve(dir);
  const problems: Problem[] = [];
  const wsFile = join(root, WORKSPACE_FILE);
  if (!(await exists(wsFile))) {
    return { dir: root, mocks: [], chaos: {}, redaction: null, problems: [{ file: WORKSPACE_FILE, line: null, message: "no es un workspace de Mockix: falta mockix.workspace.yaml (crea uno con «mockix init»)" }] };
  }
  const parsed = await parseYaml(wsFile, WORKSPACE_FILE, workspaceFile);
  if (!parsed.ok) problems.push(...parsed.problems);

  let folders: string[] = [];
  try {
    folders = (await readdir(join(root, "mocks"), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    // No mocks folder yet: an empty workspace.
  }
  const wsValue: WorkspaceFile | null = parsed.ok ? parsed.value : null;
  const listed = wsValue?.mocks ?? [];
  const source = opts.env ?? process.env;
  const chaos = await loadChaos(root);
  problems.push(...chaos.problems);
  const shared: Shared = {
    variables: Object.fromEntries(Object.entries(wsValue?.variables ?? {}).map(([k, v]) => [k, String(v)])),
    env: Object.fromEntries((wsValue?.env ?? []).flatMap((k) => (source[k] === undefined ? [] : [[k, source[k]!]]))),
    chaos: chaos.profiles,
  };
  for (const name of listed) {
    if (!folders.includes(name)) problems.push({ file: WORKSPACE_FILE, line: null, message: `mocks: no existe la carpeta mocks/${name}` });
  }
  const names = [...listed.filter((n) => folders.includes(n)), ...folders.filter((n) => !listed.includes(n))];

  const mocks: LoadedMock[] = [];
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      problems.push({ file: `mocks/${name}`, line: null, message: "el nombre de la carpeta del mock solo puede tener minúsculas, números y guiones" });
      continue;
    }
    mocks.push(await loadMock(root, name, opts, shared));
  }

  // Two mocks on the same fixed port and host cannot both run.
  const seen = new Map<string, string>();
  for (const m of mocks) {
    if (!m.config || m.config.port === 0) continue;
    const key = `${m.config.host}:${m.config.port}`;
    const other = seen.get(key);
    if (other) m.problems.push({ file: `mocks/${m.name}/${MOCK_FILE}`, line: null, message: `port: ${m.config.port} ya lo usa el mock "${other}"` });
    else seen.set(key, m.name);
  }
  for (const m of mocks) if (m.problems.length) m.config = null;

  return { dir: root, mocks, problems, chaos: chaos.profiles, redaction: (wsValue?.redaction as RedactionRule[] | undefined) ?? null };
}
