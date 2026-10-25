import { MockStartError, startMock, type CallbackLogEntry, type Exchange, type MessageLogEntry, type MockHandle, type RequestLogEntry } from "@mockix/core";
import { ErrorCodes } from "@shared/rpc";
import type { HostParams, HostResult } from "@shared/host-methods";
import { HandlerError, type Handlers } from "./rpc-server";

export interface HostDeps {
  /** Push a served request to main. */
  onRequest(entry: RequestLogEntry): void;
  /** Push a webhook the mock sent. */
  onCallback?(entry: CallbackLogEntry): void;
  /** Push a request the proxy forwarded, in full (recording). */
  onExchange?(exchange: Exchange): void;
  /** Push a WebSocket or Socket.IO message, or a gRPC call. */
  onMessage?(entry: MessageLogEntry): void;
  /** Value of the Server header the mock sends. */
  serverHeader: string;
  exit(code: number): void;
}

/** A host serves exactly one mock: main starts one host per running mock. */
export function createHandlers(deps: HostDeps): Handlers & { readonly current: MockHandle | null } {
  const startedAt = performance.now();
  let current: MockHandle | null = null;

  const describe = (m: MockHandle) => ({ name: m.name, host: m.host, port: m.port, url: m.url, routeCount: m.routeCount, grpcPort: m.grpcPort });

  async function start(definition: unknown, record = false): Promise<MockHandle> {
    try {
      current = await startMock(definition, {
        serverHeader: deps.serverHeader,
        ...(record && deps.onExchange ? { onProxied: deps.onExchange } : {}),
      });
    } catch (err) {
      if (err instanceof MockStartError) throw new HandlerError(err.code, err.message);
      throw new HandlerError(ErrorCodes.invalidParams, err instanceof Error ? err.message : String(err));
    }
    current.on("request", deps.onRequest);
    if (deps.onCallback) current.on("callback", deps.onCallback);
    if (deps.onMessage) current.on("message", deps.onMessage);
    return current;
  }

  return {
    get current() {
      return current;
    },
    "system.ping": (params): HostResult<"system.ping"> => {
      const { sentAt } = params as HostParams<"system.ping">;
      return { sentAt, hostTime: Date.now(), pid: process.pid, uptimeMs: Math.round(performance.now() - startedAt) };
    },
    "system.info": (): HostResult<"system.info"> => ({
      node: process.versions.node,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
    }),
    "mock.start": async (params): Promise<HostResult<"mock.start">> => {
      if (current) throw new HandlerError(ErrorCodes.alreadyRunning, `Mock "${current.name}" is already running`);
      const { definition, record } = params as HostParams<"mock.start">;
      const mock = await start(definition, record === true);
      return describe(mock);
    },
    "mock.update": async (params): Promise<HostResult<"mock.update">> => {
      if (!current) throw new HandlerError(ErrorCodes.hostUnavailable, "No mock is running in this host");
      const { definition } = params as HostParams<"mock.update">;
      let result;
      try {
        result = current.update(definition);
      } catch (err) {
        throw new HandlerError(ErrorCodes.invalidParams, err instanceof Error ? err.message : String(err));
      }
      if (result.applied) return { mode: "updated", ...describe(current) };
      // Port, host or TLS changed: restart the listener with the new version.
      const old = current;
      current = null;
      await old.stop();
      return { mode: "restarted", ...describe(await start(definition)) };
    },
    "mock.stop": async (): Promise<HostResult<"mock.stop">> => {
      if (!current) return { stopped: false };
      const mock = current;
      current = null;
      await mock.stop();
      return { stopped: true };
    },
    "mock.contract": (params): HostResult<"mock.contract"> => {
      if (!current) throw new HandlerError(ErrorCodes.hostUnavailable, "No mock is running in this host");
      if ((params as HostParams<"mock.contract">).clear) current.clearContract();
      return current.contract();
    },
    "mock.scenarios": (): HostResult<"mock.scenarios"> => {
      if (!current) throw new HandlerError(ErrorCodes.hostUnavailable, "No mock is running in this host");
      return { now: Date.now(), views: current.scenarios(), recent: current.scenarioEvents(50) };
    },
    "mock.scenarioSet": (params): HostResult<"mock.scenarioSet"> => {
      if (!current) throw new HandlerError(ErrorCodes.hostUnavailable, "No mock is running in this host");
      const { id, key, state } = params as HostParams<"mock.scenarioSet">;
      try {
        return current.setScenario(id, key, state);
      } catch (err) {
        throw new HandlerError(ErrorCodes.invalidParams, err instanceof Error ? err.message : String(err));
      }
    },
    "mock.scenarioReset": (params): HostResult<"mock.scenarioReset"> => {
      if (!current) throw new HandlerError(ErrorCodes.hostUnavailable, "No mock is running in this host");
      current.resetScenarios((params as HostParams<"mock.scenarioReset">).id);
      return { reset: true };
    },
    "mock.chaos": (): HostResult<"mock.chaos"> => {
      if (!current) throw new HandlerError(ErrorCodes.hostUnavailable, "No mock is running in this host");
      return current.chaos();
    },
    "mock.chaosSet": (params): HostResult<"mock.chaosSet"> => {
      if (!current) throw new HandlerError(ErrorCodes.hostUnavailable, "No mock is running in this host");
      const { profile, reset } = params as HostParams<"mock.chaosSet">;
      try {
        current.setChaos(reset ? undefined : (profile ?? null));
      } catch (err) {
        throw new HandlerError(ErrorCodes.invalidParams, err instanceof Error ? err.message : String(err));
      }
      return { done: true };
    },
    "mock.chaosControl": (params): HostResult<"mock.chaosControl"> => {
      if (!current) throw new HandlerError(ErrorCodes.hostUnavailable, "No mock is running in this host");
      const { action } = params as HostParams<"mock.chaosControl">;
      if (action === "restart") current.restartChaos();
      else current.pauseChaos(action === "pause");
      return { done: true };
    },
    "diagnostics.crash": (params): HostResult<"diagnostics.crash"> => {
      const { exitCode } = params as HostParams<"diagnostics.crash">;
      // Exit after the result has been posted back.
      setTimeout(() => deps.exit(exitCode), 50);
      return { scheduled: true };
    },
  };
}
