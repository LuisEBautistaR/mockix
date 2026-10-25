/**
 * Postman Collection v2.0/v2.1 (and Sendix collections, which are v2.1) → mock.
 *
 * Every request with saved examples becomes a route; each example becomes a
 * response, and what tells the examples' original requests apart (a path
 * variable, a query parameter, a header) becomes its rule. Collection
 * variables become mock variables, and {{variable}} in bodies becomes
 * {{getVar 'variable'}}.
 */
import { exchangesToRoutes, type Exchange } from "./exchanges.js";
import { stringify } from "yaml";
import { ImportError, newReport, slugify, type ImportResult, type ImportedMock, type ImportedRoute } from "./model.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Postman dynamic variables with a Mockix equivalent. */
const DYNAMIC: Record<string, string> = {
  $guid: "{{uuid}}",
  $randomUUID: "{{uuid}}",
  $timestamp: "{{now 'unix'}}",
  $isoTimestamp: "{{now 'iso'}}",
  $randomInt: "{{int 0 1000}}",
  $randomBoolean: "{{boolean}}",
  $randomEmail: "{{faker 'internet.email'}}",
  $randomFirstName: "{{faker 'person.firstName'}}",
  $randomLastName: "{{faker 'person.lastName'}}",
  $randomFullName: "{{faker 'person.fullName'}}",
  $randomPhoneNumber: "{{faker 'phone.number'}}",
  $randomCity: "{{faker 'location.city'}}",
  $randomCountry: "{{faker 'location.country'}}",
  $randomProductName: "{{faker 'commerce.productName'}}",
  $randomPrice: "{{faker 'commerce.price'}}",
  $randomCompanyName: "{{faker 'company.name'}}",
  $randomUrl: "{{faker 'internet.url'}}",
  $randomWord: "{{faker 'lorem.word'}}",
  $randomLoremSentence: "{{faker 'lorem.sentence'}}",
};

/** {{var}} → {{getVar 'var'}}, dynamic variables → helpers; any other "{{" is escaped. Returns unknown dynamic names too. */
export function convertPostmanText(text: string): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const out = text.replace(/\{\{([^{}]*)\}\}|\{\{/g, (whole, name: string | undefined) => {
    if (name === undefined) return "\\{{";
    const n = name.trim();
    if (n.startsWith("$")) {
      if (DYNAMIC[n]) return DYNAMIC[n]!;
      unknown.push(n);
      return `\\{{${name}}}`;
    }
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(n)) return `{{getVar '${n}'}}`;
    return `\\{{${name}}}`;
  });
  return { text: out, unknown };
}

function urlOf(url: unknown): { raw: string; path: string; query: string } {
  let raw = "";
  if (typeof url === "string") raw = url;
  else if (isObj(url)) {
    if (typeof url["raw"] === "string") raw = url["raw"];
    else {
      const path = Array.isArray(url["path"]) ? url["path"].map(String).join("/") : "";
      const query = Array.isArray(url["query"]) ? url["query"].filter(isObj).map((q) => `${q["key"]}=${q["value"] ?? ""}`).join("&") : "";
      raw = `/${path}${query ? `?${query}` : ""}`;
    }
  }
  // Drop the scheme+host part, written literally or as a {{variable}}.
  let rest = raw.replace(/^\s*\{\{[^}]+\}\}/, "").replace(/^[a-z]+:\/\/[^/?#]*/i, "");
  if (!rest.startsWith("/")) rest = `/${rest}`;
  const q = rest.indexOf("?");
  const path = (q === -1 ? rest : rest.slice(0, q)).replace(/#.*$/, "");
  return { raw, path: path.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, ":$1") || "/", query: q === -1 ? "" : rest.slice(q) };
}

const headerMap = (list: unknown): Record<string, string> =>
  Object.fromEntries((Array.isArray(list) ? list : []).filter(isObj).filter((h) => h["disabled"] !== true).map((h) => [String(h["key"]), String(h["value"] ?? "")]));

/** Path prefix of the base URL variable (https://api.test/v1 → /v1), when every request uses it. */
function prefixFromVariables(variables: Record<string, string>, usesVar: string | null): string {
  if (!usesVar || !variables[usesVar]) return "";
  try {
    const p = new URL(variables[usesVar]!).pathname.replace(/\/+$/, "");
    return /^(\/[^/\s?#]+)*$/.test(p) ? p : "";
  } catch {
    return "";
  }
}

export function importPostman(value: unknown, source: string): ImportResult {
  if (!isObj(value) || !Array.isArray(value["item"])) throw new ImportError("No es una colección de Postman: falta item");
  const info = isObj(value["info"]) ? value["info"] : {};
  const title = typeof info["name"] === "string" ? info["name"] : "coleccion";
  const report = newReport("postman", `${title} (${source})`);
  const variables: Record<string, string> = {};
  for (const v of Array.isArray(value["variable"]) ? value["variable"] : []) if (isObj(v) && typeof v["key"] === "string") variables[v["key"]] = String(v["value"] ?? "");

  const routes: ImportedRoute[] = [];
  const realtime: Array<{ id: string; folder: string; def: Record<string, unknown> & { path: string } }> = [];
  const grpcServices = new Map<string, { proto: string; file: string }>();
  let grpcPort: number | null = null;
  const usedIds = new Set<string>();
  const hostVars = new Map<string, number>();
  const unknownDynamic = new Set<string>();

  const visit = (items: unknown[], folder: string[]) => {
    for (const item of items.filter(isObj)) {
      const name = typeof item["name"] === "string" ? item["name"] : "peticion";
      if (Array.isArray(item["item"])) {
        visit(item["item"], [...folder, slugify(name, "carpeta")]);
        continue;
      }
      const sendix = isObj(item["x-sendix"]) ? item["x-sendix"] : null;
      const kind = sendix ? String(sendix["type"] ?? sendix["kind"] ?? "http") : "http";
      if (sendix && kind !== "http") {
        const label = [...folder, name].join("/");
        const request = isObj(item["request"]) ? item["request"] : {};
        const url = urlOf(request["url"]);
        const hostVar = /^\s*\{\{([^}]+)\}\}/.exec(url.raw)?.[1] ?? null;
        if (hostVar && kind !== "grpc") hostVars.set(hostVar, (hostVars.get(hostVar) ?? 0) + 1);
        const base = slugify(name, kind);
        let id = folder.length ? `${folder.join("/")}/${base}` : base;
        for (let n = 2; usedIds.has(id); n++) id = `${folder.length ? `${folder.join("/")}/` : ""}${base}-${n}`;
        usedIds.add(id);
        const saved = (Array.isArray(sendix["messages"]) ? sendix["messages"] : []).filter(isObj);
        if (kind === "websocket") {
          realtime.push({
            id,
            folder: folder.join("/"),
            def: {
              id,
              protocol: "ws",
              path: url.path,
              description: `Importado de Sendix${saved.length ? `; el cliente envía: ${saved.map((m) => String(m["name"] ?? "mensaje")).join(", ")}` : ""}.`,
              echo: true,
            },
          });
          report.routes++;
          report.warnings.push(`${label}: WebSocket importado con eco; Sendix guarda lo que envía el cliente, no las respuestas del servidor`);
        } else if (kind === "socketio") {
          const events = [...new Set(saved.map((m) => String(m["event"] ?? "")).filter(Boolean))];
          const settings = isObj(sendix["settings"]) ? sendix["settings"] : {};
          if (typeof settings["path"] === "string" && settings["path"] !== "" && settings["path"] !== "/socket.io") report.warnings.push(`${label}: Socket.IO en ${settings["path"]}; el mock usa /socket.io`);
          realtime.push({
            id,
            folder: folder.join("/"),
            def: {
              id,
              protocol: "socketio",
              path: url.path,
              description: "Importado de Sendix.",
              ...(events.length ? { messages: events.map((event) => ({ id: slugify(event, "evento"), event, ack: { json: { ok: true, evento: event } } })) } : {}),
            },
          });
          report.routes++;
          report.responses += events.length;
          report.generated += events.length;
        } else if (kind === "grpc") {
          const service = String(sendix["service"] ?? "");
          const definition = isObj(sendix["definition"]) ? sendix["definition"] : {};
          const files = (Array.isArray(definition["files"]) ? definition["files"] : []).filter((f): f is string => typeof f === "string" && f !== "");
          if (!service) report.skipped.push(`${label}: gRPC sin servicio`);
          else if (!files.length) report.skipped.push(`${label}: el servicio ${service} se descubre por reflection; copia su .proto a protos/ y crea grpc/${slugify(service, "servicio")}.yaml`);
          else if (!grpcServices.has(service)) {
            const target = /:(\d{2,5})(?:\/|$)/.exec(url.raw.replace(/^[a-z]+:\/\//i, "x://"))?.[1];
            if (target && grpcPort === null) grpcPort = Number(target);
            grpcServices.set(service, { proto: files[0]!, file: `grpc/${slugify(service.split(".").pop() ?? service, "servicio")}.yaml` });
            report.routes++;
          }
        } else report.skipped.push(`${label}: tipo ${kind} desconocido`);
        continue;
      }
      const request = isObj(item["request"]) ? item["request"] : typeof item["request"] === "string" ? { url: item["request"], method: "GET" } : null;
      if (!request) continue;
      const url = urlOf(request["url"]);
      const hostVar = /^\s*\{\{([^}]+)\}\}/.exec(url.raw)?.[1] ?? null;
      if (hostVar) hostVars.set(hostVar, (hostVars.get(hostVar) ?? 0) + 1);
      const method = String(request["method"] ?? "GET").toUpperCase();
      const base = slugify(name, `${method.toLowerCase()}-ruta`);
      const folderPath = folder.join("/");
      let id = folderPath ? `${folderPath}/${base}` : base;
      for (let n = 2; usedIds.has(id); n++) id = `${folderPath ? `${folderPath}/` : ""}${base}-${n}`;
      usedIds.add(id);
      const description = typeof request["description"] === "string" ? request["description"] : isObj(request["description"]) ? String(request["description"]["content"] ?? "") : undefined;

      const examples = (Array.isArray(item["response"]) ? item["response"] : []).filter(isObj);
      if (examples.length === 0) {
        routes.push({ folder: folderPath, draft: { id, method, path: url.path, ...(description ? { description } : {}), responses: [{ id: "ok", default: true, status: 200, body: { kind: "inline", text: "{}\n" } }] } });
        report.routes++;
        report.responses++;
        report.generated++;
        report.warnings.push(`${id}: sin ejemplos guardados; responde 200 {} hasta que lo edites`);
        continue;
      }
      const exchanges: Exchange[] = examples.map((ex) => {
        const original = isObj(ex["originalRequest"]) ? ex["originalRequest"] : request;
        const o = urlOf(original["url"] ?? request["url"]);
        // Example paths may carry real values where the request has :vars.
        return {
          method,
          url: o.path.replace(/:([A-Za-z0-9_]+)/g, (m, v: string) => variables[v] ?? m) + o.query,
          requestHeaders: headerMap(original["header"]),
          requestBody: isObj(original["body"]) && typeof original["body"]["raw"] === "string" ? original["body"]["raw"] : "",
          status: typeof ex["code"] === "number" ? ex["code"] : 200,
          responseHeaders: headerMap(ex["header"]),
          responseBody: (() => {
            const c = convertPostmanText(typeof ex["body"] === "string" ? ex["body"] : "");
            c.unknown.forEach((u) => unknownDynamic.add(u));
            return c.text;
          })(),
          binary: false,
        };
      });
      const converted = exchangesToRoutes(exchanges, { fixedPath: url.path, method, id: base, folder: folderPath, templateBodies: true, ...(description ? { description } : {}) });
      for (const r of converted.routes) {
        r.draft.id = id;
        // Example names are better response ids than codes.
        r.draft.responses?.forEach((resp, i) => {
          const exName = examples.find((e) => (typeof e["code"] === "number" ? e["code"] : 200) === resp.status)?.["name"];
          if (i > 0 && typeof exName === "string") {
            const nice = slugify(exName, resp.id);
            if (!r.draft.responses!.some((o) => o.id === nice)) resp.id = nice;
          }
        });
        routes.push(r);
      }
      report.routes += converted.routes.length;
      report.responses += converted.responses;
      report.fromExamples += converted.responses;
      report.warnings.push(...converted.warnings.map((w) => `${id}: ${w}`));
    }
  };
  visit(value["item"], []);

  const hostVar = [...hostVars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const prefix = prefixFromVariables(variables, hostVar);
  if (prefix) for (const r of routes) if (r.draft.path.startsWith(`${prefix}/`)) r.draft.path = r.draft.path.slice(prefix.length);
  const extraFiles: Record<string, string> = {};
  for (const r of realtime) {
    // WebSocket paths live under the prefix like HTTP routes; Socket.IO namespaces do not.
    if (r.def["protocol"] === "ws" && prefix && r.def.path.startsWith(`${prefix}/`)) r.def.path = r.def.path.slice(prefix.length);
    extraFiles[`routes/${r.folder ? `${r.folder}/` : ""}${r.id.split("/").pop()}.yaml`] = stringify(r.def);
  }
  const protoSources: NonNullable<ImportedMock["protoSources"]> = [];
  for (const [service, g] of grpcServices) {
    const to = `protos/${g.proto.split(/[\\/]/).pop()}`;
    extraFiles[g.file] = `${stringify({ proto: to, service, description: "Importado de Sendix: los métodos responden un ejemplo generado del esquema hasta que añadas sus respuestas." })}`;
    protoSources.push({ from: g.proto, to, service, extraFile: g.file });
  }
  if (unknownDynamic.size) report.warnings.push(`Variables dinámicas sin equivalente (se dejan como texto): ${[...unknownDynamic].join(", ")}`);
  if (hostVar) report.warnings.push(`{{${hostVar}}} se usa como base de las URL${prefix ? `; su ruta ${prefix} es el prefijo del mock` : ""}`);

  return {
    mock: {
      name: slugify(title, "coleccion"),
      port: 3000,
      prefix,
      variables,
      buckets: {},
      routes,
      ...(Object.keys(extraFiles).length ? { extraFiles } : {}),
      ...(protoSources.length ? { protoSources, grpc: { port: grpcPort ?? 50051 } } : {}),
    },
    report,
  };
}
