/**
 * OpenAPI 3.0/3.1 and Swagger 2 → mock, and mock → OpenAPI 3.1.
 *
 * Import: one route per operation (folder = first tag), one response per
 * status code. A response body comes from the example when there is one, and
 * otherwise from the schema as a template with fake data. openapi-extras.ts
 * adds the rest (picking a response, CRUD, scenarios, chaos errors).
 */
import SwaggerParser from "@apidevtools/swagger-parser";
import type { MockConfig } from "../runtime.js";
import type { ResponseDraft } from "../edit.js";
import { ImportError, escapeMustaches, newReport, slugify, type ImportResult, type ImportedRoute } from "./model.js";
import { addPicker, enrichOpenApi, type SourceOperation } from "./openapi-extras.js";
import { templateFromSchema } from "./schema-template.js";

type Obj = Record<string, unknown>;
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** /pets/{petId} → /pets/:petId (names keep only characters a :param allows). */
export function toMockPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_m, name: string) => `:${name.replace(/[^A-Za-z0-9_]/g, "_")}`);
}

/** /pets/:petId → /pets/{petId} */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\/\*$/, "/{rest}");
}

function prefixFrom(doc: Obj): string {
  const servers = doc["servers"];
  if (Array.isArray(servers) && isObj(servers[0]) && typeof servers[0]["url"] === "string") {
    try {
      const path = new URL(servers[0]["url"], "http://placeholder").pathname.replace(/\/+$/, "");
      return /^(\/[^/\s?#{}]+)*$/.test(path) ? path : "";
    } catch {
      return "";
    }
  }
  if (typeof doc["basePath"] === "string") return doc["basePath"].replace(/\/+$/, "");
  return "";
}

/** Example and schema of the preferred media type of a response. */
function mediaOf(response: Obj, swagger2: boolean): { type: string | null; example: unknown; hasExample: boolean; schema: unknown } {
  if (swagger2) {
    const examples = isObj(response["examples"]) ? response["examples"] : {};
    const type = Object.keys(examples)[0] ?? (response["schema"] ? "application/json" : null);
    const hasExample = type !== null && type in examples;
    return { type, example: hasExample ? examples[type!] : undefined, hasExample, schema: response["schema"] };
  }
  const content = isObj(response["content"]) ? response["content"] : {};
  const types = Object.keys(content);
  const type = types.find((t) => t.includes("json")) ?? types[0] ?? null;
  if (!type) return { type: null, example: undefined, hasExample: false, schema: undefined };
  const media = isObj(content[type]) ? content[type] : {};
  if ("example" in media) return { type, example: media["example"], hasExample: true, schema: media["schema"] };
  if (isObj(media["examples"])) {
    const first = Object.values(media["examples"])[0];
    if (isObj(first) && "value" in first) return { type, example: first["value"], hasExample: true, schema: media["schema"] };
  }
  const schema = media["schema"];
  if (isObj(schema) && "example" in schema) return { type, example: schema["example"], hasExample: true, schema };
  return { type, example: undefined, hasExample: false, schema };
}

export async function importOpenApi(value: unknown, source: string): Promise<ImportResult> {
  if (!isObj(value)) throw new ImportError("No es un documento OpenAPI");
  let doc: Obj;
  try {
    doc = (await SwaggerParser.dereference(structuredClone(value) as never, { dereference: { circular: "ignore" } })) as unknown as Obj;
  } catch (err) {
    throw new ImportError(`El documento OpenAPI no es válido: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  const swagger2 = typeof doc["swagger"] === "string";
  const info = isObj(doc["info"]) ? doc["info"] : {};
  const report = newReport("openapi", typeof info["title"] === "string" ? `${info["title"]} (${source})` : source);
  const routes: ImportedRoute[] = [];
  const ops: SourceOperation[] = [];
  const usedIds = new Set<string>();
  let selectable = 0;

  for (const [path, item] of Object.entries(isObj(doc["paths"]) ? doc["paths"] : {})) {
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const responses: ResponseDraft[] = [];
      const entries = Object.entries(isObj(op["responses"]) ? op["responses"] : {});
      const codes = entries.filter(([code]) => /^\d{3}$/.test(code));
      if (codes.length === 0) {
        report.warnings.push(`${method.toUpperCase()} ${path}: sin códigos de respuesta concretos; se crea un 200 vacío`);
      }
      // 2xx first: the first success becomes the default response.
      codes.sort(([a], [b]) => (a.startsWith("2") === b.startsWith("2") ? Number(a) - Number(b) : a.startsWith("2") ? -1 : 1));
      let success: SourceOperation["success"] = null;
      for (const [code, raw] of codes) {
        const response = isObj(raw) ? raw : {};
        const media = mediaOf(response, swagger2);
        const status = Number(code);
        if (!success && status >= 200 && status < 300) success = { schema: media.schema, example: media.example, hasExample: media.hasExample };
        // The first success is "ok"; the rest are named by their code (r-201, error-404…).
        const firstSuccess = status < 300 && responses.every((r) => (r.status ?? 200) >= 300);
        const draft: ResponseDraft = { id: firstSuccess ? "ok" : `${status < 400 ? "r" : "error"}-${code}`, status, body: { kind: "none" } };
        if (typeof response["description"] === "string" && response["description"]) draft.description = response["description"];
        if (media.type) draft.headers = { "Content-Type": media.type.includes("json") && !media.type.includes("charset") ? `${media.type}; charset=utf-8` : media.type };
        if (media.hasExample) {
          const text = typeof media.example === "string" ? media.example : `${JSON.stringify(media.example, null, 2)}\n`;
          draft.body = { kind: "inline", text: escapeMustaches(text) };
          report.fromExamples++;
        } else if (media.schema !== undefined) {
          draft.body = { kind: "inline", text: `${templateFromSchema(media.schema)}\n` };
          report.generated++;
        } else if (status !== 204 && status !== 304) {
          report.generated++;
        }
        responses.push(draft);
      }
      if (responses.length === 0) responses.push({ id: "ok", status: 200, body: { kind: "inline", text: "{}\n" } });
      responses[0]!.default = true;
      selectable += addPicker(responses);

      let id = typeof op["operationId"] === "string" ? slugify(op["operationId"].replace(/([a-z])([A-Z])/g, "$1-$2"), "") : "";
      if (!id) id = slugify(`${method}-${path.replace(/[{}]/g, "")}`, `${method}-ruta`);
      const tag = Array.isArray(op["tags"]) && typeof op["tags"][0] === "string" ? slugify(op["tags"][0], "") : "";
      const fullId = tag ? `${tag}/${id}` : id;
      let unique = fullId;
      for (let n = 2; usedIds.has(unique); n++) unique = `${fullId}-${n}`;
      usedIds.add(unique);

      const description = [op["summary"], op["description"]].find((d) => typeof d === "string" && d) as string | undefined;
      const route: ImportedRoute = {
        folder: tag,
        draft: { id: unique, method: method.toUpperCase(), path: toMockPath(path), ...(description ? { description } : {}), responses },
      };
      routes.push(route);
      ops.push({ path, method, op, route, success });
      report.routes++;
      report.responses += responses.length;
    }
  }
  if (isObj(doc["webhooks"]) && Object.keys(doc["webhooks"]).length) report.skipped.push("webhooks: Mockix los envía como callbacks de una respuesta; añádelos a mano donde toque");
  if (routes.length === 0) report.warnings.push("El documento no tiene operaciones");

  const enriched = enrichOpenApi(ops, routes, report, selectable);
  report.extras = enriched.extras;
  if (swagger2) report.extras.notes.push("Es Swagger 2.0: no se conecta como contrato porque la revisión de peticiones necesita OpenAPI 3. Si lo conviertes a OpenAPI 3 y lo vuelves a importar, queda conectado.");
  // A CRUD route stands for several operations.
  report.routes = enriched.routes.length;

  return {
    mock: {
      name: slugify(typeof info["title"] === "string" ? info["title"] : "", "openapi"),
      port: 3000,
      prefix: prefixFrom(doc),
      variables: {},
      buckets: enriched.buckets,
      routes: enriched.routes,
      extraFiles: enriched.extraFiles,
      serverErrors: enriched.serverErrors,
    },
    report,
  };
}

/** Example value for export: the body as JSON when it is plain JSON (not a template). */
function exampleOf(text: string): unknown {
  if (text.includes("{{")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text || undefined;
  }
}

/** A mock as an OpenAPI 3.1 document (paths, parameters, responses with their examples). */
export function exportOpenApi(config: MockConfig): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of config.routes) {
    if (route.path.startsWith("^")) continue;
    const path = toOpenApiPath(route.path);
    const params = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    const methods = route.crud ? ["get", "post"] : route.method === "ANY" ? ["get"] : [route.method.toLowerCase()];
    for (const method of methods) {
      const responses: Record<string, unknown> = {};
      for (const r of route.responses) {
        const type = Object.entries(r.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1]?.split(";")[0]?.trim();
        const text = r.body?.kind === "text" ? r.body.text : "";
        const example = exampleOf(text);
        const entry: Record<string, unknown> = { description: r.id };
        if (type && r.body) entry["content"] = { [type]: example === undefined ? { schema: {} } : { example } };
        if (!responses[String(r.status)]) responses[String(r.status)] = entry;
      }
      if (route.crud) responses["200"] = { description: `lista de ${route.crud.bucket}`, content: { "application/json": { example: config.buckets[route.crud.bucket] ?? [] } } };
      paths[path] ??= {};
      paths[path]![method] = { operationId: route.id.replace(/[^A-Za-z0-9]+/g, "-"), ...(params.length ? { parameters: params } : {}), responses };
    }
  }
  return {
    openapi: "3.1.0",
    info: { title: config.name, version: "1.0.0", description: "Exportado desde Mockix" },
    servers: [{ url: `http://localhost:${config.port}${config.prefix}` }],
    paths,
  };
}
