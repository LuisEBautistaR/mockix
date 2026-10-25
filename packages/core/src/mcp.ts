/**
 * MCP server for AI agents: tools over the workspace and the running mocks,
 * and resources with the workspace files and the format schemas.
 *
 * Every write goes through the same zod schemas as the UI, and a file that
 * would leave its mock with problems is put back as it was: an agent cannot
 * leave the workspace broken. Writes can require approval (the desktop asks
 * in its UI) and every call is audited.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parse as parseYaml, parseDocument, stringify, isMap, isSeq } from "yaml";
import { z } from "zod";
import { Contract, checkMockResponses, contractCoverage, type ContractReport } from "./contract.js";
import { deleteRoute } from "./edit.js";
import { chaosFile, grpcFile, mockFile, realtimeFile, routeFile, scenarioFile, workspaceFile } from "./format.js";
import { importSource, writeImported } from "./import/index.js";
import { allProblems, loadWorkspace, type Problem, type WorkspaceLoad } from "./loader.js";
import { convertRecording, listRecordings, mergeIntoMock, readRecording, recordingPath } from "./record/index.js";
import type { ScenarioEvent, ScenarioView } from "./scenarios.js";
import type { ChaosReport } from "./chaos.js";
import type { RequestLogEntry } from "./server.js";

/** What the tools need from whoever runs the mocks (the CLI in-process, the desktop through its hosts). */
export interface McpBackend {
  readonly workspace: string;
  load(): Promise<WorkspaceLoad>;
  status(): Promise<Array<{ name: string; state: string; url: string | null; prefix: string; grpcPort: number | null }>>;
  start(name: string): Promise<{ url: string }>;
  stop(name: string): Promise<void>;
  /** Newest first. */
  logs(name: string, limit: number): Promise<RequestLogEntry[]>;
  scenarios(name: string): Promise<ScenarioView[]>;
  setScenario(name: string, id: string, key: string, state: string): Promise<ScenarioEvent>;
  chaos(name: string): Promise<ChaosReport>;
  /** null: no chaos; undefined: back to mock.yaml. */
  setChaos(name: string, profile: string | null | undefined): Promise<ChaosReport>;
  contract(name: string): Promise<ContractReport | null>;
  recordStart(target: string, port: number): Promise<{ url: string; file: string }>;
  recordStop(): Promise<{ file: string; count: number } | null>;
  /** Called after the tools change files, so running mocks pick them up. */
  changed?(): Promise<void>;
}

export interface ApprovalRequest {
  tool: string;
  /** What the agent wants, in one sentence ("crear GET /pedidos/:id en tienda"). */
  summary: string;
  input: unknown;
}

export interface AuditEntry {
  at: number;
  tool: string;
  summary: string;
  write: boolean;
  outcome: "ok" | "error" | "rejected";
  detail: string | null;
  durationMs: number;
}

export interface McpOptions {
  name?: string;
  version?: string;
  /** Asked before every tool that writes; false rejects the call. Default: allowed. */
  approve?: (request: ApprovalRequest) => Promise<boolean>;
  /** Refuse every tool that writes. */
  readOnly?: boolean;
  audit?: (entry: AuditEntry) => void;
}

class ToolError extends Error {}

const TRASH_DIR = join(".mockix", "trash");
const BODY_LIMIT = 64 * 1024;
const toPosix = (p: string) => p.split(sep).join("/");
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

const problemsText = (problems: Problem[]) => problems.map((p) => `${p.file}${p.line ? `:${p.line}` : ""}: ${p.message}`);

/** routes/<folder>/<method>-<path>.yaml, like the editor names them. */
function routeFileName(route: Record<string, unknown>): string {
  const protocol = typeof route["protocol"] === "string" ? route["protocol"] : null;
  const kind = protocol ?? (route["crud"] ? "crud" : String(route["method"] ?? "get").toLowerCase());
  const slugPath = String(route["path"] ?? "")
    .replace(/^\^/, "")
    .replace(/[:*]/g, "")
    .split("/")
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${kind}-${slugPath || "raiz"}.yaml`;
}

/** Inside the workspace, never outside (agents pass paths). */
function inside(root: string, rel: string): string {
  const abs = resolve(root, rel);
  if (abs !== resolve(root) && !abs.startsWith(resolve(root) + sep)) throw new ToolError(`${rel} está fuera del workspace`);
  return abs;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

export function createMcpServer(backend: McpBackend, options: McpOptions = {}): McpServer {
  const server = new McpServer({ name: options.name ?? "mockix", version: options.version ?? "0.0.0" }, { capabilities: { tools: {}, resources: {} } });
  const ws = resolve(backend.workspace);

  const mockOf = async (name: string) => {
    const load = await backend.load();
    const mock = load.mocks.find((m) => m.name === name);
    if (!mock) throw new ToolError(`No hay ningún mock "${name}". Mocks: ${load.mocks.map((m) => m.name).join(", ") || "(ninguno)"}`);
    return { load, mock };
  };

  /**
   * Writes a file of a mock (or of the workspace) and checks the workspace
   * again; when the change brings problems, the previous content comes back.
   */
  const writeChecked = async (rel: string, text: string, mock: string | null): Promise<{ problems: string[] }> => {
    const abs = inside(ws, rel);
    const previous = await readFile(abs, "utf8").catch(() => null);
    await writeAtomic(abs, text);
    const load = await loadWorkspace(ws);
    const relPosix = toPosix(relative(ws, abs));
    const problems = allProblems(load).filter((p) => p.file === relPosix || (mock !== null && p.file.startsWith(`mocks/${mock}/`)));
    if (problems.length) {
      if (previous === null) await rm(abs, { force: true });
      else await writeAtomic(abs, previous);
      throw new ToolError(`No se guardó ${relPosix}: dejaría el mock con problemas:\n${problemsText(problems).join("\n")}`);
    }
    return { problems: [] };
  };

  /** Validates a route given as an object or as YAML text with its schema (HTTP, WebSocket or Socket.IO). */
  const routeText = (input: { route?: Record<string, unknown> | undefined; yaml?: string | undefined }): { value: Record<string, unknown>; text: string } => {
    let value: unknown = input.route;
    if (input.yaml !== undefined) {
      try {
        value = parseYaml(input.yaml);
      } catch (err) {
        throw new ToolError(`YAML no válido: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolError("Falta la ruta: pasa route (objeto) o yaml (texto)");
    const v = value as Record<string, unknown>;
    const schema = v["protocol"] === "ws" || v["protocol"] === "socketio" ? realtimeFile : routeFile;
    const parsed = schema.safeParse(v);
    if (!parsed.success) throw new ToolError(`La ruta no es válida:\n${parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("\n")}`);
    return { value: v, text: input.yaml ?? stringify(v, { lineWidth: 0 }) };
  };

  const routeFileOf = (load: WorkspaceLoad, mock: string, routeId: string): string | null => {
    const config = load.mocks.find((m) => m.name === mock)?.config;
    const file = config?.routes.find((r) => r.id === routeId)?.file ?? config?.realtime.find((r) => r.id === routeId)?.file;
    return file ? `mocks/${mock}/${file}` : null;
  };

  type Handler<A> = (args: A) => Promise<unknown>;
  const tool = <S extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; input: S; write: boolean; summary: (args: z.infer<z.ZodObject<S>>) => string },
    handler: Handler<z.infer<z.ZodObject<S>>>,
  ) => {
    server.registerTool(
      name,
      { title: config.title, description: config.description, inputSchema: config.input, annotations: { readOnlyHint: !config.write, destructiveHint: config.write && name.startsWith("delete") } },
      (async (args: z.infer<z.ZodObject<S>>) => {
        const started = performance.now();
        const summary = config.summary(args);
        const audit = (outcome: AuditEntry["outcome"], detail: string | null) =>
          options.audit?.({ at: Date.now(), tool: name, summary, write: config.write, outcome, detail, durationMs: Math.round(performance.now() - started) });
        if (config.write) {
          if (options.readOnly) {
            audit("rejected", "solo lectura");
            return { isError: true, content: [{ type: "text" as const, text: "Este servidor MCP es de solo lectura: no puede cambiar el workspace ni los mocks." }] };
          }
          if (options.approve && !(await options.approve({ tool: name, summary, input: args }))) {
            audit("rejected", "rechazada por el usuario");
            return { isError: true, content: [{ type: "text" as const, text: `El usuario no aprobó: ${summary}` }] };
          }
        }
        try {
          const value = await handler(args);
          if (config.write) await backend.changed?.();
          audit("ok", null);
          return json(value);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          audit("error", message);
          return { isError: true, content: [{ type: "text" as const, text: message }] };
        }
      }) as never,
    );
  };

  const mockName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).describe("Nombre del mock (carpeta de mocks/)");
  const routeIdArg = z.string().regex(/^[a-z0-9][a-z0-9_/-]{0,127}$/).describe("Id de la ruta (list_routes)");
  const routeObject = z.record(z.string(), z.unknown());

  /* ---------- Mocks ---------- */

  tool(
    "list_mocks",
    { title: "Listar mocks", description: "Mocks del workspace con su estado, URL, número de rutas y problemas.", input: {}, write: false, summary: () => "listar los mocks" },
    async () => {
      const [load, status] = await Promise.all([backend.load(), backend.status()]);
      return load.mocks.map((m) => {
        const s = status.find((x) => x.name === m.name);
        return {
          name: m.name,
          state: s?.state ?? "stopped",
          url: s?.url ? `${s.url}${s.prefix}` : null,
          grpcPort: s?.grpcPort ?? null,
          port: m.config?.port ?? null,
          prefix: m.config?.prefix ?? null,
          routes: m.config?.routes.length ?? 0,
          realtime: m.config?.realtime.length ?? 0,
          grpcServices: m.config?.grpc?.services.length ?? 0,
          problems: problemsText(m.problems),
        };
      });
    },
  );

  tool("start_mock", { title: "Iniciar un mock", description: "Arranca un mock y devuelve su URL.", input: { mock: mockName }, write: false, summary: (a) => `iniciar ${a.mock}` }, async ({ mock }) => {
    await mockOf(mock);
    return backend.start(mock);
  });

  tool("stop_mock", { title: "Detener un mock", description: "Detiene un mock en marcha.", input: { mock: mockName }, write: false, summary: (a) => `detener ${a.mock}` }, async ({ mock }) => {
    await backend.stop(mock);
    return { stopped: mock };
  });

  /* ---------- Routes ---------- */

  tool(
    "list_routes",
    { title: "Listar rutas", description: "Rutas HTTP, WebSocket/Socket.IO y servicios gRPC de un mock, en el orden en que se evalúan.", input: { mock: mockName }, write: false, summary: (a) => `listar las rutas de ${a.mock}` },
    async ({ mock }) => {
      const { mock: m } = await mockOf(mock);
      if (!m.config) return { problems: problemsText(m.problems) };
      return {
        http: m.config.routes.map((r) => ({ id: r.id, method: r.method, path: r.path, file: r.file, mode: r.crud ? "crud" : r.mode, responses: r.responses.map((x) => `${x.id} (${x.status})`) })),
        realtime: m.config.realtime.map((r) => ({ id: r.id, protocol: r.protocol, path: r.path, file: r.file, messages: r.messages.map((x) => x.id) })),
        grpc: m.config.grpc?.services.map((s) => ({ service: s.service, file: s.file, proto: s.proto, methods: Object.keys(s.methods) })) ?? [],
      };
    },
  );

  tool(
    "get_route",
    { title: "Leer una ruta", description: "El YAML de una ruta tal como está en disco.", input: { mock: mockName, route: routeIdArg }, write: false, summary: (a) => `leer ${a.route} de ${a.mock}` },
    async ({ mock, route }) => {
      const { load } = await mockOf(mock);
      const file = routeFileOf(load, mock, route);
      if (!file) throw new ToolError(`No hay ninguna ruta "${route}" en ${mock}`);
      return { file, yaml: await readFile(join(ws, file), "utf8") };
    },
  );

  tool(
    "upsert_route",
    {
      title: "Crear o reemplazar una ruta",
      description:
        "Escribe una ruta (HTTP, o protocol: ws / socketio) con el formato de mockix://schema/route. Pasa route (objeto) o yaml (texto). Con id de una ruta existente la reemplaza; si no, crea routes/<folder>/<método>-<ruta>.yaml. Se valida y, si deja el mock con problemas, no se guarda.",
      input: { mock: mockName, route: routeObject.optional(), yaml: z.string().max(1024 * 1024).optional(), folder: z.string().regex(/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/i).optional().describe("Subcarpeta de routes/") },
      write: true,
      summary: (a) => {
        const r = (a.route ?? (() => {
          try {
            return parseYaml(a.yaml ?? "") as Record<string, unknown>;
          } catch {
            return {};
          }
        })()) as Record<string, unknown>;
        const what = r["protocol"] ? `${String(r["protocol"]).toUpperCase()} ${String(r["path"] ?? "")}` : `${r["crud"] ? "CRUD" : String(r["method"] ?? "GET")} ${String(r["path"] ?? "")}`;
        return `crear o cambiar ${what.trim()} en ${a.mock}`;
      },
    },
    async ({ mock, route, yaml, folder }) => {
      const { load } = await mockOf(mock);
      const { value, text } = routeText({ route, yaml });
      const id = typeof value["id"] === "string" ? value["id"] : null;
      const existing = id ? routeFileOf(load, mock, id) : null;
      const rel = existing ?? `mocks/${mock}/routes/${folder ? `${folder}/` : ""}${routeFileName(value)}`;
      if (!existing && (await stat(inside(ws, rel)).then(() => true, () => false))) throw new ToolError(`${rel} ya existe: pon el id de esa ruta para reemplazarla`);
      await writeChecked(rel, text, mock);
      const after = await loadWorkspace(ws);
      const config = after.mocks.find((m) => m.name === mock)?.config;
      const fileInMock = rel.slice(`mocks/${mock}/`.length);
      const written = config?.routes.find((r) => r.file === fileInMock) ?? config?.realtime.find((r) => r.file === fileInMock);
      return { file: rel, id: written?.id ?? id, created: !existing };
    },
  );

  tool(
    "upsert_response",
    {
      title: "Crear o reemplazar una respuesta",
      description: "Añade una respuesta a una ruta HTTP, o reemplaza la que tiene el mismo id. Formato de responses[] en mockix://schema/route.",
      input: { mock: mockName, route: routeIdArg, response: routeObject },
      write: true,
      summary: (a) => `${typeof a.response["id"] === "string" ? `respuesta ${a.response["id"]}` : "una respuesta"} en ${a.route} de ${a.mock}`,
    },
    async ({ mock, route, response }) => {
      const { load } = await mockOf(mock);
      const rel = routeFileOf(load, mock, route);
      if (!rel || !load.mocks.find((m) => m.name === mock)?.config?.routes.some((r) => r.id === route)) throw new ToolError(`No hay ninguna ruta HTTP "${route}" en ${mock}`);
      const doc = parseDocument(await readFile(join(ws, rel), "utf8"));
      const list = doc.get("responses", true);
      const node = doc.createNode(response);
      let replaced = false;
      if (isSeq(list)) {
        const i = list.items.findIndex((item) => isMap(item) && item.get("id") === response["id"]);
        if (i >= 0) {
          list.items[i] = node;
          replaced = true;
        } else list.items.push(node);
      } else doc.set("responses", doc.createNode([response]));
      const parsed = routeFile.safeParse(doc.toJS());
      if (!parsed.success) throw new ToolError(`La respuesta no es válida:\n${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n")}`);
      await writeChecked(rel, doc.toString({ lineWidth: 0 }), mock);
      return { file: rel, response: response["id"] ?? null, replaced };
    },
  );

  tool(
    "delete_route",
    { title: "Borrar una ruta", description: "Mueve el archivo de la ruta a .mockix/trash/ (se puede recuperar).", input: { mock: mockName, route: routeIdArg }, write: true, summary: (a) => `borrar ${a.route} de ${a.mock}` },
    async ({ mock, route }) => {
      await mockOf(mock);
      const file = await deleteRoute(ws, mock, route, async (abs) => {
        const to = join(ws, TRASH_DIR, `${Date.now()}-${mock}-${abs.split(/[\\/]/).pop()}`);
        await mkdir(dirname(to), { recursive: true });
        await rename(abs, to);
      });
      return { deleted: `mocks/${mock}/${file}`, trash: toPosix(TRASH_DIR) };
    },
  );

  /* ---------- Requests and logs ---------- */

  tool(
    "send_request",
    {
      title: "Probar una ruta",
      description: "Envía una petición HTTP al mock en marcha (la ruta es relativa al prefijo) y devuelve estado, cabeceras y cuerpo.",
      input: {
        mock: mockName,
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
        path: z.string().regex(/^\/(?!\/)[^\s#]*$/, "una ruta que empieza por /").describe("Ruta bajo el prefijo, con query si hace falta"),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().max(1024 * 1024).optional(),
      },
      write: false,
      summary: (a) => `${a.method ?? "GET"} ${a.path} en ${a.mock}`,
    },
    async ({ mock, method, path, headers, body }) => {
      const s = (await backend.status()).find((x) => x.name === mock);
      if (!s?.url || s.state !== "running") throw new ToolError(`${mock} no está en marcha: usa start_mock`);
      const started = performance.now();
      const h: Record<string, string> = { "User-Agent": "Mockix MCP", ...(headers ?? {}) };
      if (body && !Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["Content-Type"] = /^\s*[[{]/.test(body) ? "application/json" : "text/plain";
      const res = await fetch(`${s.url}${s.prefix}${path}`, { method, headers: h, ...(body && !["GET", "HEAD"].includes(method) ? { body } : {}), signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      return {
        status: res.status,
        durationMs: Math.round(performance.now() - started),
        headers: Object.fromEntries(res.headers),
        body: text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}…` : text,
      };
    },
  );

  tool(
    "query_logs",
    {
      title: "Consultar el log",
      description: "Peticiones recientes de un mock (la más nueva primero), con filtros opcionales.",
      input: { mock: mockName, limit: z.number().int().min(1).max(500).default(50), status: z.number().int().min(0).max(599).optional(), path: z.string().max(500).optional().describe("Texto que contiene la URL") },
      write: false,
      summary: (a) => `leer el log de ${a.mock}`,
    },
    async ({ mock, limit, status, path }) => {
      const rows = (await backend.logs(mock, 500)).filter((e) => (status === undefined || e.status === status) && (!path || e.url.includes(path))).slice(0, limit ?? 50);
      return rows.map((e) => ({
        seq: e.seq,
        at: new Date(e.at).toISOString(),
        method: e.method,
        url: e.url,
        status: e.status,
        durationMs: e.durationMs,
        route: e.routeId,
        response: e.responseId,
        error: e.error,
        violations: e.violations?.length ?? 0,
        chaos: e.chaos ? { error: e.chaos.error, latencyMs: e.chaos.latencyMs, drop: e.chaos.drop, timeout: e.chaos.timeout } : null,
      }));
    },
  );

  tool(
    "get_log",
    { title: "Leer una petición del log", description: "Una petición completa: cabeceras y cuerpos (con credenciales redactadas), tiempos, contrato y caos.", input: { mock: mockName, seq: z.number().int().min(1) }, write: false, summary: (a) => `leer la petición ${a.seq} de ${a.mock}` },
    async ({ mock, seq }) => {
      const entry = (await backend.logs(mock, 500)).find((e) => e.seq === seq);
      if (!entry) throw new ToolError(`No está la petición ${seq} en el log reciente de ${mock}`);
      return entry;
    },
  );

  /* ---------- Validation and import ---------- */

  tool("validate_workspace", { title: "Validar el workspace", description: "Problemas de todos los archivos, con archivo y línea.", input: {}, write: false, summary: () => "validar el workspace" }, async () => {
    const load = await backend.load();
    const problems = problemsText(allProblems(load));
    return { valid: problems.length === 0, mocks: load.mocks.length, problems };
  });

  tool(
    "validate_contract",
    {
      title: "Validar contra el contrato",
      description: "Cobertura del contrato OpenAPI del mock, sus respuestas que no lo cumplen y, si está en marcha, las peticiones que no lo cumplieron.",
      input: { mock: mockName },
      write: false,
      summary: (a) => `validar el contrato de ${a.mock}`,
    },
    async ({ mock }) => {
      const { mock: m } = await mockOf(mock);
      if (!m.config?.contract) throw new ToolError(`${mock} no tiene contrato (contract: en mock.yaml)`);
      const contract = new Contract(m.config.contract.document);
      const running = (await backend.status()).find((x) => x.name === mock)?.state === "running";
      return {
        file: m.config.contract.file,
        mode: m.config.contract.mode,
        coverage: contractCoverage(m.config, contract),
        responseProblems: checkMockResponses(m.config, contract),
        live: running ? await backend.contract(mock) : null,
      };
    },
  );

  tool(
    "import_openapi",
    {
      title: "Importar un contrato o una colección",
      description: "Crea un mock nuevo desde OpenAPI 3/Swagger 2, Postman v2.x (o Sendix), HAR o Mockoon. Pasa path (un archivo dentro del workspace) o text (el contenido).",
      input: { path: z.string().max(500).optional(), text: z.string().max(10 * 1024 * 1024).optional(), name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional() },
      write: true,
      summary: (a) => `importar ${a.path ?? "un documento"} como mock${a.name ? ` ${a.name}` : ""}`,
    },
    async ({ path, text, name }) => {
      let source = text;
      let fileName = "documento";
      let baseDir = ws;
      if (path !== undefined) {
        const abs = inside(ws, path);
        source = await readFile(abs, "utf8");
        fileName = abs.split(/[\\/]/).pop()!;
        baseDir = dirname(abs);
      }
      if (source === undefined) throw new ToolError("Pasa path o text");
      const result = await importSource(source, fileName, { baseDir });
      const written = await writeImported(ws, result, name ? { name } : {});
      return { mock: written.name, routes: written.routes, report: written.report };
    },
  );

  /* ---------- Recording ---------- */

  tool("list_recordings", { title: "Listar grabaciones", description: "Grabaciones de .mockix/recordings/.", input: {}, write: false, summary: () => "listar las grabaciones" }, async () => listRecordings(ws));

  tool(
    "record_start",
    { title: "Empezar a grabar", description: "Pone un proxy delante de la API real y graba cada intercambio (crudo, en .mockix/recordings/).", input: { target: z.url({ protocol: /^https?$/ }), port: z.number().int().min(0).max(65535).default(0) }, write: true, summary: (a) => `grabar el tráfico de ${a.target}` },
    async ({ target, port }) => backend.recordStart(target.replace(/\/+$/, ""), port ?? 0),
  );

  tool("record_stop", { title: "Terminar la grabación", description: "Detiene el proxy de grabación.", input: {}, write: true, summary: () => "terminar la grabación" }, async () => {
    const done = await backend.recordStop();
    if (!done) throw new ToolError("No hay ninguna grabación en curso");
    return done;
  });

  tool(
    "convert_recording",
    {
      title: "Convertir una grabación en mock",
      description: "Convierte una grabación en un mock nuevo (name) o añade sus rutas y respuestas a uno existente (into), sin credenciales.",
      input: { file: z.string().regex(/^[A-Za-z0-9._-]+\.jsonl$/), name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(), into: mockName.optional(), prefix: z.string().max(200).default("") },
      write: true,
      summary: (a) => (a.into ? `añadir ${a.file} a ${a.into}` : `crear el mock ${a.name ?? "nuevo"} desde ${a.file}`),
    },
    async ({ file, name, into, prefix }) => {
      if (name && into) throw new ToolError("Usa name (mock nuevo) o into (mock existente), no los dos");
      const load = await backend.load();
      const { exchanges } = await readRecording(recordingPath(ws, file));
      const result = convertRecording(exchanges, { name: name ?? into ?? "grabacion", source: file, prefix: prefix ?? "", ...(load.redaction ? { redaction: load.redaction } : {}) });
      if (into) {
        const config = load.mocks.find((m) => m.name === into)?.config;
        if (!config) throw new ToolError(`${into} tiene problemas o no existe`);
        return mergeIntoMock(ws, into, config, result);
      }
      const written = await writeImported(ws, result, name ? { name } : {});
      return { mock: written.name, routes: written.routes, report: written.report };
    },
  );

  /* ---------- Scenarios and chaos ---------- */

  tool(
    "get_scenario_state",
    { title: "Ver escenarios", description: "Escenarios del mock en marcha con sus instancias y estados.", input: { mock: mockName, scenario: z.string().optional() }, write: false, summary: (a) => `ver los escenarios de ${a.mock}` },
    async ({ mock, scenario }) => {
      const views = await backend.scenarios(mock);
      return scenario ? views.filter((v) => v.id === scenario) : views;
    },
  );

  tool(
    "set_scenario_state",
    { title: "Forzar un estado", description: "Pone una instancia de un escenario en un estado.", input: { mock: mockName, scenario: z.string().min(1), key: z.string().max(512).default(""), state: z.string().min(1) }, write: true, summary: (a) => `poner ${a.scenario}${a.key ? `[${a.key}]` : ""} en ${a.state} (${a.mock})` },
    async ({ mock, scenario, key, state }) => backend.setScenario(mock, scenario, key ?? "", state),
  );

  tool(
    "apply_chaos",
    {
      title: "Aplicar caos",
      description: "Aplica un perfil de chaos/ al mock en marcha (profile), lo quita (null) o vuelve al de mock.yaml (reset: true). No cambia archivos.",
      input: { mock: mockName, profile: z.string().nullable().optional(), reset: z.boolean().optional() },
      write: true,
      summary: (a) => (a.reset ? `volver al caos de mock.yaml en ${a.mock}` : a.profile ? `aplicar el perfil de caos ${a.profile} a ${a.mock}` : `quitar el caos de ${a.mock}`),
    },
    async ({ mock, profile, reset }) => backend.setChaos(mock, reset ? undefined : (profile ?? null)),
  );

  /* ---------- Resources ---------- */

  const schemas: Record<string, z.ZodType> = { workspace: workspaceFile, mock: mockFile, route: routeFile, realtime: realtimeFile, scenario: scenarioFile, chaos: chaosFile, grpc: grpcFile };
  for (const [name, schema] of Object.entries(schemas)) {
    server.registerResource(
      `schema-${name}`,
      `mockix://schema/${name}`,
      { title: `Esquema: ${name}`, description: `JSON Schema del archivo ${name} del formato de Mockix`, mimeType: "application/schema+json" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/schema+json", text: JSON.stringify(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }), null, 2) }] }),
    );
  }

  const listFiles = async (): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.(ya?ml|json|proto|txt|md)$/i.test(e.name)) out.push(toPosix(relative(ws, p)));
      }
    };
    await walk(ws);
    return out.sort();
  };
  server.registerResource(
    "workspace-file",
    new ResourceTemplate("mockix://workspace/{+path}", {
      list: async () => ({ resources: (await listFiles()).map((p) => ({ uri: `mockix://workspace/${p}`, name: p, mimeType: p.endsWith(".json") ? "application/json" : "text/plain" })) }),
    }),
    { title: "Archivos del workspace", description: "Los YAML, JSON y .proto del workspace (sin .mockix/)." },
    async (uri, variables) => {
      const rel = decodeURIComponent(String(variables["path"] ?? ""));
      if (rel.split("/").some((part) => part.startsWith("."))) throw new Error("Solo archivos del workspace, no .mockix/");
      const text = await readFile(inside(ws, rel), "utf8");
      return { contents: [{ uri: uri.href, text }] };
    },
  );

  return server;
}
