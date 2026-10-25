import { writeFile } from "node:fs/promises";
import {
  Contract,
  publishRunning,
  type RunningMock,
  MockStartError,
  checkMockResponses,
  contractJUnit,
  loadWorkspace,
  startMock,
  watchWorkspace,
  type MockConfig,
  type MockHandle,
  type CallbackLogEntry,
  type Problem,
  type JUnitSuite,
  type MessageLogEntry,
  type RequestLogEntry,
  type ScenarioEvent,
  type WorkspaceWatcher,
} from "@mockix/core";
import type { Io } from "./main.js";

export interface ServeOptions {
  dir: string;
  mocks: string[];
  port: number | null;
  host: string | null;
  watch: boolean;
  seed: number | null;
  adminToken: string | null;
  serverHeader: string;
  /** Overrides the contract mode of every mock that has a contract. */
  contract?: "off" | "warn" | "strict" | null;
  /** Chaos profile for every served mock ("off": none), instead of mock.yaml's. */
  chaos?: string | null;
  /** Where the contract report goes on stop (.xml JUnit, .json). */
  report?: string | null;
  /** Exit 2 when any request or response broke a contract. */
  failOnViolation?: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const time = (epoch: number) => new Date(epoch).toTimeString().slice(0, 8);

export function formatProblem(p: Problem): string {
  return `  ${p.file}${p.line ? `:${p.line}` : ""}  ${p.message}`;
}

const WHO: Record<RequestLogEntry["kind"], (e: RequestLogEntry) => string> = {
  route: (e) => `${e.routeId} → ${e.responseId}`,
  crud: (e) => `${e.routeId} (CRUD)`,
  proxy: () => "→ API real",
  preflight: () => "preflight CORS",
  none: () => "sin ruta",
};

export function formatLogLine(entry: RequestLogEntry, mock: string | null): string {
  const latency = entry.latencyMs > 0 ? ` (${entry.latencyMs} ms simulados)` : "";
  const error = entry.error ? `  ERROR: ${entry.error}` : "";
  const c = entry.chaos;
  const chaos = c
    ? c.drop
      ? "  ⚡ caos: conexión cortada"
      : c.timeout
        ? "  ⚡ caos: sin respuesta"
        : c.error !== null || c.latencyMs > 0 || c.trickleKBps !== null
          ? `  ⚡ caos: ${[c.error !== null ? `error ${c.error}` : null, c.latencyMs > 0 ? `+${c.latencyMs} ms` : null, c.trickleKBps !== null ? `lento ${c.trickleKBps} KB/s` : null].filter(Boolean).join(", ")}`
          : ""
    : "";
  const v = entry.violations ?? [];
  const contract = v.length ? `  ⚠ contrato: ${v[0]!.side === "response" ? "respuesta: " : ""}${v[0]!.message}${v.length > 1 ? ` (+${v.length - 1})` : ""}` : "";
  return `${time(entry.at)}  ${mock ? `${mock}  ` : ""}${entry.method.padEnd(6)} ${entry.url}  ${entry.status}  ${entry.durationMs} ms${latency}  ${WHO[entry.kind](entry)}${error}${chaos}${contract}`;
}

const MODE_ES = { off: "apagado", warn: "avisar", strict: "estricto" } as const;
const PROTOCOL = { ws: "WS", socketio: "Socket.IO", grpc: "gRPC" } as const;

/** One WebSocket or Socket.IO message, or one gRPC call. */
export function formatMessageLine(m: MessageLogEntry, mock: string | null): string {
  const head = `${time(m.at)}  ${mock ? `${mock}  ` : ""}  ⇄ ${PROTOCOL[m.protocol]} ${m.routeId} ${m.connection}`;
  const data = m.data.length > 160 ? `${m.data.slice(0, 157)}…` : m.data;
  switch (m.kind) {
    case "connect":
      return `${head} conectado${data ? ` (${data})` : ""}`;
    case "disconnect":
      return `${head} desconectado`;
    case "in":
      return `${head} ← ${m.event ? `${m.event} ` : ""}${data}${m.matched ? `  → ${m.matched}` : ""}`;
    case "out":
      return `${head} → ${m.event ? `${m.event} ` : ""}${data}`;
    default:
      return `${head} ${m.status ?? ""}  ${m.durationMs ?? 0} ms${m.matched ? `  → ${m.matched}` : ""}`;
  }
}

export function formatScenarioLine(e: ScenarioEvent, mock: string | null): string {
  const t = e.trigger;
  const why = t.kind === "request" ? `${t.method} ${t.url}${t.status ? ` · ${t.status}` : ""}` : t.kind === "timer" ? `a los ${Math.round(t.afterMs / 100) / 10} s` : t.kind === "manual" ? "manual" : "inicio";
  return `${time(e.at)}  ${mock ? `${mock}  ` : ""}  ⇢ ${e.scenario}${e.key ? `[${e.key}]` : ""} ${e.from ?? "·"} → ${e.to}  (${why})`;
}

export function formatCallbackLine(entry: CallbackLogEntry, mock: string | null): string {
  const result = entry.error ? `ERROR: ${entry.error}` : `${entry.status}  ${entry.durationMs} ms`;
  return `${time(entry.at)}  ${mock ? `${mock}  ` : ""}  ↪ callback ${entry.method} ${entry.url}  ${result}`;
}

const rutas = (n: number) => (n === 1 ? "1 ruta" : `${n} rutas`);

/**
 * Serves the selected mocks of a workspace until `stop` aborts. Edits are
 * applied live; a change that does not validate keeps the last good version.
 */
export async function serveWorkspace(opts: ServeOptions, io: Io, stop: AbortSignal): Promise<number> {
  const load = await loadWorkspace(opts.dir);
  if (load.problems.length) {
    io.err("mockix: el workspace tiene problemas:");
    for (const p of load.problems) io.err(formatProblem(p));
    return 1;
  }
  for (const name of opts.mocks) {
    if (!load.mocks.some((m) => m.name === name)) {
      io.err(`mockix: no hay ningún mock "${name}". Mocks: ${load.mocks.map((m) => m.name).join(", ") || "(ninguno)"}`);
      return 1;
    }
  }
  const targets = load.mocks.filter((m) => opts.mocks.length === 0 || opts.mocks.includes(m.name));
  if (targets.length === 0) {
    io.err("mockix: el workspace no tiene mocks todavía (crea una carpeta en mocks/ con su mock.yaml)");
    return 1;
  }
  if (opts.chaos && opts.chaos !== "off" && !load.chaos[opts.chaos]) {
    io.err(`mockix: no hay ningún perfil de caos "${opts.chaos}". Perfiles: ${Object.keys(load.chaos).join(", ") || "(ninguno; créalos en chaos/*.yaml)"}`);
    return 1;
  }
  const broken = targets.filter((m) => m.problems.length);
  if (broken.length) {
    for (const m of broken) {
      io.err(`mockix: el mock "${m.name}" tiene problemas:`);
      for (const p of m.problems) io.err(formatProblem(p));
    }
    return 1;
  }

  const prefixLog = targets.length > 1;
  const running = new Map<string, MockHandle>();
  const withOverrides = (c: MockConfig): MockConfig => ({
    ...c,
    port: opts.port ?? c.port,
    host: opts.host ?? c.host,
    contract: c.contract && opts.contract ? { ...c.contract, mode: opts.contract } : c.contract,
    chaos: opts.chaos ? { ...c.chaos, profile: opts.chaos === "off" ? null : opts.chaos } : c.chaos,
  });
  const configs = new Map<string, MockConfig>();

  async function launch(config: MockConfig): Promise<MockHandle> {
    const mock = await startMock(withOverrides(config), {
      serverHeader: opts.serverHeader,
      adminToken: opts.adminToken,
      ...(opts.seed === null ? {} : { seed: opts.seed }),
    });
    mock.on("request", (e) => io.out(formatLogLine(e, prefixLog ? config.name : null)));
    mock.on("callback", (e) => (e.error ? io.err : io.out)(formatCallbackLine(e, prefixLog ? config.name : null)));
    mock.on("scenario", (e) => e.trigger.kind !== "start" && io.out(formatScenarioLine(e, prefixLog ? config.name : null)));
    mock.on("message", (m) => io.out(formatMessageLine(m, prefixLog ? config.name : null)));
    running.set(config.name, mock);
    configs.set(config.name, withOverrides(config));
    return mock;
  }

  const stopAll = async () => {
    await Promise.all([...running.values()].map((m) => m.stop()));
    running.clear();
  };

  for (const m of targets) {
    try {
      const mock = await launch(m.config!);
      const extras = [m.config!.proxy ? `proxy → ${m.config!.proxy.target}` : null, opts.adminToken ? `control en ${mock.url}/__mockix` : null].filter(Boolean);
      io.out(`${m.name}  ${mock.url}${m.config!.prefix}  (${rutas(mock.routeCount)}${extras.length ? `; ${extras.join("; ")}` : ""})`);
      const contract = configs.get(m.name)!.contract;
      if (contract) io.out(`  contrato ${contract.file} (${MODE_ES[contract.mode]})`);
      else if (opts.contract) io.err(`Aviso: ${m.name} no tiene contrato en mock.yaml; --contract no le afecta.`);
      if (m.config!.scenarios.length) io.out(`  escenarios: ${m.config!.scenarios.map((s) => s.id).join(", ")}`);
      for (const r of m.config!.realtime) {
        io.out(r.protocol === "ws" ? `  WebSocket  ${mock.url.replace(/^http/, "ws")}${m.config!.prefix}${r.path}` : `  Socket.IO  ${mock.url}${r.path === "/" ? "" : r.path}  (path /socket.io)`);
      }
      if (m.config!.grpc && mock.grpcPort) {
        const g = m.config!.grpc;
        io.out(`  gRPC  ${mock.host}:${mock.grpcPort}  (${g.services.map((s) => s.service).join(", ") || "sin servicios"}${g.tls ? "; TLS" : ""}${g.reflection ? "; reflection" : ""})`);
      }
      const chaos = configs.get(m.name)!.chaos;
      const profile = chaos.profile ? chaos.profiles[chaos.profile] : undefined;
      if (profile) io.out(`  caos: ${profile.name} (${profile.loop ? `ciclo de ${Math.round(profile.cycleMs / 100) / 10} s` : "sin bucle"}${opts.seed === null ? "" : `, semilla ${opts.seed}`})`);
      if (!LOOPBACK.has(mock.host)) io.err(`Aviso: ${m.name} escucha en ${mock.host}; otros equipos de la red pueden llegar a este mock.`);
    } catch (err) {
      io.err(`mockix: no se pudo iniciar "${m.name}": ${err instanceof MockStartError ? `${err.code}, ${err.message}` : String(err)}`);
      await stopAll();
      return 1;
    }
  }

  // .mockix/running.json tells other tools (Sendix) where each mock listens.
  const published = () => {
    const out: Record<string, RunningMock> = {};
    for (const [name, h] of running) {
      const prefix = configs.get(name)?.prefix ?? "";
      out[name] = { url: h.url, prefix, baseUrl: `${h.url}${prefix}`, grpc: h.grpcPort ? `${h.host}:${h.grpcPort}` : null };
    }
    return publishRunning(load.dir, out, "cli").catch(() => undefined);
  };
  await published();

  let watcher: WorkspaceWatcher | null = null;
  let reloading = Promise.resolve();
  const announcedNew = new Set<string>();
  if (opts.watch) {
    watcher = watchWorkspace(load.dir, () => {
      reloading = reloading.then(reload, reload);
    });
    io.out(`Vigilando cambios en ${load.dir}. Ctrl+C para detener.`);
  } else {
    io.out("Ctrl+C para detener.");
  }
  if (opts.seed !== null) io.out(`Semilla ${opts.seed}: los datos falsos y las elecciones al azar se repiten en cada ejecución.`);

  async function reload(): Promise<void> {
    const next = await loadWorkspace(opts.dir);
    if (next.problems.length) {
      io.err("Cambios con problemas en el workspace; los mocks siguen con la versión anterior:");
      for (const p of next.problems) io.err(formatProblem(p));
      return;
    }
    for (const [name, mock] of running) {
      const fresh = next.mocks.find((m) => m.name === name);
      if (!fresh) {
        await mock.stop();
        running.delete(name);
        io.out(`${name}: eliminado del workspace, detenido`);
        continue;
      }
      if (!fresh.config) {
        io.err(`${name}: cambios con problemas; sigue la versión anterior:`);
        for (const p of fresh.problems) io.err(formatProblem(p));
        continue;
      }
      const result = mock.update(withOverrides(fresh.config));
      if (result.applied) {
        io.out(`${name}: recargado (${rutas(fresh.config.routes.length)})`);
        continue;
      }
      await mock.stop();
      running.delete(name);
      try {
        const restarted = await launch(fresh.config);
        io.out(`${name}: reiniciado en ${restarted.url}${fresh.config.prefix}`);
      } catch (err) {
        io.err(`${name}: no se pudo reiniciar: ${err instanceof MockStartError ? `${err.code}, ${err.message}` : String(err)}`);
      }
    }
    await published();
    for (const m of next.mocks) {
      if (opts.mocks.length === 0 && !running.has(m.name) && !targets.some((t) => t.name === m.name) && !announcedNew.has(m.name)) {
        announcedNew.add(m.name);
        io.out(`Nuevo mock "${m.name}": reinicia mockix serve para servirlo.`);
      }
    }
  }

  await new Promise<void>((resolve) => {
    if (stop.aborted) resolve();
    else stop.addEventListener("abort", () => resolve(), { once: true });
  });
  watcher?.close();
  await reloading;
  const failing = await contractSummary();
  await stopAll();
  await published();
  io.out("Mocks detenidos.");
  return opts.failOnViolation && failing > 0 ? 2 : 0;

  /** Prints what broke each contract and writes --report; returns how many requests and responses failed. */
  async function contractSummary(): Promise<number> {
    const suites: JUnitSuite[] = [];
    let failing = 0;
    for (const [name, mock] of running) {
      const report = mock.contract();
      const config = configs.get(name);
      if (!report || !config?.contract) continue;
      const contract = new Contract(config.contract.document);
      const responseProblems = config.contract.responses ? checkMockResponses(config, contract).filter((p) => p.operation !== null) : [];
      suites.push({ report, operations: contract.operations, responseProblems });
      failing += report.failing + responseProblems.length;
      io.out(`Contrato de ${name}: ${report.requests} peticiones, ${report.failing} no cumplen${report.rules.length ? ` (${report.rules.length === 1 ? "1 regla" : `${report.rules.length} reglas`})` : ""}.`);
      for (const r of report.rules.slice(0, 10)) io.out(`  ${r.count}×  ${r.operation}  ${r.side === "response" ? "respuesta: " : ""}${r.rule}`);
    }
    if (opts.report) {
      const text = /\.json$/i.test(opts.report) ? `${JSON.stringify(suites.map(({ report, responseProblems }) => ({ ...report, responseProblems })), null, 2)}\n` : contractJUnit(suites);
      await writeFile(opts.report, text);
      io.out(`Informe del contrato en ${opts.report}`);
    }
    return failing;
  }
}
