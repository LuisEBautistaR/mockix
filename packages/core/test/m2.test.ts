import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { allProblems, loadWorkspace, startMock, type CallbackLogEntry, type MockDefinition, type MockHandle, type RequestLogEntry, type RuntimeRoute } from "@mockix/core";

const running: MockHandle[] = [];
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((m) => m.stop()));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function start(definition: MockDefinition, options = {}): Promise<MockHandle> {
  const mock = await startMock(definition, options);
  running.push(mock);
  return mock;
}

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** A tiny "real API" for proxy and callback tests. */
async function fixture(handler: (seen: Seen) => { status: number; headers?: Record<string, string>; body?: string }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const s = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    seen.push(s);
    const r = handler(s);
    res.writeHead(r.status, r.headers ?? {});
    res.end(r.body ?? "");
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

const textRoute = (id: string, method: RuntimeRoute["method"], path: string, text: string, extra: Partial<RuntimeRoute["responses"][number]> = {}): RuntimeRoute => ({
  id,
  file: "",
  method,
  path,
  mode: "rules",
  latencyMs: 0,
  crud: null,
  responses: [{ id: "ok", default: true, status: 200, headers: { "Content-Type": "application/json" }, body: { kind: "text", text }, latencyMs: 0, rules: null, template: true, callbacks: [], ...extra }],
});

const crudRoute: RuntimeRoute = { id: "inv", file: "", method: "ANY", path: "/inventario", mode: "rules", latencyMs: 0, crud: { bucket: "inventario", key: "sku" }, responses: [] };
const seed = [
  { sku: "A", sucursal: "cdmx", stock: 5 },
  { sku: "B", sucursal: "gdl", stock: 0 },
  { sku: "C", sucursal: "cdmx", stock: 9 },
];

describe("CRUD routes", () => {
  it("lists, filters, sorts, paginates, creates, replaces, updates and deletes", async () => {
    const m = await start({ name: "t", port: 0, routes: [crudRoute], buckets: { inventario: seed } }, { seed: 1 });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${m.url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
    };

    const all = await call("GET", "/inventario");
    expect(all.json).toHaveLength(3);
    expect(all.headers.get("x-total-count")).toBe("3");
    expect((await call("GET", "/inventario?sucursal=cdmx")).json.map((x: { sku: string }) => x.sku)).toEqual(["A", "C"]);
    expect((await call("GET", "/inventario?sort=stock&order=desc")).json.map((x: { sku: string }) => x.sku)).toEqual(["C", "A", "B"]);
    const page2 = await call("GET", "/inventario?limit=2&page=2");
    expect(page2.json.map((x: { sku: string }) => x.sku)).toEqual(["C"]);
    expect(page2.headers.get("x-total-count")).toBe("3");

    expect((await call("GET", "/inventario/B")).json).toEqual({ sku: "B", sucursal: "gdl", stock: 0 });
    expect((await call("GET", "/inventario/Z")).status).toBe(404);

    const created = await call("POST", "/inventario", { sucursal: "mty", stock: 1 });
    expect(created.status).toBe(201);
    expect(created.json.sku).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.headers.get("location")).toBe(`/inventario/${created.json.sku}`);
    expect((await call("POST", "/inventario", { sku: "A" })).status).toBe(409);
    expect((await call("POST", "/inventario", [1, 2])).status).toBe(400);

    expect((await call("PUT", "/inventario/A", { stock: 50, sku: "OTRO" })).json).toEqual({ stock: 50, sku: "A" });
    expect((await call("PATCH", "/inventario/C", { stock: 1 })).json).toEqual({ sku: "C", sucursal: "cdmx", stock: 1 });
    expect((await call("DELETE", "/inventario/B")).status).toBe(204);
    expect((await call("DELETE", "/inventario/B")).status).toBe(404);
    const bad = await call("DELETE", "/inventario");
    expect(bad.status).toBe(405);
    expect(bad.headers.get("allow")).toBe("GET, HEAD, POST");
    expect((await call("GET", "/inventario")).json.map((x: { sku: string }) => x.sku)).toEqual(["A", "C", created.json.sku]);

    // Live data survives a reload while the seed is unchanged, and restarts when the seed changes.
    m.update({ name: "t", port: m.port, routes: [crudRoute], buckets: { inventario: seed } });
    expect((await call("GET", "/inventario")).json).toHaveLength(3);
    m.update({ name: "t", port: m.port, routes: [crudRoute], buckets: { inventario: [seed[0]] } });
    expect((await call("GET", "/inventario")).json).toEqual([seed[0]]);
  });
});

describe("templates in responses", () => {
  it("renders bodies and headers, and gives the same output for the same seed", async () => {
    const route = textRoute("c", "GET", "/clientes/:id", '{"id":"{{urlParam \'id\'}}","nombre":"{{faker \'person.fullName\'}}","n":{{int 1 1000}}}', {
      headers: { "Content-Type": "application/json", "X-Cliente": "{{urlParam 'id'}}" },
    });
    const run = async () => {
      const m = await start({ name: "t", port: 0, routes: [route] }, { seed: 99 });
      const a = await fetch(`${m.url}/clientes/7`);
      const b = await fetch(`${m.url}/clientes/8`);
      return [a.headers.get("x-cliente"), await a.text(), await b.text()];
    };
    const first = await run();
    expect(first[0]).toBe("7");
    expect(JSON.parse(first[1]!)).toMatchObject({ id: "7" });
    expect(await run()).toEqual(first);
  });

  it("answers 500 with the reason when a template fails, and serves raw text when template is off", async () => {
    const broken = textRoute("b", "GET", "/b", "{{faker 'nada.algo'}}");
    const raw = textRoute("r", "GET", "/r", "{{literal}}", { template: false });
    const m = await start({ name: "t", port: 0, routes: [broken, raw] });
    const entries: RequestLogEntry[] = [];
    m.on("request", (e) => entries.push(e));
    const res = await fetch(`${m.url}/b`);
    expect(res.status).toBe(500);
    expect(res.headers.get("x-mockix")).toBe("template-error");
    expect(await res.json()).toMatchObject({ error: "Template error", route: "b", response: "ok" });
    expect(await (await fetch(`${m.url}/r`)).text()).toBe("{{literal}}");
    await expect.poll(() => entries[0]?.error).toContain("no existe");
  });
});

describe("request log capture", () => {
  it("keeps headers and bodies, and redacts credentials", async () => {
    const m = await start({ name: "t", port: 0, routes: [textRoute("p", "POST", "/p", '{"ok":true}')] });
    const entries: RequestLogEntry[] = [];
    m.on("request", (e) => entries.push(e));
    await fetch(`${m.url}/p`, { method: "POST", headers: { Authorization: "Bearer secreto", Cookie: "s=1", "content-type": "application/json", "X-Traza": "t1" }, body: '{"a":1}' });
    await expect.poll(() => entries.length).toBe(1);
    const e = entries[0]!;
    expect(e.kind).toBe("route");
    expect(e.request.headers).toMatchObject({ authorization: "[redactado]", cookie: "[redactado]", "x-traza": "t1" });
    expect(e.request.body).toBe('{"a":1}');
    expect(e.response).toMatchObject({ body: '{"ok":true}', binary: false, truncated: false });
    expect(e.response.headers["content-type"]).toBe("application/json");
    expect(m.logs(1)[0]!.seq).toBe(1);
  });
});

describe("callbacks", () => {
  it("calls allowed hosts after answering, rendered with the request, and refuses others", async () => {
    const hook = await fixture(() => ({ status: 202 }));
    const target = new URL(hook.url);
    const route = textRoute("c", "POST", "/pedidos", '{"id":"p1"}', {
      callbacks: [
        { url: `${hook.url}/hooks/{{body 'tipo'}}`, method: "POST", headers: { "X-Evento": "pedido" }, body: '{"cliente":{{body \'cliente\'}}}', delayMs: 0 },
        { url: "http://otro.test/x", method: "POST", headers: {}, body: null, delayMs: 0 },
      ],
    });
    const m = await start({ name: "t", port: 0, routes: [route], callbackHosts: [target.host] });
    const calls: CallbackLogEntry[] = [];
    m.on("callback", (c) => calls.push(c));
    expect((await fetch(`${m.url}/pedidos`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"tipo":"nuevo","cliente":1043}' })).status).toBe(200);

    await expect.poll(() => calls.length, { timeout: 5000 }).toBe(2);
    expect(hook.seen).toHaveLength(1);
    expect(hook.seen[0]).toMatchObject({ method: "POST", url: "/hooks/nuevo", body: '{"cliente":1043}' });
    expect(hook.seen[0]!.headers["x-evento"]).toBe("pedido");
    expect(hook.seen[0]!.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(calls.find((c) => c.url.startsWith(hook.url))).toMatchObject({ requestSeq: 1, status: 202, error: null });
    expect(calls.find((c) => c.url === "http://otro.test/x")?.error).toContain("host no permitido");
  });
});

describe("partial mocking (proxy)", () => {
  it("forwards what no route answers, with method, path, query, headers and body", async () => {
    const api = await fixture((s) => ({ status: s.url.startsWith("/v1/clientes") ? 200 : 418, headers: { "content-type": "application/json", "x-real": "si" }, body: JSON.stringify({ real: true, url: s.url }) }));
    const m = await start({
      name: "t",
      port: 0,
      prefix: "/v1",
      routes: [textRoute("salud", "GET", "/salud", '{"mock":true}')],
      proxy: { target: `${api.url}/v1`, keepPrefix: false, insecure: false, headers: { "X-Desde": "mockix" } },
    });
    const entries: RequestLogEntry[] = [];
    m.on("request", (e) => entries.push(e));

    expect(await (await fetch(`${m.url}/v1/salud`)).json()).toEqual({ mock: true });
    const res = await fetch(`${m.url}/v1/clientes/9?x=1`, { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer real" }, body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-real")).toBe("si");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ real: true, url: "/v1/clientes/9?x=1" });
    expect(api.seen.at(-1)).toMatchObject({ method: "POST", url: "/v1/clientes/9?x=1", body: '{"a":1}' });
    expect(api.seen.at(-1)!.headers["x-desde"]).toBe("mockix");
    expect(api.seen.at(-1)!.headers["authorization"]).toBe("Bearer real");
    expect(api.seen).toHaveLength(1);

    await expect.poll(() => entries.length).toBe(2);
    expect(entries[1]).toMatchObject({ kind: "proxy", status: 200, routeId: null });
    expect(entries[1]!.response.body).toContain('"real":true');
  });

  it("answers 502 when the real API is down", async () => {
    const m = await start({ name: "t", port: 0, routes: [], proxy: { target: "http://127.0.0.1:9", keepPrefix: false, insecure: false, headers: {} } });
    const res = await fetch(`${m.url}/x`);
    expect(res.status).toBe(502);
    expect(res.headers.get("x-mockix")).toBe("proxy-error");
  });

  it("is used when a fallback route lets the request through", async () => {
    const api = await fixture(() => ({ status: 200, body: "real" }));
    const fallback: RuntimeRoute = { ...textRoute("f", "GET", "/x", "mock", { rules: { mode: "all", when: [{ target: "query.mock", op: "exists", value: undefined, negate: false }] } }), mode: "fallback" };
    const m = await start({ name: "t", port: 0, routes: [fallback], proxy: { target: api.url, keepPrefix: false, insecure: false, headers: {} } });
    expect(await (await fetch(`${m.url}/x?mock=1`)).text()).toBe("mock");
    expect(await (await fetch(`${m.url}/x`)).text()).toBe("real");
  });
});

describe("control API", () => {
  it("exposes health always and the rest only with the token", async () => {
    const m = await start({ name: "t", port: 0, routes: [crudRoute], buckets: { inventario: seed }, variables: { moneda: "MXN" } }, { adminToken: "s3creto" });
    const call = (method: string, path: string, token: string | null = "s3creto", body?: unknown) =>
      fetch(`${m.url}/__mockix${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

    expect(await (await call("GET", "/health", null)).json()).toEqual({ status: "ok", mock: "t", routes: 1 });
    expect((await call("GET", "/logs", null)).status).toBe(401);
    expect((await call("GET", "/logs", "otro")).status).toBe(401);

    await fetch(`${m.url}/inventario/A`);
    const logs = (await (await call("GET", "/logs?limit=5")).json()) as RequestLogEntry[];
    expect(logs.map((l) => l.url)).toEqual(["/inventario/A"]);

    expect(await (await call("GET", "/buckets")).json()).toEqual(["inventario"]);
    expect((await (await call("PUT", "/buckets/inventario", "s3creto", [{ sku: "X" }])).json())).toEqual([{ sku: "X" }]);
    expect(await (await fetch(`${m.url}/inventario`)).json()).toEqual([{ sku: "X" }]);
    await call("POST", "/buckets/inventario/reset");
    expect(await (await fetch(`${m.url}/inventario`)).json()).toHaveLength(3);

    expect(await (await call("PUT", "/vars/moneda", "s3creto", { value: "USD" })).json()).toEqual({ moneda: "USD" });
    expect(await (await call("GET", "/vars")).json()).toEqual({ moneda: "USD" });
    await call("POST", "/reset");
    expect(await (await call("GET", "/vars")).json()).toEqual({ moneda: "MXN" });
    expect((await call("DELETE", "/logs")).status).toBe(204);
    expect(await (await call("GET", "/logs")).json()).toEqual([]);
  });

  it("does not exist without a token", async () => {
    const m = await start({ name: "t", port: 0, routes: [] });
    expect((await fetch(`${m.url}/__mockix/health`)).status).toBe(200);
    expect((await fetch(`${m.url}/__mockix/logs`, { headers: { Authorization: "Bearer x" } })).status).toBe(404);
  });
});

describe("loader, M2 parts", () => {
  async function workspace(files: Record<string, string>): Promise<string> {
    const ws = await mkdtemp(join(tmpdir(), "mockix-m2-"));
    dirs.push(ws);
    for (const [rel, content] of Object.entries({ "mockix.workspace.yaml": "format: 1\n", ...files })) {
      await mkdir(dirname(join(ws, rel)), { recursive: true });
      await writeFile(join(ws, rel), content);
    }
    return ws;
  }

  it("reads buckets, variables, allow-listed env, proxy and callbacks", async () => {
    const ws = await workspace({
      "mockix.workspace.yaml": "format: 1\nvariables: { moneda: MXN, iva: 0.16 }\nenv: [MOCKIX_PRUEBA, NO_DEFINIDA]\n",
      "mocks/a/mock.yaml": "port: 0\nvariables: { moneda: USD }\nproxy: { target: 'https://api.test/v1/', keepPrefix: true }\ncallbacks: { allow: [hooks.test] }\n",
      "mocks/a/data/productos.json": '[{"id":1}]',
      "mocks/a/routes/inv.yaml": "path: /inv\ncrud: { bucket: productos }\n",
    });
    const config = (await loadWorkspace(ws, { env: { MOCKIX_PRUEBA: "valor", PATH: "secreto" } })).mocks[0]!.config!;
    expect(config.variables).toEqual({ moneda: "USD", iva: "0.16" });
    expect(config.env).toEqual({ MOCKIX_PRUEBA: "valor" });
    expect(config.buckets).toEqual({ productos: [{ id: 1 }] });
    expect(config.proxy).toEqual({ target: "https://api.test/v1", keepPrefix: true, insecure: false, headers: {} });
    expect(config.callbackHosts).toEqual(["hooks.test"]);
    expect(config.routes[0]).toMatchObject({ method: "ANY", crud: { bucket: "productos", key: "id" }, responses: [] });
  });

  it("reports template, bucket and CRUD problems", async () => {
    const ws = await workspace({
      "mocks/a/mock.yaml": "port: 0\n",
      "mocks/a/data/roto.json": '{\n  "a": 1,\n  oops\n}',
      "mocks/a/data/objeto.json": '{"a":1}',
      "mocks/a/routes/t.yaml": "path: /t\nresponses:\n  - id: ok\n    body: '{{#repeat 2}}sin cerrar'\n",
      "mocks/a/routes/h.yaml": "path: /h\nresponses:\n  - id: ok\n    headers: { X: '{{noExiste 1}}' }\n",
      "mocks/a/routes/c1.yaml": "path: /c1\ncrud: { bucket: falta }\n",
      "mocks/a/routes/c2.yaml": "path: /c2\ncrud: { bucket: objeto }\n",
      "mocks/a/routes/c3.yaml": "path: /c3\nmethod: GET\ncrud: { bucket: objeto }\nresponses: [{ id: ok }]\n",
    });
    const problems = allProblems(await loadWorkspace(ws));
    const messages = problems.map((p) => `${p.file}:${p.line ?? "-"} ${p.message}`);
    expect(messages).toContainEqual("mocks/a/data/roto.json:3 JSON no válido");
    expect(messages).toContainEqual(expect.stringMatching(/routes\/t\.yaml.*responses\[0\]\.body: plantilla:/));
    expect(messages).toContainEqual(expect.stringMatching(/routes\/h\.yaml.*headers\.X: plantilla:.*noExiste/));
    expect(messages).toContainEqual(expect.stringContaining("crud.bucket: no existe data/falta.json"));
    expect(messages).toContainEqual(expect.stringContaining("debe ser una lista"));
    expect(messages).toContainEqual(expect.stringContaining("una ruta CRUD no lleva respuestas propias"));
    expect(messages).toContainEqual(expect.stringContaining("una ruta CRUD atiende todos los métodos"));
  });
});
