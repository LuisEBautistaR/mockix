/**
 * The runtime model: a fully resolved mock, ready to serve. Bodies are already
 * read from disk, so a definition can cross a process boundary (structured
 * clone) and the server never touches the workspace.
 */
import { z } from "zod";
import { RESPONSE_MODES, ROUTE_METHODS, RULE_OPS, slug } from "./format.js";

export const runtimeBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("bytes"), data: z.instanceof(Uint8Array), path: z.string() }),
]);

export const runtimeRule = z.object({
  target: z.string(),
  op: z.enum(RULE_OPS),
  value: z.unknown(),
  negate: z.boolean(),
});

export const runtimeCallback = z.object({
  url: z.string(),
  method: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
  delayMs: z.number().min(0),
});

export const runtimeResponse = z.object({
  id: z.string(),
  default: z.boolean(),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
  body: runtimeBody.nullable(),
  latencyMs: z.number().min(0),
  rules: z.object({ mode: z.enum(["all", "any"]), when: z.array(runtimeRule) }).nullable(),
  template: z.boolean().default(true),
  callbacks: z.array(runtimeCallback).default([]),
});

export const runtimeRoute = z.object({
  id: z.string(),
  /** Source file, relative to the mock folder (for logs and the UI). */
  file: z.string(),
  method: z.enum(ROUTE_METHODS),
  path: z.string(),
  mode: z.enum(RESPONSE_MODES),
  latencyMs: z.number().min(0),
  crud: z.object({ bucket: z.string(), key: z.string(), list: z.object({ items: z.string(), total: z.string().optional() }).optional() }).nullable().default(null),
  /** Chaos profile resolved from the route and its folders: a name, null (exempt) or undefined (the mock's). */
  chaos: z.string().nullable().optional(),
  responses: z.array(runtimeResponse),
});

const runtimeAudience = z.string();

export const runtimeRealtime = z.object({
  id: z.string(),
  file: z.string(),
  protocol: z.enum(["ws", "socketio"]),
  /** WebSocket path under the prefix, or Socket.IO namespace. */
  path: z.string(),
  description: z.string().nullable(),
  onConnect: z.array(
    z.object({
      afterMs: z.number().min(0),
      everyMs: z.number().min(0).nullable(),
      times: z.number().int().nullable(),
      send: z.string().nullable(),
      emit: z.string().nullable(),
      data: z.string().nullable(),
      to: runtimeAudience,
    }),
  ),
  messages: z.array(
    z.object({
      id: z.string(),
      default: z.boolean(),
      event: z.string().nullable(),
      rules: z.object({ mode: z.enum(["all", "any"]), when: z.array(runtimeRule) }).nullable(),
      delayMs: z.number().min(0),
      reply: z.string().nullable(),
      broadcast: z.string().nullable(),
      close: z.object({ code: z.number().int(), reason: z.string() }).nullable(),
      ack: z.string().nullable(),
      emit: z.object({ event: z.string(), data: z.string().nullable(), to: runtimeAudience }).nullable(),
      join: z.string().nullable(),
      leave: z.string().nullable(),
    }),
  ),
  echo: z.boolean(),
  template: z.boolean(),
});

export const runtimeGrpcResponse = z.object({
  id: z.string(),
  default: z.boolean(),
  rules: z.object({ mode: z.enum(["all", "any"]), when: z.array(runtimeRule) }).nullable(),
  delayMs: z.number().min(0),
  /** JSON text of the message (a template). */
  message: z.string().nullable(),
  stream: z.array(z.object({ message: z.string(), delayMs: z.number().min(0) })).nullable(),
  repeat: z.number().int().min(1),
  status: z.string(),
  details: z.string(),
  metadata: z.record(z.string(), z.string()),
  trailers: z.record(z.string(), z.string()),
});

export const runtimeGrpc = z.object({
  port: z.number().int().min(0).max(65535),
  tls: z.boolean(),
  reflection: z.boolean(),
  services: z.array(
    z.object({
      file: z.string(),
      proto: z.string(),
      service: z.string(),
      /** protobufjs JSON of the .proto and its imports. */
      descriptor: z.record(z.string(), z.unknown()),
      methods: z.record(z.string(), z.array(runtimeGrpcResponse)),
    }),
  ),
});

export const runtimeChaosProfile = z.object({
  name: z.string(),
  /** Source file, relative to the workspace. */
  file: z.string(),
  description: z.string().nullable(),
  loop: z.boolean(),
  cycleMs: z.number().min(0),
  points: z.array(
    z.object({
      tMs: z.number().min(0),
      latencyMs: z.number().min(0),
      jitterMs: z.number().min(0),
      errorRate: z.number().min(0).max(1),
      errors: z.array(z.object({ status: z.number().int(), weight: z.number().positive() })),
    }),
  ),
  extras: z.object({ dropRate: z.number().min(0).max(1), timeoutRate: z.number().min(0).max(1), trickleKBps: z.number().positive().nullable() }),
});

export const runtimeScenario = z.object({
  id: z.string(),
  /** Source file, relative to the mock folder. */
  file: z.string(),
  key: z.string().nullable(),
  initial: z.string(),
  states: z.array(z.string()),
  transitions: z.array(
    z.object({
      from: z.array(z.string()),
      to: z.string(),
      on: z.object({ method: z.enum(ROUTE_METHODS), path: z.string(), rules: z.array(runtimeRule) }).nullable(),
      afterMs: z.number().min(0).nullable(),
    }),
  ),
});

export const runtimeContract = z.object({
  /** Path relative to the workspace (for messages and reports). */
  file: z.string(),
  mode: z.enum(["off", "warn", "strict"]),
  responses: z.boolean(),
  /** The OpenAPI document, bundled: external refs inlined, internal ones kept. */
  document: z.record(z.string(), z.unknown()),
});

export const mockConfig = z.object({
  name: slug,
  /** Loopback by default: listening on the network must be an explicit choice. */
  host: z.string().min(1).default("127.0.0.1"),
  /** 0 asks the system for a free port. */
  port: z.number().int().min(0).max(65535),
  prefix: z.string().default(""),
  cors: z.boolean().default(true),
  latencyMs: z.number().min(0).default(0),
  tls: z.object({ cert: z.string(), key: z.string() }).nullable().default(null),
  routes: z.array(runtimeRoute),
  /** Workspace variables overlaid with the mock's own. */
  variables: z.record(z.string(), z.string()).default({}),
  /** Allow-listed environment variables, resolved when the workspace loads. */
  env: z.record(z.string(), z.string()).default({}),
  /** Seeds of the data buckets (mocks/<name>/data/*.json). */
  buckets: z.record(z.string(), z.unknown()).default({}),
  proxy: z
    .object({ target: z.string(), keepPrefix: z.boolean(), insecure: z.boolean(), headers: z.record(z.string(), z.string()) })
    .nullable()
    .default(null),
  /** Hosts (host or host:port) callbacks may reach. */
  callbackHosts: z.array(z.string()).default([]),
  scenarios: z.array(runtimeScenario).default([]),
  contract: runtimeContract.nullable().default(null),
  /** WebSocket routes and Socket.IO namespaces. */
  realtime: z.array(runtimeRealtime).default([]),
  grpc: runtimeGrpc.nullable().default(null),
  chaos: z
    .object({
      /** Every profile of the workspace, so the profile can be switched at runtime. */
      profiles: z.record(z.string(), runtimeChaosProfile),
      /** The mock's own profile, or null. */
      profile: z.string().nullable(),
      /** Folder of routes/ → profile (null: exempt), as written in mock.yaml. */
      folders: z.record(z.string(), z.string().nullable()),
    })
    .default({ profiles: {}, profile: null, folders: {} }),
});

export type RuntimeBody = z.output<typeof runtimeBody>;
export type RuntimeRule = z.output<typeof runtimeRule>;
export type RuntimeCallback = z.output<typeof runtimeCallback>;
export type RuntimeResponse = z.output<typeof runtimeResponse>;
export type RuntimeRoute = z.output<typeof runtimeRoute>;
export type RuntimeScenario = z.output<typeof runtimeScenario>;
export type RuntimeContract = z.output<typeof runtimeContract>;
export type RuntimeChaosProfile = z.output<typeof runtimeChaosProfile>;
export type RuntimeRealtime = z.output<typeof runtimeRealtime>;
export type RuntimeGrpc = z.output<typeof runtimeGrpc>;
export type RuntimeGrpcResponse = z.output<typeof runtimeGrpcResponse>;
export type MockConfig = z.output<typeof mockConfig>;
export type MockDefinition = z.input<typeof mockConfig>;

export function parseMock(input: unknown): MockConfig {
  return mockConfig.parse(input);
}

/** Small helper for tests and examples: a route with one fixed text response. */
export function fixedRoute(method: (typeof ROUTE_METHODS)[number], path: string, status: number, text: string, headers: Record<string, string> = {}): RuntimeRoute {
  return {
    id: `${method.toLowerCase()}${path.replace(/[^a-z0-9]+/gi, "-")}`.replace(/-+$/, ""),
    file: "",
    method,
    path,
    mode: "rules",
    latencyMs: 0,
    crud: null,
    responses: [{ id: "ok", default: true, status, headers, body: { kind: "text", text }, latencyMs: 0, rules: null, template: true, callbacks: [] }],
  };
}
