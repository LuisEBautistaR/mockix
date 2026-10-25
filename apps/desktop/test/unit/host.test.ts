import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fixedRoute, type MockDefinition, type RequestLogEntry } from "@mockix/core";

const demo = (port: number, text = "hola"): MockDefinition => ({ name: "demo", port, routes: [fixedRoute("GET", "/", 200, text), fixedRoute("GET", "/x", 200, "x")] });
import type { FromHost } from "@shared/rpc";
import { createHandlers } from "../../src/host/handlers";
import { createRpcServer, HandlerError, type Handlers } from "../../src/host/rpc-server";

function setup(handlers: Handlers, testMode = false) {
  const sent: FromHost[] = [];
  const server = createRpcServer({ handlers, send: (m) => sent.push(m), testMode });
  const call = async (id: string, method: string, params: unknown) => {
    server.handle({ kind: "call", id, method, params });
    await expect.poll(() => sent.find((m) => m.kind === "result" && m.id === id)).toBeDefined();
    return sent.find((m) => m.kind === "result" && m.id === id);
  };
  return { server, sent, call };
}

const pong: Handlers = { "system.ping": (p) => ({ sentAt: (p as { sentAt: number }).sentAt, hostTime: 2, pid: 7, uptimeMs: 1 }) };

describe("host RPC server", () => {
  it("answers a valid call with a validated result", async () => {
    const { call } = setup(pong);
    expect(await call("a", "system.ping", { sentAt: 1 })).toEqual({ kind: "result", id: "a", ok: true, value: { sentAt: 1, hostTime: 2, pid: 7, uptimeMs: 1 } });
  });

  it("rejects methods outside the contract table, and listed methods without a handler", async () => {
    const { call } = setup(pong);
    expect(await call("b", "fs.readFile", {})).toMatchObject({ ok: false, error: { code: "UNKNOWN_METHOD" } });
    expect(await call("b2", "mock.stop", {})).toMatchObject({ ok: false, error: { code: "UNKNOWN_METHOD" } });
  });

  it("rejects invalid params before reaching the handler", async () => {
    let reached = false;
    const { call } = setup({ "system.ping": () => ((reached = true), {}) });
    expect(await call("c", "system.ping", { sentAt: "now" })).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(reached).toBe(false);
  });

  it("refuses results that break the contract", async () => {
    const { call } = setup({ "system.ping": () => ({ hacked: true }) });
    expect(await call("d", "system.ping", { sentAt: 1 })).toMatchObject({ ok: false, error: { code: "INVALID_RESULT" } });
  });

  it("passes HandlerError codes through and wraps other exceptions", async () => {
    const { call } = setup({
      "system.ping": () => {
        throw new HandlerError("PORT_IN_USE", "taken");
      },
      "system.info": () => {
        throw new Error("socket closed");
      },
    });
    expect(await call("e", "system.ping", { sentAt: 1 })).toMatchObject({ ok: false, error: { code: "PORT_IN_USE", message: "taken" } });
    expect(await call("e2", "system.info", {})).toMatchObject({ ok: false, error: { code: "HANDLER_FAILED", message: "socket closed" } });
  });

  it("cancels an in-flight call", async () => {
    const { server, sent } = setup({
      "system.ping": (_p, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({}))),
    });
    server.handle({ kind: "call", id: "f", method: "system.ping", params: { sentAt: 1 } });
    await expect.poll(() => server.inFlight).toBe(1);
    server.handle({ kind: "cancel", id: "f" });
    expect(sent.at(-1)).toMatchObject({ id: "f", ok: false, error: { code: "CANCELLED" } });
  });

  it("does not expose test-only methods outside test mode", async () => {
    const handlers: Handlers = { "diagnostics.crash": () => ({ scheduled: true }) };
    expect(await setup(handlers, false).call("g", "diagnostics.crash", { exitCode: 1 })).toMatchObject({ ok: false, error: { code: "UNKNOWN_METHOD" } });
    expect(await setup(handlers, true).call("g", "diagnostics.crash", { exitCode: 1 })).toMatchObject({ ok: true });
  });

  it("answers malformed envelopes that carry an id", async () => {
    const { call } = setup(pong);
    expect(await call("h", undefined as never, undefined)).toMatchObject({ ok: false, error: { code: "INVALID_ENVELOPE" } });
  });
});

describe("host handlers", () => {
  const exits: number[] = [];
  const requests: RequestLogEntry[] = [];
  let handlers = createHandlers({ onRequest: (e) => requests.push(e), serverHeader: "Mockix/test", exit: (c) => exits.push(c) });

  afterEach(async () => {
    await handlers["mock.stop"]!({}, { id: "x", signal: new AbortController().signal });
    handlers = createHandlers({ onRequest: (e) => requests.push(e), serverHeader: "Mockix/test", exit: (c) => exits.push(c) });
    requests.length = 0;
  });

  it("starts one mock, forwards its requests and refuses a second start", async () => {
    const { call } = setup(handlers);
    const started = await call("s1", "mock.start", { definition: demo(0) });
    expect(started).toMatchObject({ ok: true, value: { name: "demo", host: "127.0.0.1", routeCount: 2 } });
    const url = (started as { value: { url: string } }).value.url;

    const res = await fetch(`${url}/`);
    expect(res.headers.get("server")).toBe("Mockix/test");
    await expect.poll(() => requests.length).toBe(1);

    expect(await call("s2", "mock.start", { definition: demo(0) })).toMatchObject({ ok: false, error: { code: "ALREADY_RUNNING" } });
    expect(await call("s3", "mock.stop", {})).toMatchObject({ ok: true, value: { stopped: true } });
    expect(await call("s4", "mock.stop", {})).toMatchObject({ ok: true, value: { stopped: false } });
    await expect(fetch(`${url}/`)).rejects.toThrow();
  });

  it("updates the running mock in place, and restarts its listener when the port changes", async () => {
    const { call } = setup(handlers);
    const started = (await call("u1", "mock.start", { definition: demo(0, "v1") })) as { value: { url: string; port: number } };
    const { url, port } = started.value;

    expect(await call("u2", "mock.update", { definition: demo(port, "v2") })).toMatchObject({ ok: true, value: { mode: "updated", port } });
    expect(await (await fetch(`${url}/`)).text()).toBe("v2");

    const free = createServer();
    await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
    const freePort = (free.address() as { port: number }).port;
    await new Promise<void>((r) => free.close(() => r()));
    const moved = await call("u3", "mock.update", { definition: demo(freePort, "v3") });
    expect(moved).toMatchObject({ ok: true, value: { mode: "restarted" } });
    const newUrl = (moved as { value: { url: string } }).value.url;
    expect(await (await fetch(`${newUrl}/`)).text()).toBe("v3");

    expect(await setup(createHandlers({ onRequest: () => {}, serverHeader: "x", exit: () => {} })).call("u4", "mock.update", { definition: demo(0) })).toMatchObject({
      ok: false,
      error: { code: "HOST_UNAVAILABLE" },
    });
  });

  it("maps core start errors to their codes", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    try {
      const { call } = setup(handlers);
      expect(await call("p1", "mock.start", { definition: demo(port) })).toMatchObject({ ok: false, error: { code: "PORT_IN_USE" } });
      expect(await call("p2", "mock.start", { definition: { name: "Mal Nombre", port: 0, routes: [] } })).toMatchObject({
        ok: false,
        error: { code: "INVALID_PARAMS" },
      });
    } finally {
      blocker.close();
    }
  });

  it("schedules the exit after answering a crash request", async () => {
    const { call } = setup(handlers, true);
    expect(await call("c1", "diagnostics.crash", { exitCode: 3 })).toMatchObject({ ok: true, value: { scheduled: true } });
    await expect.poll(() => exits).toEqual([3]);
  });
});
