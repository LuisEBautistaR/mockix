/**
 * The mock's gRPC server (HTTP/2, its own port): each method answers by
 * rules on the request message and its metadata, in the four call types.
 * Methods without answers return an example generated from the schema.
 */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { ReflectionService } from "@grpc/reflection";
import type { Faker } from "@faker-js/faker";
import protobuf from "protobufjs";
import { testRules, type RequestContext } from "./rules.js";
import type { MessageLogEntry } from "./realtime.js";
import type { RuntimeGrpc, RuntimeGrpcResponse } from "./runtime.js";
import type { TemplateEngine } from "./template.js";

export interface GrpcDeps {
  engine: TemplateEngine;
  faker: Faker;
  state(ctx: RequestContext): Record<string, string | undefined>;
  log(entry: MessageLogEntry): void;
  captureBytes: number;
}

export interface GrpcController {
  readonly port: number;
  stop(): Promise<void>;
}

export class GrpcStartError extends Error {
  readonly code: "PORT_IN_USE" | "START_FAILED";
  constructor(code: "PORT_IN_USE" | "START_FAILED", message: string) {
    super(message);
    this.name = "GrpcStartError";
    this.code = code;
  }
}

const LOADER = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true } as const;
const sleep = (ms: number) => new Promise<void>((r) => (ms > 0 ? setTimeout(r, ms) : r()));

function metadataOf(map: Record<string, string>): grpc.Metadata {
  const md = new grpc.Metadata();
  for (const [k, v] of Object.entries(map)) md.set(k, v);
  return md;
}

function headersOf(md: grpc.Metadata): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(md.getMap())) out[k.toLowerCase()] = Buffer.isBuffer(v) ? v.toString("base64") : String(v);
  return out;
}

/** An example message for a type, with fake data by field type and name. */
export function exampleMessage(type: protobuf.Type, faker: Faker, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of type.fieldsArray) {
    field.resolve();
    const one = () => exampleValue(field, faker, depth);
    out[field.name] = field.repeated ? [one(), one()] : one();
  }
  return out;
}

function exampleValue(field: protobuf.Field, faker: Faker, depth: number): unknown {
  const name = field.name.toLowerCase();
  if (field.resolvedType instanceof protobuf.Enum) return Object.keys(field.resolvedType.values)[1] ?? Object.keys(field.resolvedType.values)[0];
  if (field.resolvedType instanceof protobuf.Type) return depth < 3 ? exampleMessage(field.resolvedType, faker, depth + 1) : {};
  switch (field.type) {
    case "string":
      if (/(^|_)id$/.test(name)) return faker.string.alphanumeric(8);
      if (name.includes("email") || name.includes("correo")) return faker.internet.email();
      if (name.includes("nombre") || name.includes("name")) return faker.commerce.productName();
      if (name.includes("fecha") || name.includes("date")) return faker.date.recent().toISOString();
      if (name.includes("url")) return faker.internet.url();
      return faker.lorem.words(2);
    case "bool":
      return faker.datatype.boolean();
    case "double":
    case "float":
      return faker.number.float({ min: 1, max: 1000, fractionDigits: 2 });
    case "bytes":
      return Buffer.from(faker.string.alphanumeric(8));
    default:
      // int32, int64 (as string with longs: String), uint, sint, fixed…
      return field.type.includes("64") ? String(faker.number.int({ min: 1, max: 100_000 })) : faker.number.int({ min: 1, max: 1000 });
  }
}

export async function startGrpc(def: RuntimeGrpc, host: string, tls: { cert: string; key: string } | null, deps: GrpcDeps): Promise<GrpcController> {
  const server = new grpc.Server();
  const merged: protoLoader.PackageDefinition = {};
  let calls = 0;
  const cut = (text: string) => (text.length > deps.captureBytes ? `${text.slice(0, deps.captureBytes)}…` : text);

  for (const svc of def.services) {
    const pkg = protoLoader.fromJSON(svc.descriptor as protobuf.INamespace, LOADER);
    Object.assign(merged, pkg);
    const root = protobuf.Root.fromJSON(svc.descriptor as protobuf.INamespace);
    const service = pkg[svc.service] as grpc.ServiceDefinition | undefined;
    if (!service) continue;
    const reflected = root.lookupService(svc.service);
    const impl: grpc.UntypedServiceImplementation = {};
    const hits = new Map<string, number>();

    for (const [methodName, method] of Object.entries(service)) {
      const responses = svc.methods[methodName] ?? [];
      const routeId = `${svc.service}/${methodName}`;
      const responseType = root.lookupType(reflected.methods[methodName]!.responseType);

      const ctxFor = (body: unknown, md: grpc.Metadata): RequestContext => {
        const n = (hits.get(methodName) ?? 0) + 1;
        hits.set(methodName, n);
        const ctx: RequestContext = {
          method: "POST",
          path: `/${svc.service}/${methodName}`,
          query: {},
          headers: headersOf(md),
          cookies: {},
          params: {},
          body: { raw: JSON.stringify(body), parsed: body },
          requestNumber: n,
        };
        ctx.state = deps.state(ctx);
        return ctx;
      };
      const pick = (ctx: RequestContext): RuntimeGrpcResponse | null => responses.find((r) => r.rules && testRules(r.rules, ctx)) ?? responses.find((r) => r.default) ?? responses[0] ?? null;
      const build = (text: string | null, ctx: RequestContext): Record<string, unknown> => (text === null ? exampleMessage(responseType, deps.faker) : (JSON.parse(deps.engine.render(text, ctx)) as Record<string, unknown>));
      const statusError = (r: RuntimeGrpcResponse): Partial<grpc.StatusObject> => ({
        code: grpc.status[r.status as keyof typeof grpc.status] as grpc.status,
        details: r.details || r.status,
        metadata: metadataOf(r.trailers),
      });
      const log = (connection: string, started: number, data: string, matched: string | null, status: string) =>
        deps.log({ at: Date.now(), protocol: "grpc", routeId, connection, kind: "call", event: methodName, data: cut(data), matched, status, durationMs: Math.round(performance.now() - started) });
      const fail = (err: unknown): Partial<grpc.StatusObject> => ({ code: grpc.status.INTERNAL, details: `Mockix: ${err instanceof Error ? err.message : String(err)}` });

      if (!method.requestStream && !method.responseStream) {
        impl[methodName] = (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
          const id = `grpc${++calls}`;
          const started = performance.now();
          const ctx = ctxFor(call.request, call.metadata);
          const r = pick(ctx);
          void (async () => {
            await sleep(r?.delayMs ?? 0);
            if (r && Object.keys(r.metadata).length) call.sendMetadata(metadataOf(r.metadata));
            if (r && r.status !== "OK") {
              log(id, started, ctx.body.raw, r.id, r.status);
              return callback(statusError(r));
            }
            try {
              const msg = build(r?.message ?? null, ctx);
              log(id, started, ctx.body.raw, r?.id ?? "ejemplo", "OK");
              callback(null, msg, r ? metadataOf(r.trailers) : undefined);
            } catch (err) {
              log(id, started, ctx.body.raw, r?.id ?? null, "INTERNAL");
              callback(fail(err));
            }
          })();
        };
      } else if (!method.requestStream && method.responseStream) {
        impl[methodName] = (call: grpc.ServerWritableStream<unknown, unknown>) => {
          const id = `grpc${++calls}`;
          const started = performance.now();
          const ctx = ctxFor(call.request, call.metadata);
          const r = pick(ctx);
          void (async () => {
            try {
              await sleep(r?.delayMs ?? 0);
              if (r && Object.keys(r.metadata).length) call.sendMetadata(metadataOf(r.metadata));
              const items = r?.stream ?? [{ message: r?.message ?? null, delayMs: 0 }];
              for (let k = 0; k < (r?.repeat ?? 1) && !call.cancelled; k++) {
                for (const item of items) {
                  await sleep(item.delayMs);
                  if (call.cancelled) break;
                  call.write(build(item.message, ctx));
                }
              }
              log(id, started, ctx.body.raw, r?.id ?? "ejemplo", r?.status ?? "OK");
              if (r && r.status !== "OK") call.destroy(Object.assign(new Error(r.details || r.status), statusError(r)));
              else call.end(r ? metadataOf(r.trailers) : undefined);
            } catch (err) {
              log(id, started, ctx.body.raw, r?.id ?? null, "INTERNAL");
              call.destroy(Object.assign(new Error("Mockix"), fail(err)));
            }
          })();
        };
      } else if (method.requestStream && !method.responseStream) {
        impl[methodName] = (call: grpc.ServerReadableStream<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
          const id = `grpc${++calls}`;
          const started = performance.now();
          const messages: unknown[] = [];
          call.on("data", (m) => messages.push(m));
          call.on("end", () => {
            const ctx = ctxFor({ messages, count: messages.length }, call.metadata);
            const r = pick(ctx);
            void (async () => {
              await sleep(r?.delayMs ?? 0);
              if (r && r.status !== "OK") {
                log(id, started, ctx.body.raw, r.id, r.status);
                return callback(statusError(r));
              }
              try {
                const msg = build(r?.message ?? null, ctx);
                log(id, started, ctx.body.raw, r?.id ?? "ejemplo", "OK");
                callback(null, msg, r ? metadataOf(r.trailers) : undefined);
              } catch (err) {
                callback(fail(err));
              }
            })();
          });
        };
      } else {
        impl[methodName] = (call: grpc.ServerDuplexStream<unknown, unknown>) => {
          const id = `grpc${++calls}`;
          const started = performance.now();
          let pending = Promise.resolve();
          call.on("data", (m) => {
            const ctx = ctxFor(m, call.metadata);
            const r = pick(ctx);
            pending = pending.then(async () => {
              await sleep(r?.delayMs ?? 0);
              if (call.cancelled) return;
              if (r && r.status !== "OK") {
                log(id, started, ctx.body.raw, r.id, r.status);
                call.destroy(Object.assign(new Error(r.details || r.status), statusError(r)));
                return;
              }
              try {
                call.write(build(r?.message ?? null, ctx));
                log(id, started, ctx.body.raw, r?.id ?? "ejemplo", "OK");
              } catch (err) {
                call.destroy(Object.assign(new Error("Mockix"), fail(err)));
              }
            });
          });
          call.on("end", () => void pending.then(() => call.end()));
        };
      }
    }
    server.addService(service, impl);
  }
  if (def.reflection) new ReflectionService(merged).addToServer(server);

  const credentials = def.tls && tls ? grpc.ServerCredentials.createSsl(null, [{ cert_chain: Buffer.from(tls.cert), private_key: Buffer.from(tls.key) }], false) : grpc.ServerCredentials.createInsecure();
  const address = host.includes(":") ? `[${host}]:${def.port}` : `${host}:${def.port}`;
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(address, credentials, (err, bound) => {
      if (err) {
        const inUse = /EADDRINUSE|address already in use|No address added/i.test(err.message);
        reject(new GrpcStartError(inUse ? "PORT_IN_USE" : "START_FAILED", inUse ? `gRPC port ${def.port} is already in use (${address})` : err.message));
      } else resolve(bound);
    });
  });

  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          server.forceShutdown();
          resolve();
        }, 2000);
        server.tryShutdown(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}
