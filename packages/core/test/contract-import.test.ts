/**
 * A mock built from an OpenAPI contract: routes, picking any documented
 * response, the contract connected, CRUD over a bucket, a scenario deduced
 * from a status field and chaos profiles prepared from the server errors.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { allProblems, importSource, loadWorkspace, startMock, writeEmptyWorkspace, writeImported } from "@mockix/core";

const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const CONTRACT = `openapi: 3.0.3
info: { title: Ventas Demo, version: 1.0.0 }
servers:
  - url: http://localhost:4000/api/v2
paths:
  /clientes:
    get:
      tags: [clientes]
      responses:
        "200":
          description: Lista
          content:
            application/json:
              schema:
                type: object
                properties:
                  data: { type: array, items: { $ref: "#/components/schemas/Cliente" } }
                  total: { type: integer }
        "500": { description: Error interno }
    post:
      tags: [clientes]
      requestBody:
        content: { application/json: { schema: { $ref: "#/components/schemas/Cliente" } } }
      responses:
        "201": { description: Creado, content: { application/json: { schema: { $ref: "#/components/schemas/Cliente" } } } }
  /clientes/{clienteId}:
    get:
      tags: [clientes]
      parameters: [{ name: clienteId, in: path, required: true, schema: { type: string } }]
      responses:
        "200": { description: Uno, content: { application/json: { schema: { $ref: "#/components/schemas/Cliente" } } } }
        "404": { description: No existe }
    delete:
      tags: [clientes]
      parameters: [{ name: clienteId, in: path, required: true, schema: { type: string } }]
      responses:
        "204": { description: Borrado }
  /pedidos/{id}:
    get:
      tags: [pedidos]
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200":
          description: Pedido
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  estado: { type: string, enum: [CREADO, PAGADO, ENVIADO, CANCELADO] }
              example: { id: ped_1, estado: CREADO }
        "404":
          description: No existe
          content:
            application/json:
              example: { error: no existe }
        "503": { description: Mantenimiento }
    delete:
      tags: [pedidos]
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "204": { description: Cancelado }
  /pedidos/{id}/pago:
    post:
      tags: [pedidos]
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200": { description: Pagado }
components:
  schemas:
    Cliente:
      type: object
      required: [clienteId, nombre]
      properties:
        clienteId: { type: string }
        nombre: { type: string }
        correo: { type: string, format: email }
`;

describe("a mock from an OpenAPI contract", () => {
  it("builds routes, picker, contract, CRUD, scenario and chaos, and reports them", async () => {
    const ws = await mkdtemp(join(tmpdir(), "mockix-contract-"));
    dirs.push(ws);
    await writeEmptyWorkspace(ws);
    const written = await writeImported(ws, await importSource(CONTRACT, "ventas.yaml"));
    const extras = written.report.extras!;

    expect(written.name).toBe("ventas-demo");
    expect(extras.contract).toBe("contracts/ventas-demo.openapi.yaml");
    expect(await readFile(join(ws, extras.contract!), "utf8")).toBe(CONTRACT);
    expect(extras.crud).toEqual([{ bucket: "clientes", path: "/clientes", items: 3 }]);
    expect(extras.scenarios).toEqual([{ id: "pedidos", field: "estado", states: ["creado", "pagado", "enviado", "cancelado"], transitions: 2 }]);
    expect(extras.chaos).toEqual(["ventas-demo-lenta", "ventas-demo-inestable", "ventas-demo-caida"]);
    expect(extras.selectable).toBe(4);
    expect(await readdir(join(ws, "chaos"))).toEqual(["ventas-demo.yaml"]);
    expect(await readFile(join(ws, "chaos/ventas-demo.yaml"), "utf8")).toContain("503");

    const load = await loadWorkspace(ws);
    expect(allProblems(load)).toEqual([]);
    const config = load.mocks[0]!.config!;
    expect(config.contract?.mode).toBe("warn");
    expect(config.chaos.profile).toBeNull();
    expect(Object.keys(config.chaos.profiles)).toEqual(expect.arrayContaining(extras.chaos));

    const mock = await startMock({ ...config, port: 0 }, { seed: 7 });
    const base = `${mock.url}/api/v2`;
    try {
      // CRUD over the bucket, inside the contract's envelope.
      const list = (await (await fetch(`${base}/clientes`)).json()) as { data: Array<{ clienteId: string }>; total: number };
      expect(list.total).toBe(3);
      expect(list.data).toHaveLength(3);
      const created = await fetch(`${base}/clientes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clienteId: "c-nuevo", nombre: "Ana" }) });
      expect(created.status).toBe(201);
      expect(await (await fetch(`${base}/clientes/c-nuevo`)).json()).toMatchObject({ clienteId: "c-nuevo", nombre: "Ana" });

      // Any documented response, by header or by query.
      expect((await fetch(`${base}/pedidos/ped_1`, { headers: { "X-Mockix-Respuesta": "404" } })).status).toBe(404);
      expect((await fetch(`${base}/pedidos/ped_1?mockix_respuesta=503`)).status).toBe(503);

      // The scenario: GET answers the original value for the current state.
      expect(await (await fetch(`${base}/pedidos/ped_1`)).json()).toEqual({ id: "ped_1", estado: "CREADO" });
      expect((await fetch(`${base}/pedidos/ped_1/pago`, { method: "POST" })).status).toBe(200);
      expect(await (await fetch(`${base}/pedidos/ped_1`)).json()).toEqual({ id: "ped_1", estado: "PAGADO" });
      await fetch(`${base}/pedidos/ped_2`, { method: "DELETE" });
      expect(await (await fetch(`${base}/pedidos/ped_2`)).json()).toEqual({ id: "ped_2", estado: "CANCELADO" });
    } finally {
      await mock.stop();
    }
  });

  it("can skip the contract and the chaos profiles", async () => {
    const ws = await mkdtemp(join(tmpdir(), "mockix-contract-"));
    dirs.push(ws);
    await writeEmptyWorkspace(ws);
    const written = await writeImported(ws, await importSource(CONTRACT, "ventas.yaml"), { contract: false, chaos: false });
    expect(written.report.extras!.contract).toBeNull();
    expect(written.report.extras!.chaos).toEqual([]);
    const names = await readdir(ws);
    expect(names).not.toContain("contracts");
    expect(names).not.toContain("chaos");
    expect(allProblems(await loadWorkspace(ws))).toEqual([]);
  });
});
