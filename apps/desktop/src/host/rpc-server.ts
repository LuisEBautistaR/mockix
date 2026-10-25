import { ErrorCodes, toHostSchema, type FromHost, type RpcError } from "@shared/rpc";
import { hostMethods, isHostMethod, type HostMethod } from "@shared/host-methods";

export interface CallContext {
  id: string;
  signal: AbortSignal;
}

export type Handler = (params: unknown, call: CallContext) => unknown;
export type Handlers = Partial<Record<HostMethod, Handler>>;

/** Thrown by handlers to answer with a specific error code (e.g. PORT_IN_USE). */
export class HandlerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HandlerError";
    this.code = code;
  }
}

export interface RpcServerOptions {
  handlers: Handlers;
  send(message: FromHost): void;
  testMode: boolean;
  log?: (message: string, detail?: unknown) => void;
}

/** Turns incoming envelopes into handler calls and always answers with a result envelope. */
export function createRpcServer({ handlers, send, testMode, log = () => {} }: RpcServerOptions) {
  const inFlight = new Map<string, AbortController>();

  const fail = (id: string, error: RpcError) => send({ kind: "result", id, ok: false, error });

  async function call(id: string, method: string, rawParams: unknown): Promise<void> {
    const handler = isHostMethod(method) ? handlers[method] : undefined;
    if (!isHostMethod(method) || !handler || (hostMethods[method].testOnly && !testMode)) {
      fail(id, { code: ErrorCodes.unknownMethod, message: `Unknown method "${method}"` });
      return;
    }
    const contract = hostMethods[method];
    const params = contract.params.safeParse(rawParams);
    if (!params.success) {
      fail(id, { code: ErrorCodes.invalidParams, message: params.error.message });
      return;
    }
    const controller = new AbortController();
    inFlight.set(id, controller);
    try {
      const value = await handler(params.data, { id, signal: controller.signal });
      // Cancelled meanwhile: the CANCELLED result has already been sent.
      if (controller.signal.aborted) return;
      const result = contract.result.safeParse(value);
      if (!result.success) {
        log(`Handler returned an invalid result for ${method}`, result.error.issues);
        fail(id, { code: ErrorCodes.invalidResult, message: `Invalid result from ${method}` });
        return;
      }
      send({ kind: "result", id, ok: true, value: result.data });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof HandlerError) {
        fail(id, { code: err.code, message: err.message });
        return;
      }
      log(`Handler failed on ${method}`, err);
      fail(id, { code: ErrorCodes.handlerFailed, message: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.delete(id);
    }
  }

  return {
    handle(raw: unknown): void {
      const parsed = toHostSchema.safeParse(raw);
      if (!parsed.success) {
        log("Dropped an invalid envelope", parsed.error.issues);
        const id = typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "string" ? raw.id : null;
        if (id) fail(id, { code: ErrorCodes.invalidEnvelope, message: "Invalid envelope" });
        return;
      }
      const message = parsed.data;
      if (message.kind === "cancel") {
        // Answer at once: the handler may not have started yet, or may ignore the signal.
        const controller = inFlight.get(message.id);
        if (controller) {
          inFlight.delete(message.id);
          controller.abort();
          fail(message.id, { code: ErrorCodes.cancelled, message: "Call was cancelled" });
        }
        return;
      }
      void call(message.id, message.method, message.params);
    },
    get inFlight(): number {
      return inFlight.size;
    },
  };
}
