/**
 * Cassette mode: replays a recording exactly, for CI. Request n gets the
 * recorded answer to the n-th matching request (same method, path and query);
 * a request that was not recorded is a miss: it gets 599 with an explanation
 * and is counted, so the run can fail.
 */
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Exchange } from "../import/exchanges.js";
import { MockStartError } from "../server.js";

export interface CassetteOptions {
  port: number;
  host?: string;
  /** Requests must also come in the recorded order (default: any order, each recording used once). */
  strict?: boolean;
  /** When the recording runs out for a request, answer with its last recorded response again (default false: a miss). */
  repeatLast?: boolean;
  serverHeader?: string;
}

export interface CassetteEvent {
  at: number;
  method: string;
  url: string;
  status: number;
  /** Index in the recording that answered, or null for a miss. */
  index: number | null;
  reason: string | null;
}

type Events = { request: [CassetteEvent] };

export interface CassetteHandle extends EventEmitter<Events> {
  readonly url: string;
  readonly port: number;
  readonly total: number;
  /** Recorded exchanges not requested yet. */
  remaining(): number;
  misses(): CassetteEvent[];
  stop(): Promise<void>;
}

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"]);
const keyOf = (method: string, url: string) => {
  const u = new URL(url, "http://x");
  const params = [...u.searchParams].sort(([a], [b]) => a.localeCompare(b));
  return `${method.toUpperCase()} ${u.pathname}?${new URLSearchParams(params).toString()}`;
};

export async function startCassette(exchanges: Exchange[], options: CassetteOptions): Promise<CassetteHandle> {
  const events = new EventEmitter<Events>();
  const used = new Set<number>();
  const missed: CassetteEvent[] = [];
  const lastFor = new Map<string, number>();
  let cursor = 0;

  const answer = (res: ServerResponse, ex: Exchange) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(ex.responseHeaders)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    headers["X-Mockix"] = "cassette";
    res.writeHead(ex.status, headers);
    res.end(ex.binary && ex.responseBytes ? Buffer.from(ex.responseBytes) : ex.responseBody);
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const key = keyOf(method, url);
    res.setHeader("Server", options.serverHeader ?? "Mockix");
    let index: number | null = null;
    let reason: string | null = null;

    if (options.strict) {
      const next = exchanges[cursor];
      if (next && keyOf(next.method, next.url) === key) index = cursor++;
      else reason = next ? `se esperaba ${keyOf(next.method, next.url).replace(/\?$/, "")}` : "la grabación ya terminó";
    } else {
      const found = exchanges.findIndex((ex, i) => !used.has(i) && keyOf(ex.method, ex.url) === key);
      if (found !== -1) index = found;
      else if (options.repeatLast && lastFor.has(key)) index = lastFor.get(key)!;
      else reason = exchanges.some((ex) => keyOf(ex.method, ex.url) === key) ? "ya se usaron todas sus respuestas grabadas" : "no está en la grabación";
    }

    let status = 599;
    if (index !== null) {
      used.add(index);
      lastFor.set(key, index);
      status = exchanges[index]!.status;
      answer(res, exchanges[index]!);
    } else {
      res.writeHead(599, { "Content-Type": "application/json; charset=utf-8", "X-Mockix": "cassette-miss" });
      res.end(JSON.stringify({ error: "Request not in the cassette", method, url, reason }));
    }
    const event: CassetteEvent = { at: Date.now(), method, url, status, index, reason };
    if (index === null) missed.push(event);
    events.emit("request", event);
  };

  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "EADDRINUSE" ? new MockStartError("PORT_IN_USE", `Port ${options.port} is already in use`) : new MockStartError("START_FAILED", err.message)),
    );
    server.listen(options.port, options.host ?? "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const host = options.host ?? "127.0.0.1";
  let stopping: Promise<void> | null = null;

  return Object.assign(events, {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    port,
    total: exchanges.length,
    remaining: () => exchanges.length - used.size,
    misses: () => [...missed],
    stop(): Promise<void> {
      stopping ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return stopping;
    },
  }) as CassetteHandle;
}
