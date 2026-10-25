import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  allProblems,
  chaosAt,
  chaosTimeIn,
  decideChaos,
  loadWorkspace,
  startMock,
  writeExampleWorkspace,
  type MockConfig,
  type MockHandle,
  type RequestLogEntry,
  type RuntimeChaosProfile,
} from "@mockix/core";

const running: MockHandle[] = [];
const dirs: string[] = [];
afterEach(async () => Promise.all(running.splice(0).map((m) => m.stop())));
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function example(mockYaml?: (text: string) => string, extra?: (ws: string) => Promise<void>): Promise<{ ws: string; config: MockConfig }> {
  const ws = await mkdtemp(join(tmpdir(), "mockix-m7-"));
  dirs.push(ws);
  await writeExampleWorkspace(ws);
  const yaml = join(ws, "mocks/tienda/mock.yaml");
  const text = (await readFile(yaml, "utf8")).replace("port: 3000", "port: 0");
  await writeFile(yaml, mockYaml ? mockYaml(text) : text);
  await extra?.(ws);
  const load = await loadWorkspace(ws);
  expect(allProblems(load)).toEqual([]);
  return { ws, config: load.mocks[0]!.config! };
}

async function serve(config: MockConfig, options: Parameters<typeof startMock>[1] = {}): Promise<{ mock: MockHandle; base: string; log: RequestLogEntry[] }> {
  const mock = await startMock(config, options);
  running.push(mock);
  const log: RequestLogEntry[] = [];
  mock.on("request", (e) => log.push(e));
  return { mock, base: `${mock.url}/v1`, log };
}

const profile = (patch: Partial<RuntimeChaosProfile>): RuntimeChaosProfile => ({
  name: "p",
  file: "chaos/p.yaml",
  description: null,
  loop: true,
  cycleMs: 60_000,
  points: [],
  extras: { dropRate: 0, timeoutRate: 0, trickleKBps: null },
  ...patch,
});

describe("chaos timeline", () => {
  it("interpolates between points, loops back to the first one and holds without a loop", async () => {
    const { config } = await example();
    const red = config.chaos.profiles["red-inestable"]!;
    expect(Object.keys(config.chaos.profiles)).toEqual(["red-inestable", "rampa", "pico", "red-3g", "se-cae-a-los-30s"]);
    expect(red).toMatchObject({ loop: true, cycleMs: 60_000, extras: { dropRate: 0.02, timeoutRate: 0.01, trickleKBps: null } });
    expect(chaosAt(red, 0)).toMatchObject({ latencyMs: 50, jitterMs: 10, errorRate: 0 });
    expect(chaosAt(red, 25_000)).toMatchObject({ latencyMs: 460, jitterMs: 170, errorRate: 0.085, errors: [{ status: 503, weight: 1 }] });
    expect(chaosAt(red, 30_000).errors).toEqual([
      { status: 500, weight: 1 },
      { status: 503, weight: 2 },
    ]);
    expect(chaosAt(red, 52_500).latencyMs).toBe(50);
    expect(chaosTimeIn(red, 61_000)).toBe(1_000);

    const fall = config.chaos.profiles["se-cae-a-los-30s"]!;
    expect(chaosTimeIn(fall, 90_000)).toBe(30_100);
    expect(chaosAt(fall, chaosTimeIn(fall, 90_000))).toMatchObject({ errorRate: 1 });
    expect(chaosAt(config.chaos.profiles["rampa"]!, 60_000).latencyMs).toBe(1010);
  });

  it("draws the same effects for the same seed, and five numbers per request whatever happens", () => {
    const p = profile({ points: [{ tMs: 0, latencyMs: 100, jitterMs: 50, errorRate: 0.3, errors: [{ status: 500, weight: 1 }, { status: 503, weight: 3 }] }], extras: { dropRate: 0.1, timeoutRate: 0.1, trickleKBps: null } });
    let calls = 0;
    const counting = () => (calls++, 0.99);
    decideChaos(p, 0, counting);
    expect(calls).toBe(5);
    const run = (seed: number) => {
      let s = seed;
      const random = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      return Array.from({ length: 200 }, () => decideChaos(p, 0, random));
    };
    const a = run(42);
    expect(run(42)).toEqual(a);
    expect(run(43)).not.toEqual(a);
    const kinds = { drop: a.filter((d) => d.drop).length, timeout: a.filter((d) => d.timeout).length, error: a.filter((d) => d.error !== null).length };
    expect(kinds.drop).toBeGreaterThan(5);
    expect(kinds.timeout).toBeGreaterThan(5);
    expect(kinds.error).toBeGreaterThan(30);
    expect(a.filter((d) => d.error === 503).length).toBeGreaterThan(a.filter((d) => d.error === 500).length);
    for (const d of a.filter((x) => !x.drop && !x.timeout)) {
      expect(d.latencyMs).toBeGreaterThanOrEqual(50);
      expect(d.latencyMs).toBeLessThanOrEqual(150);
    }
  });
});

describe("chaos in the mock", () => {
  it("injects errors and latency, marks them in the log, and repeats with the same seed", async () => {
    const { config } = await example(
      (t) => t.replace("# chaos:\n#   profile: red-inestable\n#   folders: { pedidos: off }", "chaos:\n  profile: fallos\n  folders: { pedidos: off }"),
      (ws) => writeFile(join(ws, "chaos/fallos.yaml"), "fallos:\n  duration: 60s\n  points:\n    - { t: 0s }\n    - { t: 30s, latency: 20ms, jitter: 10ms, errorRate: 0.4, errors: [502, 503] }\n"),
    );
    expect(config.chaos.profile).toBe("fallos");
    expect(config.routes.find((r) => r.id === "pedidos/crear")!.chaos).toBeNull();
    expect(config.routes.find((r) => r.id === "salud")!.chaos).toBeUndefined();

    const once = async () => {
      let clock = 1_000_000;
      const { mock, base, log } = await serve(config, { seed: 7, now: () => clock });
      clock += 30_000;
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await fetch(`${base}/salud`)).status);
      expect((await fetch(`${base}/pedidos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"lineas":[]}' })).status).toBe(201);
      await expect.poll(() => log.length).toBe(13);
      const report = mock.chaos();
      await mock.stop();
      running.splice(running.indexOf(mock), 1);
      return { statuses, log, report };
    };
    const a = await once();
    const b = await once();
    expect(a.statuses).toEqual(b.statuses);
    expect(a.log.map((e) => e.chaos?.latencyMs)).toEqual(b.log.map((e) => e.chaos?.latencyMs));
    expect(a.statuses.some((s) => s >= 500)).toBe(true);
    expect(a.statuses.some((s) => s === 200)).toBe(true);

    const injected = a.log.find((e) => e.status >= 500)!;
    expect(injected.chaos).toMatchObject({ profile: "fallos", tMs: 30_000 });
    expect([502, 503]).toContain(injected.chaos!.error);
    expect(injected.response.headers["x-mockix"]).toBe("chaos");
    expect(a.log[0]!.chaos!.latencyMs).toBeGreaterThanOrEqual(10);
    expect(a.log[0]!.chaos!.latencyMs).toBeLessThanOrEqual(30);
    expect(a.log[0]!.timings.chaosMs).toBeGreaterThanOrEqual(5);
    expect(a.log.at(-1)!.chaos).toBeNull();

    expect(a.report).toMatchObject({ profile: "fallos", paused: false, tMs: 30_000, cycleMs: 60_000, requests: 13, affected: 12 });
    expect(a.report.routes.find((r) => r.routeId === "salud")).toMatchObject({ requests: 12, affected: 12 });
  }, 60_000);

  it("cuts connections, holds requests, and sends slow bodies", async () => {
    const { config } = await example(undefined, async (ws) => {
      await writeFile(
        join(ws, "chaos/extra.yaml"),
        "corta:\n  points: [{ t: 0s }]\n  extras: { dropRate: 1 }\ncuelga:\n  points: [{ t: 0s }]\n  extras: { timeoutRate: 1 }\nlenta:\n  points: [{ t: 0s }]\n  extras: { trickleKBps: 2 }\n",
      );
    });
    const { mock, base, log } = await serve(config);

    mock.setChaos("corta");
    await expect(fetch(`${base}/salud`)).rejects.toThrow();
    await expect.poll(() => log.length).toBe(1);
    expect(log[0]).toMatchObject({ status: 0, error: "caos: conexión cortada sin respuesta", chaos: { drop: true } });

    mock.setChaos("cuelga");
    await expect(fetch(`${base}/salud`, { signal: AbortSignal.timeout(300) })).rejects.toThrow();
    await expect.poll(() => log.length).toBe(2);
    expect(log[1]).toMatchObject({ status: 0, error: "caos: sin respuesta", chaos: { timeout: true } });

    mock.setChaos("lenta");
    const started = performance.now();
    const body = await (await fetch(`${base}/productos`)).text();
    const took = performance.now() - started;
    expect(body.length).toBeGreaterThan(300);
    expect(took).toBeGreaterThan(150);
    await expect.poll(() => log.length).toBe(3);
    expect(log[2]!.chaos!.trickleKBps).toBe(2);
    expect(log[2]!.timings.chaosMs).toBeGreaterThan(100);

    mock.setChaos(null);
    expect((await fetch(`${base}/salud`)).status).toBe(200);
    expect(() => mock.setChaos("no-existe")).toThrow('No existe el perfil de caos "no-existe"');
  });

  it("is controlled through the control API: override, pause, restart", async () => {
    const { config } = await example();
    let clock = 5_000;
    const { mock, base } = await serve(config, { adminToken: "t0k", now: () => clock });
    const admin = (path: string, init: RequestInit = {}) => fetch(`${mock.url}/__mockix${path}`, { ...init, headers: { Authorization: "Bearer t0k", "Content-Type": "application/json" } });
    expect(await (await admin("/chaos")).json()).toMatchObject({ profile: null, paused: false });
    expect(await (await admin("/chaos", { method: "PUT", body: JSON.stringify({ profile: "se-cae-a-los-30s" }) })).json()).toMatchObject({ profile: "se-cae-a-los-30s", tMs: 0 });
    expect((await fetch(`${base}/salud`)).status).toBe(200);
    clock += 31_000;
    expect((await fetch(`${base}/salud`)).status).toBe(503);
    expect(await (await admin("/chaos/pause", { method: "POST" })).json()).toMatchObject({ paused: true });
    expect((await fetch(`${base}/salud`)).status).toBe(200);
    await admin("/chaos/resume", { method: "POST" });
    expect(await (await admin("/chaos/restart", { method: "POST" })).json()).toMatchObject({ tMs: 0, requests: 0 });
    expect((await fetch(`${base}/salud`)).status).toBe(200);
    expect((await admin("/chaos", { method: "PUT", body: JSON.stringify({ profile: "nada" }) })).status).toBe(400);
  });

  it("reports unknown profiles and badly ordered points", async () => {
    const ws = await mkdtemp(join(tmpdir(), "mockix-m7-"));
    dirs.push(ws);
    await writeExampleWorkspace(ws);
    await writeFile(join(ws, "chaos/malo.yaml"), "atras:\n  points:\n    - { t: 10s }\n    - { t: 5s }\n");
    await writeFile(join(ws, "chaos/reservado.yaml"), "off:\n  points: [{ t: 0s }]\n");
    const yaml = join(ws, "mocks/tienda/mock.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace("# chaos:\n#   profile: red-inestable", "chaos:\n  profile: tormenta"));
    const messages = allProblems(await loadWorkspace(ws)).map((p) => `${p.file}: ${p.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        "chaos/malo.yaml: atras.points[1].t: los puntos van en orden de tiempo",
        'chaos/reservado.yaml: off: "off" está reservado para quitar el caos; usa otro nombre',
        'mocks/tienda/mock.yaml: chaos: no hay ningún perfil "tormenta" en chaos/',
      ]),
    );
  });
});
