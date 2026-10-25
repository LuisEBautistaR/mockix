import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { Faker, base, en, es, es_MX } from "@faker-js/faker";
import protobuf from "protobufjs";
import { io as ioClient, type Socket } from "socket.io-client";
import { WebSocket } from "ws";
import { exampleMessage, type MockConfig } from "@mockix/core";
import { ErrorCodes, type Outcome } from "@shared/rpc";
import type { GrpcCallResult } from "@shared/ipc";
import type { MockManager } from "./mock-manager";
import type { WorkspaceService } from "./workspace";

const LOADER = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true } as const;
const CALL_LIMIT_MS = 15_000;

type Connection = { kind: "ws"; socket: WebSocket } | { kind: "socketio"; socket: Socket };

const notRunning = (id: string): Outcome<never> => ({ ok: false, error: { code: ErrorCodes.hostUnavailable, message: `Mock "${id}" is not running` } });
const failed = (message: string): Outcome<never> => ({ ok: false, error: { code: ErrorCodes.handlerFailed, message } });

/**
 * "Probar" for the realtime routes and gRPC services: main is the client, so
 * the page never opens sockets of its own. What the mock answers shows up in
 * the live message log, which the host reports anyway.
 */
export class LiveTester {
  readonly #workspace: WorkspaceService;
  readonly #mocks: MockManager;
  readonly #open = new Map<string, Connection>();

  constructor(workspace: WorkspaceService, mocks: MockManager) {
    this.#workspace = workspace;
    this.#mocks = mocks;
  }

  #config(id: string): MockConfig | null {
    return this.#mocks.configOf(id);
  }

  /** The route's file, as on disk. */
  async source(mockId: string, file: string): Promise<Outcome<string>> {
    const dir = this.#workspace.state.dir;
    if (!dir) return { ok: false, error: { code: ErrorCodes.noWorkspace, message: "No workspace is open" } };
    const config = this.#config(mockId);
    const known = config && (config.realtime.some((r) => r.file === file) || config.grpc?.services.some((s) => s.file === file));
    if (!known) return { ok: false, error: { code: ErrorCodes.notFound, message: `${file} is not a realtime route or gRPC service of ${mockId}` } };
    return { ok: true, value: await readFile(join(dir, "mocks", mockId, file), "utf8") };
  }

  async connect(mockId: string, routeId: string): Promise<Outcome<null>> {
    const status = this.#mocks.list().find((m) => m.id === mockId);
    const route = this.#config(mockId)?.realtime.find((r) => r.id === routeId);
    if (!status?.url || status.state !== "running") return notRunning(mockId);
    if (!route) return failed(`No realtime route "${routeId}"`);
    const key = `${mockId}/${routeId}`;
    this.disconnect(mockId, routeId);
    const extra = status.tls && status.url.startsWith("https") ? { rejectUnauthorized: false } : {};
    try {
      if (route.protocol === "ws") {
        const socket = new WebSocket(`${status.url.replace(/^http/, "ws")}${status.prefix}${route.path}`, { headers: { "User-Agent": "Mockix (Probar)" }, ...extra });
        await new Promise<void>((resolve, reject) => {
          socket.once("open", () => resolve());
          socket.once("error", reject);
          socket.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        });
        socket.on("close", () => this.#open.get(key)?.socket === socket && this.#open.delete(key));
        this.#open.set(key, { kind: "ws", socket });
      } else {
        const socket = ioClient(`${status.url}${route.path === "/" ? "" : route.path}`, { transports: ["websocket"], reconnection: false, extraHeaders: { "User-Agent": "Mockix (Probar)" }, ...extra });
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", () => resolve());
          socket.once("connect_error", reject);
        });
        socket.on("disconnect", () => this.#open.get(key)?.socket === socket && this.#open.delete(key));
        this.#open.set(key, { kind: "socketio", socket });
      }
      return { ok: true, value: null };
    } catch (err) {
      return failed(`No se pudo conectar: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  isOpen(mockId: string, routeId: string): boolean {
    return this.#open.has(`${mockId}/${routeId}`);
  }

  /** Sends a message (WebSocket) or emits an event (Socket.IO, with an ack callback). */
  async send(mockId: string, routeId: string, text: string, event: string | null): Promise<Outcome<{ ack: unknown }>> {
    const conn = this.#open.get(`${mockId}/${routeId}`);
    if (!conn) return failed("Conecta primero");
    if (conn.kind === "ws") {
      conn.socket.send(text);
      return { ok: true, value: { ack: null } };
    }
    if (!event) return failed("Falta el evento");
    let data: unknown = text;
    try {
      data = text.trim() ? JSON.parse(text) : undefined;
    } catch {
      // plain text payload
    }
    const ack = await new Promise<unknown>((resolve) => {
      conn.socket.timeout(1500).emit(event, ...(data === undefined ? [] : [data]), (err: Error | null, value: unknown) => resolve(err ? null : value));
    });
    return { ok: true, value: { ack } };
  }

  disconnect(mockId: string, routeId: string): Outcome<null> {
    const key = `${mockId}/${routeId}`;
    const conn = this.#open.get(key);
    this.#open.delete(key);
    if (conn?.kind === "ws") conn.socket.close();
    else conn?.socket.close();
    return { ok: true, value: null };
  }

  closeAll(): void {
    for (const key of [...this.#open.keys()]) {
      const [mockId, ...rest] = key.split("/");
      this.disconnect(mockId!, rest.join("/"));
    }
  }

  #service(mockId: string, service: string) {
    return this.#config(mockId)?.grpc?.services.find((s) => s.service === service) ?? null;
  }

  /** An example request for a method, generated from its message type. */
  example(mockId: string, service: string, method: string): Outcome<string> {
    const svc = this.#service(mockId, service);
    if (!svc) return failed(`No gRPC service "${service}"`);
    try {
      const root = protobuf.Root.fromJSON(svc.descriptor as protobuf.INamespace);
      const m = root.lookupService(service).methods[method];
      if (!m) return failed(`No method "${method}"`);
      const faker = new Faker({ locale: [es_MX, es, en, base] });
      faker.seed(7);
      return { ok: true, value: JSON.stringify(exampleMessage(root.lookupType(m.requestType), faker), null, 2) };
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
  }

  /** Calls a method of the running mock. Streams send the one message and collect what comes back. */
  async call(mockId: string, service: string, method: string, text: string): Promise<Outcome<GrpcCallResult>> {
    const status = this.#mocks.list().find((m) => m.id === mockId);
    const config = this.#config(mockId);
    const svc = this.#service(mockId, service);
    if (!status?.grpcPort || status.state !== "running") return notRunning(mockId);
    if (!svc || !config?.grpc) return failed(`No gRPC service "${service}"`);
    let request: unknown;
    try {
      request = text.trim() ? JSON.parse(text) : {};
    } catch {
      return failed("El mensaje no es JSON válido");
    }
    const pkg = grpc.loadPackageDefinition(protoLoader.fromJSON(svc.descriptor as protobuf.INamespace, LOADER));
    let ctor: unknown = pkg;
    for (const part of service.split(".")) ctor = (ctor as Record<string, unknown> | undefined)?.[part];
    if (typeof ctor !== "function") return failed(`No gRPC service "${service}"`);
    const credentials = config.grpc.tls && config.tls ? grpc.credentials.createSsl(Buffer.from(config.tls.cert)) : grpc.credentials.createInsecure();
    const client = new (ctor as grpc.ServiceClientConstructor)(`${status.host === "0.0.0.0" ? "127.0.0.1" : status.host}:${status.grpcPort}`, credentials, config.grpc.tls ? { "grpc.ssl_target_name_override": "localhost" } : {});
    const fn = (client as unknown as Record<string, ((...a: unknown[]) => unknown) & { requestStream?: boolean; responseStream?: boolean }>)[method];
    const def = (ctor as grpc.ServiceClientConstructor).service[method];
    if (!fn || !def) {
      client.close();
      return failed(`No method "${method}"`);
    }
    const started = performance.now();
    const deadline = new Date(Date.now() + CALL_LIMIT_MS);
    const messages: unknown[] = [];
    const done = (s: { code: number; details: string; metadata?: grpc.Metadata }): GrpcCallResult => ({
      status: grpc.status[s.code] ?? String(s.code),
      details: s.details,
      messages,
      trailers: Object.fromEntries(Object.entries(s.metadata?.getMap() ?? {}).map(([k, v]) => [k, String(v)])),
      durationMs: Math.round(performance.now() - started),
    });
    const result = await new Promise<GrpcCallResult>((resolve) => {
      const finish = (s: grpc.StatusObject) => resolve(done(s));
      if (!def.requestStream) {
        if (!def.responseStream) {
          const call = fn.call(client, request, new grpc.Metadata(), { deadline }, (err: grpc.ServiceError | null, res: unknown) => {
            if (!err) messages.push(res);
          }) as grpc.ClientUnaryCall;
          call.on("status", finish);
        } else {
          const call = fn.call(client, request, new grpc.Metadata(), { deadline }) as grpc.ClientReadableStream<unknown>;
          call.on("data", (m) => messages.push(m));
          call.on("error", () => undefined);
          call.on("status", finish);
        }
      } else if (!def.responseStream) {
        const call = fn.call(client, new grpc.Metadata(), { deadline }, (err: grpc.ServiceError | null, res: unknown) => {
          if (!err) messages.push(res);
        }) as grpc.ClientWritableStream<unknown>;
        call.on("status", finish);
        call.write(request);
        call.end();
      } else {
        const call = fn.call(client, new grpc.Metadata(), { deadline }) as grpc.ClientDuplexStream<unknown, unknown>;
        call.on("data", (m) => messages.push(m));
        call.on("error", () => undefined);
        call.on("status", finish);
        call.write(request);
        call.end();
      }
    });
    client.close();
    return { ok: true, value: result };
  }
}
