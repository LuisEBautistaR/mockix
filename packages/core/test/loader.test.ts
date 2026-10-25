import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WorkspaceExistsError, allProblems, hasProblems, loadWorkspace, startMock, watchWorkspace, writeExampleWorkspace, type MockHandle } from "@mockix/core";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mockix-ws-"));
  dirs.push(d);
  return d;
}
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function put(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
}

const running: MockHandle[] = [];
afterEach(async () => Promise.all(running.splice(0).map((m) => m.stop())));

describe("example workspace", () => {
  it("loads without problems and serves every documented behaviour", async () => {
    const ws = await tempDir();
    await writeExampleWorkspace(ws);
    await expect(writeExampleWorkspace(ws)).rejects.toBeInstanceOf(WorkspaceExistsError);

    const load = await loadWorkspace(ws);
    expect(allProblems(load)).toEqual([]);
    expect(load.mocks.map((m) => m.name)).toEqual(["tienda"]);
    const config = load.mocks[0]!.config!;
    expect(config).toMatchObject({ port: 3000, prefix: "/v1", cors: true });
    expect(config.routes.map((r) => r.id)).toEqual([
      "clientes/obtener",
      "inestable",
      "inventario",
      "logo",
      "pedidos/cancelar",
      "pedidos/estado",
      "pedidos/obtener",
      "pedidos/pagar",
      "pedidos/crear",
      "productos/obtener",
      "productos/listar",
      "productos/crear",
      "salud",
    ]);
    expect(config.variables).toEqual({ moneda: "MXN", tienda: "cdmx-centro" });
    expect(Object.keys(config.buckets)).toEqual(["inventario", "productos"]);
    expect(config.callbackHosts).toEqual(["localhost:4000"]);

    const m = await startMock({ ...config, port: 0 }, { random: () => 0, seed: 7 });
    running.push(m);
    const api = `${m.url}/v1`;

    const list = await fetch(`${api}/productos`);
    expect(list.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(((await list.json()) as { total: number }).total).toBe(3);
    expect(await (await fetch(`${api}/productos?categoria=ninguna`)).json()).toEqual({ data: [], total: 0 });

    expect(await (await fetch(`${api}/productos/prd_7Qm2`)).json()).toEqual({ id: "prd_7Qm2", nombre: "Café de Veracruz 500 g", precio: 189, moneda: "MXN", activo: true });
    const invented = (await (await fetch(`${api}/productos/prd_nuevo`)).json()) as { id: string; nombre: string; precio: number };
    expect(invented.id).toBe("prd_nuevo");
    expect(invented.nombre.length).toBeGreaterThan(0);
    expect((await fetch(`${api}/productos/9001`)).status).toBe(404);

    const cliente = (await (await fetch(`${api}/clientes/c_1`)).json()) as { id: string; tienda: string; pedidos: Array<{ moneda: string }> };
    expect(cliente).toMatchObject({ id: "c_1", tienda: "cdmx-centro" });
    expect(cliente.pedidos).toHaveLength(2);
    expect(cliente.pedidos[0]!.moneda).toBe("MXN");

    const inventario = await fetch(`${api}/inventario?sucursal=cdmx-centro`);
    expect(inventario.headers.get("x-total-count")).toBe("2");
    expect((await fetch(`${api}/inventario/CAF-OAX-1K`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${api}/inventario/CAF-OAX-1K`)).status).toBe(404);

    const create = (body: unknown) => fetch(`${api}/productos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await create({ nombre: "Café", precio: 10 });
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe("/v1/productos/prd_nuevo");
    expect((await create({ nombre: "Café", precio: -1 })).status).toBe(422);

    const estados = [];
    for (let i = 0; i < 4; i++) estados.push(((await (await fetch(`${api}/pedidos/ped_1/estado`)).json()) as { estado: string }).estado);
    expect(estados).toEqual(["creado", "pagado", "enviado", "creado"]);

    const unstable = await fetch(`${api}/inestable`);
    expect(unstable.status).toBe(200);

    const logo = await fetch(`${api}/logo.svg`);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(await logo.text()).toContain("<svg");

    expect(await (await fetch(`${api}/salud`)).json()).toEqual({ ok: true, servicio: "tienda" });
  });
});

describe("loadWorkspace problems", () => {
  it("explains a folder that is not a workspace", async () => {
    const load = await loadWorkspace(await tempDir());
    expect(load.problems).toEqual([{ file: "mockix.workspace.yaml", line: null, message: expect.stringContaining("mockix init") }]);
  });

  it("reports schema problems with file, line and path, in Spanish", async () => {
    const ws = await tempDir();
    await put(ws, {
      "mockix.workspace.yaml": "format: 1\n",
      "mocks/tienda/mock.yaml": "port: 3000\n",
      "mocks/tienda/routes/mala.yaml": ["method: GET", "path: /x", "responses:", "  - id: ok", "    status: 999", "    rules:", "      when:", "        - { target: nada, op: equals, value: 1 }"].join("\n"),
    });
    const load = await loadWorkspace(ws);
    const problems = allProblems(load);
    expect(problems).toContainEqual({ file: "mocks/tienda/routes/mala.yaml", line: 5, message: expect.stringMatching(/^responses\[0\]\.status: .*599/) });
    expect(problems).toContainEqual({ file: "mocks/tienda/routes/mala.yaml", line: 8, message: expect.stringContaining("objetivo no válido") });
    expect(load.mocks[0]!.config).toBeNull();
  });

  it("reports YAML syntax errors with their line", async () => {
    const ws = await tempDir();
    await put(ws, { "mockix.workspace.yaml": "format: 1\n", "mocks/a/mock.yaml": "port: 1\nport: 2\n" });
    expect(allProblems(await loadWorkspace(ws))).toEqual([{ file: "mocks/a/mock.yaml", line: 2, message: expect.stringContaining("YAML no válido") }]);
  });

  it("keeps body files inside the mock folder", async () => {
    const ws = await tempDir();
    await put(ws, {
      "mockix.workspace.yaml": "format: 1\n",
      "secreto.txt": "no",
      "mocks/a/mock.yaml": "port: 0\n",
      "mocks/a/routes/r.yaml": "path: /x\nresponses:\n  - id: ok\n    body: { file: ../../../secreto.txt }\n",
      "mocks/a/routes/s.yaml": "path: /y\nresponses:\n  - id: ok\n    body: { file: falta.json }\n",
    });
    const messages = allProblems(await loadWorkspace(ws)).map((p) => p.message);
    expect(messages).toContainEqual(expect.stringContaining("fuera de la carpeta del mock"));
    expect(messages).toContainEqual(expect.stringContaining("no existe el archivo falta.json"));
  });

  it("detects repeated ids, bad order entries, several defaults and shared ports", async () => {
    const ws = await tempDir();
    await put(ws, {
      "mockix.workspace.yaml": "format: 1\nmocks: [a, fantasma]\n",
      "mocks/a/mock.yaml": "port: 4000\norder: [uno, nadie]\n",
      "mocks/a/routes/uno.yaml": "id: uno\npath: /1\nresponses:\n  - id: ok\n    default: true\n  - id: ok2\n    default: true\n",
      "mocks/a/routes/otro.yaml": "id: dos\npath: /2\nresponses: [{ id: ok }]\n",
      "mocks/a/routes/dup.yaml": "id: dos\npath: /3\nresponses: [{ id: ok }]\n",
    });
    const load = await loadWorkspace(ws);
    const messages = allProblems(load).map((p) => p.message);
    expect(messages).toContainEqual(expect.stringContaining("mocks/fantasma"));
    expect(messages).toContainEqual(expect.stringContaining("solo una respuesta puede ser la de por defecto"));
    expect(messages).toContainEqual(expect.stringContaining('id "dos" repetido'));
    expect(messages).toContainEqual(expect.stringContaining('order: no hay ninguna ruta con id "nadie"'));
    expect(hasProblems(load)).toBe(true);
  });

  it("refuses two mocks on the same port and host", async () => {
    const ws = await tempDir();
    await put(ws, {
      "mockix.workspace.yaml": "format: 1\n",
      "mocks/a/mock.yaml": "port: 4000\n",
      "mocks/b/mock.yaml": "port: 4000\n",
      "mocks/c/mock.yaml": "port: 4000\nhost: 0.0.0.0\n",
    });
    const load = await loadWorkspace(ws);
    expect(allProblems(load)).toEqual([{ file: "mocks/b/mock.yaml", line: null, message: 'port: 4000 ya lo usa el mock "a"' }]);
    expect(load.mocks.map((m) => m.config !== null)).toEqual([true, false, true]);
  });

  it("orders routes by mock.yaml first, then by file path; ids default to the file path", async () => {
    const ws = await tempDir();
    await put(ws, {
      "mockix.workspace.yaml": "format: 1\n",
      "mocks/a/mock.yaml": "port: 0\norder: [z/ultima]\n",
      "mocks/a/routes/b.yaml": "path: /b\nresponses: [{ id: ok }]\n",
      "mocks/a/routes/a.yaml": "path: /a\nlatency: 2s\nresponses: [{ id: ok, latency: 40ms, body: 'texto' }]\n",
      "mocks/a/routes/z/ultima.yaml": "path: /z\nresponses: [{ id: ok, body: '{\"a\":1}' }]\n",
    });
    const config = (await loadWorkspace(ws)).mocks[0]!.config!;
    expect(config.routes.map((r) => r.id)).toEqual(["z/ultima", "a", "b"]);
    const a = config.routes[1]!;
    expect(a.latencyMs).toBe(2000);
    expect(a.responses[0]).toMatchObject({ latencyMs: 40, default: true, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    expect(config.routes[0]!.responses[0]!.headers["Content-Type"]).toBe("application/json; charset=utf-8");
  });

  it("generates and reuses a certificate for tls: true", async () => {
    const ws = await tempDir();
    await put(ws, { "mockix.workspace.yaml": "format: 1\n", "mocks/s/mock.yaml": "port: 0\ntls: true\n" });
    const first = (await loadWorkspace(ws)).mocks[0]!.config!;
    expect(first.tls?.cert).toContain("BEGIN CERTIFICATE");
    expect(await readFile(join(ws, ".mockix/tls/cert.pem"), "utf8")).toBe(first.tls!.cert);
    expect((await loadWorkspace(ws)).mocks[0]!.config!.tls).toEqual(first.tls);
  });
});

describe("watchWorkspace", () => {
  it("reports a burst of edits once, ignoring .mockix", async () => {
    const ws = await tempDir();
    await put(ws, { "mocks/a/routes/r.yaml": "x" });
    const calls: string[][] = [];
    const watcher = watchWorkspace(ws, (files) => calls.push(files), 100);
    try {
      await new Promise((r) => setTimeout(r, 100));
      await put(ws, { ".mockix/x.txt": "ignorado" });
      await new Promise((r) => setTimeout(r, 250));
      expect(calls).toEqual([]);
      await writeFile(join(ws, "mocks/a/routes/r.yaml"), "y");
      await writeFile(join(ws, "mocks/a/routes/r.yaml"), "z");
      await expect.poll(() => calls.length, { timeout: 3000 }).toBe(1);
      expect(calls[0]).toContain("mocks/a/routes/r.yaml");
    } finally {
      watcher.close();
    }
  });
});
