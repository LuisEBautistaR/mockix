/**
 * Swagger 2.0 → OpenAPI 3.0, so a Swagger contract can be connected to a mock
 * (the contract checker reads OpenAPI 3). Structural and lossless for what the
 * checker uses: servers from host/basePath/schemes, definitions/parameters/
 * responses/securityDefinitions into components, body and formData parameters
 * into requestBody, response schemas and examples into content per media type,
 * and $refs rewritten to their new places.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch"] as const;

/** Keywords a Swagger 2 non-body parameter keeps in its OpenAPI 3 schema. */
const SCHEMA_KEYS = ["type", "format", "items", "default", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum", "maxLength", "minLength", "pattern", "maxItems", "minItems", "uniqueItems", "enum", "multipleOf"];

export function isSwagger2(doc: unknown): doc is Obj {
  return isObj(doc) && typeof doc["swagger"] === "string" && doc["swagger"].startsWith("2");
}

/** A deep copy with every $ref pointed at its OpenAPI 3 location. */
function rewriteRefs(value: unknown, bodyParams: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteRefs(v, bodyParams));
  if (!isObj(value)) return value;
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "$ref" && typeof v === "string") {
      out[k] = v
        .replace(/^#\/definitions\//, "#/components/schemas/")
        .replace(/^#\/responses\//, "#/components/responses/")
        .replace(/^#\/parameters\/(.+)$/, (_m, name: string) => (bodyParams.has(name) ? `#/components/requestBodies/${name}` : `#/components/parameters/${name}`));
    } else out[k] = rewriteRefs(v, bodyParams);
  }
  return out;
}

/** Swagger-only schema keywords → their OpenAPI 3 form, everywhere in the schema. */
function fixSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(fixSchema);
  if (!isObj(schema)) return schema;
  const out: Obj = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "x-nullable") out["nullable"] = v;
    else if (k === "discriminator" && typeof v === "string") out["discriminator"] = { propertyName: v };
    else if (k === "type" && v === "file") {
      out["type"] = "string";
      out["format"] = "binary";
    } else out[k] = fixSchema(v);
  }
  return out;
}

function styleOf(param: Obj): Obj {
  const where = param["in"];
  switch (param["collectionFormat"]) {
    case "multi":
      return { style: "form", explode: true };
    case "ssv":
      return { style: "spaceDelimited", explode: false };
    case "pipes":
      return { style: "pipeDelimited", explode: false };
    case "csv":
      return where === "query" || where === "formData" ? { style: "form", explode: false } : { style: "simple" };
    default:
      return {};
  }
}

/** A non-body Swagger 2 parameter as an OpenAPI 3 parameter. */
function convertParameter(param: Obj): Obj {
  if (typeof param["$ref"] === "string") return param;
  const schema: Obj = {};
  for (const key of SCHEMA_KEYS) if (key in param) schema[key] = param[key];
  const out: Obj = { name: param["name"], in: param["in"] };
  if (param["description"] !== undefined) out["description"] = param["description"];
  if (param["required"] !== undefined || param["in"] === "path") out["required"] = param["in"] === "path" ? true : param["required"];
  if (param["allowEmptyValue"] !== undefined) out["allowEmptyValue"] = param["allowEmptyValue"];
  for (const [k, v] of Object.entries(param)) if (k.startsWith("x-")) out[k] = v;
  out["schema"] = fixSchema(schema);
  return { ...out, ...styleOf(param) };
}

function convertHeaders(headers: unknown): Obj | undefined {
  if (!isObj(headers)) return undefined;
  const out: Obj = {};
  for (const [name, h] of Object.entries(headers)) {
    if (!isObj(h)) continue;
    const schema: Obj = {};
    for (const key of SCHEMA_KEYS) if (key in h) schema[key] = h[key];
    out[name] = { ...(h["description"] !== undefined ? { description: h["description"] } : {}), schema: fixSchema(schema) };
  }
  return out;
}

/** A Swagger 2 response as an OpenAPI 3 response: its schema and examples under each media type it produces. */
function convertResponse(response: unknown, produces: string[]): unknown {
  if (!isObj(response) || typeof response["$ref"] === "string") return response;
  const out: Obj = { description: typeof response["description"] === "string" ? response["description"] : "" };
  const headers = convertHeaders(response["headers"]);
  if (headers) out["headers"] = headers;
  const examples = isObj(response["examples"]) ? response["examples"] : {};
  const types = [...new Set([...(response["schema"] !== undefined ? produces : []), ...Object.keys(examples)])];
  if (types.length) {
    const content: Obj = {};
    for (const type of types) {
      const media: Obj = {};
      if (response["schema"] !== undefined) media["schema"] = fixSchema(response["schema"]);
      if (type in examples) media["example"] = examples[type];
      content[type] = media;
    }
    out["content"] = content;
  }
  for (const [k, v] of Object.entries(response)) if (k.startsWith("x-")) out[k] = v;
  return out;
}

function requestBodyFrom(body: Obj, consumes: string[]): Obj {
  const content: Obj = {};
  for (const type of consumes) content[type] = { schema: fixSchema(body["schema"] ?? {}), ...(body["x-examples"] && isObj(body["x-examples"]) && type in body["x-examples"] ? { example: body["x-examples"][type] } : {}) };
  return { ...(body["description"] !== undefined ? { description: body["description"] } : {}), ...(body["required"] ? { required: true } : {}), content };
}

function requestBodyFromForm(fields: Obj[], consumes: string[]): Obj {
  const properties: Obj = {};
  const required: string[] = [];
  for (const f of fields) {
    const schema = (convertParameter({ ...f, in: "query" })["schema"] ?? {}) as Obj;
    properties[String(f["name"])] = { ...schema, ...(f["description"] !== undefined ? { description: f["description"] } : {}) };
    if (f["required"]) required.push(String(f["name"]));
  }
  const types = consumes.filter((t) => t.includes("form")).length ? consumes.filter((t) => t.includes("form")) : fields.some((f) => f["type"] === "file") ? ["multipart/form-data"] : ["application/x-www-form-urlencoded"];
  const schema: Obj = { type: "object", properties, ...(required.length ? { required } : {}) };
  return { ...(required.length ? { required: true } : {}), content: Object.fromEntries(types.map((t) => [t, { schema }])) };
}

function serversOf(doc: Obj): Obj[] {
  const base = typeof doc["basePath"] === "string" ? doc["basePath"].replace(/\/+$/, "") : "";
  if (typeof doc["host"] !== "string" || !doc["host"]) return [{ url: base || "/" }];
  const schemes = Array.isArray(doc["schemes"]) && doc["schemes"].length ? (doc["schemes"] as string[]) : ["http"];
  return schemes.map((s) => ({ url: `${s}://${doc["host"]}${base}` }));
}

function convertSecurityScheme(s: unknown): unknown {
  if (!isObj(s)) return s;
  const description = s["description"] !== undefined ? { description: s["description"] } : {};
  if (s["type"] === "basic") return { type: "http", scheme: "basic", ...description };
  if (s["type"] === "apiKey") return { type: "apiKey", name: s["name"], in: s["in"], ...description };
  if (s["type"] === "oauth2") {
    const scopes = isObj(s["scopes"]) ? s["scopes"] : {};
    const flow = s["flow"];
    const flows: Obj =
      flow === "implicit"
        ? { implicit: { authorizationUrl: s["authorizationUrl"], scopes } }
        : flow === "password"
          ? { password: { tokenUrl: s["tokenUrl"], scopes } }
          : flow === "application"
            ? { clientCredentials: { tokenUrl: s["tokenUrl"], scopes } }
            : { authorizationCode: { authorizationUrl: s["authorizationUrl"], tokenUrl: s["tokenUrl"], scopes } };
    return { type: "oauth2", flows, ...description };
  }
  return s;
}

/** Converts a Swagger 2.0 document to OpenAPI 3.0.3. The input is not changed. */
export function swagger2ToOpenApi3(source: Obj): Obj {
  const globalParams = isObj(source["parameters"]) ? source["parameters"] : {};
  const bodyParams = new Set(Object.entries(globalParams).filter(([, p]) => isObj(p) && p["in"] === "body").map(([name]) => name));
  const doc = rewriteRefs(source, bodyParams) as Obj;
  const globalConsumes = Array.isArray(doc["consumes"]) && doc["consumes"].length ? (doc["consumes"] as string[]) : ["application/json"];
  const globalProduces = Array.isArray(doc["produces"]) && doc["produces"].length ? (doc["produces"] as string[]) : ["application/json"];
  const params = isObj(doc["parameters"]) ? doc["parameters"] : {};

  const components: Obj = {};
  if (isObj(doc["definitions"])) components["schemas"] = fixSchema(doc["definitions"]);
  const componentParams = Object.fromEntries(Object.entries(params).filter(([name]) => !bodyParams.has(name)).map(([name, p]) => [name, convertParameter(p as Obj)]));
  if (Object.keys(componentParams).length) components["parameters"] = componentParams;
  const requestBodies = Object.fromEntries([...bodyParams].map((name) => [name, requestBodyFrom(params[name] as Obj, globalConsumes)]));
  if (Object.keys(requestBodies).length) components["requestBodies"] = requestBodies;
  if (isObj(doc["responses"])) components["responses"] = Object.fromEntries(Object.entries(doc["responses"]).map(([name, r]) => [name, convertResponse(r, globalProduces)]));
  if (isObj(doc["securityDefinitions"])) components["securitySchemes"] = Object.fromEntries(Object.entries(doc["securityDefinitions"]).map(([name, s]) => [name, convertSecurityScheme(s)]));

  const paths: Obj = {};
  for (const [path, rawItem] of Object.entries(isObj(doc["paths"]) ? doc["paths"] : {})) {
    if (!isObj(rawItem)) continue;
    const item: Obj = {};
    const shared = Array.isArray(rawItem["parameters"]) ? (rawItem["parameters"] as Obj[]) : [];
    const sharedBody = shared.find((p) => p["in"] === "body");
    const sharedForm = shared.filter((p) => p["in"] === "formData");
    const sharedRest = shared.filter((p) => p["in"] !== "body" && p["in"] !== "formData");
    if (sharedRest.length) item["parameters"] = sharedRest.map(convertParameter);
    for (const [k, v] of Object.entries(rawItem)) if (k.startsWith("x-") || k === "summary" || k === "description") item[k] = v;

    for (const method of METHODS) {
      const op = rawItem[method];
      if (!isObj(op)) continue;
      const consumes = Array.isArray(op["consumes"]) && op["consumes"].length ? (op["consumes"] as string[]) : globalConsumes;
      const produces = Array.isArray(op["produces"]) && op["produces"].length ? (op["produces"] as string[]) : globalProduces;
      const out: Obj = {};
      for (const key of ["tags", "summary", "description", "externalDocs", "operationId", "deprecated", "security", "callbacks"]) if (op[key] !== undefined) out[key] = op[key];
      for (const [k, v] of Object.entries(op)) if (k.startsWith("x-")) out[k] = v;

      const own = Array.isArray(op["parameters"]) ? (op["parameters"] as Obj[]) : [];
      const refBody = own.find((p) => typeof p["$ref"] === "string" && p["$ref"].startsWith("#/components/requestBodies/"));
      const body = own.find((p) => p["in"] === "body") ?? sharedBody;
      const form = [...sharedForm.filter((s) => !own.some((p) => p["name"] === s["name"] && p["in"] === "formData")), ...own.filter((p) => p["in"] === "formData")];
      const rest = own.filter((p) => p !== refBody && p["in"] !== "body" && p["in"] !== "formData");
      if (rest.length) out["parameters"] = rest.map(convertParameter);
      if (refBody) out["requestBody"] = { $ref: refBody["$ref"] };
      else if (body) out["requestBody"] = requestBodyFrom(body, consumes);
      else if (form.length) out["requestBody"] = requestBodyFromForm(form, consumes);

      const responses = isObj(op["responses"]) ? op["responses"] : {};
      out["responses"] = Object.fromEntries(Object.entries(responses).map(([code, r]) => [code, convertResponse(r, produces)]));
      item[method] = out;
    }
    paths[path] = item;
  }

  const result: Obj = { openapi: "3.0.3", info: doc["info"] ?? { title: "API", version: "1.0.0" }, servers: serversOf(doc) };
  for (const key of ["tags", "externalDocs", "security"]) if (doc[key] !== undefined) result[key] = doc[key];
  result["paths"] = paths;
  if (Object.keys(components).length) result["components"] = components;
  for (const [k, v] of Object.entries(doc)) if (k.startsWith("x-")) result[k] = v;
  return result;
}
