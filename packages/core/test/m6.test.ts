import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  Contract,
  allProblems,
  checkMockResponses,
  contractCoverage,
  contractJUnit,
  loadWorkspace,
  startMock,
  writeExampleWorkspace,
  type MockConfig,
  type MockHandle,
  type RequestLogEntry,
  type ScenarioEvent,
} from "@mockix/core";

const running: MockHandle[] = [];
const dirs: string[] = [];
afterEach(async () => Promise.all(running.splice(0).map((m) => m.stop())));
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function example(edit?: (ws: string) => Promise<void>): Promise<{ ws: string; config: MockConfig }> {
  const ws = await mkdtemp(join(tmpdir(), "mockix-m6-"));
  dirs.push(ws);
  await writeExampleWorkspace(ws);
  const yaml = join(ws, "mocks/tienda/mock.yaml");
  await writeFile(yaml, (await readFile(yaml, "utf8")).replace("port: 3000", "port: 0"));
  await edit?.(ws);
  const load = await loadWorkspace(ws);
  expect(allProblems(load)).toEqual([]);
  return { ws, config: load.mocks[0]!.config! };
}

async function serve(config: MockConfig, options: Parameters<typeof startMock>[1] = {}): Promise<{ mock: MockHandle; base: string }> {
  const mock = await startMock(config, options);
  running.push(mock);
  return { mock, base: `${mock.url}/v1` };
}

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "app-movil/3.4.1" }, body: JSON.stringify(body) });

describe("contract", () => {
  it("checks parameters and bodies with the reason in Spanish", async () => {
    const { config } = await example();
    const contract = new Contract(config.contract!.document);
    expect(contract.version).toBe("3.1");
    expect(contract.operations).toHaveLength(11);

    const req = (method: string, path: string, extra: Partial<Parameters<Contract["checkRequest"]>[0]> = {}) =>
      contract.checkRequest({ method, path, query: {}, headers: {}, cookies: {}, body: { raw: "", parsed: undefined }, ...extra });

    expect(req("GET", "/productos", { query: { limit: "50" } }).violations).toEqual([]);
    expect(req("GET", "/productos", { query: { limit: "500" } }).violations.map((v) => v.message)).toEqual(["query.limit máximo 100 (recibido 500)"]);
    expect(req("GET", "/ofertas").violations).toMatchObject([{ where: "operation", rule: "operación no definida en el contrato", operation: "GET /ofertas" }]);

    const body = { lineas: [{ sku: "CAF-VER-500", cantidad: "2" }, { sku: "X" }], notas: "rápido" };
    const raw = JSON.stringify(body);
    const r = req("POST", "/pedidos", { headers: { "content-type": "application/json" }, body: { raw, parsed: body } });
    expect(r.operation).toBe("POST /pedidos");
    expect(r.violations.map((v) => v.message).sort()).toEqual([
      'body propiedad extra "notas"',
      'body.lineas[0].cantidad debe ser integer (recibido "2", un string)',
      "body.lineas[1].cantidad es obligatorio",
    ]);
    expect(r.violations.find((v) => v.where === "body.lineas[0].cantidad")!.rule).toBe("body.lineas[].cantidad debe ser integer");
    expect(req("POST", "/pedidos", { headers: { "content-type": "text/plain" }, body: { raw: "hola", parsed: undefined } }).violations[0]!.message).toBe("Content-Type debe ser application/json (recibido text/plain)");
    expect(req("POST", "/pedidos").violations[0]!.message).toBe("body es obligatorio");

    // Responses: exact status, then default; unknown statuses are reported.
    expect(contract.checkResponse("GET /productos/{id}", 404, { "Content-Type": "application/json" }, '{"error":"no"}').map((v) => v.message)).toEqual(["body.codigo es obligatorio"]);
    expect(contract.checkResponse("GET /productos/{id}", 500, {}, null).map((v) => v.message)).toEqual(["estado 500 no documentado"]);
    expect(contract.expectedSchema({ side: "request", operation: "POST /pedidos", where: "body.lineas[0].cantidad", rule: "", message: "" })).toMatchObject({ required: ["lineas"], properties: { lineas: { items: { required: ["sku", "cantidad"] } } } });
  });

  it("understands OpenAPI 3.0 schemas (nullable, boolean exclusiveMinimum)", () => {
    const contract = new Contract({
      openapi: "3.0.3",
      info: { title: "x", version: "1" },
      paths: {
        "/p": {
          post: {
            requestBody: { content: { "application/json": { schema: { type: "object", properties: { n: { type: "number", minimum: 0, exclusiveMinimum: true }, s: { type: "string", nullable: true } } } } } },
            responses: { default: { description: "ok" } },
          },
        },
      },
    });
    const check = (parsed: unknown) => contract.checkRequest({ method: "POST", path: "/p", query: {}, headers: { "content-type": "application/json" }, cookies: {}, body: { raw: JSON.stringify(parsed), parsed } }).violations.map((v) => v.message);
    expect(check({ n: 1, s: null })).toEqual([]);
    expect(check({ n: 0 })).toEqual(["body.n mínimo 0 (sin incluirlo) (recibido 0)"]);
    expect(() => new Contract({ swagger: "2.0" })).toThrow(/no es un documento OpenAPI 3/);
  });

  it("warns by default, rejects in strict mode, and counts by rule and by client", async () => {
    const { config } = await example();
    const { mock, base } = await serve(config);
    const entries: RequestLogEntry[] = [];
    mock.on("request", (e) => entries.push(e));

    const bad = await fetch(`${base}/pedidos`, json({ lineas: [{ sku: "A", cantidad: "2" }] }));
    expect(bad.status).toBe(201);
    await fetch(`${base}/pedidos`, json({ lineas: [{ sku: "B", cantidad: "3" }] }));
    expect((await fetch(`${base}/productos?limit=10`, { headers: { "User-Agent": "panel-admin/1.12" } })).status).toBe(200);
    await expect.poll(() => entries.length).toBe(3);
    expect(entries[0]!.violations.map((v) => v.message)).toEqual(['body.lineas[0].cantidad debe ser integer (recibido "2", un string)']);

    const report = mock.contract()!;
    expect(report).toMatchObject({ mock: "tienda", file: "contracts/tienda.openapi.yaml", mode: "warn", operations: 11, requests: 3, failing: 2 });
    expect(report.rules[0]).toMatchObject({ rule: "body.lineas[].cantidad debe ser integer", count: 2, lastClient: "app-movil/3.4.1", operation: "POST /pedidos" });
    expect(report.clients).toEqual([
      { client: "app-movil/3.4.1", requests: 2, failing: 2 },
      { client: "panel-admin/1.12", requests: 1, failing: 0 },
    ]);
    const junit = contractJUnit([{ report, operations: new Contract(config.contract!.document).operations }]);
    expect(junit).toContain('<testcase classname="contrato tienda" name="POST /pedidos"><failure message="petición: body.lineas[].cantidad debe ser integer');
    expect(junit).toContain('tests="11" failures="1"');

    mock.update({ ...config, contract: { ...config.contract!, mode: "strict" } });
    const strict = await fetch(`${base}/pedidos`, json({ lineas: [] }));
    expect(strict.status).toBe(400);
    expect(strict.headers.get("content-type")).toContain("application/problem+json");
    expect(await strict.json()).toMatchObject({ title: "La petición no cumple el contrato", status: 400, detail: "body.lineas al menos 1 elementos", operation: "POST /pedidos" });
    expect((await fetch(`${base}/salud`)).status).toBe(200);
  });

  it("checks the mock's own responses, live and statically, and reports coverage", async () => {
    const { config } = await example(async (ws) => {
      const file = join(ws, "mocks/tienda/routes/productos/get-producto.yaml");
      await writeFile(file, (await readFile(file, "utf8")).replace("json: { error: no existe, codigo: PRODUCTO_NO_ENCONTRADO }", "json: { error: no existe }"));
    });
    const contract = new Contract(config.contract!.document);
    const coverage = contractCoverage(config, contract);
    expect(coverage.filter((c) => !c.routeId).map((c) => `${c.method} ${c.path} ${c.hasExample}`)).toEqual(["GET /facturas false", "PATCH /pedidos/{id} true"]);
    expect(coverage.find((c) => c.path === "/pedidos/{id}/pago")!.routeId).toBe("pedidos/pagar");

    const problems = checkMockResponses(config, contract);
    expect(problems.map((p) => `${p.routeId} ${p.responseId}: ${p.message}`).sort()).toEqual([
      "inestable ok: la operación no está en el contrato",
      "logo ok: la operación no está en el contrato",
      "pedidos/estado creado: la operación no está en el contrato",
      "productos/obtener no-existe: body.codigo es obligatorio",
    ]);

    const { mock, base } = await serve(config);
    const entries: RequestLogEntry[] = [];
    mock.on("request", (e) => entries.push(e));
    expect((await fetch(`${base}/productos/9001`)).status).toBe(404);
    await expect.poll(() => entries.length).toBe(1);
    expect(entries[0]!.violations).toMatchObject([{ side: "response", where: "body.codigo", status: 404, message: "body.codigo es obligatorio" }]);
    expect(mock.contract()!.rules[0]).toMatchObject({ side: "response", routeId: "productos/obtener", responseId: "no-existe" });
  });
});

describe("scenarios", () => {
  it("runs the order flow: requests and time move each order on its own", async () => {
    const { config } = await example();
    let clock = 1_000_000;
    const { mock, base } = await serve(config, { now: () => clock });
    const events: ScenarioEvent[] = [];
    mock.on("scenario", (e) => events.push(e));
    const get = async (id: string) => (await (await fetch(`${base}/pedidos/${id}`)).json()) as { estado: string; guia?: string };

    expect(await get("ped_1")).toEqual({ id: "ped_1", estado: "creado" });
    expect(await (await fetch(`${base}/pedidos/ped_1/pago`, { method: "POST" })).json()).toEqual({ id: "ped_1", estado: "pagado" });
    expect((await get("ped_2")).estado).toBe("creado");

    clock += 10_000;
    const sent = await get("ped_1");
    expect(sent.estado).toBe("enviado");
    expect(sent.guia).toMatch(/^MX-\d{5}$/);
    expect((await get("ped_2")).estado).toBe("creado");

    // Cancelling: allowed from creado, refused once it left.
    expect((await fetch(`${base}/pedidos/ped_1`, { method: "DELETE" })).status).toBe(409);
    expect(await (await fetch(`${base}/pedidos/ped_2`, { method: "DELETE" })).json()).toEqual({ id: "ped_2", estado: "cancelado" });
    expect((await fetch(`${base}/pedidos/ped_2`)).status).toBe(410);
    expect((await fetch(`${base}/pedidos/ped_2/pago`, { method: "POST" })).status).toBe(409);

    clock += 30_000;
    const views = mock.scenarios();
    const pedido = views[0]!;
    expect(pedido).toMatchObject({ id: "pedido", key: "params.id", initial: "creado", counts: { creado: 0, pagado: 0, enviado: 0, entregado: 1, cancelado: 1 } });
    expect(pedido.transitions.map((t) => t.fired)).toEqual([1, 1, 1, 1]);
    const one = pedido.instances.find((i) => i.key === "ped_1")!;
    expect(one).toMatchObject({ state: "entregado", final: true, next: null });
    expect(one.history.map((h) => `${h.from ?? "·"}→${h.to} ${h.trigger.kind}`)).toEqual(["·→creado start", "creado→pagado request", "pagado→enviado timer", "enviado→entregado timer"]);
    expect(one.history[1]!.trigger).toMatchObject({ kind: "request", method: "POST", url: "/v1/pedidos/ped_1/pago", status: 200 });
    expect(one.history[2]!.at).toBe(1_000_000 + 10_000);
    await expect.poll(() => events.filter((e) => e.trigger.kind === "request").length).toBe(2);

    // Forcing and resetting from the API.
    expect(mock.setScenario("pedido", "ped_9", "enviado")).toMatchObject({ from: "creado", to: "enviado", trigger: { kind: "manual" } });
    expect((await get("ped_9")).estado).toBe("enviado");
    expect(() => mock.setScenario("pedido", "ped_9", "perdido")).toThrow('"perdido" no es un estado de pedido');
    mock.resetScenarios("pedido");
    expect((await get("ped_1")).estado).toBe("creado");
  });

  it("serves scenarios and the contract through the control API", async () => {
    const { config } = await example();
    const { mock } = await serve(config, { adminToken: "t0k" });
    const admin = (path: string, init: RequestInit = {}) => fetch(`${mock.url}/__mockix${path}`, { ...init, headers: { Authorization: "Bearer t0k", "Content-Type": "application/json" } });
    expect((await admin("/scenarios/pedido/instances/ped_5", { method: "PUT", body: JSON.stringify({ state: "pagado" }) })).status).toBe(200);
    const list = (await (await admin("/scenarios")).json()) as Array<{ instances: Array<{ key: string; state: string }> }>;
    expect(list[0]!.instances).toMatchObject([{ key: "ped_5", state: "pagado" }]);
    expect((await admin("/scenarios/pedido/instances/ped_5", { method: "PUT", body: JSON.stringify({ state: "x" }) })).status).toBe(400);
    expect((await admin("/scenarios/pedido/reset", { method: "POST" })).status).toBe(200);
    expect(((await (await admin("/scenarios")).json()) as Array<{ instances: unknown[] }>)[0]!.instances).toEqual([]);

    await fetch(`${mock.url}/v1/ofertas`);
    const junit = await admin("/contract?format=junit");
    expect(junit.headers.get("content-type")).toContain("application/xml");
    expect(await junit.text()).toContain('name="GET /ofertas"><failure message="operación no definida en el contrato"');
    expect((await admin("/contract", { method: "DELETE" })).status).toBe(204);
    expect(((await (await admin("/contract")).json()) as { requests: number }).requests).toBe(0);
  });

  it("reports scenario problems with their file", async () => {
    const ws = await mkdtemp(join(tmpdir(), "mockix-m6-"));
    dirs.push(ws);
    await writeExampleWorkspace(ws);
    await writeFile(join(ws, "mocks/tienda/scenarios/malo.yaml"), "initial: x\nstates: [a, b]\ntransitions:\n  - { from: a, to: c, after: 5s, on: { path: /x } }\n");
    const route = join(ws, "mocks/tienda/routes/pedidos/get-pedido.yaml");
    await writeFile(route, (await readFile(route, "utf8")).replace("value: cancelado", "value: perdido"));
    const messages = allProblems(await loadWorkspace(ws)).map((p) => `${p.file}: ${p.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        "mocks/tienda/scenarios/malo.yaml: transitions[0]: cada transición lleva on (una petición) o after (un tiempo), no los dos",
        'mocks/tienda/routes/pedidos/get-pedido.yaml: responses[2].rules: "perdido" no es un estado de pedido (creado, pagado, enviado, entregado, cancelado)',
      ]),
    );
  });
});
