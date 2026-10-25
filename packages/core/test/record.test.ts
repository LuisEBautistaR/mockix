import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  RecordingWriter,
  allProblems,
  convertRecording,
  listRecordings,
  loadWorkspace,
  mergeIntoMock,
  planMerge,
  readRecording,
  startCassette,
  startMock,
  writeExampleWorkspace,
  writeImported,
  type Exchange,
  type MockHandle,
} from "@mockix/core";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const SECRETS = ["Bearer s3cr3t-real", "sesion=abc123", "ana.torres@correo-real.mx", "55 1234 5678", "rcv-7Hq-Zk2", "k-real-999"];

const stops: Array<() => Promise<unknown>> = [];
const dirs: string[] = [];
afterEach(async () => Promise.all(stops.splice(0).map((s) => s())));
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

/** The "real API": answers depend on the id, a role header and a query flag. */
async function realApi(): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    for await (const _ of req) void _;
    const url = new URL(req.url!, "http://x");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", "Set-Cookie": "sesion=abc123", Date: new Date().toUTCString(), ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/v1/logo.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(PNG);
    }
    const cliente = /^\/v1\/clientes\/(\d+)$/.exec(url.pathname);
    if (cliente) {
      if (cliente[1]!.startsWith("9")) return send(404, { error: "no existe" });
      if (req.headers["x-rol"] === "invitado") return send(403, { error: "rol" });
      return send(200, { id: Number(cliente[1]), nombre: "Ana Torres", email: "ana.torres@correo-real.mx", telefono: "55 1234 5678", token_recuperacion: "rcv-7Hq-Zk2", nivel: "oro" });
    }
    if (url.pathname === "/v1/productos") return send(200, url.searchParams.get("vacio") ? { data: [] } : { data: [{ id: "prd_7Qm2" }] });
    return send(404, { error: "ruta" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

async function workspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "mockix-rec-"));
  dirs.push(ws);
  await writeExampleWorkspace(ws);
  return ws;
}

/** Records the traffic of `calls` through a recording proxy in front of the real API. */
async function record(ws: string, api: string, calls: (proxy: string) => Promise<void>): Promise<string> {
  const writer = new RecordingWriter(ws, api);
  const proxy: MockHandle = await startMock({ name: "grabacion", port: 0, routes: [], proxy: { target: api, keepPrefix: true, insecure: false, headers: {} } }, { onProxied: (ex) => void writer.add(ex) });
  await calls(proxy.url);
  await proxy.stop();
  await writer.flush();
  return writer.file;
}

const traffic = async (base: string) => {
  const auth = { Authorization: "Bearer s3cr3t-real" };
  await fetch(`${base}/v1/clientes/1043`, { headers: auth });
  await fetch(`${base}/v1/clientes/2001`, { headers: auth });
  await fetch(`${base}/v1/clientes/9001`, { headers: auth });
  await fetch(`${base}/v1/clientes/1043`, { headers: { ...auth, "X-Rol": "invitado" } });
  await fetch(`${base}/v1/productos?api_key=k-real-999`);
  await fetch(`${base}/v1/productos?vacio=1&api_key=k-real-999`);
  await fetch(`${base}/v1/logo.png`);
};

describe("recording → mock", () => {
  it("records the real API, converts it, and replays it with the API turned off and no secrets on disk", async () => {
    const ws = await workspace();
    const api = await realApi();
    const file = await record(ws, api.url, traffic);
    await new Promise<void>((r) => api.server.close(() => r()));

    expect(file).toContain(join(".mockix", "recordings"));
    const listed = await listRecordings(ws);
    expect(listed).toEqual([expect.objectContaining({ target: api.url, exchanges: 7 })]);
    const { exchanges } = await readRecording(file);
    expect(exchanges).toHaveLength(7);
    expect(exchanges[0]!.requestHeaders["authorization"]).toBe("Bearer s3cr3t-real"); // raw stays raw in .mockix/
    expect(Buffer.from(exchanges[6]!.responseBytes!)).toEqual(PNG);

    const result = convertRecording(exchanges, { name: "api-real", source: listed[0]!.file, prefix: "/v1" });
    expect(planMerge(null, result, exchanges, "/v1").map((p) => `${p.method} ${p.path} ${p.exchanges} ${p.responses} ${p.action}`)).toEqual([
      "GET /clientes/:id 4 3 new",
      "GET /productos 2 2 new",
      "GET /logo.png 1 1 new",
    ]);
    const written = await writeImported(ws, result, { port: 0 });

    // Not one secret in any generated file.
    const root = join(ws, "mocks", written.name);
    const all: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(join(d, e.name));
        else all.push(await readFile(join(d, e.name), "latin1"));
      }
    };
    await walk(root);
    for (const secret of SECRETS) expect(all.join("\n"), secret).not.toContain(secret);

    // Served with the real API down: same answers, ids follow the URL, fake data in sensitive fields.
    const load = await loadWorkspace(ws);
    expect(allProblems(load)).toEqual([]);
    const mock = await startMock(load.mocks.find((m) => m.name === written.name)!.config!);
    stops.push(() => mock.stop());
    const base = `${mock.url}/v1`;
    const cliente = (await (await fetch(`${base}/clientes/3003`)).json()) as Record<string, unknown>;
    expect(cliente).toMatchObject({ id: 3003, nombre: "Ana Torres", nivel: "oro" });
    expect(cliente["email"]).not.toBe("ana.torres@correo-real.mx");
    expect((await fetch(`${base}/clientes/9001`)).status).toBe(404);
    expect((await fetch(`${base}/clientes/1043`, { headers: { "X-Rol": "invitado" } })).status).toBe(403);
    expect(await (await fetch(`${base}/productos?vacio=1`)).json()).toEqual({ data: [] });
    expect(Buffer.from(await (await fetch(`${base}/logo.png`)).arrayBuffer())).toEqual(PNG);
  });

  it("adds new routes and new answers to an existing mock without duplicating", async () => {
    const ws = await workspace();
    const tienda = (await loadWorkspace(ws)).mocks[0]!.config!;
    const exchanges: Exchange[] = [
      { method: "GET", url: "/v1/salud", requestHeaders: {}, requestBody: "", status: 200, responseHeaders: { "content-type": "application/json" }, responseBody: '{"ok":true,"servicio":"tienda"}', binary: false },
      { method: "GET", url: "/v1/salud?fallo=1", requestHeaders: {}, requestBody: "", status: 503, responseHeaders: { "content-type": "application/json" }, responseBody: '{"ok":false}', binary: false },
      { method: "GET", url: "/v1/facturas/77", requestHeaders: {}, requestBody: "", status: 200, responseHeaders: { "content-type": "application/json" }, responseBody: '{"id":77}', binary: false },
    ];
    const result = convertRecording(exchanges, { name: "x", source: "prueba", prefix: "/v1" });
    expect(planMerge(tienda, result, exchanges, "/v1").map((p) => `${p.path} ${p.action} ${p.added}`)).toEqual(["/salud append 1", "/facturas/:id new 1"]);

    const merged = await mergeIntoMock(ws, "tienda", tienda, result);
    expect(merged).toMatchObject({ newRoutes: 1, appended: 1, unchanged: 0, failed: [] });
    const load = await loadWorkspace(ws);
    expect(allProblems(load)).toEqual([]);
    const config = load.mocks[0]!.config!;
    expect(config.routes.find((r) => r.path === "/salud")!.responses.map((r) => r.status)).toEqual([200, 503]);
    expect(config.routes.some((r) => r.path === "/facturas/:id")).toBe(true);

    const again = await mergeIntoMock(ws, "tienda", config, convertRecording(exchanges, { name: "x", source: "prueba", prefix: "/v1" }));
    expect(again).toMatchObject({ newRoutes: 0, appended: 0, unchanged: 2 });
  });

  it("uses the workspace's redaction profile", async () => {
    const ws = await workspace();
    await writeFile(join(ws, "mockix.workspace.yaml"), "format: 1\nredaction:\n  - { where: json, match: nivel, action: faker, faker: lorem.word }\n");
    const load = await loadWorkspace(ws);
    expect(load.redaction).toEqual([{ where: "json", match: "nivel", action: "faker", faker: "lorem.word" }]);
    const result = convertRecording(
      [{ method: "GET", url: "/x", requestHeaders: {}, requestBody: "", status: 200, responseHeaders: {}, responseBody: '{"nivel":"oro","email":"a@b.c"}', binary: false }],
      { name: "x", source: "p", redaction: load.redaction! },
    );
    const body = result.mock.routes[0]!.draft.responses![0]!.body;
    expect(body.kind === "inline" && body.text).toContain("{{faker 'lorem.word'}}");
    expect(body.kind === "inline" && body.text).toContain("a@b.c"); // only the profile's rules apply
  });
});

describe("cassette", () => {
  const ex = (method: string, url: string, status: number, body: string): Exchange => ({ method, url, requestHeaders: {}, requestBody: "", status, responseHeaders: { "content-type": "text/plain" }, responseBody: body, binary: false });

  it("replays recorded answers in order and reports requests that were not recorded", async () => {
    const tape = [ex("GET", "/estado", 200, "creado"), ex("GET", "/estado", 200, "pagado"), ex("POST", "/pedidos?a=1&b=2", 201, "ok")];
    const c = await startCassette(tape, { port: 0 });
    stops.push(() => c.stop());
    expect(await (await fetch(`${c.url}/estado`)).text()).toBe("creado");
    expect(await (await fetch(`${c.url}/pedidos?b=2&a=1`, { method: "POST" })).text()).toBe("ok");
    expect(await (await fetch(`${c.url}/estado`)).text()).toBe("pagado");
    const extra = await fetch(`${c.url}/estado`);
    expect(extra.status).toBe(599);
    expect(extra.headers.get("x-mockix")).toBe("cassette-miss");
    expect((await fetch(`${c.url}/nada`)).status).toBe(599);
    expect(c.remaining()).toBe(0);
    expect(c.misses().map((m) => m.reason)).toEqual(["ya se usaron todas sus respuestas grabadas", "no está en la grabación"]);
  });

  it("in strict mode, requires the recorded order", async () => {
    const c = await startCassette([ex("GET", "/a", 200, "a"), ex("GET", "/b", 200, "b")], { port: 0, strict: true });
    stops.push(() => c.stop());
    expect((await fetch(`${c.url}/b`)).status).toBe(599);
    expect(await (await fetch(`${c.url}/a`)).text()).toBe("a");
    expect(await (await fetch(`${c.url}/b`)).text()).toBe("b");
    expect(c.misses()[0]!.reason).toBe("se esperaba GET /a");
  });
});
