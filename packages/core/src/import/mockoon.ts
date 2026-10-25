/**
 * Mockoon environment file → mock. The field names follow Mockoon's public
 * documentation of its data files; this is an interoperability importer and
 * shares no code with Mockoon.
 */
import { stringify } from "yaml";
import type { ResponseDraft, RouteDraft } from "../edit.js";
import { checkTemplate } from "../template.js";
import { ImportError, newReport, slugify, type ImportResult, type ImportedRoute } from "./model.js";

type Obj = Record<string, unknown>;
type RuleDraft = NonNullable<ResponseDraft["rules"]>["when"][number];
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const headerMap = (list: unknown): Record<string, string> =>
  Object.fromEntries((Array.isArray(list) ? list : []).filter(isObj).filter((h) => str(h["key"])).map((h) => [str(h["key"]), str(h["value"])]));

const TARGETS: Record<string, (modifier: string) => string | null> = {
  body: (m) => (m ? `body.${m.replace(/^\$\.?/, "")}` : "body"),
  query: (m) => (m ? `query.${m}` : null),
  header: (m) => (m ? `header.${m}` : null),
  cookie: (m) => (m ? `cookie.${m}` : null),
  params: (m) => (m ? `params.${m}` : null),
  path: () => "path",
  method: () => "method",
  request_number: () => "request.number",
};

function convertRule(rule: Obj, warn: (w: string) => void): RuleDraft | null {
  const target = TARGETS[str(rule["target"])];
  const path = target?.(str(rule["modifier"]));
  if (!path) {
    warn(`regla sobre "${str(rule["target"])}" sin equivalente (${str(rule["target"]) === "data_bucket" || str(rule["target"]) === "global_var" ? "llega con los escenarios en M6" : "se omite"})`);
    return null;
  }
  const negate = rule["invert"] === true ? true : undefined;
  const value = rule["value"];
  switch (str(rule["operator"], "equals")) {
    case "equals":
      return { target: path, op: "equals", value: typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) && path === "request.number" ? Number(value) : value, negate };
    case "regex":
      return { target: path, op: "regex", value, negate };
    case "regex_i":
      warn(`regex sin distinguir mayúsculas convertida a regex normal: ${String(value)}`);
      return { target: path, op: "regex", value, negate };
    case "null":
      return { target: path, op: "null", negate };
    case "empty_array":
      return { target: path, op: "empty", negate };
    case "array_includes":
      return { target: path, op: "contains", value, negate };
    case "valid_json_schema":
      warn("regla valid_json_schema: la validación con esquemas llega con los contratos en M6");
      return null;
    default:
      warn(`operador "${str(rule["operator"])}" sin equivalente`);
      return null;
  }
}

/** Mockoon's {{data 'name'}} uses bucket names or ids; ours uses the bucket slug. */
function rewriteBucketRefs(text: string, ids: Map<string, string>): string {
  return text.replace(/\{\{(data|dataRaw)\s+'([^']+)'/g, (m, helper: string, ref: string) => {
    const slug = ids.get(ref);
    return slug ? `{{${helper} '${slug}'` : m;
  });
}

export function importMockoon(value: unknown, source: string): ImportResult {
  if (!isObj(value) || !Array.isArray(value["routes"])) throw new ImportError("No es un entorno de Mockoon: falta routes");
  const name = str(value["name"], "mockoon");
  const report = newReport("mockoon", `${name} (${source})`);
  const envHeaders = headerMap(value["headers"]);

  // Data buckets: by id and by name, both pointing to our slug.
  const buckets: Record<string, unknown> = {};
  const bucketIds = new Map<string, string>();
  for (const b of Array.isArray(value["data"]) ? value["data"].filter(isObj) : []) {
    const slug = slugify(str(b["name"], "bucket"), "bucket");
    try {
      buckets[slug] = JSON.parse(str(b["value"], "null"));
      for (const ref of [str(b["uuid"]), str(b["id"]), str(b["name"])]) if (ref) bucketIds.set(ref, slug);
    } catch {
      report.warnings.push(`bucket "${str(b["name"])}": su valor no es JSON (las plantillas dentro de buckets no se importan)`);
    }
  }

  const routes: ImportedRoute[] = [];
  const extraWs: Record<string, string> = {};
  const usedIds = new Set<string>();
  for (const route of value["routes"].filter(isObj)) {
    const type = str(route["type"], "http");
    const endpoint = `/${str(route["endpoint"]).replace(/^\/+/, "")}`;
    const method = str(route["method"], "get").toUpperCase();
    const label = `${method} ${endpoint}`;
    if (type === "ws") {
      const list = (Array.isArray(route["responses"]) ? route["responses"] : []).filter(isObj);
      const warnWs = (w: string) => report.warnings.push(`WS ${endpoint}: ${w}`);
      const body = (r: Obj) => rewriteBucketRefs(str(r["body"]), bucketIds);
      const id = slugify(`ws-${endpoint.replace(/[:*]/g, "")}`, "ws");
      const def: Record<string, unknown> = { id, protocol: "ws", path: endpoint, description: str(route["documentation"]) || `Importado de Mockoon (${label})` };
      const streaming = str(route["streamingMode"]).toUpperCase();
      if (streaming && list.length) {
        const every = typeof route["streamingInterval"] === "number" && route["streamingInterval"] > 0 ? route["streamingInterval"] : 1000;
        def["onConnect"] = [{ every, send: body(list.find((r) => r["default"] === true) ?? list[0]!), ...(streaming === "BROADCAST" ? { to: "all" } : {}) }];
      } else {
        def["messages"] = list.map((r, i) => {
          const rules = (Array.isArray(r["rules"]) ? r["rules"] : []).filter(isObj).map((x) => convertRule(str(x["target"]) === "message" ? { ...x, target: "body" } : x, warnWs)).filter((x): x is RuleDraft => x !== null);
          return {
            id: slugify(str(r["label"]), i === 0 ? "respuesta" : `respuesta-${i + 1}`),
            ...(r["default"] === true || (i === 0 && !list.some((x) => x["default"] === true)) ? { default: true } : {}),
            ...(rules.length ? { rules: { mode: str(r["rulesOperator"], "OR") === "AND" ? "all" : "any", when: rules } } : {}),
            reply: body(r),
          };
        });
      }
      extraWs[`routes/${id}.yaml`] = stringify(def);
      report.routes++;
      report.responses += list.length;
      report.fromExamples += list.length;
      continue;
    }
    let id = slugify(`${type === "crud" ? "crud" : method.toLowerCase()}-${endpoint.replace(/[:*]/g, "")}`, "ruta");
    for (let n = 2; usedIds.has(id); n++) id = `${id}-${n}`;
    usedIds.add(id);
    const warn = (w: string) => report.warnings.push(`${label}: ${w}`);
    const docs = str(route["documentation"]);
    const list = (Array.isArray(route["responses"]) ? route["responses"] : []).filter(isObj);

    if (type === "crud") {
      const bucketRef = str(list[0]?.["databucketID"]);
      const bucket = bucketIds.get(bucketRef);
      if (!bucket || !Array.isArray(buckets[bucket])) {
        report.skipped.push(`${label}: ruta CRUD sin un bucket de lista`);
        continue;
      }
      const draft: RouteDraft = { id, path: endpoint, crud: { bucket, key: str(list[0]?.["crudKey"], "id") }, ...(docs ? { description: docs } : {}) };
      routes.push({ folder: "", draft });
      report.routes++;
      continue;
    }

    const responses: ResponseDraft[] = [];
    const usedResp = new Set<string>();
    for (const [i, r] of list.entries()) {
      const status = typeof r["statusCode"] === "number" ? r["statusCode"] : 200;
      let rid = slugify(str(r["label"]), i === 0 ? "ok" : `r-${status}`);
      for (let n = 2; usedResp.has(rid); n++) rid = `${rid}-${n}`;
      usedResp.add(rid);
      const headers = { ...envHeaders, ...headerMap(r["headers"]) };
      const draft: ResponseDraft = { id: rid, status, body: { kind: "none" } };
      if (Object.keys(headers).length) draft.headers = headers;
      if (r["default"] === true) draft.default = true;
      if (typeof r["latency"] === "number" && r["latency"] > 0) draft.latency = r["latency"];
      if (str(r["label"]) && str(r["label"]) !== rid) draft.description = str(r["label"]);

      const bodyType = str(r["bodyType"], "INLINE");
      if (bodyType === "FILE") {
        warn(`la respuesta "${rid}" sirve el archivo ${str(r["filePath"])}; cópialo a files/ y apunta body a él`);
        draft.body = { kind: "inline", text: "" };
      } else if (bodyType === "DATABUCKET") {
        const bucket = bucketIds.get(str(r["databucketID"]));
        draft.body = bucket ? { kind: "inline", text: `{{json (dataRaw '${bucket}') 2}}\n` } : { kind: "inline", text: "" };
        if (!bucket) warn(`la respuesta "${rid}" usa un bucket que no se importó`);
      } else {
        draft.body = { kind: "inline", text: rewriteBucketRefs(str(r["body"]), bucketIds) };
      }
      if (r["disableTemplating"] === true) draft.template = false;
      else if (draft.body.kind === "inline" && draft.body.text.includes("{{")) {
        try {
          checkTemplate(draft.body.text);
        } catch (err) {
          draft.template = false;
          warn(`la respuesta "${rid}" usa helpers sin equivalente; se sirve como texto (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`);
        }
      }

      const rules = (Array.isArray(r["rules"]) ? r["rules"] : []).filter(isObj).map((x) => convertRule(x, warn)).filter((x): x is RuleDraft => x !== null);
      if (rules.length) draft.rules = { mode: str(r["rulesOperator"], "OR") === "AND" ? "all" : "any", when: rules };
      if (Array.isArray(r["callbacks"]) && r["callbacks"].length) warn(`la respuesta "${rid}" tiene callbacks: revísalos y añádelos a callbacks en el YAML`);
      responses.push(draft);
    }
    if (responses.length === 0) responses.push({ id: "ok", default: true, status: 200, body: { kind: "inline", text: "" } });
    if (!responses.some((r) => r.default)) responses[0]!.default = true;

    const draft: RouteDraft = { id, method: method === "ALL" ? "ANY" : method, path: endpoint, responses, ...(docs ? { description: docs } : {}) };
    switch (route["responseMode"]) {
      case "RANDOM":
        draft.mode = "random";
        break;
      case "SEQUENTIAL":
        draft.mode = "sequential";
        break;
      case "FALLBACK":
        draft.mode = "fallback";
        break;
      case "DISABLE_RULES":
        for (const resp of responses) delete resp.rules;
        warn("modo «sin reglas»: se quitan las reglas y responde la de por defecto");
        break;
    }
    routes.push({ folder: "", draft });
    report.routes++;
    report.responses += responses.length;
    report.fromExamples += responses.length;
  }

  const prefix = str(value["endpointPrefix"]).replace(/^\/*/, "/").replace(/\/+$/, "");
  const proxyHost = str(value["proxyHost"]);
  if (value["tlsOptions"] && isObj(value["tlsOptions"]) && value["tlsOptions"]["enabled"] === true) report.warnings.push("TLS activo en el original: pon tls: true en mock.yaml si lo quieres");
  return {
    mock: {
      name: slugify(name, "mockoon"),
      port: typeof value["port"] === "number" ? value["port"] : 3000,
      prefix: prefix === "/" ? "" : prefix,
      ...(typeof value["latency"] === "number" && value["latency"] > 0 ? { latency: value["latency"] } : {}),
      ...(typeof value["cors"] === "boolean" ? { cors: value["cors"] } : {}),
      ...(value["proxyMode"] === true && /^https?:\/\//.test(proxyHost) ? { proxy: { target: proxyHost, keepPrefix: value["proxyRemovePrefix"] !== true } } : {}),
      variables: {},
      buckets,
      routes,
      ...(Object.keys(extraWs).length ? { extraFiles: extraWs } : {}),
    },
    report,
  };
}
