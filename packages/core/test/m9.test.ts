import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { LocalBackend, createMcpServer, writeExampleWorkspace, type ApprovalRequest, type AuditEntry, type McpOptions } from "@mockix/core";

const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function connect(options: McpOptions = {}) {
  const ws = await mkdtemp(join(tmpdir(), "mockix-m9-"));
  dirs.push(ws);
  await writeExampleWorkspace(ws);
  const yaml = join(ws, "mocks/tienda/mock.yaml");
  await writeFile(yaml, (await readFile(yaml, "utf8")).replace("port: 3000", "port: 0"));
  const backend = new LocalBackend(ws);
  const server = createMcpServer(backend, options);
  const client = new Client({ name: "prueba", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(async () => {
    await client.close();
    await backend.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    const text = res.content[0]?.text ?? "";
    return { error: res.isError === true, text, value: res.isError ? null : (JSON.parse(text) as Record<string, unknown> & unknown[]) };
  };
  return { ws, client, call };
}

describe("MCP server", () => {
  it("lets an agent create a route, test it and read it in the log", async () => {
    const audit: AuditEntry[] = [];
    const { ws, client, call } = await connect({ audit: (e) => audit.push(e) });
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining(["list_mocks", "start_mock", "upsert_route", "upsert_response", "delete_route", "send_request", "query_logs", "get_log", "validate_contract", "set_scenario_state", "apply_chaos", "record_start", "convert_recording"]),
    );
    expect((await client.listTools()).tools.find((t) => t.name === "list_mocks")!.annotations?.readOnlyHint).toBe(true);

    expect((await call("list_mocks")).value![0]).toMatchObject({ name: "tienda", state: "stopped", routes: 13, realtime: 2, grpcServices: 1, problems: [] });

    const created = await call("upsert_route", {
      mock: "tienda",
      folder: "envios",
      route: { method: "GET", path: "/envios/:id", responses: [{ id: "ok", body: { json: { id: "{{urlParam 'id'}}", estado: "en ruta" } } }] },
    });
    expect(created.value).toEqual({ file: "mocks/tienda/routes/envios/get-envios-id.yaml", id: "envios/get-envios-id", created: true });
    expect(await readFile(join(ws, "mocks/tienda/routes/envios/get-envios-id.yaml"), "utf8")).toContain("path: /envios/:id");

    const started = await call("start_mock", { mock: "tienda" });
    expect(String(started.value!["url"])).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await call("send_request", { mock: "tienda", path: "/envios/E-7" });
    expect(res.value).toMatchObject({ status: 200 });
    expect(JSON.parse(String(res.value!["body"]))).toEqual({ id: "E-7", estado: "en ruta" });

    // A new response with a rule, while the mock runs: it picks it up at once.
    await call("upsert_response", { mock: "tienda", route: "envios/get-envios-id", response: { id: "perdido", status: 404, body: { json: { error: "perdido" } }, rules: { when: [{ target: "params.id", op: "regex", value: "^X" }] } } });
    expect((await call("send_request", { mock: "tienda", path: "/envios/X-1" })).value).toMatchObject({ status: 404 });

    const logs = (await call("query_logs", { mock: "tienda", limit: 5 })).value!;
    expect(logs.map((l: { url: string; status: number }) => `${l.url} ${l.status}`)).toEqual(["/v1/envios/X-1 404", "/v1/envios/E-7 200"]);
    const one = (await call("get_log", { mock: "tienda", seq: logs[1].seq })).value!;
    expect(one).toMatchObject({ routeId: "envios/get-envios-id", responseId: "ok", request: { headers: { "user-agent": "Mockix MCP" } } });

    expect(audit.map((a) => `${a.tool}:${a.outcome}${a.write ? ":w" : ""}`)).toEqual([
      "list_mocks:ok",
      "upsert_route:ok:w",
      "start_mock:ok",
      "send_request:ok",
      "upsert_response:ok:w",
      "send_request:ok",
      "query_logs:ok",
      "get_log:ok",
    ]);
    expect(audit[1]!.summary).toBe("crear o cambiar GET /envios/:id en tienda");
  });

  it("refuses invalid routes and changes that would break the mock, and keeps the files as they were", async () => {
    const { ws, call } = await connect();
    const bad = await call("upsert_route", { mock: "tienda", yaml: "method: GET\npath: /x\nresponses:\n  - id: ok\n    status: 42\n" });
    expect(bad.error).toBe(true);
    expect(bad.text).toContain("responses.0.status");

    // Valid on its own, but it points at a body file that does not exist.
    const broken = await call("upsert_route", { mock: "tienda", route: { method: "GET", path: "/roto", responses: [{ id: "ok", body: { file: "no-existe.json" } }] } });
    expect(broken.error).toBe(true);
    expect(broken.text).toContain("dejaría el mock con problemas");
    expect(await readdir(join(ws, "mocks/tienda/routes"))).not.toContain("get-roto.yaml");

    const salud = join(ws, "mocks/tienda/routes/salud.yaml");
    const before = await readFile(salud, "utf8");
    const replaced = await call("upsert_route", { mock: "tienda", route: { id: "salud", method: "GET", path: "/salud", responses: [{ id: "ok", body: { file: "/files/no-hay.txt" } }] } });
    expect(replaced.error).toBe(true);
    expect(await readFile(salud, "utf8")).toBe(before);
    expect((await call("validate_workspace")).value).toMatchObject({ valid: true });

    const removed = await call("delete_route", { mock: "tienda", route: "salud" });
    expect(removed.value).toMatchObject({ deleted: "mocks/tienda/routes/salud.yaml" });
    expect((await readdir(join(ws, ".mockix/trash"))).some((f) => f.endsWith("salud.yaml"))).toBe(true);
  });

  it("asks before every write and rejects what is not approved; read-only refuses all writes", async () => {
    const asked: ApprovalRequest[] = [];
    const audit: AuditEntry[] = [];
    const { ws, call } = await connect({ approve: async (r) => (asked.push(r), r.tool !== "delete_route"), audit: (e) => audit.push(e) });
    expect((await call("list_routes", { mock: "tienda" })).error).toBe(false);
    const denied = await call("delete_route", { mock: "tienda", route: "salud" });
    expect(denied).toMatchObject({ error: true, text: "El usuario no aprobó: borrar salud de tienda" });
    expect(await readFile(join(ws, "mocks/tienda/routes/salud.yaml"), "utf8")).toContain("/salud");
    expect(asked.map((a) => a.summary)).toEqual(["borrar salud de tienda"]);
    expect(audit.at(-1)).toMatchObject({ tool: "delete_route", outcome: "rejected", detail: "rechazada por el usuario" });

    const ro = await connect({ readOnly: true });
    const write = await ro.call("upsert_route", { mock: "tienda", route: { method: "GET", path: "/x", responses: [{ id: "ok" }] } });
    expect(write).toMatchObject({ error: true });
    expect(write.text).toContain("solo lectura");
  });

  it("drives scenarios, chaos and the contract of a running mock", async () => {
    const { call } = await connect();
    await call("start_mock", { mock: "tienda" });
    expect((await call("set_scenario_state", { mock: "tienda", scenario: "pedido", key: "p9", state: "cancelado" })).value).toMatchObject({ to: "cancelado" });
    expect((await call("send_request", { mock: "tienda", path: "/pedidos/p9" })).value).toMatchObject({ status: 410 });
    expect((await call("get_scenario_state", { mock: "tienda", scenario: "pedido" })).value![0].instances[0]).toMatchObject({ key: "p9", state: "cancelado" });

    expect((await call("apply_chaos", { mock: "tienda", profile: "se-cae-a-los-30s" })).value).toMatchObject({ profile: "se-cae-a-los-30s", tMs: 0 });
    expect((await call("apply_chaos", { mock: "tienda", reset: true })).value).toMatchObject({ profile: null });
    expect((await call("apply_chaos", { mock: "tienda", profile: "nada" })).error).toBe(true);

    await call("send_request", { mock: "tienda", method: "POST", path: "/pedidos", body: '{"lineas":[{"sku":"A","cantidad":"2"}]}' });
    const contract = (await call("validate_contract", { mock: "tienda" })).value!;
    expect(contract).toMatchObject({ file: "contracts/tienda.openapi.yaml", mode: "warn" });
    expect(contract["live"]).toMatchObject({ failing: 1, rules: [{ rule: "body.lineas[].cantidad debe ser integer" }] });
  });

  it("serves the format schemas and the workspace files as resources", async () => {
    const { client } = await connect();
    const resources = (await client.listResources()).resources.map((r) => r.uri);
    expect(resources).toEqual(expect.arrayContaining(["mockix://schema/route", "mockix://schema/mock", "mockix://workspace/mocks/tienda/mock.yaml", "mockix://workspace/protos/catalogo.proto"]));
    expect(resources.some((u) => u.includes(".mockix"))).toBe(false);
    const schema = JSON.parse(((await client.readResource({ uri: "mockix://schema/route" })).contents[0] as { text: string }).text) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["method", "path", "responses", "crud", "chaos"]));
    const file = (await client.readResource({ uri: "mockix://workspace/mocks/tienda/routes/salud.yaml" })).contents[0] as { text: string };
    expect(file.text).toContain("path: /salud");
    await expect(client.readResource({ uri: "mockix://workspace/../../etc/hosts" })).rejects.toThrow();
  });
});
