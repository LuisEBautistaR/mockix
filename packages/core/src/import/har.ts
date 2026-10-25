/** HAR (browser or proxy traffic) → mock, through the shared traffic converter. */
import { exchangesToRoutes, type Exchange } from "./exchanges.js";
import { ImportError, nameFromUrl, newReport, type ImportResult } from "./model.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const headerMap = (list: unknown): Record<string, string> =>
  Object.fromEntries((Array.isArray(list) ? list : []).filter(isObj).map((h) => [String(h["name"]), String(h["value"] ?? "")]));

export function importHar(value: unknown, source: string, prefix = ""): ImportResult {
  const entries = isObj(value) && isObj(value["log"]) && Array.isArray(value["log"]["entries"]) ? (value["log"]["entries"] as unknown[]) : null;
  if (!entries) throw new ImportError("No es un HAR: falta log.entries");
  const report = newReport("har", source);
  const exchanges: Exchange[] = [];
  const origins = new Map<string, number>();

  for (const entry of entries.filter(isObj)) {
    const req = isObj(entry["request"]) ? entry["request"] : null;
    const res = isObj(entry["response"]) ? entry["response"] : null;
    if (!req || !res || typeof req["url"] !== "string") continue;
    let url: URL;
    try {
      url = new URL(req["url"]);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (typeof res["status"] !== "number" || res["status"] < 100) {
      report.skipped.push(`${req["method"]} ${url.pathname}: sin respuesta (estado ${String(res["status"])})`);
      continue;
    }
    origins.set(url.origin, (origins.get(url.origin) ?? 0) + 1);
    const content = isObj(res["content"]) ? res["content"] : {};
    const mime = String(content["mimeType"] ?? "");
    const base64 = content["encoding"] === "base64";
    const textual = /json|text|xml|javascript|x-www-form-urlencoded|svg/i.test(mime);
    let body = typeof content["text"] === "string" ? content["text"] : "";
    if (base64 && textual) body = Buffer.from(body, "base64").toString("utf8");
    const postData = isObj(req["postData"]) ? req["postData"] : {};
    exchanges.push({
      method: String(req["method"] ?? "GET"),
      url: url.pathname + url.search,
      requestHeaders: headerMap(req["headers"]),
      requestBody: typeof postData["text"] === "string" ? postData["text"] : "",
      status: res["status"],
      responseHeaders: headerMap(res["headers"]),
      responseBody: body,
      binary: !!body && !textual,
    });
  }
  if (exchanges.length === 0) throw new ImportError("El HAR no tiene peticiones HTTP con respuesta");

  const origin = [...origins].sort((a, b) => b[1] - a[1])[0]![0];
  if (origins.size > 1) report.warnings.push(`El HAR mezcla ${origins.size} orígenes; todas sus rutas van al mismo mock (el principal es ${origin})`);
  const converted = exchangesToRoutes(exchanges, { prefix });
  report.routes = converted.routes.length;
  report.responses = converted.responses;
  report.fromExamples = converted.responses;
  report.warnings.push(...converted.warnings);
  if (converted.redacted) report.warnings.push(converted.redacted === 1 ? "1 valor sensible sustituido por datos falsos (tokens, correos, teléfonos…)" : `${converted.redacted} valores sensibles sustituidos por datos falsos (tokens, correos, teléfonos…)`);
  report.source = `${source} · ${origin}`;

  return {
    mock: { name: nameFromUrl(origin, "har"), port: 3000, prefix, variables: {}, buckets: {}, routes: converted.routes },
    report,
  };
}
