import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EditError, WorkspaceExistsError, allProblems, createMock, deleteMock, deleteRoute, loadWorkspace, readRoute, startMock, writeEmptyWorkspace, writeExampleWorkspace, writeRoute, type RouteDraft } from "@mockix/core";

const dirs: string[] = [];
async function example(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "mockix-edit-"));
  dirs.push(ws);
  await writeExampleWorkspace(ws);
  return ws;
}
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

describe("readRoute", () => {
  it("returns an editable draft with the text of body files", async () => {
    const ws = await example();
    const doc = await readRoute(ws, "tienda", "productos/obtener");
    expect(doc.file).toBe("routes/productos/get-producto.yaml");
    expect(doc.draft).toMatchObject({ id: "productos/obtener", method: "GET", path: "/productos/:id" });
    const [ok, noExiste] = doc.draft.responses!;
    expect(ok).toMatchObject({ id: "ok", default: true, body: { kind: "file", path: "get-producto.200.json" } });
    expect(ok!.body.kind === "file" && ok!.body.text).toContain("{{urlParam 'id'}}");
    expect(noExiste).toMatchObject({ id: "no-existe", status: 404, body: { kind: "json", value: { error: "no existe", codigo: "PRODUCTO_NO_ENCONTRADO" } } });
    expect((await readRoute(ws, "tienda", "inventario")).draft).toEqual({ id: "inventario", path: "/inventario", description: expect.any(String), crud: { bucket: "inventario", key: "id" } });
  });

  it("explains unknown routes and mocks", async () => {
    const ws = await example();
    await expect(readRoute(ws, "tienda", "nada")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readRoute(ws, "../x", "nada")).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("writeRoute", () => {
  it("updates a route in place, keeps comments, and writes body files", async () => {
    const ws = await example();
    const file = join(ws, "mocks/tienda/routes/productos/get-producto.yaml");
    await writeFile(file, `# Comentario que debe quedarse\n${await readFile(file, "utf8")}`);
    const { draft } = await readRoute(ws, "tienda", "productos/obtener");
    const ok = draft.responses![0]!;
    if (ok.body.kind === "file") ok.body.text = '{ "id": "{{urlParam \'id\'}}", "editado": true }';
    draft.responses![1]!.status = 410;
    draft.latency = 25;

    expect(await writeRoute(ws, "tienda", draft, "productos/obtener")).toBe("routes/productos/get-producto.yaml");
    const yaml = await readFile(file, "utf8");
    expect(yaml.startsWith("# Comentario que debe quedarse")).toBe(true);
    expect(yaml).toContain("status: 410");
    expect(yaml).toContain("latency: 25");
    expect(await readFile(join(ws, "mocks/tienda/routes/productos/get-producto.200.json"), "utf8")).toContain('"editado": true');

    const load = await loadWorkspace(ws);
    expect(allProblems(load)).toEqual([]);
    const m = await startMock({ ...load.mocks[0]!.config!, port: 0 });
    try {
      expect(await (await fetch(`${m.url}/v1/productos/x1`)).json()).toEqual({ id: "x1", editado: true });
      expect((await fetch(`${m.url}/v1/productos/9001`)).status).toBe(410);
    } finally {
      await m.stop();
    }
  });

  it("creates new route files with readable names and unique ids", async () => {
    const ws = await example();
    const draft: RouteDraft = {
      id: "facturas/obtener",
      method: "GET",
      path: "/facturas/:id",
      responses: [{ id: "ok", default: true, body: { kind: "inline", text: '{"id":"{{urlParam \'id\'}}"}' } }],
    };
    expect(await writeRoute(ws, "tienda", draft, null, "facturas")).toBe("routes/facturas/get-facturas-id.yaml");
    expect(await writeRoute(ws, "tienda", { ...draft, id: "facturas/otra" }, null, "facturas")).toBe("routes/facturas/get-facturas-id-2.yaml");
    await expect(writeRoute(ws, "tienda", draft, null, "facturas")).rejects.toMatchObject({ code: "EXISTS" });
    expect((await readRoute(ws, "tienda", "facturas/obtener")).draft.responses![0]!.body).toEqual({ kind: "inline", text: '{"id":"{{urlParam \'id\'}}"}' });
    expect(allProblems(await loadWorkspace(ws))).toEqual([]);
  });

  it("refuses invalid drafts without touching disk, and paths outside the mock", async () => {
    const ws = await example();
    const before = await readFile(join(ws, "mocks/tienda/routes/salud.yaml"), "utf8");
    const err = await writeRoute(ws, "tienda", { id: "salud", path: "sin-barra", responses: [] }, "salud").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EditError);
    expect((err as EditError).code).toBe("INVALID");
    expect((err as EditError).issues.map((i) => i.path)).toEqual(expect.arrayContaining(["path", "responses"]));
    expect(await readFile(join(ws, "mocks/tienda/routes/salud.yaml"), "utf8")).toBe(before);

    await expect(writeRoute(ws, "tienda", { path: "/x", responses: [{ id: "ok", body: { kind: "inline", text: "" } }] }, null, "../../..")).rejects.toMatchObject({ code: "OUTSIDE" });
    await expect(
      writeRoute(ws, "tienda", { path: "/x", responses: [{ id: "ok", body: { kind: "file", path: "../../../fuera.txt", text: "x" } }] }, null),
    ).rejects.toMatchObject({ code: "OUTSIDE" });
  });
});

describe("createMock and deleteRoute", () => {
  it("creates a mock folder, lists it in the workspace, and deletes routes", async () => {
    const ws = await example();
    await createMock(ws, "pagos", 3001, "/api");
    await expect(createMock(ws, "pagos", 3002)).rejects.toMatchObject({ code: "EXISTS" });
    await expect(createMock(ws, "Mal", 3002)).rejects.toMatchObject({ code: "INVALID" });
    expect(await readFile(join(ws, "mockix.workspace.yaml"), "utf8")).toContain("mocks: [ tienda, pagos ]");

    await writeRoute(ws, "pagos", { method: "POST", path: "/cobros", responses: [{ id: "ok", status: 201, body: { kind: "json", value: { id: "c1" } } }] }, null);
    const load = await loadWorkspace(ws);
    expect(allProblems(load)).toEqual([]);
    expect(load.mocks.find((m) => m.name === "pagos")!.config).toMatchObject({ port: 3001, prefix: "/api", routes: [{ id: "post-cobros", method: "POST" }] });

    const trashed: string[] = [];
    expect(await deleteRoute(ws, "pagos", "post-cobros", async (p) => void trashed.push(p))).toBe("routes/post-cobros.yaml");
    expect(trashed).toHaveLength(1);
    expect(await deleteRoute(ws, "tienda", "salud")).toBe("routes/salud.yaml");
    await expect(readRoute(ws, "tienda", "salud")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("deletes a whole mock, its workspace entry and only its own Sendix environment", async () => {
    const ws = await example();
    await createMock(ws, "pagos", 3001);
    await mkdir(join(ws, "environments"), { recursive: true });
    const own = join(ws, "environments", "Mock pagos.postman_environment.json");
    await writeFile(own, JSON.stringify({ name: "Mock pagos", values: [], "x-mockix": { mock: "pagos" } }));
    const foreign = join(ws, "environments", "Mock tienda.postman_environment.json");
    await writeFile(foreign, JSON.stringify({ name: "Mock tienda", values: [] }));

    const trashed: string[] = [];
    const trash = async (p: string) => {
      trashed.push(p);
      await rm(p, { recursive: true, force: true });
    };
    expect(await deleteMock(ws, "pagos", trash)).toEqual(["mocks/pagos", "environments/Mock pagos.postman_environment.json"]);
    expect(trashed).toEqual([join(ws, "mocks", "pagos"), own]);
    expect(await readFile(join(ws, "mockix.workspace.yaml"), "utf8")).toContain("mocks: [ tienda ]");

    // Without a trash it removes for good, and keeps an environment someone else wrote.
    expect(await deleteMock(ws, "tienda")).toEqual(["mocks/tienda"]);
    expect(await readdir(join(ws, "mocks"))).toEqual([]);
    expect(await readFile(foreign, "utf8")).toContain("Mock tienda");
    expect(allProblems(await loadWorkspace(ws))).toEqual([]);
    await expect(deleteMock(ws, "tienda")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteMock(ws, "../fuera")).rejects.toMatchObject({ code: "INVALID" });
  });

  it("refuses a folder that is not a workspace without leaving a half-made mock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mockix-edit-"));
    dirs.push(dir);
    await expect(createMock(dir, "pruebas", 3000, "/v3/run")).rejects.toMatchObject({ code: "NOT_WORKSPACE" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("turns a folder with orphan mocks into a workspace that loads them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mockix-edit-"));
    dirs.push(dir);
    await mkdir(join(dir, "mocks", "huerfano", "routes"), { recursive: true });
    await writeFile(join(dir, "mocks", "huerfano", "mock.yaml"), "port: 3005\n");
    expect(await writeEmptyWorkspace(dir)).toEqual(["mockix.workspace.yaml", ".gitignore"]);
    await expect(writeEmptyWorkspace(dir)).rejects.toBeInstanceOf(WorkspaceExistsError);
    await createMock(dir, "pruebas", 3000);
    const load = await loadWorkspace(dir);
    expect(allProblems(load)).toEqual([]);
    expect(load.mocks.map((m) => m.name)).toEqual(["huerfano", "pruebas"]);
  });
});
