/**
 * Every method a mock host exposes to main, with its params and result contracts.
 * Only main calls these: the renderer talks to main through the named channels
 * in ./ipc.ts and never reaches a host directly.
 */
import { z } from "zod";

export const hostMethods = {
  "system.ping": {
    params: z.object({ sentAt: z.number() }),
    result: z.object({
      sentAt: z.number(),
      hostTime: z.number(),
      pid: z.number().int(),
      uptimeMs: z.number(),
    }),
    testOnly: false,
  },
  "system.info": {
    params: z.object({}),
    result: z.object({
      node: z.string(),
      v8: z.string(),
      platform: z.string(),
      arch: z.string(),
    }),
    testOnly: false,
  },
  /** The definition is validated by the core, which owns the mock model. With record, proxied exchanges are sent as "exchange" events. */
  "mock.start": {
    params: z.object({ definition: z.unknown(), record: z.boolean().optional() }),
    result: z.object({
      name: z.string(),
      host: z.string(),
      port: z.number().int().min(1).max(65535),
      url: z.string(),
      routeCount: z.number().int().min(0),
      grpcPort: z.number().int().nullable(),
    }),
    testOnly: false,
  },
  /** Applies a new version of the running mock: in place when possible, otherwise by restarting its listener. */
  "mock.update": {
    params: z.object({ definition: z.unknown() }),
    result: z.object({
      mode: z.enum(["updated", "restarted"]),
      name: z.string(),
      host: z.string(),
      port: z.number().int().min(1).max(65535),
      url: z.string(),
      routeCount: z.number().int().min(0),
      grpcPort: z.number().int().nullable(),
    }),
    testOnly: false,
  },
  "mock.stop": {
    params: z.object({}),
    result: z.object({ stopped: z.boolean() }),
    testOnly: false,
  },
  /** Contract violations counted by the running mock (clear resets the counters first). */
  "mock.contract": {
    params: z.object({ clear: z.boolean().optional() }),
    result: z.custom<unknown>(() => true),
    testOnly: false,
  },
  /** Scenario definitions with live instances, and the latest transitions. */
  "mock.scenarios": {
    params: z.object({}),
    result: z.object({ now: z.number(), views: z.array(z.custom<unknown>(() => true)), recent: z.array(z.custom<unknown>(() => true)) }),
    testOnly: false,
  },
  "mock.scenarioSet": {
    params: z.object({ id: z.string().min(1).max(64), key: z.string().max(512), state: z.string().min(1).max(64) }),
    result: z.custom<unknown>(() => true),
    testOnly: false,
  },
  "mock.scenarioReset": {
    params: z.object({ id: z.string().min(1).max(64).optional() }),
    result: z.object({ reset: z.literal(true) }),
    testOnly: false,
  },
  /** The chaos timeline now and the effects of the last minute. */
  "mock.chaos": {
    params: z.object({}),
    result: z.custom<unknown>(() => true),
    testOnly: false,
  },
  /** Replaces the mock's chaos profile until it stops (profile null: no chaos; reset: back to mock.yaml). */
  "mock.chaosSet": {
    params: z.object({ profile: z.string().min(1).max(64).nullable().optional(), reset: z.boolean().optional() }),
    result: z.object({ done: z.literal(true) }),
    testOnly: false,
  },
  /** Runtime control: pause, restart the timeline. */
  "mock.chaosControl": {
    params: z.object({ action: z.enum(["pause", "resume", "restart"]) }),
    result: z.object({ done: z.literal(true) }),
    testOnly: false,
  },
  /** Kills the host on purpose so tests can check that main restarts it. */
  "diagnostics.crash": {
    params: z.object({ exitCode: z.number().int().min(1).max(255) }),
    result: z.object({ scheduled: z.literal(true) }),
    testOnly: true,
  },
} as const;

export type HostMethod = keyof typeof hostMethods;
export type HostParams<M extends HostMethod> = z.input<(typeof hostMethods)[M]["params"]>;
export type HostResult<M extends HostMethod> = z.output<(typeof hostMethods)[M]["result"]>;

export function isHostMethod(value: unknown): value is HostMethod {
  return typeof value === "string" && Object.hasOwn(hostMethods, value);
}

const capturedSchema = z.object({
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  truncated: z.boolean(),
  binary: z.boolean(),
});

export const requestLogSchema = z.object({
  seq: z.number().int(),
  at: z.number(),
  method: z.string(),
  url: z.string(),
  status: z.number().int(),
  durationMs: z.number(),
  kind: z.enum(["route", "crud", "proxy", "preflight", "none"]),
  routeId: z.string().nullable(),
  responseId: z.string().nullable(),
  latencyMs: z.number(),
  timings: z.object({ receiveMs: z.number(), processMs: z.number(), latencyMs: z.number(), chaosMs: z.number(), sendMs: z.number() }),
  request: capturedSchema,
  response: capturedSchema,
  error: z.string().nullable(),
  violations: z
    .array(
      z.object({
        side: z.enum(["request", "response"]),
        operation: z.string(),
        where: z.string(),
        rule: z.string(),
        message: z.string(),
        status: z.number().int().optional(),
      }),
    )
    .default([]),
  chaos: z
    .object({
      profile: z.string(),
      tMs: z.number(),
      latencyMs: z.number(),
      error: z.number().int().nullable(),
      drop: z.boolean(),
      timeout: z.boolean(),
      trickleKBps: z.number().nullable(),
    })
    .nullable()
    .default(null),
});

export const messageLogSchema = z.object({
  at: z.number(),
  protocol: z.enum(["ws", "socketio", "grpc"]),
  routeId: z.string(),
  connection: z.string(),
  kind: z.enum(["connect", "disconnect", "in", "out", "call"]),
  event: z.string().nullable(),
  data: z.string(),
  matched: z.string().nullable(),
  status: z.string().nullable(),
  durationMs: z.number().nullable(),
});

export const callbackLogSchema = z.object({
  requestSeq: z.number().int(),
  at: z.number(),
  method: z.string(),
  url: z.string(),
  status: z.number().int().nullable(),
  durationMs: z.number(),
  error: z.string().nullable(),
});
