import type { ChaosDecisionView, MockState, RequestLog } from "@shared/ipc";

export const STATE_LABEL: Record<MockState, string> = {
  stopped: "Detenido",
  starting: "Iniciando",
  running: "En marcha",
  restarting: "Reiniciando",
  failed: "Con errores",
};

export const MODE_LABEL: Record<string, string> = { rules: "Reglas", random: "Aleatorio", sequential: "Secuencial", fallback: "Fallback", crud: "CRUD" };

const PHRASE: Record<number, string> = {
  100: "Continue", 101: "Switching", 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 410: "Gone", 413: "Too Large",
  415: "Unsupported Media", 422: "Unprocessable", 429: "Too Many Requests", 500: "Internal Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Unavailable", 504: "Gateway Timeout",
};
export const COMMON_STATUSES = [200, 201, 202, 204, 301, 302, 304, 400, 401, 403, 404, 405, 409, 410, 422, 429, 500, 502, 503, 504];

export const phrase = (code: number) => PHRASE[code] ?? "";
export const statusText = (code: number) => `${code} ${phrase(code)}`.trim();
export const tone = (code: number) => (code < 400 ? "ok" : "err");

export const METHOD_CLASS: Record<string, string> = {
  GET: "m-get",
  POST: "m-post",
  PUT: "m-put",
  PATCH: "m-patch",
  DELETE: "m-delete",
  HEAD: "m-any",
  OPTIONS: "m-any",
  ANY: "m-any",
};
export const shortMethod = (m: string) => (m === "DELETE" ? "DEL" : m === "OPTIONS" ? "OPT" : m);
export const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"] as const;

export const time = (epoch: number) => new Date(epoch).toLocaleTimeString("es-MX", { hour12: false });
export const folderName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir;

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

export function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(2).replace(".", ",")} s` : `${Math.round(n * 10) / 10} ms`;
}

/** Size of the response body as captured (an approximation for truncated bodies). */
export function responseSize(row: RequestLog): number {
  const declared = Number(row.response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > 0) return declared;
  return new TextEncoder().encode(row.response.body).length;
}

/** A path with :params and * replaced by sample values, ready to send. */
export function samplePath(pattern: string): string | null {
  if (pattern.startsWith("^")) return null;
  return pattern.replace(/:([A-Za-z0-9_]+)/g, "1").replace(/\/\*$/, "").replace(/\*$/, "") || "/";
}

/** Splits a route path into text and :param pieces, for the amber chips. */
export function pathPieces(path: string): Array<{ text: string; param: boolean }> {
  if (path.startsWith("^")) return [{ text: path, param: false }];
  const out: Array<{ text: string; param: boolean }> = [];
  for (const part of path.split(/(:[A-Za-z0-9_]+|\*)/)) if (part) out.push({ text: part, param: part.startsWith(":") || part === "*" });
  return out;
}

export function curlFor(method: string, url: string, headers: Record<string, string>, body: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const parts = [`curl -X ${method} ${q(url)}`];
  for (const [k, v] of Object.entries(headers)) if (!["host", "content-length", "connection"].includes(k.toLowerCase()) && v !== "[redactado]") parts.push(`-H ${q(`${k}: ${v}`)}`);
  if (body) parts.push(`--data-raw ${q(body)}`);
  return parts.join(" \\\n  ");
}

/** What chaos did to a request, in a few words ("error 503 · +627 ms"). */
export function chaosText(d: ChaosDecisionView): string {
  if (d.drop) return "conexión cortada";
  if (d.timeout) return "sin respuesta";
  return [d.error !== null ? `error ${d.error}` : null, d.latencyMs > 0 ? `+${d.latencyMs} ms` : null, d.trickleKBps !== null ? `lento ${d.trickleKBps} KB/s` : null].filter(Boolean).join(" · ");
}
