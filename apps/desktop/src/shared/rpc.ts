/**
 * Wire format between main and a mock host (utilityProcess), carried over a MessagePort.
 *
 *   call    → { kind: "call",   id, method, params }
 *   result  ← { kind: "result", id, ok: true, value } | { kind: "result", id, ok: false, error }
 *   event   ← { kind: "event",  stream, name, data }        (ready, request log)
 *   cancel  → { kind: "cancel", id }
 *
 * Both ends validate every envelope; method params and results are validated
 * against the contracts in ./host-methods.ts.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type RpcError = z.infer<typeof errorSchema>;

export const callSchema = z.object({
  kind: z.literal("call"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown(),
});

export const resultSchema = z.discriminatedUnion("ok", [
  z.object({ kind: z.literal("result"), id: z.string().min(1), ok: z.literal(true), value: z.unknown() }),
  z.object({ kind: z.literal("result"), id: z.string().min(1), ok: z.literal(false), error: errorSchema }),
]);

export const eventSchema = z.object({
  kind: z.literal("event"),
  stream: z.string().min(1),
  name: z.string().min(1),
  data: z.unknown(),
});

export const cancelSchema = z.object({
  kind: z.literal("cancel"),
  id: z.string().min(1),
});

export const toHostSchema = z.discriminatedUnion("kind", [callSchema, cancelSchema]);
export const fromHostSchema = z.union([resultSchema, eventSchema]);

export type CallEnvelope = z.infer<typeof callSchema>;
export type ResultEnvelope = z.infer<typeof resultSchema>;
export type EventEnvelope = z.infer<typeof eventSchema>;
export type ToHost = z.infer<typeof toHostSchema>;
export type FromHost = z.infer<typeof fromHostSchema>;

/** First message main sends to a host, together with the MessagePort. */
export const handshakeSchema = z.object({
  type: z.literal("connect"),
  protocol: z.literal(PROTOCOL_VERSION),
  testMode: z.boolean(),
});
export type Handshake = z.infer<typeof handshakeSchema>;

/** Result as returned to callers (main and renderer never see thrown errors from a host). */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: RpcError };

export const ErrorCodes = {
  invalidEnvelope: "INVALID_ENVELOPE",
  unknownMethod: "UNKNOWN_METHOD",
  invalidParams: "INVALID_PARAMS",
  invalidResult: "INVALID_RESULT",
  handlerFailed: "HANDLER_FAILED",
  cancelled: "CANCELLED",
  timeout: "TIMEOUT",
  hostUnavailable: "HOST_UNAVAILABLE",
  hostExited: "HOST_EXITED",
  forbidden: "FORBIDDEN",
  notFound: "NOT_FOUND",
  alreadyRunning: "ALREADY_RUNNING",
  hasProblems: "HAS_PROBLEMS",
  noWorkspace: "NO_WORKSPACE",
  workspaceExists: "WORKSPACE_EXISTS",
  notWorkspace: "NOT_WORKSPACE",
} as const;
