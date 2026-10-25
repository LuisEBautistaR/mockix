import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { allProblems, loadWorkspace, startMock, writeExampleWorkspace, type MessageLogEntry, type MockConfig, type MockHandle } from "@mockix/core";

const running: MockHandle[] = [];
const closers: Array<() => void> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) c();
  await Promise.all(running.splice(0).map((m) => m.stop()));
});
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function example(edit?: (ws: string) => Promise<void>): Promise<{ ws: string; config: MockConfig }> {
  const ws = await mkdtemp(join(tmpdir(), "mockix-m8-"));
  dirs.push(ws);
  await writeExampleWorkspace(ws);
  const yaml = join(ws, "mocks/tienda/mock.yaml");
  await writeFile(yaml, (await readFile(yaml, "utf8")).replace("port: 3000", "port: 0"));
  await edit?.(ws);
  const load = await loadWorkspace(ws);
  expect(allProblems(load)).toEqual([]);
  return { ws, config: load.mocks[0]!.config! };
}

async function serve(config: MockConfig): Promise<{ mock: MockHandle; messages: MessageLogEntry[] }> {
  const mock = await startMock(config);
  running.push(mock);
  const messages: MessageLogEntry[] = [];
  mock.on("message", (m) => messages.push(m));
  return { mock, messages };
}

/** A WebSocket client that keeps every message it gets. */
async function wsClient(url: string): Promise<{ ws: WebSocket; got: unknown[]; next(): Promise<unknown> }> {
  const ws = new WebSocket(url);
  closers.push(() => ws.terminate());
  const got: unknown[] = [];
  const waiters: Array<(v: unknown) => void> = [];
  ws.on("message", (data) => {
    const text = data.toString();
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // plain text
    }
    got.push(value);
    waiters.shift()?.(value);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  let read = 0;
  return {
    ws,
    got,
    next: () => (read < got.length ? Promise.resolve(got[read++]) : new Promise((r) => waiters.push((v) => (read++, r(v))))),
  };
}

describe("WebSocket", () => {
  it("runs the connect script, answers by rules, broadcasts, echoes and closes", async () => {
    const { config } = await example();
    expect(config.realtime.map((r) => `${r.protocol} ${r.id} ${r.path}`)).toEqual(["socketio pedidos-en-vivo /pedidos", "ws notificaciones /notificaciones"]);
    const { mock, messages } = await serve(config);
    const url = `${mock.url.replace("http", "ws")}/v1/notificaciones`;
    const a = await wsClient(url);
    const b = await wsClient(url);
    expect(await a.next()).toEqual({ tipo: "hola", tienda: "cdmx-centro" });
    await b.next();
    expect(mock.connections()).toMatchObject({ notificaciones: 2 });

    a.ws.send(JSON.stringify({ tipo: "ping" }));
    expect(await a.next()).toMatchObject({ tipo: "pong" });
    a.ws.send(JSON.stringify({ tipo: "aviso", texto: "cerramos a las 9" }));
    expect(await a.next()).toEqual({ tipo: "aviso", texto: "cerramos a las 9" });
    expect(await b.next()).toEqual({ tipo: "aviso", texto: "cerramos a las 9" });
    a.ws.send("texto suelto");
    expect(await a.next()).toBe("texto suelto");

    const closed = new Promise<number>((r) => a.ws.once("close", (code) => r(code)));
    a.ws.send(JSON.stringify({ tipo: "salir" }));
    expect(await a.next()).toEqual({ tipo: "adios" });
    expect(await closed).toBe(1000);

    await expect.poll(() => messages.filter((m) => m.kind === "disconnect").length).toBe(1);
    expect(messages.find((m) => m.kind === "in" && m.data.includes("ping"))).toMatchObject({ protocol: "ws", routeId: "notificaciones", matched: "pong" });
    expect(messages.find((m) => m.kind === "in" && m.data === "texto suelto")!.matched).toBe("eco");

    // A path without a WebSocket route is refused with a 404 during the handshake.
    const status = await new Promise<number>((resolve) => {
      const bad = new WebSocket(`${mock.url.replace("http", "ws")}/v1/no-existe`);
      bad.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      bad.on("error", () => resolve(-1));
    });
    expect(status).toBe(404);
  });
});

describe("Socket.IO", () => {
  it("joins rooms, acknowledges, emits to a room, and refuses namespaces it does not define", async () => {
    const { config } = await example();
    const { mock, messages } = await serve(config);
    const connect = (ns: string) => {
      const socket: ClientSocket = ioClient(`${mock.url}${ns}`, { transports: ["websocket"], reconnection: false });
      closers.push(() => socket.close());
      return socket;
    };
    const a = connect("/pedidos");
    const welcome = await new Promise((r) => a.once("bienvenida", r));
    expect(welcome).toEqual({ namespace: "/pedidos" });
    const b = connect("/pedidos");
    await new Promise((r) => b.once("bienvenida", r));

    expect(await a.emitWithAck("seguir", { id: "p1" })).toEqual({ ok: true, sala: "pedido:p1" });
    expect(await b.emitWithAck("seguir", { id: "p1" })).toEqual({ ok: true, sala: "pedido:p1" });
    expect(await a.emitWithAck("estado", { id: "p1" })).toMatchObject({ id: "p1", estado: "en camino" });
    const toB = new Promise((r) => b.once("nota", r));
    const toA = new Promise((r) => a.once("nota", r));
    a.emit("nota", { id: "p1", texto: "sale hoy" });
    expect(await toB).toEqual({ id: "p1", texto: "sale hoy" });
    expect(await toA).toEqual({ id: "p1", texto: "sale hoy" });
    expect(mock.connections()).toMatchObject({ "pedidos-en-vivo": 2 });

    const main = connect("/");
    const refused = await new Promise<Error>((r) => main.once("connect_error", r));
    expect(refused.message).toBe("Este mock no define el namespace /");
    expect(messages.filter((m) => m.protocol === "socketio" && m.kind === "in").map((m) => `${m.event}:${m.matched}`)).toEqual(["seguir:seguir", "seguir:seguir", "estado:estado", "nota:nota"]);

    // HTTP routes keep working next to Socket.IO.
    expect((await fetch(`${mock.url}/v1/salud`)).status).toBe(200);
  });
});

describe("gRPC", () => {
  const protoPath = (ws: string) => join(ws, "protos/catalogo.proto");
  const client = (ws: string, port: number) => {
    const pkg = protoLoader.loadSync(protoPath(ws), { keepCase: true, longs: String, enums: String, defaults: true });
    const tienda = (grpc.loadPackageDefinition(pkg) as unknown as { tienda: { Catalogo: grpc.ServiceClientConstructor } }).tienda;
    const c = new tienda.Catalogo(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as grpc.Client & Record<string, (...a: unknown[]) => unknown>;
    closers.push(() => c.close());
    return c;
  };
  const unary = (c: Record<string, (...a: unknown[]) => unknown>, method: string, req: unknown) =>
    new Promise<{ err: grpc.ServiceError | null; res: unknown; trailers: grpc.Metadata | null }>((resolve) => {
      let trailers: grpc.Metadata | null = null;
      const call = c[method]!(req, (err: grpc.ServiceError | null, res: unknown) => setTimeout(() => resolve({ err, res, trailers: err?.metadata ?? trailers }), 10)) as grpc.ClientUnaryCall;
      call.on("status", (s: grpc.StatusObject) => (trailers = s.metadata));
    });

  it("serves the four call types with rules, statuses and trailers, and answers reflection", async () => {
    const { ws, config } = await example();
    expect(config.grpc).toMatchObject({ port: 0, tls: false, reflection: true, services: [{ service: "tienda.Catalogo", proto: "protos/catalogo.proto" }] });
    const { mock, messages } = await serve(config);
    expect(mock.grpcPort).toBeGreaterThan(0);
    const c = client(ws, mock.grpcPort!);

    const ok = await unary(c, "ObtenerProducto", { id: "prd_7Qm2" });
    expect(ok.err).toBeNull();
    expect(ok.res).toMatchObject({ id: "prd_7Qm2", nombre: "Café de Veracruz 500 g", precio: 189, stock: 12, categoria: "CAFE" });
    const missing = await unary(c, "ObtenerProducto", { id: "9001" });
    expect(missing.err).toMatchObject({ code: grpc.status.NOT_FOUND, details: "no existe el producto" });
    expect(missing.trailers?.get("x-motivo")).toEqual(["catalogo"]);

    const listed = await new Promise<unknown[]>((resolve, reject) => {
      const out: unknown[] = [];
      const stream = c["ListarProductos"]!({ categoria: "CAFE" }) as grpc.ClientReadableStream<unknown>;
      stream.on("data", (m) => out.push(m));
      stream.on("end", () => resolve(out));
      stream.on("error", reject);
    });
    expect(listed.map((p) => (p as { id: string }).id)).toEqual(["prd_7Qm2", "prd_8Lx4", "prd_9Kc1"]);

    const summary = await new Promise<unknown>((resolve, reject) => {
      const stream = c["SubirPrecios"]!((err: Error | null, res: unknown) => (err ? reject(err) : resolve(res))) as grpc.ClientWritableStream<unknown>;
      for (const id of ["a", "b", "c"]) stream.write({ id, precio: 10 });
      stream.end();
    });
    expect(summary).toEqual({ actualizados: 3, mensaje: "precios recibidos" });

    const chat = await new Promise<unknown[]>((resolve, reject) => {
      const out: unknown[] = [];
      const stream = c["Chat"]!() as grpc.ClientDuplexStream<unknown, unknown>;
      stream.on("data", (m) => out.push(m));
      stream.on("end", () => resolve(out));
      stream.on("error", reject);
      stream.write({ de: "ana", texto: "hola" });
      stream.write({ de: "ana", texto: "¿hay café?" });
      stream.end();
    });
    expect(chat).toEqual([
      { de: "mockix", texto: "recibido: hola" },
      { de: "mockix", texto: "recibido: ¿hay café?" },
    ]);

    // Server reflection lists the service without the .proto.
    const reflectionProto = join(dirname(createRequire(import.meta.url).resolve("@grpc/reflection/package.json")), "build/proto/grpc/reflection/v1alpha/reflection.proto");
    const refPkg = grpc.loadPackageDefinition(protoLoader.loadSync(reflectionProto, { keepCase: true })) as unknown as { grpc: { reflection: { v1alpha: { ServerReflection: grpc.ServiceClientConstructor } } } };
    const ref = new refPkg.grpc.reflection.v1alpha.ServerReflection(`127.0.0.1:${mock.grpcPort}`, grpc.credentials.createInsecure()) as grpc.Client & Record<string, () => grpc.ClientDuplexStream<unknown, unknown>>;
    closers.push(() => ref.close());
    const services = await new Promise<string[]>((resolve, reject) => {
      const stream = ref["ServerReflectionInfo"]!();
      stream.on("data", (m: { list_services_response?: { service: Array<{ name: string }> } }) => {
        resolve(m.list_services_response!.service.map((s) => s.name));
        stream.end();
      });
      stream.on("error", reject);
      stream.write({ list_services: "" });
    });
    expect(services).toContain("tienda.Catalogo");

    expect(messages.filter((m) => m.protocol === "grpc").map((m) => `${m.event}:${m.status}`)).toEqual(["ObtenerProducto:OK", "ObtenerProducto:NOT_FOUND", "ListarProductos:OK", "SubirPrecios:OK", "Chat:OK", "Chat:OK"]);
  });

  it("answers an example generated from the schema for methods without answers", async () => {
    const { ws, config } = await example(async (w) => {
      await writeFile(join(w, "mocks/tienda/grpc/catalogo.yaml"), "proto: protos/catalogo.proto\nservice: tienda.Catalogo\n");
    });
    const { mock } = await serve(config);
    const { err, res } = await unary(client(ws, mock.grpcPort!), "ObtenerProducto", { id: "x" });
    expect(err).toBeNull();
    const p = res as { id: string; nombre: string; precio: number; stock: number; categoria: string };
    expect(typeof p.id).toBe("string");
    expect(p.nombre.length).toBeGreaterThan(0);
    expect(p.precio).toBeGreaterThan(0);
    expect(p.categoria).toBe("CAFE");
  });

  it("reports gRPC and realtime problems with their file", async () => {
    const ws = await mkdtemp(join(tmpdir(), "mockix-m8-"));
    dirs.push(ws);
    await writeExampleWorkspace(ws);
    await writeFile(join(ws, "mocks/tienda/grpc/malo.yaml"), "proto: protos/catalogo.proto\nservice: tienda.Inventario\n");
    await writeFile(join(ws, "mocks/tienda/grpc/metodo.yaml"), "proto: protos/no-existe.proto\nservice: x.Y\n");
    await writeFile(join(ws, "mocks/tienda/routes/ws-malo.yaml"), "protocol: ws\nmessages:\n  - id: a\n    ack: hola\n");
    await writeFile(join(ws, "mocks/tienda/routes/sio-malo.yaml"), "protocol: socketio\npath: /otro\nmessages:\n  - id: a\n    ack: hola\n");
    const messages = allProblems(await loadWorkspace(ws)).map((p) => `${p.file}: ${p.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        "mocks/tienda/grpc/malo.yaml: service: protos/catalogo.proto no define el servicio tienda.Inventario",
        "mocks/tienda/grpc/metodo.yaml: proto: no existe protos/no-existe.proto",
        "mocks/tienda/routes/ws-malo.yaml: path: una ruta WebSocket necesita path",
        "mocks/tienda/routes/sio-malo.yaml: messages[0].event: en Socket.IO cada mensaje dice a qué event responde",
      ]),
    );
  });
});
