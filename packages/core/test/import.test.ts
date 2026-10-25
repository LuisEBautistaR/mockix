import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  allProblems,
  detectFormat,
  exportOpenApi,
  importSource,
  inferPath,
  loadWorkspace,
  parseSource,
  startMock,
  writeExampleWorkspace,
  writeImported,
  type MockHandle,
} from "@mockix/core";

const fixtures = join(import.meta.dirname, "fixtures");
const dirs: string[] = [];
const running: MockHandle[] = [];
afterEach(async () => Promise.all(running.splice(0).map((m) => m.stop())));
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function emptyWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "mockix-imp-"));
  dirs.push(ws);
  await writeExampleWorkspace(ws);
  return ws;
}

/** Imports a fixture into a fresh workspace, checks it loads cleanly and serves it. */
async function importAndServe(file: string, port = 0) {
  const ws = await emptyWorkspace();
  const result = await importSource(await readFile(join(fixtures, file), "utf8"), file, { baseDir: fixtures });
  const written = await writeImported(ws, result, { port });
  const load = await loadWorkspace(ws);
  expect(allProblems(load)).toEqual([]);
  const config = load.mocks.find((m) => m.name === written.name)!.config!;
  // Imported gRPC servers keep their port in the files; tests take a free one.
  const mock = await startMock({ ...config, grpc: config.grpc ? { ...config.grpc, port: 0 } : null }, { seed: 3 });
  running.push(mock);
  return { ws, written, config, mock, base: `${mock.url}${config.prefix}` };
}

describe("format detection", () => {
  it("recognises each source", async () => {
    expect(detectFormat(parseSource(await readFile(join(fixtures, "openapi-tienda.yaml"), "utf8")))).toBe("openapi");
    expect(detectFormat(parseSource(await readFile(join(fixtures, "postman-tienda.json"), "utf8")))).toBe("postman");
    expect(detectFormat(parseSource(await readFile(join(fixtures, "trafico.har"), "utf8")))).toBe("har");
    expect(detectFormat(parseSource(await readFile(join(fixtures, "mockoon-env.json"), "utf8")))).toBe("mockoon");
    expect(detectFormat({ hola: 1 })).toBeNull();
    await expect(importSource('{"hola":1}', "x.json")).rejects.toThrow(/No se reconoce el formato/);
    await expect(importSource("{ roto", "x.json")).rejects.toThrow(/JSON ni YAML/);
  });

  it("infers ids in paths", () => {
    expect(inferPath("/clientes/1043/pedidos/7d1e9c2a-1b2c-4d5e-8f90-a1b2c3d4e5f6")).toBe("/clientes/:id/pedidos/:pedido");
    expect(inferPath("/productos/prd_7Qm2")).toBe("/productos/:id");
    expect(inferPath("/inventario/CAF-VER-500")).toBe("/inventario/:id");
    expect(inferPath("/archivos/e3b0c44298fc1c14")).toBe("/archivos/:id");
    expect(inferPath("/v1/salud")).toBe("/v1/salud");
  });
});

describe("Postman collection", () => {
  it("serves exactly what the saved examples say, with rules from the original requests", async () => {
    const { ws, written, config, base } = await importAndServe("postman-tienda.json");
    expect(written.name).toBe("tienda-api");
    expect(config.prefix).toBe("/v1");
    expect(config.variables).toEqual({ baseUrl: "https://api.tienda-demo.test/v1", moneda: "MXN" });
    expect(written.report).toMatchObject({ format: "postman", routes: 7, fromExamples: 6, generated: 2 });
    expect(written.report.skipped).toEqual([expect.stringContaining("tienda.Pagos se descubre por reflection")]);
    expect(config.realtime.map((r) => `${r.protocol} ${r.path}`)).toEqual(["ws /pedidos/canal", "socketio /pedidos"]);
    expect(config.realtime[1]!.messages.map((m) => m.event)).toEqual(["seguir"]);
    expect(config.grpc).toMatchObject({ port: 50051, services: [{ service: "tienda.Catalogo", proto: "protos/catalogo.proto" }] });
    expect(await readFile(join(ws, "protos/catalogo.proto"), "utf8")).toContain("service Catalogo");

    const ok = (await (await fetch(`${base}/productos/prd_7Qm2`)).json()) as Record<string, string>;
    expect(ok).toMatchObject({ id: "prd_7Qm2", nombre: "Café de Veracruz 500 g", moneda: "MXN" });
    expect(ok["consulta"]).toMatch(/^[0-9a-f-]{36}$/);
    const missing = await fetch(`${base}/productos/9001`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "no existe" });

    expect(await (await fetch(`${base}/productos?categoria=ninguna`)).json()).toEqual({ data: [], total: 0 });
    expect(await (await fetch(`${base}/productos?categoria=cafe`)).json()).toEqual({ data: [{ id: "prd_7Qm2" }], total: 1 });

    expect((await fetch(`${base}/pedidos`, { method: "POST", headers: { "X-Rol": "invitado" } })).status).toBe(403);
    expect((await fetch(`${base}/pedidos`, { method: "POST", headers: { "X-Rol": "cliente" } })).status).toBe(201);
    expect((await fetch(`${base}/salud`)).status).toBe(200);
  });
});

describe("OpenAPI", () => {
  it("imports operations with examples, schema-generated bodies, tags as folders and the server prefix", async () => {
    const { ws, written, config, base } = await importAndServe("openapi-tienda.yaml");
    expect(written.name).toBe("tienda-demo");
    expect(config.prefix).toBe("/v1");
    expect(written.report).toMatchObject({ format: "openapi", routes: 5, fromExamples: 4, generated: 2 });
    expect(config.routes.map((r) => r.id).sort()).toEqual(["get-salud", "productos/borrar-producto", "productos/crear-producto", "productos/listar-productos", "productos/obtener-producto"]);
    expect(await readFile(join(ws, "mocks/tienda-demo/routes/productos/get-productos-productoid.yaml"), "utf8")).toContain("path: /productos/:productoId");

    const list = await fetch(`${base}/productos`);
    expect(await list.json()).toEqual({ data: [{ id: "prd_7Qm2", nombre: "Café de Veracruz 500 g", precio: 189 }], total: 1 });
    const generated = (await (await fetch(`${base}/productos/x1`)).json()) as Record<string, unknown>;
    expect(generated["id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(["cafe", "te"]).toContain(generated["categoria"]);
    expect(typeof generated["precio"]).toBe("number");
    expect(generated["stock"]).toBeLessThanOrEqual(50);
    expect(Array.isArray(generated["etiquetas"])).toBe(true);
    expect(String(generated["email"])).toContain("@");
    expect((await fetch(`${base}/productos/x1`, { method: "DELETE" })).status).toBe(204);
    const created = await fetch(`${base}/productos`, { method: "POST" });
    expect(created.status).toBe(201);
    expect(await (await fetch(`${base}/salud`)).text()).toBe("ok");
  });

  it("exports a mock and imports it back with the same operations and statuses", async () => {
    const ws = await emptyWorkspace();
    const tienda = (await loadWorkspace(ws)).mocks[0]!.config!;
    const doc = exportOpenApi(tienda);
    expect(doc).toMatchObject({ openapi: "3.1.0", servers: [{ url: "http://localhost:3000/v1" }] });
    expect(Object.keys(doc["paths"] as object)).toContain("/productos/{id}");

    const again = await importSource(JSON.stringify(doc), "exportado.json");
    const pairs = (routes: Array<{ method?: string; path: string; statuses: number[] }>) => routes.map((r) => `${r.method} ${r.path} ${r.statuses.join(",")}`).sort();
    const expected = pairs(
      tienda.routes.filter((r) => !r.crud).map((r) => ({ method: r.method, path: r.path, statuses: [...new Set(r.responses.map((x) => x.status))].sort((a, b) => a - b) })),
    );
    const imported = pairs(again.mock.routes.filter((r) => !r.draft.path.startsWith("/inventario")).map((r) => ({ method: r.draft.method, path: r.draft.path, statuses: (r.draft.responses ?? []).map((x) => x.status ?? 200).sort((a, b) => a - b) })));
    expect(imported).toEqual(expected);
    expect(again.mock.prefix).toBe("/v1");
  });
});

describe("HAR", () => {
  it("infers params, groups answers into rules, redacts secrets and escapes literal mustaches", async () => {
    const ws = await emptyWorkspace();
    const result = await importSource(await readFile(join(fixtures, "trafico.har"), "utf8"), "trafico.har", { prefix: "/v1" });
    expect(result.report.source).toContain("https://api.tienda-demo.test");
    expect(result.mock.routes.map((r) => `${r.draft.method} ${r.draft.path}`)).toEqual(["GET /clientes/:id", "GET /productos", "GET /logo.png"]);
    expect(result.report.warnings).toEqual(expect.arrayContaining([expect.stringContaining("binario"), expect.stringContaining("valores sensibles")]));

    const written = await writeImported(ws, result, { port: 0 });
    expect(written.name).toBe("tienda-demo");
    const files = await readFile(join(ws, `mocks/${written.name}/routes/get-clientes-id.yaml`), "utf8");
    expect(files).not.toContain("secreto");
    expect(files).not.toContain("ana@correo-demo.test");
    expect(files).not.toContain("r3c-7Hq");
    expect(files).not.toMatch(/set-cookie/i);

    const load = await loadWorkspace(ws);
    expect(allProblems(load)).toEqual([]);
    const mock = await startMock(load.mocks.find((m) => m.name === written.name)!.config!);
    running.push(mock);
    const base = `${mock.url}/v1`;
    const cliente = (await (await fetch(`${base}/clientes/5555`)).json()) as Record<string, unknown>;
    expect(cliente).toMatchObject({ id: 5555, nombre: "Ana Torres" });
    expect(String(cliente["email"])).toContain("@");
    expect(cliente["email"]).not.toBe("ana@correo-demo.test");
    expect((await fetch(`${base}/clientes/9001`)).status).toBe(404);
    expect(await (await fetch(`${base}/productos`)).json()).toEqual({ data: [{ id: "prd_7Qm2" }], plantilla: "{{no-es-plantilla}}" });
  });
});

describe("Mockoon environment", () => {
  it("converts routes, rules, modes, buckets and CRUD, and reports what it cannot", async () => {
    const { written, config, base } = await importAndServe("mockoon-env.json");
    expect(written.name).toBe("pagos-demo");
    expect(config.prefix).toBe("/api");
    expect(Object.keys(config.buckets)).toEqual(["cobros"]);
    const report = written.report;
    expect(report.skipped).toEqual([]);
    const eventos = config.realtime.find((r) => r.path === "/eventos")!;
    expect(eventos.messages.map((m) => `${m.id} ${m.default} ${m.rules?.when[0]?.target ?? "-"}`)).toEqual(["pong false body.tipo", "eco true -"]);
    expect(config.realtime.find((r) => r.path === "/latido")!.onConnect).toMatchObject([{ everyMs: 50, to: "all", send: '{"tipo":"latido"}' }]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('bucket "Plantilla"'), expect.stringContaining("helpers sin equivalente")]),
    );

    const ok = (await (await fetch(`${base}/cobros/c7`)).json()) as Record<string, string>;
    expect(ok["id"]).toBe("c7");
    expect((await fetch(`${base}/cobros/c7`)).headers.get("x-servicio")).toBe("pagos");
    expect((await fetch(`${base}/cobros/9x`)).status).toBe(404);
    expect((await fetch(`${base}/cobros/c7`, { headers: { "X-Forzar": "404" } })).status).toBe(404);
    expect(config.routes.find((r) => r.path === "/estado")).toMatchObject({ method: "ANY", mode: "random" });
    expect(config.routes.find((r) => r.path === "/cobros")?.crud).toEqual({ bucket: "cobros", key: "id" });
    expect(await (await fetch(`${base}/todos`)).json()).toEqual([
      { id: "c1", monto: 100 },
      { id: "c2", monto: 250 },
    ]);
    expect(await (await fetch(`${base}/fecha`)).text()).toBe("{{dateTimeShift days=1}}");
  });
});
