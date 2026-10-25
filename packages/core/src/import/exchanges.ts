/**
 * Recorded or example traffic → routes. Shared by the HAR and Postman
 * importers and by recording (M5):
 *
 *  - path parameters are inferred from values that look like ids
 *    (/clientes/1043 and /clientes/2001 → /clientes/:id);
 *  - exchanges of one route that answered differently become separate
 *    responses, with a rule deduced from what tells their requests apart;
 *  - credentials are redacted: secret headers and query keys are dropped and
 *    sensitive JSON fields are replaced by fake data templates.
 */
import { compilePath } from "../path.js";
import type { ResponseDraft, RouteDraft } from "../edit.js";
import type { ImportedRoute } from "./model.js";

type RuleDraftShape = NonNullable<ResponseDraft["rules"]>["when"][number];

export interface Exchange {
  method: string;
  /** Absolute URL, or a path with its query. */
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  binary: boolean;
  /** Bytes of a binary response (recordings keep them; imports may not). */
  responseBytes?: Uint8Array | undefined;
  /** Epoch ms when it was recorded. */
  at?: number | undefined;
}

export interface RedactionRule {
  where: "header" | "query" | "json";
  /** Names separated by "|", case-insensitive. */
  match: string;
  action: "remove" | "faker";
  /** faker path and arguments for action "faker", e.g. "internet.email" or "string.alphanumeric 24". */
  faker?: string;
}

export const DEFAULT_REDACTION: RedactionRule[] = [
  { where: "header", match: "authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token", action: "remove" },
  { where: "query", match: "api_key|apikey|access_token|token|key|signature|sig", action: "remove" },
  { where: "json", match: "token|access_token|refresh_token|id_token|password|contrasena|secret|api_key|apikey|token_recuperacion", action: "faker", faker: "string.alphanumeric 24" },
  { where: "json", match: "email|correo|mail", action: "faker", faker: "internet.email" },
  { where: "json", match: "phone|telefono|celular|movil|mobile", action: "faker", faker: "phone.number" },
  { where: "json", match: "card_number|tarjeta|cvv|iban|clabe", action: "faker", faker: "finance.accountNumber" },
];

export interface ConvertOptions {
  /** Stripped from paths when present. */
  prefix?: string;
  redaction?: RedactionRule[];
  /** Folder under routes/ for every route. */
  folder?: string;
  /** Use this route path instead of inferring one (Postman requests already have one). */
  fixedPath?: string;
  method?: string;
  id?: string;
  description?: string;
  /** Bodies are already Mockix templates (Postman examples converted): do not escape their "{{". */
  templateBodies?: boolean;
  /** Keep binary bodies as files (returned in `files`) instead of dropping them. */
  binaryFiles?: boolean;
}

export interface ConvertResult {
  routes: ImportedRoute[];
  responses: number;
  redacted: number;
  warnings: string[];
  /** Binary bodies to write under files/, by name (with binaryFiles). */
  files: Record<string, Uint8Array>;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/x-icon": "ico", "application/pdf": "pdf", "application/zip": "zip", "font/woff2": "woff2" };

/** A file name for a binary body: the URL's own name when it has one, otherwise one from the route. */
function binaryName(url: string, routeId: string, status: number, type: string, taken: Record<string, unknown>): string {
  const last = new URL(url, "http://x").pathname.split("/").pop() ?? "";
  const ext = EXT[type.split(";")[0]!.trim().toLowerCase()] ?? "bin";
  const base = /^[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,6}$/.test(last) ? last : `${routeId.replace(/[^a-z0-9-]+/g, "-")}-${status}.${ext}`;
  let name = base;
  for (let n = 2; name in taken; n++) name = base.replace(/(\.[^.]+)?$/, `-${n}$1`);
  return name;
}

const DROP_RESPONSE_HEADERS = new Set(["date", "content-length", "transfer-encoding", "connection", "keep-alive", "server", "etag", "last-modified", "vary", "age", "via", "alt-svc", "strict-transport-security", "x-powered-by", "content-encoding"]);
const RULE_HEADERS = /^(x-[a-z0-9-]+|accept-language|accept)$/i;

const names = (match: string) => new Set(match.toLowerCase().split("|").map((s) => s.trim()).filter(Boolean));

/** Does a path segment look like an id rather than a fixed word? */
export function looksLikeId(segment: string): boolean {
  return (
    /^\d+$/.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
    /^[0-9a-f]{16,}$/i.test(segment) ||
    /^[A-Za-z]{1,6}[_-](?=[A-Za-z0-9]*\d)[A-Za-z0-9]{3,}$/.test(segment) ||
    /^[A-Z]{2,5}-[A-Z0-9-]*\d[A-Z0-9-]*$/.test(segment)
  );
}

function singular(word: string): string {
  const w = word.replace(/[^A-Za-z0-9_]/g, "_");
  if (/[^aeiou]es$/i.test(w) && w.length > 4) return w.slice(0, -2);
  if (/s$/i.test(w) && w.length > 3) return w.slice(0, -1);
  return w || "param";
}

/** /clientes/1043/pedidos/7d1e… → /clientes/:id/pedidos/:pedido */
export function inferPath(path: string): string {
  const segments = path.split("/");
  let params = 0;
  return segments
    .map((s, i) => {
      if (!s || !looksLikeId(s)) return s;
      params++;
      return params === 1 ? ":id" : `:${singular(segments[i - 1] ?? "param")}`;
    })
    .join("/");
}

function splitUrl(url: string): { path: string; query: URLSearchParams } {
  const u = new URL(url, "http://placeholder");
  return { path: decodeURIComponent(u.pathname), query: u.searchParams };
}

function stripPrefix(prefix: string | undefined, path: string): string {
  if (!prefix) return path;
  if (path === prefix) return "/";
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
}

interface Prepared {
  ex: Exchange;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  bodyKey: string;
}

/** Replaces sensitive JSON fields with fake-data templates. Returns the text and how many fields changed. */
function redactJson(text: string, rules: RedactionRule[], escape = true): { text: string; count: number; json: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { text, count: 0, json: false };
  }
  const jsonRules = rules.filter((r) => r.where === "json");
  let count = 0;
  const marks = new Map<string, string>();
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v)) {
      const rule = jsonRules.find((r) => names(r.match).has(k.toLowerCase()));
      if (rule && inner !== null && typeof inner !== "object") {
        count++;
        if (rule.action === "remove") continue;
        const [path, ...args] = (rule.faker ?? "string.alphanumeric 16").split(/\s+/);
        const mark = `__mockix_${marks.size}__`;
        marks.set(mark, `{{faker '${path}'${args.length ? ` ${args.join(" ")}` : ""}}}`);
        out[k] = mark;
      } else out[k] = walk(inner);
    }
    return out;
  };
  const redacted = walk(value);
  let out = JSON.stringify(redacted, null, 2);
  if (escape) out = out.replace(/\{\{/g, "\\{{");
  for (const [mark, tpl] of marks) out = out.replace(`"${mark}"`, `"${tpl}"`);
  return { text: `${out}\n`, count, json: true };
}

function responseHeaders(headers: Record<string, string>, rules: RedactionRule[]): Record<string, string> {
  const secret = new Set(rules.filter((r) => r.where === "header").flatMap((r) => [...names(r.match)]));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(key) || secret.has(key) || key.startsWith("access-control-")) continue;
    out[key === "content-type" ? "Content-Type" : k] = v;
  }
  return out;
}

/** A value present in every exchange of `group` and in no exchange outside it. */
function distinguishing(group: Prepared[], others: Prepared[], pick: (p: Prepared) => Record<string, string>): { key: string; values: string[] } | null {
  const keys = new Set(group.flatMap((p) => Object.keys(pick(p))));
  for (const key of keys) {
    const inGroup = group.map((p) => pick(p)[key]);
    if (inGroup.some((v) => v === undefined)) continue;
    const values = [...new Set(inGroup as string[])];
    if (values.length > 5) continue;
    const outside = new Set(others.map((p) => pick(p)[key]));
    if (values.every((v) => !outside.has(v))) return { key, values };
  }
  return null;
}

export function exchangesToRoutes(exchanges: Exchange[], options: ConvertOptions = {}): ConvertResult {
  const rules = options.redaction ?? DEFAULT_REDACTION;
  const secretHeaders = new Set(rules.filter((r) => r.where === "header").flatMap((r) => [...names(r.match)]));
  const secretQuery = new Set(rules.filter((r) => r.where === "query").flatMap((r) => [...names(r.match)]));
  const warnings: string[] = [];
  const files: Record<string, Uint8Array> = {};
  let redacted = 0;
  let responses = 0;

  // 1. Route path for every exchange.
  const fixed = options.fixedPath ? compilePath(options.fixedPath) : null;
  const byRoute = new Map<string, Prepared[]>();
  for (const ex of exchanges) {
    const { path: raw, query } = splitUrl(ex.url);
    const local = stripPrefix(options.prefix, raw);
    const path = options.fixedPath ?? inferPath(local);
    const params = fixed ? (fixed(local) ?? {}) : (compilePath(path)(local) ?? {});
    const q: Record<string, string> = {};
    for (const [k, v] of query) if (!secretQuery.has(k.toLowerCase())) q[k] = v;
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(ex.requestHeaders)) if (RULE_HEADERS.test(k) && !secretHeaders.has(k.toLowerCase())) h[k.toLowerCase()] = v;
    const method = (options.method ?? ex.method).toUpperCase();
    const key = `${method} ${path}`;
    byRoute.set(key, [...(byRoute.get(key) ?? []), { ex, path, params, query: q, headers: h, bodyKey: `${ex.status}\u0000${ex.binary ? "binary" : canonical(ex.responseBody, params)}` }]);
  }

  const routes: ImportedRoute[] = [];
  for (const [key, items] of byRoute) {
    const [method, path] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
    // 2. One response per distinct answer; the most common success is the default.
    const groups = new Map<string, Prepared[]>();
    for (const p of items) groups.set(p.bodyKey, [...(groups.get(p.bodyKey) ?? []), p]);
    const ordered = [...groups.values()].sort((a, b) => {
      const sa = a[0]!.ex.status < 300 ? 0 : 1;
      const sb = b[0]!.ex.status < 300 ? 0 : 1;
      return sa - sb || b.length - a.length;
    });
    const drafts: ResponseDraft[] = [];
    const usedIds = new Set<string>();
    ordered.forEach((group, index) => {
      const first = group[0]!.ex;
      const others = items.filter((p) => !group.includes(p));
      let id = index === 0 ? "ok" : first.status >= 400 ? `error-${first.status}` : `r-${first.status}`;
      for (let n = 2; usedIds.has(id); n++) id = `${index === 0 ? "ok" : first.status >= 400 ? `error-${first.status}` : `r-${first.status}`}-${n}`;
      usedIds.add(id);
      const draft: ResponseDraft = { id, status: first.status, body: { kind: "none" } };
      const headers = responseHeaders(first.responseHeaders, rules);
      if (Object.keys(headers).length) draft.headers = headers;

      if (first.binary) {
        if (options.binaryFiles && first.responseBytes) {
          const type = Object.entries(first.responseHeaders).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
          const name = binaryName(first.url, `${method.toLowerCase()}${path.replace(/[:*]/g, "")}`, first.status, type, files);
          files[name] = first.responseBytes;
          draft.body = { kind: "file", path: `/files/${name}`, text: null };
        } else warnings.push(`${method} ${path}: cuerpo binario de ${first.status} omitido`);
      } else if (first.responseBody) {
        const r = redactJson(first.responseBody, rules, !options.templateBodies);
        redacted += r.count;
        let text = r.json ? r.text : options.templateBodies ? first.responseBody : first.responseBody.replace(/\{\{/g, "\\{{");
        // A top-level id equal to the URL's id becomes {{urlParam 'id'}}.
        if (r.json && index === 0 && group[0]!.params["id"] !== undefined) {
          const v = group[0]!.params["id"]!;
          text = text.replace(new RegExp(`^(  "id": )("${escapeRe(v)}"|${/^\d+$/.test(v) ? escapeRe(v) : "(?!)"})(,?)$`, "m"), (_m, pre: string, val: string, comma: string) => `${pre}${val.startsWith('"') ? `"{{urlParam 'id'}}"` : "{{urlParam 'id'}}"}${comma}`);
        }
        // Literal "{{" is escaped as "\{{", so the body stays a template either way.
        draft.body = { kind: "inline", text };
      }

      if (index === 0) draft.default = true;
      else {
        const rule = ruleFor(group, others);
        if (rule) draft.rules = { when: [rule] };
        else warnings.push(`${method} ${path}: la respuesta ${first.status} no se distingue de las demás por la petición; queda sin reglas`);
      }
      drafts.push(draft);
    });
    responses += drafts.length;

    const id = options.id ?? `${method.toLowerCase()}${path.replace(/[:*]/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`.replace(/-+$/, "");
    const draft: RouteDraft = { id: options.folder ? `${options.folder}/${id}` : id, method, path, responses: drafts };
    if (options.description) draft.description = options.description;
    routes.push({ folder: options.folder ?? "", draft });
  }
  return { routes, responses, redacted, warnings, files };
}

function ruleFor(group: Prepared[], others: Prepared[]): RuleDraftShape | null {
  const param = distinguishing(group, others, (p) => p.params);
  if (param) return param.values.length === 1 ? { target: `params.${param.key}`, op: "equals", value: param.values[0] } : { target: `params.${param.key}`, op: "in", value: param.values };
  const query = distinguishing(group, others, (p) => p.query);
  if (query) return query.values.length === 1 ? { target: `query.${query.key}`, op: "equals", value: query.values[0] } : { target: `query.${query.key}`, op: "in", value: query.values };
  const header = distinguishing(group, others, (p) => p.headers);
  if (header) return header.values.length === 1 ? { target: `header.${header.key}`, op: "equals", value: header.values[0] } : { target: `header.${header.key}`, op: "in", value: header.values };
  return null;
}

/** Comparable form of a body: JSON normalised, and top-level values that echo a path parameter (the id) ignored. */
function canonical(text: string, params: Record<string, string> = {}): string {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const echoes = new Set(Object.values(params));
      for (const [k, v] of Object.entries(value)) if ((typeof v === "string" || typeof v === "number") && echoes.has(String(v))) (value as Record<string, unknown>)[k] = `__param__`;
    }
    return JSON.stringify(value);
  } catch {
    return text;
  }
}

/** Same comparison for answers already in a mock (used when merging a recording). */
export function answerKey(status: number, text: string): string {
  return `${status}\u0000${canonical(text)}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
