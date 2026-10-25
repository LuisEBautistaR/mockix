/**
 * OpenAPI 3.0/3.1 contract checks: every request against its operation
 * (path, method, parameters, body) and every mock response against the
 * documented responses, with the reasons in Spanish.
 *
 * The document arrives bundled (external refs inlined, internal $refs kept),
 * so it crosses process boundaries as plain JSON and ajv resolves the refs.
 */
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { IncomingHttpHeaders } from "node:http";
import type { MockConfig } from "./runtime.js";
import { previewTemplate } from "./template.js";

export type ContractMode = "off" | "warn" | "strict";

export interface Violation {
  side: "request" | "response";
  /** Contract operation ("POST /pedidos/{id}") or, when none matched, the request itself. */
  operation: string;
  /** body.lineas[0].cantidad, query.limit, header.X-Tienda, cookie.x, params.id, operation, status, content-type */
  where: string;
  /** The rule broken, the same for every request that breaks it ("body.lineas[].cantidad debe ser integer"). */
  rule: string;
  /** This request's detail ("… (recibido "2", un string)"). */
  message: string;
  /** Status of the checked response (response side only). */
  status?: number | undefined;
}

export interface ContractRequest {
  method: string;
  /** Path after the mock prefix. */
  path: string;
  query: Record<string, string | string[]>;
  headers: IncomingHttpHeaders;
  cookies: Record<string, string>;
  body: { raw: string; parsed: unknown };
}

export interface ContractOperation {
  method: string;
  path: string;
  operationId: string | null;
  summary: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

interface CompiledOperation extends ContractOperation {
  key: string;
  pointer: string;
  regex: RegExp;
  names: string[];
  /** Templated segments: fewer means more specific (OpenAPI matches concrete paths first). */
  templated: number;
}

const escapePointer = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v);
const TYPE_ES: Record<string, string> = { string: "un string", number: "un número", integer: "un entero", boolean: "un booleano", object: "un objeto", array: "una lista", null: "null", undefined: "nada" };

function shortValue(v: unknown): string {
  const text = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
}

/** /lineas/0/cantidad → body.lineas[0].cantidad */
function instanceWhere(base: string, instancePath: string): string {
  let out = base;
  for (const raw of instancePath.split("/").slice(1)) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    out += /^\d+$/.test(part) ? `[${part}]` : `.${part}`;
  }
  return out;
}

/** One ajv error → where it happened, the rule (no request values) and the detail. */
function describe(base: string, e: ErrorObject): { where: string; rule: string; message: string } {
  let where = instanceWhere(base, e.instancePath);
  const p = e.params as Record<string, unknown>;
  let rule: string;
  let detail = "";
  switch (e.keyword) {
    case "type":
      rule = `debe ser ${String(p["type"])}`;
      detail = ` (recibido ${shortValue(e.data)}, ${TYPE_ES[typeOf(e.data)] ?? typeOf(e.data)})`;
      break;
    case "required":
      where = `${where}.${String(p["missingProperty"])}`;
      rule = "es obligatorio";
      break;
    case "additionalProperties":
      rule = `propiedad extra "${String(p["additionalProperty"])}"`;
      break;
    case "enum":
      rule = `debe ser uno de: ${(p["allowedValues"] as unknown[]).map((v) => shortValue(v)).join(", ")}`;
      detail = ` (recibido ${shortValue(e.data)})`;
      break;
    case "const":
      rule = `debe ser ${shortValue(p["allowedValue"])}`;
      break;
    case "minimum":
    case "exclusiveMinimum":
    case "maximum":
    case "exclusiveMaximum":
      rule = `${e.keyword.includes("inimum") ? "mínimo" : "máximo"} ${String(p["limit"])}${e.keyword.startsWith("exclusive") ? " (sin incluirlo)" : ""}`;
      detail = ` (recibido ${shortValue(e.data)})`;
      break;
    case "minLength":
      rule = `al menos ${String(p["limit"])} caracteres`;
      break;
    case "maxLength":
      rule = `como mucho ${String(p["limit"])} caracteres`;
      break;
    case "minItems":
      rule = `al menos ${String(p["limit"])} elementos`;
      break;
    case "maxItems":
      rule = `como mucho ${String(p["limit"])} elementos`;
      break;
    case "uniqueItems":
      rule = "los elementos no se pueden repetir";
      break;
    case "pattern":
      rule = `no cumple el patrón ${String(p["pattern"])}`;
      detail = ` (recibido ${shortValue(e.data)})`;
      break;
    case "format":
      rule = `debe tener formato ${String(p["format"])}`;
      detail = ` (recibido ${shortValue(e.data)})`;
      break;
    case "oneOf":
    case "anyOf":
      rule = "no cumple ninguna de las opciones del esquema";
      break;
    case "minProperties":
    case "maxProperties":
      rule = `${e.keyword === "minProperties" ? "al menos" : "como mucho"} ${String(p["limit"])} propiedades`;
      break;
    default:
      rule = e.message ?? e.keyword;
  }
  const generic = where.replace(/\[\d+\]/g, "[]");
  return { where, rule: `${generic} ${rule}`, message: `${where} ${rule}${detail}` };
}

/** OpenAPI 3.0 schemas use the draft-04 boolean exclusiveMinimum/Maximum; ajv wants numbers. */
function upgrade30(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(upgrade30);
  if (!isObj(node)) return node;
  const out: Obj = {};
  for (const [k, v] of Object.entries(node)) out[k] = upgrade30(v);
  for (const [flag, limit] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]] as const) {
    if (out[flag] === true && typeof out[limit] === "number") {
      out[flag] = out[limit];
      delete out[limit];
    } else if (out[flag] === false) delete out[flag];
  }
  return out;
}

const mediaBase = (type: string | undefined) => (type ?? "").split(";", 1)[0]!.trim().toLowerCase();
const isJsonType = (type: string) => type === "application/json" || type.endsWith("+json");

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export class Contract {
  readonly version: "3.0" | "3.1";
  readonly operations: ContractOperation[];
  readonly #doc: Obj;
  readonly #ops: CompiledOperation[];
  readonly #basePath: string;
  readonly #ajv: Ajv;
  /** Same document, coercing strings: parameters and form bodies always arrive as text. */
  readonly #coerce: Ajv;
  readonly #cache = new Map<string, ValidateFunction>();

  constructor(document: unknown) {
    if (!isObj(document) || typeof document["openapi"] !== "string") throw new ContractError("no es un documento OpenAPI 3 (falta openapi)");
    const version = document["openapi"];
    if (!/^3\.[01]\./.test(version)) throw new ContractError(`OpenAPI ${version} no está soportado: usa 3.0 o 3.1`);
    this.version = version.startsWith("3.1") ? "3.1" : "3.0";
    this.#doc = (this.version === "3.0" ? upgrade30(document) : structuredClone(document)) as Obj;

    const make = (coerce: boolean) => {
      const options = { strict: false, allErrors: true, verbose: true, validateSchema: false, ...(coerce ? { coerceTypes: "array" as const } : {}) };
      const ajv = this.version === "3.1" ? new Ajv2020(options) : new Ajv(options);
      (addFormats.default ?? addFormats)(ajv);
      ajv.addSchema(this.#doc, "c");
      return ajv as Ajv;
    };
    this.#ajv = make(false);
    this.#coerce = make(true);

    const servers = this.#doc["servers"];
    let base = "";
    if (Array.isArray(servers) && isObj(servers[0]) && typeof servers[0]["url"] === "string") {
      try {
        base = new URL(servers[0]["url"].replace(/\{[^}]+\}/g, "x"), "http://x").pathname.replace(/\/+$/, "");
      } catch {
        // relative or odd server URL: no base path
      }
    }
    this.#basePath = base;

    const ops: CompiledOperation[] = [];
    for (const [path, item] of Object.entries(isObj(this.#doc["paths"]) ? this.#doc["paths"] : {})) {
      if (!isObj(item)) continue;
      for (const method of METHODS) {
        const op = item[method];
        if (!isObj(op)) continue;
        const names: string[] = [];
        let templated = 0;
        const source = path
          .replace(/\/+$/, "")
          .split("/")
          .map((seg) =>
            seg.replace(/\{([^}]+)\}|([^{]+)/g, (_m, name: string | undefined, lit: string | undefined) => {
              if (name !== undefined) {
                names.push(name);
                templated++;
                return "([^/]+)";
              }
              return lit!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            }),
          )
          .join("/");
        ops.push({
          method: method.toUpperCase(),
          path,
          operationId: typeof op["operationId"] === "string" ? op["operationId"] : null,
          summary: typeof op["summary"] === "string" ? op["summary"] : null,
          key: `${method.toUpperCase()} ${path}`,
          pointer: `#/paths/${escapePointer(path)}/${method}`,
          regex: new RegExp(`^${source || ""}/?$`),
          names,
          templated,
        });
      }
    }
    this.#ops = ops.sort((a, b) => a.templated - b.templated);
    this.operations = this.#ops.map(({ method, path, operationId, summary }) => ({ method, path, operationId, summary }));
  }

  /** Value at a JSON pointer of the document. */
  #at(pointer: string): unknown {
    let node: unknown = this.#doc;
    for (const raw of pointer.replace(/^#\/?/, "").split("/").filter(Boolean)) {
      const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isObj(node) && !Array.isArray(node)) return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return node;
  }

  /** Follows Reference Objects (parameters, request bodies, responses). */
  #deref(value: unknown, pointer: string): { value: unknown; pointer: string } {
    for (let i = 0; i < 10 && isObj(value) && typeof value["$ref"] === "string" && value["$ref"].startsWith("#"); i++) {
      pointer = value["$ref"];
      value = this.#at(pointer);
    }
    return { value, pointer };
  }

  #validator(pointer: string, coerce: boolean): ValidateFunction {
    const id = `${coerce ? "c:" : ""}${pointer}`;
    let fn = this.#cache.get(id);
    if (!fn) {
      fn = (coerce ? this.#coerce : this.#ajv).compile(coerce ? { type: "object", properties: { v: { $ref: `c${pointer}` } } } : { $ref: `c${pointer}` });
      this.#cache.set(id, fn);
    }
    return fn;
  }

  #match(method: string, path: string): { op: CompiledOperation; params: Record<string, string> } | null {
    const tries = [path];
    if (this.#basePath && (path === this.#basePath || path.startsWith(`${this.#basePath}/`))) tries.push(path.slice(this.#basePath.length) || "/");
    for (const p of tries) {
      for (const op of this.#ops) {
        if (op.method !== method && !(method === "HEAD" && op.method === "GET")) continue;
        const m = op.regex.exec(p);
        if (!m) continue;
        const params: Record<string, string> = {};
        op.names.forEach((n, i) => {
          try {
            params[n] = decodeURIComponent(m[i + 1]!);
          } catch {
            params[n] = m[i + 1]!;
          }
        });
        return { op, params };
      }
    }
    return null;
  }

  /** The operation a request falls on, or null. */
  operationFor(method: string, path: string): string | null {
    return this.#match(method, path)?.op.key ?? null;
  }

  checkRequest(req: ContractRequest): { operation: string | null; violations: Violation[] } {
    const found = this.#match(req.method, req.path);
    if (!found) {
      const operation = `${req.method} ${req.path}`;
      return { operation: null, violations: [{ side: "request", operation, where: "operation", rule: "operación no definida en el contrato", message: "operación no definida en el contrato" }] };
    }
    const { op, params } = found;
    const out: Violation[] = [];
    const add = (where: string, rule: string, message = rule) => out.push({ side: "request", operation: op.key, where, rule, message });
    const opObj = this.#at(op.pointer) as Obj;
    const pathItemPointer = op.pointer.slice(0, op.pointer.lastIndexOf("/"));

    // Path-level parameters, overridden by operation-level ones with the same name and location.
    const declared = new Map<string, { param: Obj; pointer: string }>();
    for (const [list, base] of [[(this.#at(pathItemPointer) as Obj)["parameters"], `${pathItemPointer}/parameters`], [opObj["parameters"], `${op.pointer}/parameters`]] as const) {
      if (!Array.isArray(list)) continue;
      list.forEach((raw, i) => {
        const { value, pointer } = this.#deref(raw, `${base}/${i}`);
        if (isObj(value) && typeof value["name"] === "string" && typeof value["in"] === "string") declared.set(`${value["in"]}:${value["name"]}`, { param: value, pointer });
      });
    }
    for (const { param, pointer } of declared.values()) {
      const name = String(param["name"]);
      const where = String(param["in"]);
      let value: unknown;
      let label = `${where}.${name}`;
      if (where === "path") {
        value = params[name];
        label = `params.${name}`;
      } else if (where === "query") value = req.query[name];
      else if (where === "header") {
        const v = req.headers[name.toLowerCase()];
        value = Array.isArray(v) ? v.join(", ") : v;
        label = `header.${name}`;
      } else if (where === "cookie") value = req.cookies[name];
      else continue;
      if (value === undefined || value === "") {
        if (param["required"] === true || where === "path") add(label, `${label} es obligatoria`);
        continue;
      }
      if (!isObj(param["schema"])) continue;
      const validate = this.#validator(`${pointer}/schema`, true);
      if (!validate({ v: value })) for (const e of validate.errors ?? []) {
        const d = describe(label, { ...e, instancePath: e.instancePath.replace(/^\/v/, "") });
        add(d.where, d.rule, d.message);
      }
    }

    // Body.
    const rb = this.#deref(opObj["requestBody"], `${op.pointer}/requestBody`);
    if (isObj(rb.value)) {
      const hasBody = req.body.raw.length > 0;
      const content = isObj(rb.value["content"]) ? rb.value["content"] : {};
      if (!hasBody) {
        if (rb.value["required"] === true) add("body", "body es obligatorio");
      } else {
        const type = mediaBase(Array.isArray(req.headers["content-type"]) ? req.headers["content-type"][0] : req.headers["content-type"]);
        const types = Object.keys(content);
        const media =
          types.find((t) => mediaBase(t) === type) ??
          types.find((t) => t.endsWith("/*") && type.startsWith(t.slice(0, -1))) ??
          types.find((t) => t === "*/*");
        if (!media) {
          if (types.length) add("content-type", `Content-Type debe ser ${types.join(" o ")}`, `Content-Type debe ser ${types.join(" o ")} (recibido ${type || "ninguno"})`);
        } else if (isObj((content[media] as Obj | undefined)?.["schema"])) {
          const schemaPointer = `${rb.pointer}/content/${escapePointer(media)}/schema`;
          if (isJsonType(type) || (type === "" && isJsonType(mediaBase(media)))) {
            if (req.body.parsed === undefined) add("body", "body debe ser JSON válido");
            else {
              const validate = this.#validator(schemaPointer, false);
              if (!validate(req.body.parsed)) for (const e of validate.errors ?? []) {
                const d = describe("body", e);
                add(d.where, d.rule, d.message);
              }
            }
          } else if (type === "application/x-www-form-urlencoded" && isObj(req.body.parsed)) {
            const validate = this.#validator(schemaPointer, true);
            if (!validate({ v: req.body.parsed })) for (const e of validate.errors ?? []) {
              const d = describe("body", { ...e, instancePath: e.instancePath.replace(/^\/v/, "") });
              add(d.where, d.rule, d.message);
            }
          }
        }
      }
    }
    return { operation: op.key, violations: out };
  }

  /** The documented response for a status: exact, then 2XX-style, then default. */
  #responseFor(operation: string, status: number): { value: Obj; pointer: string } | null {
    const op = this.#ops.find((o) => o.key === operation);
    if (!op) return null;
    const responses = (this.#at(op.pointer) as Obj)["responses"];
    if (!isObj(responses)) return null;
    const code = [String(status), `${String(status)[0]}XX`, `${String(status)[0]}xx`, "default"].find((c) => c in responses);
    if (!code) return null;
    const { value, pointer } = this.#deref(responses[code], `${op.pointer}/responses/${escapePointer(code)}`);
    return isObj(value) ? { value, pointer } : null;
  }

  /** Checks a response the mock produced. Binary bodies only get the status checked. */
  checkResponse(operation: string, status: number, headers: Record<string, string>, body: string | null): Violation[] {
    const out: Violation[] = [];
    const add = (where: string, rule: string, message = rule) => out.push({ side: "response", operation, where, rule, message, status });
    const found = this.#responseFor(operation, status);
    if (!found) {
      add("status", `estado ${status} no documentado`);
      return out;
    }
    const content = isObj(found.value["content"]) ? found.value["content"] : null;
    if (!content || body === null || body === "") return out;
    const type = mediaBase(Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1]);
    const types = Object.keys(content);
    const media = types.find((t) => mediaBase(t) === type) ?? types.find((t) => t.endsWith("/*") && type.startsWith(t.slice(0, -1))) ?? types.find((t) => t === "*/*");
    if (!media) {
      if (type) add("content-type", `Content-Type debe ser ${types.join(" o ")}`, `Content-Type debe ser ${types.join(" o ")} (enviado ${type})`);
      return out;
    }
    if (!isJsonType(type || mediaBase(media)) || !isObj((content[media] as Obj)["schema"])) return out;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      add("body", "body debe ser JSON válido");
      return out;
    }
    const validate = this.#validator(`${found.pointer}/content/${escapePointer(media)}/schema`, false);
    if (!validate(parsed)) for (const e of validate.errors ?? []) {
      const d = describe("body", e);
      add(d.where, d.rule, d.message);
    }
    return out;
  }

  /** The schema a violation was checked against, with refs resolved a few levels deep (for the UI). */
  expectedSchema(v: Violation): unknown {
    const op = this.#ops.find((o) => o.key === v.operation);
    if (!op) return null;
    let schema: unknown;
    if (v.side === "response") {
      const found = this.#responseFor(op.key, v.status ?? 200);
      const content = found && isObj(found.value["content"]) ? Object.values(found.value["content"])[0] : undefined;
      schema = isObj(content) ? content["schema"] : undefined;
    } else if (v.where.startsWith("body")) {
      const rb = this.#deref((this.#at(op.pointer) as Obj)["requestBody"], "");
      const content = isObj(rb.value) && isObj(rb.value["content"]) ? Object.values(rb.value["content"])[0] : undefined;
      schema = isObj(content) ? content["schema"] : undefined;
    } else {
      const name = v.where.split(".").slice(1).join(".");
      const list = [...((this.#at(op.pointer) as Obj)["parameters"] as unknown[] | undefined ?? [])];
      for (const raw of list) {
        const p = this.#deref(raw, "").value;
        if (isObj(p) && p["name"] === name) schema = p["schema"];
      }
    }
    const resolve = (node: unknown, depth: number): unknown => {
      if (Array.isArray(node)) return node.map((n) => resolve(n, depth));
      if (!isObj(node)) return node;
      if (typeof node["$ref"] === "string" && depth < 4) return resolve(this.#deref(node, "").value, depth + 1);
      return Object.fromEntries(Object.entries(node).map(([k, x]) => [k, resolve(x, depth)]));
    };
    return schema === undefined ? null : resolve(schema, 0);
  }

  /** Whether the documented success response has an example (the mock can copy it) or only a schema. */
  hasExample(operation: string): boolean {
    for (const status of [200, 201, 202, 204]) {
      const found = this.#responseFor(operation, status);
      if (!found) continue;
      for (const media of Object.values(isObj(found.value["content"]) ? found.value["content"] : {})) {
        if (isObj(media) && (media["example"] !== undefined || isObj(media["examples"]) || (isObj(media["schema"]) && media["schema"]["example"] !== undefined))) return true;
      }
    }
    return false;
  }
}

/* ---------- Report: what the UI, the control API and CI read ---------- */

export interface ContractRuleStat {
  rule: string;
  side: "request" | "response";
  operation: string;
  where: string;
  count: number;
  lastAt: number;
  lastMessage: string;
  lastClient: string;
  /** The request that broke it last (redacted like the log). */
  lastRequest: { method: string; url: string; body: string } | null;
  routeId: string | null;
  responseId: string | null;
}

export interface ContractClientStat {
  client: string;
  requests: number;
  failing: number;
}

export interface ContractRecent {
  seq: number;
  at: number;
  method: string;
  url: string;
  status: number;
  client: string;
  violations: Violation[];
}

export interface ContractReport {
  mock: string;
  file: string;
  mode: ContractMode;
  operations: number;
  requests: number;
  failing: number;
  rules: ContractRuleStat[];
  clients: ContractClientStat[];
  recent: ContractRecent[];
}

const RECENT_KEEP = 50;
const CLIENT_KEEP = 50;

/** Client name for grouping: the User-Agent (first product), or the Origin. */
export function clientOf(headers: Record<string, string>): string {
  const ua = headers["user-agent"]?.trim();
  if (ua) return ua.split(/\s+/, 1)[0]!.slice(0, 60);
  return headers["origin"]?.slice(0, 60) ?? "desconocido";
}

/** Counts violations by rule and by client while a mock runs. */
export class ContractTracker {
  #rules = new Map<string, ContractRuleStat>();
  #clients = new Map<string, ContractClientStat>();
  #recent: ContractRecent[] = [];
  #requests = 0;
  #failing = 0;

  record(entry: { seq: number; at: number; method: string; url: string; status: number; routeId: string | null; responseId: string | null; request: { headers: Record<string, string>; body: string } }, violations: Violation[]): void {
    const client = clientOf(entry.request.headers);
    this.#requests++;
    const c = this.#clients.get(client) ?? { client, requests: 0, failing: 0 };
    c.requests++;
    if (violations.length) {
      this.#failing++;
      c.failing++;
      this.#recent.unshift({ seq: entry.seq, at: entry.at, method: entry.method, url: entry.url, status: entry.status, client, violations });
      if (this.#recent.length > RECENT_KEEP) this.#recent.length = RECENT_KEEP;
    }
    this.#clients.set(client, c);
    if (this.#clients.size > CLIENT_KEEP) this.#clients.delete(this.#clients.keys().next().value!);
    for (const v of violations) {
      const key = `${v.side} ${v.operation} ${v.rule}`;
      const stat = this.#rules.get(key) ?? { rule: v.rule, side: v.side, operation: v.operation, where: v.where, count: 0, lastAt: 0, lastMessage: "", lastClient: "", lastRequest: null, routeId: null, responseId: null };
      stat.count++;
      stat.lastAt = entry.at;
      stat.lastMessage = v.message;
      stat.lastClient = client;
      stat.lastRequest = { method: entry.method, url: entry.url, body: entry.request.body };
      if (v.side === "response") {
        stat.routeId = entry.routeId;
        stat.responseId = entry.responseId;
      }
      this.#rules.set(key, stat);
    }
  }

  report(meta: { mock: string; file: string; mode: ContractMode; operations: number }): ContractReport {
    return {
      ...meta,
      requests: this.#requests,
      failing: this.#failing,
      rules: [...this.#rules.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt),
      clients: [...this.#clients.values()].sort((a, b) => b.requests - a.requests),
      recent: structuredClone(this.#recent),
    };
  }

  clear(): void {
    this.#rules.clear();
    this.#clients.clear();
    this.#recent = [];
    this.#requests = 0;
    this.#failing = 0;
  }
}

/* ---------- Static checks: coverage and the mock's own responses ---------- */

export interface CoverageItem {
  method: string;
  path: string;
  routeId: string | null;
  hasExample: boolean;
}

export interface ResponseProblem {
  routeId: string;
  responseId: string;
  method: string;
  path: string;
  status: number;
  operation: string | null;
  message: string;
}

/** /pedidos/:id and /pedidos/{id} → /pedidos/* */
const shape = (path: string) =>
  path
    .replace(/\/+$/, "")
    .split("/")
    .map((s) => (s.startsWith(":") || /^\{[^}]+\}$/.test(s) ? "*" : s))
    .join("/") || "/";

/** Which contract operations a route of the mock serves. */
export function contractCoverage(config: MockConfig, contract: Contract): CoverageItem[] {
  return contract.operations.map((op) => {
    const route = config.routes.find((r) => {
      if (r.path.startsWith("^") || r.path.endsWith("*")) return false;
      if (r.crud) return shape(op.path) === shape(r.path) || shape(op.path) === `${shape(r.path)}/*`;
      return (r.method === op.method || r.method === "ANY") && shape(r.path) === shape(op.path);
    });
    return { method: op.method, path: op.path, routeId: route?.id ?? null, hasExample: contract.hasExample(`${op.method} ${op.path}`) };
  });
}

/**
 * Renders a response template with a sample request: every :param is "1" and
 * every scenario is in its initial state. Null when the template fails.
 */
export function sampleRenderer(config: MockConfig): (text: string, path: string) => string | null {
  const data = { buckets: config.buckets, variables: config.variables, env: config.env };
  const state = Object.fromEntries(config.scenarios.map((s) => [s.id, s.initial]));
  return (text, path) => {
    const params = Object.fromEntries([...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => [m[1]!, "1"]));
    try {
      return previewTemplate(text, data, { method: "GET", path, query: {}, headers: {}, cookies: {}, params, body: { raw: "", parsed: undefined }, requestNumber: 1, state });
    } catch {
      return null;
    }
  };
}

/**
 * Checks every fixed response of the mock against the contract, rendering
 * templates with a sample request (sampleRenderer by default). Catches a mock
 * that drifted from the API it imitates.
 */
export function checkMockResponses(config: MockConfig, contract: Contract, render = sampleRenderer(config)): ResponseProblem[] {
  const out: ResponseProblem[] = [];
  for (const route of config.routes) {
    if (route.crud || route.path.startsWith("^") || route.path.endsWith("*") || route.method === "ANY") continue;
    const op = contract.operations.find((o) => o.method === route.method && shape(o.path) === shape(route.path));
    for (const r of route.responses) {
      const base = { routeId: route.id, responseId: r.id, method: route.method, path: route.path, status: r.status, operation: op ? `${op.method} ${op.path}` : null };
      if (!op) {
        out.push({ ...base, message: "la operación no está en el contrato" });
        break;
      }
      let body: string | null = null;
      if (r.body?.kind === "text") body = r.template ? render(r.body.text, route.path) : r.body.text;
      if (r.body?.kind === "text" && body === null) continue;
      for (const v of contract.checkResponse(base.operation!, r.status, r.headers, body)) out.push({ ...base, message: v.message });
    }
  }
  return out;
}

/* ---------- JUnit for CI ---------- */

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface JUnitSuite {
  report: ContractReport;
  operations: ContractOperation[];
  /** Static drift of the mock's responses (routes outside the contract are ignored). */
  responseProblems?: ResponseProblem[];
}

/** One suite per mock: a test case per contract operation (failing when a request or the mock broke it), plus the requests outside the contract. */
export function contractJUnit(suites: JUnitSuite[]): string {
  const parts = suites.map(junitSuite);
  const tests = parts.reduce((n, p) => n + p.tests, 0);
  const failures = parts.reduce((n, p) => n + p.failures, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="mockix" tests="${tests}" failures="${failures}">
${parts.map((p) => p.xml).join("\n")}
</testsuites>
`;
}

function junitSuite({ report, operations, responseProblems = [] }: JUnitSuite): { xml: string; tests: number; failures: number } {
  const cases: string[] = [];
  let failures = 0;
  const suite = `contrato ${report.mock}`;
  for (const op of operations) {
    const key = `${op.method} ${op.path}`;
    const rules = report.rules.filter((r) => r.operation === key);
    const drift = responseProblems.filter((p) => p.operation === key);
    if (rules.length || drift.length) {
      failures++;
      const lines = [...rules.map((r) => `${r.side === "request" ? "petición" : "respuesta"}: ${r.rule} (${r.count}×, último: ${r.lastMessage}, cliente ${r.lastClient})`), ...drift.map((p) => `mock ${p.routeId} → ${p.responseId}: ${p.message}`)];
      cases.push(`    <testcase classname="${xml(suite)}" name="${xml(key)}"><failure message="${xml(lines[0]!)}">${xml(lines.join("\n"))}</failure></testcase>`);
    } else cases.push(`    <testcase classname="${xml(suite)}" name="${xml(key)}"/>`);
  }
  for (const r of report.rules.filter((x) => x.where === "operation")) {
    failures++;
    cases.push(`    <testcase classname="${xml(suite)}" name="${xml(r.operation)}"><failure message="${xml(r.rule)}">${xml(`${r.count} peticiones; último cliente ${r.lastClient}`)}</failure></testcase>`);
  }
  return {
    tests: cases.length,
    failures,
    xml: `  <testsuite name="${xml(suite)}" tests="${cases.length}" failures="${failures}" file="${xml(report.file)}">
${cases.join("\n")}
  </testsuite>`,
  };
}
