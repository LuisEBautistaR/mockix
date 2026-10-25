/**
 * WebSocket routes and Socket.IO namespaces on the mock's HTTP server.
 *
 * Definitions are looked up again on every event, so a reload changes what
 * live connections get without dropping them; a route that disappears closes
 * its connections.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { Server as IOServer, type Namespace, type Socket } from "socket.io";
import { WebSocket, WebSocketServer } from "ws";
import { compilePath, stripPrefix, type Params } from "./path.js";
import { testRules, type RequestContext } from "./rules.js";
import type { MockConfig, RuntimeRealtime } from "./runtime.js";
import type { TemplateEngine } from "./template.js";

/** One event of a WebSocket, Socket.IO or gRPC conversation, as the log shows it. */
export interface MessageLogEntry {
  at: number;
  protocol: "ws" | "socketio" | "grpc";
  /** Realtime route id, or package.Service/Method for gRPC. */
  routeId: string;
  /** Connection or call id within this run (ws3, sio7, grpc12). */
  connection: string;
  kind: "connect" | "disconnect" | "in" | "out" | "call";
  /** Socket.IO event or gRPC method. */
  event: string | null;
  /** Payload text, cut at the capture limit. */
  data: string;
  /** The message or response that answered, if any. */
  matched: string | null;
  /** gRPC status name. */
  status: string | null;
  durationMs: number | null;
}

export interface RealtimeDeps {
  config(): MockConfig;
  engine: TemplateEngine;
  state(ctx: RequestContext): Record<string, string | undefined>;
  log(entry: MessageLogEntry): void;
  captureBytes: number;
}

export interface RealtimeController {
  /** Applies a new definition (new namespaces, closed routes). */
  update(): void;
  /** Open connections by route id. */
  connections(): Record<string, number>;
  stop(): Promise<void>;
}

const SOCKET_IO_PATH = "/socket.io";

function parseQuery(search: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(search.keys())) {
    const all = search.getAll(key);
    out[key] = all.length === 1 ? all[0]! : all;
  }
  return out;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Rules first (in order), then the default, then nothing. */
function pickMessage(list: RuntimeRealtime["messages"], ctx: RequestContext) {
  return list.find((m) => m.rules && testRules(m.rules, ctx)) ?? list.find((m) => m.default) ?? list.find((m) => !m.rules) ?? null;
}

export function createRealtime(server: Server, deps: RealtimeDeps): RealtimeController {
  let counter = 0;
  const cut = (text: string) => (text.length > deps.captureBytes ? `${text.slice(0, deps.captureBytes)}…` : text);
  const route = (id: string) => deps.config().realtime.find((r) => r.id === id) ?? null;
  const render = (def: RuntimeRealtime, text: string, ctx: RequestContext) => (def.template ? deps.engine.render(text, ctx) : text);
  /** Socket.IO payloads: JSON when the rendered text is JSON, the text otherwise. */
  const toPayload = (text: string) => {
    const parsed = tryJson(text);
    return parsed === undefined ? text : parsed;
  };

  /* ---------- WebSocket ---------- */

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const groups = new Map<string, Set<WebSocket>>();
  const timers = new Map<WebSocket, NodeJS.Timeout[]>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const config = deps.config();
    // Socket.IO answers its own upgrades.
    if (io && (url.pathname === SOCKET_IO_PATH || url.pathname.startsWith(`${SOCKET_IO_PATH}/`))) return;
    const local = stripPrefix(config.prefix, url.pathname);
    let hit: { def: RuntimeRealtime; params: Params } | null = null;
    if (local !== null) {
      for (const def of config.realtime) {
        if (def.protocol !== "ws") continue;
        const params = compilePath(def.path)(local);
        if (params) {
          hit = { def, params };
          break;
        }
      }
    }
    if (!hit) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const { def, params } = hit;
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, def.id, local!, params, url));
  };
  server.on("upgrade", onUpgrade);

  function onConnection(ws: WebSocket, req: IncomingMessage, routeId: string, path: string, params: Params, url: URL): void {
    const id = `ws${++counter}`;
    const group = groups.get(routeId) ?? new Set<WebSocket>();
    groups.set(routeId, group);
    group.add(ws);
    const own: NodeJS.Timeout[] = [];
    timers.set(ws, own);
    let received = 0;
    const base = { method: "GET", path, query: parseQuery(url.searchParams), headers: req.headers, cookies: parseCookies(req.headers.cookie), params };
    const ctxFor = (raw: string): RequestContext => {
      const ctx: RequestContext = { ...base, body: { raw, parsed: tryJson(raw) }, requestNumber: received };
      ctx.state = deps.state(ctx);
      return ctx;
    };
    const log = (kind: MessageLogEntry["kind"], data = "", matched: string | null = null) =>
      deps.log({ at: Date.now(), protocol: "ws", routeId, connection: id, kind, event: null, data: cut(data), matched, status: null, durationMs: null });
    const send = (text: string, to: string) => {
      const targets = to === "all" ? [...group] : to === "others" ? [...group].filter((c) => c !== ws) : [ws];
      for (const t of targets) if (t.readyState === WebSocket.OPEN) t.send(text);
      log("out", text);
    };
    const later = (ms: number, fn: () => void) => {
      if (ms <= 0) return fn();
      own.push(setTimeout(fn, ms));
    };

    log("connect", url.pathname + url.search);
    const def = route(routeId)!;
    for (const step of def.onConnect) {
      const run = () => {
        const current = route(routeId);
        if (!current || ws.readyState !== WebSocket.OPEN || step.send === null) return false;
        try {
          send(render(current, step.send, ctxFor("")), step.to);
        } catch (err) {
          log("out", `(error de plantilla: ${err instanceof Error ? err.message : String(err)})`);
        }
        return true;
      };
      later(step.afterMs, () => {
        if (step.everyMs === null) return void run();
        let n = 0;
        const t = setInterval(() => {
          if (!run() || (step.times !== null && ++n >= step.times)) clearInterval(t);
        }, Math.max(10, step.everyMs));
        own.push(t);
      });
    }

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      const current = route(routeId);
      if (!current) return ws.close(1001, "ruta eliminada");
      received++;
      const raw = isBinary ? data.toString("base64") : data.toString("utf8");
      const ctx = ctxFor(raw);
      const answer = pickMessage(current.messages, ctx);
      log("in", raw, answer?.id ?? (current.echo ? "eco" : null));
      if (!answer) {
        if (current.echo) send(raw, "self");
        return;
      }
      later(answer.delayMs, () => {
        try {
          if (answer.reply !== null) send(render(current, answer.reply, ctx), "self");
          if (answer.broadcast !== null) send(render(current, answer.broadcast, ctx), "all");
        } catch (err) {
          log("out", `(error de plantilla: ${err instanceof Error ? err.message : String(err)})`);
        }
        if (answer.close) ws.close(answer.close.code, answer.close.reason);
      });
    });
    ws.on("close", () => {
      for (const t of own) clearTimeout(t);
      timers.delete(ws);
      group.delete(ws);
      log("disconnect");
    });
    ws.on("error", () => ws.terminate());
  }

  /* ---------- Socket.IO ---------- */

  let io: IOServer | null = null;
  const namespaces = new Map<string, Namespace>();

  function ensureIo(): IOServer {
    if (io) return io;
    io = new IOServer(server, { path: SOCKET_IO_PATH, serveClient: false, destroyUpgrade: false, cors: { origin: true, credentials: true } });
    // The main namespace always exists in Socket.IO: refuse it unless a route defines it.
    io.of("/").use((_socket, next) => (deps.config().realtime.some((r) => r.protocol === "socketio" && r.path === "/") ? next() : next(new Error("Este mock no define el namespace /"))));
    return io;
  }

  function bindNamespace(ns: string): void {
    if (namespaces.has(ns)) return;
    const nsp = ensureIo().of(ns);
    namespaces.set(ns, nsp);
    nsp.on("connection", (socket) => onSocket(nsp, ns, socket));
  }

  function onSocket(nsp: Namespace, ns: string, socket: Socket): void {
    const def = deps.config().realtime.find((r) => r.protocol === "socketio" && r.path === ns);
    if (!def) return void socket.disconnect(true);
    const routeId = def.id;
    const id = `sio${++counter}`;
    const own: NodeJS.Timeout[] = [];
    let received = 0;
    const url = new URL(socket.handshake.url, "http://mock");
    const base = { method: "GET", path: ns, query: parseQuery(url.searchParams), headers: socket.handshake.headers, cookies: parseCookies(socket.handshake.headers.cookie), params: {} as Params };
    const ctxFor = (raw: string, parsed: unknown): RequestContext => {
      const ctx: RequestContext = { ...base, body: { raw, parsed }, requestNumber: received };
      ctx.state = deps.state(ctx);
      return ctx;
    };
    const log = (kind: MessageLogEntry["kind"], event: string | null, data = "", matched: string | null = null) =>
      deps.log({ at: Date.now(), protocol: "socketio", routeId, connection: id, kind, event, data: cut(data), matched, status: null, durationMs: null });
    const emitTo = (event: string, text: string | null, to: string, ctx: RequestContext) => {
      const current = route(routeId);
      if (!current) return;
      const data = text === null ? undefined : toPayload(render(current, text, ctx));
      const args = data === undefined ? [] : [data];
      if (to === "all") nsp.emit(event, ...args);
      else if (to === "others") socket.broadcast.emit(event, ...args);
      else if (to.startsWith("room:")) nsp.to(render(current, to.slice(5), ctx)).emit(event, ...args);
      else socket.emit(event, ...args);
      log("out", event, text === null ? "" : JSON.stringify(data));
    };
    const later = (ms: number, fn: () => void) => {
      if (ms <= 0) return fn();
      own.push(setTimeout(fn, ms));
    };

    log("connect", null, socket.handshake.url);
    for (const step of def.onConnect) {
      if (step.emit === null) continue;
      const run = () => {
        if (!socket.connected || !route(routeId)) return false;
        try {
          emitTo(step.emit!, step.data, step.to, ctxFor("", undefined));
        } catch (err) {
          log("out", step.emit, `(error de plantilla: ${err instanceof Error ? err.message : String(err)})`);
        }
        return true;
      };
      later(step.afterMs, () => {
        if (step.everyMs === null) return void run();
        let n = 0;
        const t = setInterval(() => {
          if (!run() || (step.times !== null && ++n >= step.times)) clearInterval(t);
        }, Math.max(10, step.everyMs));
        own.push(t);
      });
    }

    socket.onAny((event: string, ...args: unknown[]) => {
      const current = route(routeId);
      if (!current) return void socket.disconnect(true);
      received++;
      const ack = typeof args.at(-1) === "function" ? (args.pop() as (...a: unknown[]) => void) : null;
      const body = args.length <= 1 ? args[0] : args;
      const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
      const ctx = ctxFor(raw, typeof body === "string" ? (tryJson(body) ?? body) : body);
      const answer = pickMessage(current.messages.filter((m) => m.event === event), ctx);
      log("in", event, raw, answer?.id ?? null);
      if (!answer) return;
      later(answer.delayMs, () => {
        try {
          if (answer.join !== null) void socket.join(render(current, answer.join, ctx));
          if (answer.leave !== null) void socket.leave(render(current, answer.leave, ctx));
          if (answer.ack !== null && ack) {
            const value = toPayload(render(current, answer.ack, ctx));
            ack(value);
            log("out", `${event} (ack)`, JSON.stringify(value), answer.id);
          }
          if (answer.emit) emitTo(answer.emit.event, answer.emit.data, answer.emit.to, ctx);
        } catch (err) {
          log("out", event, `(error de plantilla: ${err instanceof Error ? err.message : String(err)})`);
        }
      });
    });
    socket.on("disconnect", () => {
      for (const t of own) clearTimeout(t);
      log("disconnect", null);
    });
  }

  const sync = () => {
    const config = deps.config();
    const wanted = new Set(config.realtime.filter((r) => r.protocol === "socketio").map((r) => r.path));
    for (const ns of wanted) bindNamespace(ns);
    for (const [ns, nsp] of namespaces) if (!wanted.has(ns)) nsp.disconnectSockets(true);
    // WebSocket routes that went away close their connections.
    const ids = new Set(config.realtime.map((r) => r.id));
    for (const [id, group] of groups) {
      if (ids.has(id)) continue;
      for (const ws of group) ws.close(1001, "ruta eliminada");
      groups.delete(id);
    }
  };
  sync();

  return {
    update: sync,
    connections() {
      const out: Record<string, number> = {};
      for (const [id, group] of groups) out[id] = group.size;
      const config = deps.config();
      for (const r of config.realtime.filter((x) => x.protocol === "socketio")) out[r.id] = namespaces.get(r.path)?.sockets.size ?? 0;
      return out;
    },
    async stop() {
      server.off("upgrade", onUpgrade);
      for (const [ws, own] of timers) {
        for (const t of own) clearTimeout(t);
        ws.terminate();
      }
      wss.close();
      if (io) {
        io.disconnectSockets(true);
        await new Promise<void>((resolve) => {
          // io.close() also closes the HTTP server; only its engine is ours to close.
          io!.engine.close();
          resolve();
        });
      }
    },
  };
}
