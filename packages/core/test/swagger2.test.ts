/**
 * Swagger 2.0 → OpenAPI 3: the conversion is a valid OpenAPI 3 document, and
 * an imported Swagger 2 contract is connected to its mock as that conversion.
 */
import SwaggerParser from "@apidevtools/swagger-parser";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { allProblems, importSource, loadWorkspace, startMock, writeEmptyWorkspace, writeImported } from "@mockix/core";
import { swagger2ToOpenApi3 } from "../src/import/swagger2.js";

const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const SWAGGER = `swagger: "2.0"
info: { title: Pagos Legado, version: "1.2" }
host: api.pagos.test:8443
basePath: /pagos/v1
schemes: [https]
consumes: [application/json]
produces: [application/json]
securityDefinitions:
  Bearer: { type: apiKey, name: Authorization, in: header }
  Basica: { type: basic }
  OAuth: { type: oauth2, flow: application, tokenUrl: https://auth.pagos.test/token, scopes: { pagos: Usar pagos } }
security: [{ Bearer: [] }]
parameters:
  Canal: { name: x-canal, in: header, required: true, type: string }
  NuevoPago: { name: pago, in: body, required: true, schema: { $ref: "#/definitions/PagoNuevo" } }
paths:
  /pagos:
    get:
      parameters:
        - $ref: "#/parameters/Canal"
        - { name: estados, in: query, type: array, items: { type: string }, collectionFormat: csv }
        - { name: limite, in: query, type: integer, minimum: 1, maximum: 50 }
      responses:
        "200":
          description: Lista
          schema: { type: array, items: { $ref: "#/definitions/Pago" } }
          headers: { X-Total: { type: integer } }
    post:
      parameters: [{ $ref: "#/parameters/NuevoPago" }]
      responses:
        "201":
          description: Creado
          schema: { $ref: "#/definitions/Pago" }
          examples: { application/json: { id: p-1, monto: 10.5, nota: null } }
        "400": { description: Datos no válidos, schema: { $ref: "#/definitions/Error" } }
  /pagos/{id}:
    parameters: [{ name: id, in: path, required: true, type: string }]
    get:
      responses:
        "200": { description: Uno, schema: { $ref: "#/definitions/Pago" } }
        "404": { description: No existe }
  /pagos/{id}/comprobante:
    post:
      consumes: [multipart/form-data]
      parameters:
        - { name: id, in: path, required: true, type: string }
        - { name: archivo, in: formData, type: file, required: true }
        - { name: nota, in: formData, type: string }
      responses:
        "204": { description: Guardado }
definitions:
  PagoNuevo:
    type: object
    required: [monto]
    properties:
      monto: { type: number, minimum: 0 }
      nota: { type: string, x-nullable: true }
  Pago:
    allOf:
      - $ref: "#/definitions/PagoNuevo"
      - type: object
        required: [id]
        properties: { id: { type: string } }
  Error:
    type: object
    properties: { mensaje: { type: string } }
`;

describe("Swagger 2.0 to OpenAPI 3", () => {
  it("gives a valid OpenAPI 3 document with everything in its new place", async () => {
    const out = swagger2ToOpenApi3(parse(SWAGGER) as Record<string, unknown>) as any;
    await expect(SwaggerParser.validate(structuredClone(out))).resolves.toBeTruthy();

    expect(out.openapi).toBe("3.0.3");
    expect(out.servers).toEqual([{ url: "https://api.pagos.test:8443/pagos/v1" }]);
    expect(out.components.securitySchemes).toEqual({
      Bearer: { type: "apiKey", name: "Authorization", in: "header" },
      Basica: { type: "http", scheme: "basic" },
      OAuth: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://auth.pagos.test/token", scopes: { pagos: "Usar pagos" } } } },
    });
    expect(out.components.parameters.Canal).toEqual({ name: "x-canal", in: "header", required: true, schema: { type: "string" } });
    expect(out.components.requestBodies.NuevoPago.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/PagoNuevo" });
    expect(out.components.schemas.PagoNuevo.properties.nota).toEqual({ type: "string", nullable: true });
    expect(out.components.schemas.Pago.allOf[0]).toEqual({ $ref: "#/components/schemas/PagoNuevo" });

    const list = out.paths["/pagos"].get;
    expect(list.parameters[0]).toEqual({ $ref: "#/components/parameters/Canal" });
    expect(list.parameters[1]).toEqual({ name: "estados", in: "query", schema: { type: "array", items: { type: "string" } }, style: "form", explode: false });
    expect(list.responses["200"].headers["X-Total"]).toEqual({ schema: { type: "integer" } });
    expect(list.responses["200"].content["application/json"].schema.items).toEqual({ $ref: "#/components/schemas/Pago" });

    const create = out.paths["/pagos"].post;
    expect(create.requestBody).toEqual({ $ref: "#/components/requestBodies/NuevoPago" });
    expect(create.responses["201"].content["application/json"].example).toEqual({ id: "p-1", monto: 10.5, nota: null });
    expect(out.paths["/pagos/{id}"].parameters[0]).toMatchObject({ name: "id", in: "path", required: true });
    expect(out.paths["/pagos/{id}"].get.responses["404"]).toEqual({ description: "No existe" });

    const upload = out.paths["/pagos/{id}/comprobante"].post.requestBody;
    expect(upload.content["multipart/form-data"].schema).toEqual({
      type: "object",
      properties: { archivo: { type: "string", format: "binary" }, nota: { type: "string" } },
      required: ["archivo"],
    });
  });

  it("connects an imported Swagger 2 contract as its conversion and checks requests with it", async () => {
    const ws = await mkdtemp(join(tmpdir(), "mockix-swagger2-"));
    dirs.push(ws);
    await writeEmptyWorkspace(ws);
    const written = await writeImported(ws, await importSource(SWAGGER, "pagos-legado.json"), { port: 0 });
    expect(written.report.extras!.contract).toBe("contracts/pagos-legado.openapi.yaml");
    expect(written.report.extras!.notes.join(" ")).toContain("Era Swagger 2.0");
    const text = await readFile(join(ws, written.report.extras!.contract!), "utf8");
    expect(text.startsWith("# Convertido por Mockix de Swagger 2.0 a OpenAPI 3 al importar pagos-legado.json.")).toBe(true);
    expect((parse(text) as { openapi: string }).openapi).toBe("3.0.3");

    const load = await loadWorkspace(ws);
    expect(allProblems(load)).toEqual([]);
    const config = load.mocks[0]!.config!;
    const mock = await startMock({ ...config, contract: { ...config.contract!, mode: "strict" } });
    try {
      const bad = await fetch(`${mock.url}/pagos/v1/pagos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ monto: "mucho" }) });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ title: "La petición no cumple el contrato", violations: [{ where: "body.monto" }] });
      const good = await fetch(`${mock.url}/pagos/v1/pagos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ monto: 12 }) });
      expect(good.status).toBe(201);
    } finally {
      await mock.stop();
    }
  });
});
