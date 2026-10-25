import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MockStartError, ensureSelfSigned, fixedRoute, startMock, type MockDefinition, type MockHandle, type RequestLogEntry, type RuntimeRoute } from "@mockix/core";

const running: MockHandle[] = [];
async function start(definition: MockDefinition, options = {}): Promise<MockHandle> {
  const mock = await startMock(definition, options);
  running.push(mock);
  return mock;
}
afterEach(async () => {
  await Promise.all(running.splice(0).map((m) => m.stop()));
});

const json = (id: string, status: number, data: unknown, extra: Partial<RuntimeRoute["responses"][number]> = {}) => ({
  id,
  default: false,
  status,
  headers: { "Content-Type": "application/json" },
  body: { kind: "text" as const, text: JSON.stringify(data) },
  latencyMs: 0,
  rules: null,
  ...extra,
});

const route = (over: Partial<RuntimeRoute> & Pick<RuntimeRoute, "responses">): RuntimeRoute => ({
  id: "r",
  file: "routes/r.yaml",
  method: "GET",
  path: "/",
  mode: "rules",
  latencyMs: 0,
  ...over,
});

const mock = (routes: RuntimeRoute[], over: Partial<MockDefinition> = {}): MockDefinition => ({ name: "tienda", port: 0, routes, ...over });

describe("startMock", () => {
  it("serves on loopback with a free port and the Server header", async () => {
    const m = await start(mock([fixedRoute("GET", "/", 200, "hola")]));
    expect(m.host).toBe("127.0.0.1");
    expect(m.url).toBe(`http://127.0.0.1:${m.port}`);
    const res = await fetch(`${m.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("server")).toBe("Mockix");
    expect(await res.text()).toBe("hola");
  });

  it("applies the prefix and answers 404 outside routes", async () => {
    const m = await start(mock([fixedRoute("GET", "/productos/:id", 200, "p")], { prefix: "/v1" }));
    expect((await fetch(`${m.url}/v1/productos/1`)).status).toBe(200);
    const miss = await fetch(`${m.url}/productos/1`);
    expect(miss.status).toBe(404);
    expect(miss.headers.get("x-mockix")).toBe("no-route");
    expect(await miss.json()).toEqual({ error: "No route in this mock", method: "GET", path: "/productos/1" });
  });

  it("picks the first response whose rules match, else the default", async () => {
    const r = route({
      method: "POST",
      path: "/pedidos",
      responses: [
        json("creado", 201, { ok: true }, { rules: { mode: "all", when: [{ target: "body.cantidad", op: "gt", value: 0, negate: false }] } }),
        json("invitado", 403, { error: "rol" }, { rules: { mode: "all", when: [{ target: "header.x-rol", op: "equals", value: "invitado", negate: false }] } }),
        json("invalido", 422, { error: "datos" }, { default: true }),
      ],
    });
    const m = await start(mock([r]));
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${m.url}/pedidos`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }).then((x) => x.status);
    expect(await post({ cantidad: 2 })).toBe(201);
    expect(await post({ cantidad: 0 }, { "X-Rol": "invitado" })).toBe(403);
    expect(await post({ cantidad: 0 })).toBe(422);
  });

  it("cycles responses in sequential mode and picks with the random source in random mode", async () => {
    const seq = route({ id: "seq", path: "/seq", mode: "sequential", responses: [json("a", 200, "a"), json("b", 201, "b"), json("c", 202, "c")] });
    const rnd = route({ id: "rnd", path: "/rnd", mode: "random", responses: [json("x", 200, "x"), json("y", 503, "y")] });
    const values = [0.1, 0.9, 0.6];
    const m = await start(mock([seq, rnd]), { random: () => values.shift() ?? 0 });
    const statuses = async (path: string, n: number) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await fetch(`${m.url}${path}`)).status);
      return out;
    };
    expect(await statuses("/seq", 4)).toEqual([200, 201, 202, 200]);
    expect(await statuses("/rnd", 3)).toEqual([200, 503, 503]);
  });

  it("falls through to the next route in fallback mode", async () => {
    const special = route({
      id: "especial",
      path: "/productos/:id",
      mode: "fallback",
      responses: [json("vip", 200, { vip: true }, { rules: { mode: "all", when: [{ target: "params.id", op: "equals", value: "vip", negate: false }] } })],
    });
    const generic = route({ id: "generico", path: "/productos/:id", responses: [json("ok", 200, { vip: false })] });
    const m = await start(mock([special, generic]));
    expect(await (await fetch(`${m.url}/productos/vip`)).json()).toEqual({ vip: true });
    expect(await (await fetch(`${m.url}/productos/1`)).json()).toEqual({ vip: false });
  });

  it("logs route, response and simulated latency", async () => {
    const r = route({ id: "lento", path: "/lento", latencyMs: 30, responses: [json("ok", 200, {}, { latencyMs: 20 })] });
    const m = await start(mock([r], { latencyMs: 10 }));
    const entries: RequestLogEntry[] = [];
    m.on("request", (e) => entries.push(e));
    const t0 = performance.now();
    await fetch(`${m.url}/lento?x=1`);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(55);
    await fetch(`${m.url}/nada`);
    await expect.poll(() => entries.length).toBe(2);
    expect(entries[0]).toMatchObject({ seq: 1, url: "/lento?x=1", status: 200, routeId: "lento", responseId: "ok", latencyMs: 60 });
    expect(entries[0]!.durationMs).toBeGreaterThanOrEqual(55);
    const t = entries[0]!.timings;
    expect(t.latencyMs).toBeGreaterThanOrEqual(55);
    expect(t.chaosMs).toBe(0);
    const sum = t.receiveMs + t.processMs + t.latencyMs + t.chaosMs + t.sendMs;
    expect(Math.abs(sum - entries[0]!.durationMs)).toBeLessThan(2);
    expect(entries[1]).toMatchObject({ seq: 2, status: 404, routeId: null, responseId: null, latencyMs: 0 });
  });

  it("adds CORS headers and answers preflights", async () => {
    const m = await start(mock([fixedRoute("POST", "/x", 201, "ok")]));
    const pre = await fetch(`${m.url}/x`, { method: "OPTIONS", headers: { Origin: "http://app.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("http://app.test");
    expect(pre.headers.get("access-control-allow-headers")).toBe("content-type");
    const res = await fetch(`${m.url}/x`, { method: "POST" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const closed = await start(mock([fixedRoute("POST", "/x", 201, "ok")], { name: "sin-cors", cors: false }));
    expect((await fetch(`${closed.url}/x`, { method: "POST" })).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers HEAD from GET routes without a body, and serves binary bodies", async () => {
    const bin = route({ id: "bin", path: "/logo.png", responses: [{ ...json("ok", 200, null), headers: { "Content-Type": "image/png" }, body: { kind: "bytes", data: new Uint8Array([137, 80, 78, 71]), path: "files/logo.png" } }] });
    const m = await start(mock([bin]));
    const head = await fetch(`${m.url}/logo.png`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(new Uint8Array(await (await fetch(`${m.url}/logo.png`)).arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it("rejects bodies over the limit with 413", async () => {
    const m = await start(mock([fixedRoute("POST", "/x", 201, "ok")]), { maxBodyBytes: 10 });
    expect((await fetch(`${m.url}/x`, { method: "POST", body: "x".repeat(50) })).status).toBe(413);
  });

  it("updates routes in place and keeps the port; asks for a restart when the port changes", async () => {
    const m = await start(mock([fixedRoute("GET", "/", 200, "v1")]));
    expect(m.update(mock([fixedRoute("GET", "/", 200, "v2")], { port: m.port }))).toEqual({ applied: true });
    expect(await (await fetch(`${m.url}/`)).text()).toBe("v2");
    expect(m.update(mock([], { port: m.port + 1 }))).toEqual({ applied: false, reason: "restart-required" });
    expect(await (await fetch(`${m.url}/`)).text()).toBe("v2");
  });

  it("frees the port on stop, even with keep-alive connections open", async () => {
    const m = await start(mock([fixedRoute("GET", "/", 200, "x")]));
    await fetch(`${m.url}/`, { keepalive: true });
    await m.stop();
    await m.stop();
    await expect(fetch(`${m.url}/`)).rejects.toThrow();
    const again = await start(mock([], { port: m.port }));
    expect(again.port).toBe(m.port);
  });

  it("rejects with PORT_IN_USE when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    try {
      const err = await startMock(mock([], { port })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MockStartError);
      expect((err as MockStartError).code).toBe("PORT_IN_USE");
    } finally {
      blocker.close();
    }
  });

  it("validates the definition before listening", async () => {
    await expect(startMock({ name: "Con Espacios", port: 0, routes: [] })).rejects.toThrow();
    await expect(startMock({ name: "ok", port: 70000, routes: [] })).rejects.toThrow();
  });
});

describe("TLS", () => {
  const dirs: string[] = [];
  afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it("serves HTTPS with the generated localhost certificate, and reuses it", async () => {
    const ws = await mkdtemp(join(tmpdir(), "mockix-tls-"));
    dirs.push(ws);
    const pair = await ensureSelfSigned(ws);
    expect(await ensureSelfSigned(ws)).toEqual(pair);

    const m = await start(mock([fixedRoute("GET", "/", 200, "seguro")], { tls: pair }));
    expect(m.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest(`${m.url}/`, { ca: pair.cert, servername: "localhost" }, (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.end();
    });
    expect(body).toBe("seguro");
  });

  it("reports an unusable certificate as TLS_INVALID", async () => {
    const err = await startMock(mock([], { tls: { cert: "no", key: "no" } })).catch((e: unknown) => e);
    expect((err as MockStartError).code).toBe("TLS_INVALID");
  });
});
