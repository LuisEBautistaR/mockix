/**
 * Editing the workspace on disk: what the desktop editor (and, from M9, the MCP
 * server) uses. Every write goes through the same zod schemas as the loader, so
 * nothing invalid reaches disk, and YAML is updated in place to keep comments
 * and key order where possible.
 */
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { isMap, parseDocument, stringify, type Document } from "yaml";
import { z } from "zod";
import { MOCK_FILE, WORKSPACE_FILE, mockFile, routeFile, slug, workspaceFile, type RouteFile } from "./format.js";

export class EditError extends Error {
  readonly code: "NOT_FOUND" | "INVALID" | "EXISTS" | "OUTSIDE" | "NOT_WORKSPACE";
  readonly issues: Array<{ path: string; message: string }>;
  constructor(code: EditError["code"], message: string, issues: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = "EditError";
    this.code = code;
    this.issues = issues;
  }
}

export type BodyDraft =
  | { kind: "none" }
  | { kind: "inline"; text: string }
  | { kind: "json"; value: unknown }
  /** text is null for binary files: they can be re-pointed but not edited as text. */
  | { kind: "file"; path: string; text: string | null };

export interface ResponseDraft {
  id: string;
  default?: boolean;
  status?: number;
  headers?: Record<string, string>;
  body: BodyDraft;
  latency?: number;
  template?: boolean;
  description?: string;
  rules?: NonNullable<RouteFile["responses"]>[number]["rules"];
  callbacks?: NonNullable<RouteFile["responses"]>[number]["callbacks"];
}

export interface RouteDraft {
  id?: string;
  method?: string;
  path: string;
  mode?: string;
  latency?: number;
  description?: string;
  crud?: { bucket: string; key?: string | undefined; list?: { items: string; total?: string | undefined } | undefined };
  responses?: ResponseDraft[];
}

export interface RouteDocument {
  /** Route file relative to the mock folder (routes/…yaml). */
  file: string;
  draft: RouteDraft;
  /** The YAML exactly as it is on disk. */
  source: string;
}

const TEXT_EXT = new Set([".json", ".txt", ".html", ".htm", ".xml", ".csv", ".md", ".css", ".js", ".svg", ".yml"]);
const toPosix = (p: string) => p.split(sep).join("/");

function mockDir(workspaceDir: string, mock: string): string {
  if (!slug.safeParse(mock).success) throw new EditError("INVALID", `Invalid mock name "${mock}"`);
  return join(resolve(workspaceDir), "mocks", mock);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolves a path inside the mock folder; refuses anything that escapes it. */
async function inside(root: string, target: string): Promise<string> {
  const absRoot = await realpath(root).catch(() => resolve(root));
  const abs = resolve(target);
  let probe = abs;
  // The file may not exist yet: check the closest existing parent.
  while (!(await exists(probe)) && dirname(probe) !== probe) probe = dirname(probe);
  const real = await realpath(probe).catch(() => probe);
  const rest = relative(probe, abs);
  const full = rest ? join(real, rest) : real;
  if (full !== absRoot && !full.startsWith(absRoot + sep)) throw new EditError("OUTSIDE", `${target} is outside the mock folder`);
  return full;
}

function bodyPath(mockRoot: string, routeAbs: string, ref: string): string {
  return ref.startsWith("/") ? resolve(mockRoot, `.${ref}`) : resolve(routeAbs, "..", ref);
}

async function listRouteFiles(dir: string): Promise<string[]> {
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
  return out;
}

/** Same default id rule as the loader: the file path under routes/ without .yaml. */
function defaultId(routesDir: string, abs: string): string {
  return toPosix(relative(routesDir, abs)).replace(/\.yaml$/, "").toLowerCase();
}

async function findRouteFile(root: string, routeId: string): Promise<{ abs: string; doc: Document; text: string } | null> {
  const routesDir = join(root, "routes");
  for (const abs of await listRouteFiles(routesDir)) {
    const text = await readFile(abs, "utf8");
    const doc = parseDocument(text);
    const id = (doc.get("id") as string | undefined) ?? defaultId(routesDir, abs);
    if (id === routeId) return { abs, doc, text };
  }
  return null;
}

function issuesOf(err: z.ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

/** Reads a route as an editable draft, with the text of its body files. */
export async function readRoute(workspaceDir: string, mock: string, routeId: string): Promise<RouteDocument> {
  const root = mockDir(workspaceDir, mock);
  const found = await findRouteFile(root, routeId);
  if (!found) throw new EditError("NOT_FOUND", `No route "${routeId}" in mock "${mock}"`);
  const parsed = routeFile.safeParse(found.doc.toJS());
  if (!parsed.success) throw new EditError("INVALID", "The route file has problems; fix them in the file first", issuesOf(parsed.error));
  const r = parsed.data;
  const responses: ResponseDraft[] = [];
  for (const resp of r.responses ?? []) {
    let body: BodyDraft = { kind: "none" };
    if (typeof resp.body === "string") body = { kind: "inline", text: resp.body };
    else if (resp.body && "inline" in resp.body) body = { kind: "inline", text: resp.body.inline };
    else if (resp.body && "json" in resp.body) body = { kind: "json", value: resp.body.json };
    else if (resp.body && "file" in resp.body) {
      const abs = bodyPath(root, found.abs, resp.body.file);
      const text = TEXT_EXT.has(extname(abs).toLowerCase()) ? await readFile(await inside(root, abs), "utf8").catch(() => "") : null;
      body = { kind: "file", path: resp.body.file, text };
    }
    const draft: ResponseDraft = { id: resp.id, body };
    if (resp.default !== undefined) draft.default = resp.default;
    if (resp.status !== undefined) draft.status = resp.status;
    if (resp.headers) draft.headers = Object.fromEntries(Object.entries(resp.headers).map(([k, v]) => [k, String(v)]));
    if (resp.latency !== undefined) draft.latency = resp.latency;
    if (resp.template !== undefined) draft.template = resp.template;
    if (resp.description !== undefined) draft.description = resp.description;
    if (resp.rules) draft.rules = resp.rules;
    if (resp.callbacks) draft.callbacks = resp.callbacks;
    responses.push(draft);
  }
  const draft: RouteDraft = { id: r.id ?? routeId, path: r.path };
  if (r.method) draft.method = r.method;
  if (r.mode) draft.mode = r.mode;
  if (r.latency !== undefined) draft.latency = r.latency;
  if (r.description !== undefined) draft.description = r.description;
  if (r.crud) draft.crud = r.crud;
  if (!r.crud) draft.responses = responses;
  return { file: toPosix(relative(root, found.abs)), draft, source: found.text };
}

/** The YAML value of a draft body (body files are written separately). */
function bodyValue(body: BodyDraft): unknown {
  switch (body.kind) {
    case "none":
      return undefined;
    case "inline":
      return body.text;
    case "json":
      return { json: body.value };
    case "file":
      return { file: body.path };
  }
}

function toRouteFile(draft: RouteDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (draft.id !== undefined) out["id"] = draft.id;
  if (draft.method !== undefined) out["method"] = draft.method;
  out["path"] = draft.path;
  if (draft.mode !== undefined && draft.mode !== "rules") out["mode"] = draft.mode;
  if (draft.latency) out["latency"] = draft.latency;
  if (draft.description) out["description"] = draft.description;
  if (draft.crud) out["crud"] = draft.crud;
  if (draft.responses) {
    out["responses"] = draft.responses.map((r) => {
      const o: Record<string, unknown> = { id: r.id };
      if (r.default) o["default"] = true;
      if (r.status !== undefined && r.status !== 200) o["status"] = r.status;
      if (r.headers && Object.keys(r.headers).length) o["headers"] = r.headers;
      const body = bodyValue(r.body);
      if (body !== undefined) o["body"] = body;
      if (r.latency) o["latency"] = r.latency;
      if (r.template === false) o["template"] = false;
      if (r.description) o["description"] = r.description;
      if (r.rules) o["rules"] = r.rules;
      if (r.callbacks?.length) o["callbacks"] = r.callbacks;
      return o;
    });
  }
  return out;
}

function fileNameFor(draft: RouteDraft): string {
  const method = draft.crud ? "crud" : (draft.method ?? "get").toLowerCase();
  const slugPath = draft.path
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
  return `${method}-${slugPath || "raiz"}`;
}

/**
 * Creates or updates a route. `routeId` names the route being edited (null to
 * create one in `folder` under routes/). Returns the route file, relative to
 * the mock folder. Throws EditError("INVALID") with field issues when the
 * draft does not validate; nothing is written then.
 */
export async function writeRoute(workspaceDir: string, mock: string, draft: RouteDraft, routeId: string | null, folder = ""): Promise<string> {
  const root = mockDir(workspaceDir, mock);
  if (!(await exists(join(root, MOCK_FILE)))) throw new EditError("NOT_FOUND", `No mock "${mock}"`);
  const plain = toRouteFile(draft);
  const parsed = routeFile.safeParse(plain);
  if (!parsed.success) throw new EditError("INVALID", "The route is not valid", issuesOf(parsed.error));

  const routesDir = join(root, "routes");
  let abs: string;
  let doc: Document;
  if (routeId) {
    const found = await findRouteFile(root, routeId);
    if (!found) throw new EditError("NOT_FOUND", `No route "${routeId}" in mock "${mock}"`);
    abs = found.abs;
    doc = found.doc;
  } else {
    const dir = await inside(routesDir, join(routesDir, folder));
    const base = fileNameFor(draft);
    let name = `${base}.yaml`;
    for (let n = 2; await exists(join(dir, name)); n++) name = `${base}-${n}.yaml`;
    abs = join(dir, name);
    doc = parseDocument("{}");
  }

  // Ids must stay unique within the mock.
  const newId = draft.id ?? defaultId(routesDir, abs);
  if (newId !== routeId) {
    const clash = await findRouteFile(root, newId);
    if (clash && clash.abs !== abs) throw new EditError("EXISTS", `Another route already uses the id "${newId}"`);
  }

  // Body files first: if one cannot be written, the route file stays as it was.
  for (const r of draft.responses ?? []) {
    if (r.body.kind !== "file" || r.body.text === null) continue;
    const target = await inside(root, bodyPath(root, abs, r.body.path));
    await mkdir(dirname(target), { recursive: true });
    const current = await readFile(target, "utf8").catch(() => null);
    if (current !== r.body.text) await writeFile(target, r.body.text);
  }

  // Update the YAML in place: keeps comments and the order of keys that stay.
  if (!isMap(doc.contents)) doc = parseDocument("{}");
  const keys = ["id", "method", "path", "mode", "latency", "description", "crud", "responses"];
  for (const key of keys) {
    if (plain[key] === undefined) doc.delete(key);
    else doc.set(key, doc.createNode(plain[key]));
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, doc.toString({ lineWidth: 0 }));
  return toPosix(relative(root, abs));
}

/** Sets the explicit route order of a mock (mock.yaml → order). An empty list removes it. */
export async function setRouteOrder(workspaceDir: string, mock: string, ids: string[]): Promise<void> {
  const file = join(mockDir(workspaceDir, mock), MOCK_FILE);
  const doc = parseDocument(await readFile(file, "utf8"));
  if (ids.length) doc.set("order", doc.createNode(ids));
  else doc.delete("order");
  await writeFile(file, doc.toString({ lineWidth: 0 }));
}

/** Removes a route file. `trash` moves it to the OS trash when the caller has one (desktop). */
export async function deleteRoute(workspaceDir: string, mock: string, routeId: string, trash?: (abs: string) => Promise<void>): Promise<string> {
  const root = mockDir(workspaceDir, mock);
  const found = await findRouteFile(root, routeId);
  if (!found) throw new EditError("NOT_FOUND", `No route "${routeId}" in mock "${mock}"`);
  if (trash) await trash(found.abs);
  else await rm(found.abs);
  return toPosix(relative(root, found.abs));
}

/**
 * Removes a whole mock: its folder, its entry in mockix.workspace.yaml (when that
 * file lists mocks) and the Sendix environment it wrote (only one it marked as its
 * own). `trash` moves files to the OS trash when the caller has one (desktop).
 * Returns the paths removed, relative to the workspace.
 */
export async function deleteMock(workspaceDir: string, name: string, trash?: (abs: string) => Promise<void>): Promise<string[]> {
  const ws = resolve(workspaceDir);
  const root = mockDir(workspaceDir, name);
  if (!(await exists(join(root, MOCK_FILE)))) throw new EditError("NOT_FOUND", `No mock named "${name}"`);
  const remove = (abs: string) => (trash ? trash(abs) : rm(abs, { recursive: true, force: true }));
  const removed: string[] = [];

  await remove(root);
  removed.push(toPosix(relative(ws, root)));

  const wsFile = join(ws, WORKSPACE_FILE);
  if (await exists(wsFile)) {
    const doc = parseDocument(await readFile(wsFile, "utf8"));
    const parsed = workspaceFile.safeParse(doc.toJS());
    if (parsed.success && parsed.data.mocks?.includes(name)) {
      doc.set("mocks", doc.createNode(parsed.data.mocks.filter((m) => m !== name), { flow: true }));
      await writeFile(wsFile, doc.toString({ lineWidth: 0 }));
    }
  }

  const env = join(ws, "environments", `Mock ${name}.postman_environment.json`);
  if (await exists(env)) {
    try {
      const marker = (JSON.parse(await readFile(env, "utf8")) as { "x-mockix"?: { mock?: unknown } })["x-mockix"];
      if (marker?.mock === name) {
        await remove(env);
        removed.push(toPosix(relative(ws, env)));
      }
    } catch {
      // Not valid JSON: not one Mockix wrote, so it stays.
    }
  }
  return removed;
}

/** Extra mock.yaml settings a caller (an importer) may set when creating a mock. */
export interface MockExtras {
  latency?: number;
  cors?: boolean;
  proxy?: { target: string; keepPrefix?: boolean } | undefined;
  variables?: Record<string, string>;
  description?: string;
  grpc?: { port: number };
  /** OpenAPI contract the mock is checked against (a path inside the workspace). */
  contract?: { file: string; mode?: "off" | "warn" | "strict" };
}

/** Creates mocks/<name>/mock.yaml and routes/ (and lists it in mockix.workspace.yaml when that file lists mocks). */
export async function createMock(workspaceDir: string, name: string, port: number, prefix = "", extras: MockExtras = {}): Promise<void> {
  // Checked before writing anything: a mock outside a workspace would be left half made and never load.
  const wsFile = join(resolve(workspaceDir), WORKSPACE_FILE);
  if (!(await exists(wsFile))) throw new EditError("NOT_WORKSPACE", `${resolve(workspaceDir)} no es un workspace de Mockix: falta ${WORKSPACE_FILE}`);
  const root = mockDir(workspaceDir, name);
  if (await exists(root)) throw new EditError("EXISTS", `A mock named "${name}" already exists`);
  const settings: Record<string, unknown> = { port };
  if (prefix) settings["prefix"] = prefix;
  if (extras.latency) settings["latency"] = extras.latency;
  if (extras.cors === false) settings["cors"] = false;
  if (extras.proxy) settings["proxy"] = extras.proxy.keepPrefix ? { target: extras.proxy.target, keepPrefix: true } : { target: extras.proxy.target };
  if (extras.variables && Object.keys(extras.variables).length) settings["variables"] = extras.variables;
  if (extras.description) settings["description"] = extras.description;
  if (extras.grpc) settings["grpc"] = { port: extras.grpc.port };
  if (extras.contract) settings["contract"] = { file: extras.contract.file, mode: extras.contract.mode ?? "warn" };
  const parsed = mockFile.safeParse(settings);
  if (!parsed.success) throw new EditError("INVALID", "The mock settings are not valid", issuesOf(parsed.error));
  await mkdir(join(root, "routes"), { recursive: true });
  await writeFile(join(root, MOCK_FILE), `# Ajustes del mock "${name}".\n${stringify(settings)}`);

  const doc = parseDocument(await readFile(wsFile, "utf8"));
  const ws = workspaceFile.safeParse(doc.toJS());
  if (ws.success && ws.data.mocks && !ws.data.mocks.includes(name)) {
    doc.set("mocks", doc.createNode([...ws.data.mocks, name], { flow: true }));
    await writeFile(wsFile, doc.toString({ lineWidth: 0 }));
  }
}
