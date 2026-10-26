/**
 * The workspace format on disk: what users, agents and git see. One YAML file
 * per route, response bodies in their own files, mock settings in mock.yaml.
 *
 *   mockix.workspace.yaml            format version and mock order
 *   mocks/<name>/mock.yaml           port, host, prefix, CORS, TLS, latency, route order
 *   mocks/<name>/routes/**\/*.yaml    one route each
 *   mocks/<name>/scenarios/*.yaml    state machines (one per file)
 *   mocks/<name>/grpc/*.yaml         gRPC services (one per file, with its .proto)
 *   contracts/*.yaml                 OpenAPI contracts a mock can be checked against
 *   chaos/*.yaml                     chaos profiles (name → points over time)
 *
 * The loader (loader.ts) turns these into the runtime model (runtime.ts).
 */
import { z } from "zod";

export const FORMAT_VERSION = 1;
export const WORKSPACE_FILE = "mockix.workspace.yaml";
export const MOCK_FILE = "mock.yaml";

export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "solo minúsculas, números y guiones (máx. 64)");

/** 40, "40ms", "2s", "1.5s" → milliseconds. */
export const duration = z.union([
  z.number().min(0).max(300_000),
  z
    .string()
    .regex(/^\d+(\.\d+)?\s*(ms|s)$/, 'usa milisegundos (40) o un texto como "40ms" o "2s"')
    .transform((s) => {
      const n = Number.parseFloat(s);
      return Math.round(s.trim().endsWith("ms") ? n : n * 1000);
    })
    .pipe(z.number().max(300_000)),
]);

export const RULE_OPS = ["equals", "regex", "exists", "empty", "null", "contains", "in", "gt", "gte", "lt", "lte"] as const;
export type RuleOp = (typeof RULE_OPS)[number];

/** Where a rule reads from; state.<scenario> is the current state of that scenario's instance. */
export const RULE_TARGET = /^(body(\.[^.\s]+|\[\d+\])*|query\.[^\s]+|header\.[^\s]+|cookie\.[^\s]+|params\.[^\s]+|method|path|request\.number|state\.[a-z0-9][a-z0-9-]*)$/;

/** 30s, "5m", "1h", or milliseconds; scenarios wait longer than responses. */
export const longDuration = z.union([
  z.number().min(0).max(86_400_000),
  z
    .string()
    .regex(/^\d+(\.\d+)?\s*(ms|s|m|h)$/, 'usa milisegundos o un texto como "10s", "5m" o "1h"')
    .transform((s) => {
      const n = Number.parseFloat(s);
      const unit = s.trim().replace(/^[\d.\s]+/, "");
      return Math.round(n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000));
    })
    .pipe(z.number().max(86_400_000)),
]);

export const ruleFile = z
  .object({
    target: z.string().regex(RULE_TARGET, "objetivo no válido: body, body.campo, query.x, header.x, cookie.x, params.x, method, path, request.number o state.<escenario>"),
    op: z.enum(RULE_OPS),
    value: z.unknown().optional(),
    negate: z.boolean().optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const needsValue = !["exists", "empty", "null"].includes(rule.op);
    if (needsValue && rule.value === undefined) ctx.addIssue({ code: "custom", path: ["value"], message: `"${rule.op}" necesita un value` });
    if (rule.op === "in" && rule.value !== undefined && !Array.isArray(rule.value)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: '"in" necesita una lista de valores' });
    }
    if (rule.op === "regex" && typeof rule.value === "string") {
      try {
        new RegExp(rule.value);
      } catch {
        ctx.addIssue({ code: "custom", path: ["value"], message: "expresión regular no válida" });
      }
    }
    if (["gt", "gte", "lt", "lte"].includes(rule.op) && typeof rule.value !== "number") {
      ctx.addIssue({ code: "custom", path: ["value"], message: `"${rule.op}" compara números` });
    }
  });

export const bodyFile = z.union([
  z.string(),
  z.object({ inline: z.string() }).strict(),
  z.object({ file: z.string().min(1) }).strict(),
  z.object({ json: z.unknown() }).strict(),
]);

/** A request the mock sends after answering (webhooks). Only to hosts allowed in mock.yaml. */
export const callbackFile = z
  .object({
    url: z.string().min(1),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
    headers: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    body: z.union([z.string(), z.object({ json: z.unknown() }).strict()]).optional(),
    delay: duration.optional(),
  })
  .strict();

export const responseFile = z
  .object({
    id: slug,
    default: z.boolean().optional(),
    status: z.number().int().min(100).max(599).optional(),
    headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "nombre de cabecera no válido"), z.union([z.string(), z.number()])).optional(),
    body: bodyFile.optional(),
    latency: duration.optional(),
    rules: z
      .object({
        mode: z.enum(["all", "any"]).optional(),
        when: z.array(ruleFile).min(1),
      })
      .strict()
      .optional(),
    /** Text bodies and header values are templates unless this is false. */
    template: z.boolean().optional(),
    callbacks: z.array(callbackFile).max(10).optional(),
    description: z.string().optional(),
  })
  .strict();

export const CHAOS_DIR = "chaos";

/** A chaos profile name, or "off" to exclude a folder or route from the mock's profile. */
const chaosRef = slug;

export const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"] as const;
export const RESPONSE_MODES = ["rules", "random", "sequential", "fallback"] as const;

export const routeFile = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_/-]{0,127}$/, "id no válido").optional(),
    method: z.enum(ROUTE_METHODS).optional(),
    path: z
      .string()
      .min(1)
      .refine((p) => p.startsWith("/") || p.startsWith("^"), 'empieza por "/" (ruta) o por "^" (expresión regular)')
      .refine((p) => {
        if (!p.startsWith("^")) return true;
        try {
          new RegExp(p);
          return true;
        } catch {
          return false;
        }
      }, "expresión regular no válida"),
    mode: z.enum(RESPONSE_MODES).optional(),
    latency: duration.optional(),
    description: z.string().optional(),
    /** A CRUD route serves a data bucket (list, get, create, replace, update, delete) instead of fixed responses. */
    crud: z
      .object({
        bucket: slug,
        key: z.string().min(1).optional(),
        /** The list wrapped in an object, as many APIs answer: { data: [...], total: 3 } → list: { items: data, total: total }. */
        list: z.object({ items: z.string().min(1), total: z.string().min(1).optional() }).strict().optional(),
      })
      .strict()
      .optional(),
    /** Chaos profile for this route only, or "off" to exempt it. */
    chaos: chaosRef.optional(),
    responses: z.array(responseFile).optional(),
  })
  .strict()
  .superRefine((route, ctx) => {
    if (route.crud && route.responses?.length) ctx.addIssue({ code: "custom", path: ["responses"], message: "una ruta CRUD no lleva respuestas propias" });
    if (route.crud && route.method && route.method !== "ANY") ctx.addIssue({ code: "custom", path: ["method"], message: "una ruta CRUD atiende todos los métodos: quita method" });
    if (route.crud && route.path.startsWith("^")) ctx.addIssue({ code: "custom", path: ["path"], message: "una ruta CRUD necesita una ruta fija, no una expresión regular" });
    if (!route.crud && !route.responses?.length) ctx.addIssue({ code: "custom", path: ["responses"], message: "una ruta necesita al menos una respuesta" });
  });

export const variablesFile = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "nombre de variable no válido"), z.union([z.string(), z.number(), z.boolean()]));

export const tlsFile = z.union([
  z.boolean(),
  z.object({ cert: z.string().min(1), key: z.string().min(1) }).strict(),
]);

export const mockFile = z
  .object({
    port: z.number().int().min(0).max(65535),
    host: z.string().min(1).optional(),
    prefix: z
      .string()
      .regex(/^(\/[^/\s?#]+)*$/, 'un prefijo como "/v1" (sin barra final)')
      .optional(),
    cors: z.boolean().optional(),
    latency: duration.optional(),
    tls: tlsFile.optional(),
    order: z.array(z.string()).optional(),
    variables: variablesFile.optional(),
    /** Partial mocking: what no route answers goes to the real API. */
    proxy: z
      .object({
        target: z.url({ protocol: /^https?$/, message: "una URL http:// o https://" }),
        /** Send the mock prefix to the target too (default: strip it). */
        keepPrefix: z.boolean().optional(),
        /** Accept an invalid certificate on the target (only for test servers). */
        insecure: z.boolean().optional(),
        headers: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      })
      .strict()
      .optional(),
    callbacks: z.object({ allow: z.array(z.string().min(1)) }).strict().optional(),
    /** gRPC server of the mock (HTTP/2, its own port); services in grpc/*.yaml. */
    grpc: z
      .object({
        port: z.number().int().min(0).max(65535),
        /** Use the mock's certificate (tls in mock.yaml). */
        tls: z.boolean().optional(),
        /** Server reflection, so clients discover the services without the .proto (default true). */
        reflection: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Chaos profile of chaos/*.yaml for the whole mock, and per folder of routes/ ("off" exempts one). */
    chaos: z
      .union([
        chaosRef,
        z
          .object({
            profile: chaosRef.optional(),
            folders: z.record(z.string().regex(/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/i, "una carpeta de routes/, como pedidos"), chaosRef).optional(),
          })
          .strict(),
      ])
      .optional(),
    /** OpenAPI contract the mock is checked against (path relative to the workspace). */
    contract: z
      .object({
        file: z.string().min(1),
        /** off: no checks; warn: report and answer as usual; strict: answer 400 problem+json. */
        mode: z.enum(["off", "warn", "strict"]).optional(),
        /** Also check the mock's own responses (default true). */
        responses: z.boolean().optional(),
      })
      .strict()
      .optional(),
    description: z.string().optional(),
  })
  .strict();

const rate = z.number().min(0, "entre 0 y 1").max(1, "entre 0 y 1 (0.15 es un 15 %)");

/** chaos/<file>.yaml: profiles by name. */
export const chaosProfileFile = z
  .object({
    description: z.string().optional(),
    /** Start over at the end of the cycle (default true). */
    loop: z.boolean().optional(),
    /** Length of the cycle; by default, the time of the last point. */
    duration: longDuration.optional(),
    points: z
      .array(
        z
          .object({
            t: longDuration,
            latency: duration.optional(),
            jitter: duration.optional(),
            errorRate: rate.optional(),
            /** Codes of the injected errors: a list (same weight) or code → weight. */
            errors: z
              .union([
                z.array(z.number().int().min(400).max(599)).min(1),
                z.record(z.string().regex(/^[45]\d\d$/, "un código 4xx o 5xx"), z.number().positive()),
              ])
              .optional(),
          })
          .strict(),
      )
      .min(1),
    extras: z
      .object({
        /** Share of requests whose connection is cut without an answer. */
        dropRate: rate.optional(),
        /** Share of requests that never get an answer. */
        timeoutRate: rate.optional(),
        /** Send bodies at this speed (KB/s). */
        trickleKBps: z.number().positive().max(1_000_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    p.points.forEach((pt, i) => {
      if (i > 0 && pt.t < p.points[i - 1]!.t) ctx.addIssue({ code: "custom", path: ["points", i, "t"], message: "los puntos van en orden de tiempo" });
    });
    if (p.duration !== undefined && p.duration < p.points.at(-1)!.t) ctx.addIssue({ code: "custom", path: ["duration"], message: "duration no puede ser menor que el último punto" });
  });

export const chaosFile = z.record(slug, chaosProfileFile);

const stateName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "un estado en minúsculas, números, guiones o guiones bajos");

/** mocks/<name>/scenarios/<id>.yaml: a state machine per key. */
export const scenarioFile = z
  .object({
    id: slug.optional(),
    description: z.string().optional(),
    /** Where the instance key comes from (params.id → one machine per order). Without it there is one shared instance. */
    key: z
      .string()
      .regex(RULE_TARGET, "objetivo no válido: params.x, query.x, header.x, cookie.x o body.campo")
      .refine((k) => !k.startsWith("state."), "la clave no puede ser otro estado")
      .optional(),
    initial: stateName,
    states: z.array(stateName).min(2),
    transitions: z
      .array(
        z
          .object({
            from: z.union([stateName, z.array(stateName).min(1)]),
            to: stateName,
            /** A request that moves the instance. */
            on: z
              .object({
                method: z.enum(ROUTE_METHODS).optional(),
                path: z.string().regex(/^\//, 'una ruta que empieza por "/" (como en las rutas, con :param)'),
                rules: z.array(ruleFile).optional(),
              })
              .strict()
              .optional(),
            /** Or time spent in the state. */
            after: longDuration.optional(),
          })
          .strict()
          .refine((t) => (t.on === undefined) !== (t.after === undefined), "cada transición lleva on (una petición) o after (un tiempo), no los dos"),
      )
      .min(1),
  })
  .strict()
  .superRefine((s, ctx) => {
    const states = new Set<string>();
    s.states.forEach((st, i) => {
      if (states.has(st)) ctx.addIssue({ code: "custom", path: ["states", i], message: `"${st}" está repetido` });
      states.add(st);
    });
    if (!states.has(s.initial)) ctx.addIssue({ code: "custom", path: ["initial"], message: `"${s.initial}" no está en states` });
    s.transitions.forEach((t, i) => {
      for (const f of Array.isArray(t.from) ? t.from : [t.from]) {
        if (!states.has(f)) ctx.addIssue({ code: "custom", path: ["transitions", i, "from"], message: `"${f}" no está en states` });
      }
      if (!states.has(t.to)) ctx.addIssue({ code: "custom", path: ["transitions", i, "to"], message: `"${t.to}" no está en states` });
    });
    const timed = new Set<string>();
    s.transitions.forEach((t, i) => {
      if (t.after === undefined) return;
      for (const f of Array.isArray(t.from) ? t.from : [t.from]) {
        if (timed.has(f)) ctx.addIssue({ code: "custom", path: ["transitions", i, "after"], message: `"${f}" ya tiene una transición por tiempo` });
        timed.add(f);
      }
    });
  });

export const workspaceFile = z
  .object({
    format: z.literal(FORMAT_VERSION, { message: `formato no soportado; esta versión lee el formato ${FORMAT_VERSION}` }),
    mocks: z.array(slug).optional(),
    /** Variables every mock can read with getVar (a mock's own variables win). */
    variables: variablesFile.optional(),
    /** Environment variables templates may read with envVar. Anything not listed stays hidden. */
    env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
    /** How recordings are cleaned when they become mocks (default: credentials, tokens, emails, phones). */
    redaction: z
      .array(
        z
          .object({
            where: z.enum(["header", "query", "json"]),
            match: z.string().min(1),
            action: z.enum(["remove", "faker"]),
            faker: z.string().regex(/^[a-zA-Z]+\.[a-zA-Z]+( \d+)?$/, 'un método de faker como "internet.email" o "string.alphanumeric 24"').optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/* ---------- WebSocket and Socket.IO routes (routes/*.yaml with protocol: ws | socketio) ---------- */

/** A text payload: a template string, or JSON written as YAML. */
const payload = z.union([z.string(), z.object({ json: z.unknown() }).strict()]);
/** Who receives a message: the sender, every connection of the route, the others, or a Socket.IO room. */
const audience = z.union([z.enum(["self", "all", "others"]), z.string().regex(/^room:.+$/, 'self, all, others o room:<sala>')]);

const realtimeStep = z
  .object({
    /** Wait before sending (one shot). */
    after: longDuration.optional(),
    /** Repeat at this interval. */
    every: longDuration.optional(),
    /** With every: how many times (default: until the client leaves). */
    times: z.number().int().min(1).max(100_000).optional(),
    /** WebSocket: the message to send. */
    send: payload.optional(),
    /** Socket.IO: the event to emit, and its data. */
    emit: z.string().min(1).optional(),
    data: payload.optional(),
    to: audience.optional(),
  })
  .strict()
  .refine((s) => (s.send !== undefined) !== (s.emit !== undefined), "cada paso lleva send (WebSocket) o emit (Socket.IO)");

const realtimeMessage = z
  .object({
    id: slug,
    default: z.boolean().optional(),
    /** Socket.IO: the incoming event this answers. */
    event: z.string().min(1).optional(),
    rules: z.object({ mode: z.enum(["all", "any"]).optional(), when: z.array(ruleFile).min(1) }).strict().optional(),
    delay: duration.optional(),
    /** WebSocket: answer to the sender; broadcast: to every connection of the route. */
    reply: payload.optional(),
    broadcast: payload.optional(),
    close: z.object({ code: z.number().int().min(1000).max(4999).optional(), reason: z.string().max(120).optional() }).strict().optional(),
    /** Socket.IO: acknowledgement for the client's callback, emissions and rooms. */
    ack: payload.optional(),
    emit: z.object({ event: z.string().min(1), data: payload.optional(), to: audience.optional() }).strict().optional(),
    join: z.string().min(1).optional(),
    leave: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .strict();

export const realtimeFile = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_/-]{0,127}$/, "id no válido").optional(),
    protocol: z.enum(["ws", "socketio"]),
    /** WebSocket: the path under the mock prefix. Socket.IO: the namespace (default "/"). */
    path: z.string().regex(/^\//, 'empieza por "/"').optional(),
    description: z.string().optional(),
    /** What the server sends on its own once a client connects. */
    onConnect: z.array(realtimeStep).max(50).optional(),
    /** Answers to incoming messages (WebSocket) or events (Socket.IO), by rules. */
    messages: z.array(realtimeMessage).max(200).optional(),
    /** WebSocket: send back what no message matched. */
    echo: z.boolean().optional(),
    template: z.boolean().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.protocol === "ws" && !r.path) ctx.addIssue({ code: "custom", path: ["path"], message: "una ruta WebSocket necesita path" });
    (r.onConnect ?? []).forEach((s, i) => {
      if (r.protocol === "ws" && s.emit !== undefined) ctx.addIssue({ code: "custom", path: ["onConnect", i], message: "en WebSocket se usa send, no emit" });
      if (r.protocol === "socketio" && s.send !== undefined) ctx.addIssue({ code: "custom", path: ["onConnect", i], message: "en Socket.IO se usa emit (con data), no send" });
      if (r.protocol === "ws" && typeof s.to === "string" && s.to.startsWith("room:")) ctx.addIssue({ code: "custom", path: ["onConnect", i, "to"], message: "las salas son de Socket.IO" });
    });
    (r.messages ?? []).forEach((m, i) => {
      if (r.protocol === "socketio" && !m.event) ctx.addIssue({ code: "custom", path: ["messages", i, "event"], message: "en Socket.IO cada mensaje dice a qué event responde" });
      if (r.protocol === "ws" && (m.ack !== undefined || m.emit !== undefined || m.join !== undefined || m.leave !== undefined || m.event !== undefined)) {
        ctx.addIssue({ code: "custom", path: ["messages", i], message: "event, ack, emit, join y leave son de Socket.IO; en WebSocket usa reply, broadcast o close" });
      }
      if (r.protocol === "socketio" && (m.reply !== undefined || m.broadcast !== undefined || m.close !== undefined)) {
        ctx.addIssue({ code: "custom", path: ["messages", i], message: "reply, broadcast y close son de WebSocket; en Socket.IO usa ack o emit" });
      }
    });
  });

/* ---------- gRPC (mocks/<name>/grpc/*.yaml) ---------- */

export const GRPC_CODES = [
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
] as const;

const metadataFile = z.record(z.string().regex(/^[a-z0-9_.-]+$/, "metadatos en minúsculas"), z.union([z.string(), z.number()]));

const grpcResponse = z
  .object({
    id: slug,
    default: z.boolean().optional(),
    rules: z.object({ mode: z.enum(["all", "any"]).optional(), when: z.array(ruleFile).min(1) }).strict().optional(),
    delay: duration.optional(),
    /** The answer (unary, client streaming, each bidi reply). Strings inside are templates. */
    message: z.unknown().optional(),
    /** Server streaming: the messages, each with its own delay. */
    stream: z.array(z.object({ message: z.unknown(), delay: duration.optional() }).strict()).max(1000).optional(),
    /** Server streaming: send the stream this many times. */
    repeat: z.number().int().min(1).max(10_000).optional(),
    status: z.enum(GRPC_CODES).optional(),
    details: z.string().optional(),
    metadata: metadataFile.optional(),
    trailers: metadataFile.optional(),
    description: z.string().optional(),
  })
  .strict();

export const grpcFile = z
  .object({
    /** The .proto, relative to the workspace (protos/catalogo.proto). */
    proto: z.string().min(1),
    /** Fully qualified service name (tienda.Catalogo). */
    service: z.string().regex(/^[A-Za-z_][\w.]*$/, "un servicio como paquete.Servicio"),
    description: z.string().optional(),
    /** Answers by method name; methods left out answer an example generated from the schema. */
    methods: z.record(z.string().regex(/^[A-Za-z_]\w*$/), z.object({ responses: z.array(grpcResponse).min(1).max(100) }).strict()).optional(),
  })
  .strict();

export type RouteFile = z.output<typeof routeFile>;
export type RealtimeFile = z.output<typeof realtimeFile>;
export type GrpcFile = z.output<typeof grpcFile>;
export type ScenarioFile = z.output<typeof scenarioFile>;
export type ChaosProfileFile = z.output<typeof chaosProfileFile>;
export type MockFile = z.output<typeof mockFile>;
export type WorkspaceFile = z.output<typeof workspaceFile>;
