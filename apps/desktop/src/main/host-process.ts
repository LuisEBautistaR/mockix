import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from "electron";
import { ErrorCodes, PROTOCOL_VERSION, fromHostSchema, type EventEnvelope, type Handshake, type Outcome, type ToHost } from "@shared/rpc";
import { hostMethods, type HostMethod, type HostParams, type HostResult } from "@shared/host-methods";

export type HostState = "starting" | "ready" | "restarting" | "failed" | "stopped";

export interface HostStatus {
  state: HostState;
  pid: number | null;
  /** How many times this host has been restarted after a crash. */
  restarts: number;
  lastExit: { code: number; at: number } | null;
}

export interface HostProcessOptions {
  entry: string;
  /** Shown in the OS task manager. */
  serviceName: string;
  testMode: boolean;
  log: (message: string, detail?: unknown) => void;
}

interface Pending {
  method: HostMethod;
  resolve: (outcome: Outcome<unknown>) => void;
  timer: NodeJS.Timeout;
}

const READY_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;
/** More crashes than this within the window marks the host as failed instead of restarting forever. */
const CRASH_BUDGET = 5;
const CRASH_WINDOW_MS = 60_000;

type Events = { status: [HostStatus]; ready: []; event: [EventEnvelope] };

/**
 * Owns one host utilityProcess: starts it, restarts it with backoff when it
 * dies, and turns calls into envelopes over a MessagePort.
 */
export class HostProcess extends EventEmitter<Events> {
  readonly #opts: HostProcessOptions;
  #child: UtilityProcess | null = null;
  #port: MessagePortMain | null = null;
  #pending = new Map<string, Pending>();
  #readyWaiters: Array<() => void> = [];
  #readyTimer: NodeJS.Timeout | null = null;
  #restartTimer: NodeJS.Timeout | null = null;
  #crashes: number[] = [];
  #stopping = false;
  #status: HostStatus = { state: "stopped", pid: null, restarts: 0, lastExit: null };

  constructor(opts: HostProcessOptions) {
    super();
    this.#opts = opts;
  }

  get status(): HostStatus {
    return { ...this.#status };
  }

  start(): void {
    this.#stopping = false;
    this.#spawn();
  }

  #setStatus(patch: Partial<HostStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.emit("status", this.status);
  }

  #spawn(): void {
    const { entry, serviceName, testMode, log } = this.#opts;
    this.#setStatus({ state: this.#status.restarts > 0 ? "restarting" : "starting", pid: null });

    const child = utilityProcess.fork(entry, [], { serviceName, stdio: "pipe" });
    this.#child = child;
    child.stdout?.on("data", (chunk: Buffer) => log(chunk.toString().trimEnd()));
    child.stderr?.on("data", (chunk: Buffer) => log(chunk.toString().trimEnd()));

    const { port1, port2 } = new MessageChannelMain();
    this.#port = port1;
    port1.on("message", ({ data }) => this.#onMessage(data));
    port1.start();
    const handshake: Handshake = { type: "connect", protocol: PROTOCOL_VERSION, testMode };
    child.postMessage(handshake, [port2]);

    child.once("exit", (code) => this.#onExit(child, code));
    this.#readyTimer = setTimeout(() => {
      log(`Host did not become ready within ${READY_TIMEOUT_MS} ms; killing it`);
      child.kill();
    }, READY_TIMEOUT_MS);
  }

  #onMessage(raw: unknown): void {
    const parsed = fromHostSchema.safeParse(raw);
    if (!parsed.success) {
      this.#opts.log("Dropped an invalid message from the host", parsed.error.issues);
      return;
    }
    const message = parsed.data;
    if (message.kind === "event") {
      if (message.stream === "host" && message.name === "ready") this.#onReady();
      else this.emit("event", message);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (!message.ok) {
      pending.resolve({ ok: false, error: message.error });
      return;
    }
    // Main re-validates results: a compromised or buggy host cannot hand the UI arbitrary shapes.
    const result = hostMethods[pending.method].result.safeParse(message.value);
    pending.resolve(
      result.success
        ? { ok: true, value: result.data }
        : { ok: false, error: { code: ErrorCodes.invalidResult, message: `Invalid result from ${pending.method}` } },
    );
  }

  #onReady(): void {
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
    this.#setStatus({ state: "ready", pid: this.#child?.pid ?? null });
    for (const wake of this.#readyWaiters.splice(0)) wake();
    this.emit("ready");
  }

  #onExit(child: UtilityProcess, code: number): void {
    if (child !== this.#child) return;
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
    this.#port?.close();
    this.#port = null;
    this.#child = null;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: { code: ErrorCodes.hostExited, message: "The mock host stopped before answering" } });
      this.#pending.delete(id);
    }

    const now = Date.now();
    this.#status.lastExit = { code, at: now };
    if (this.#stopping) {
      this.#setStatus({ state: "stopped", pid: null });
      return;
    }

    this.#opts.log(`Host exited with code ${code}`);
    this.#crashes = [...this.#crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (this.#crashes.length > CRASH_BUDGET) {
      this.#setStatus({ state: "failed", pid: null });
      for (const wake of this.#readyWaiters.splice(0)) wake();
      return;
    }
    const delay = Math.min(250 * 2 ** (this.#crashes.length - 1), 5_000);
    this.#setStatus({ state: "restarting", pid: null, restarts: this.#status.restarts + 1 });
    this.#restartTimer = setTimeout(() => this.#spawn(), delay);
  }

  #whenReady(timeoutMs: number): Promise<boolean> {
    if (this.#status.state === "ready") return Promise.resolve(true);
    if (this.#status.state === "failed" || this.#stopping) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.#readyWaiters.push(() => {
        clearTimeout(timer);
        resolve(this.#status.state === "ready");
      });
    });
  }

  /** Params must already be valid for the method. Never throws. */
  async call<M extends HostMethod>(method: M, params: HostParams<M>, timeoutMs = CALL_TIMEOUT_MS): Promise<Outcome<HostResult<M>>> {
    if (!(await this.#whenReady(READY_TIMEOUT_MS)) || !this.#port) {
      return { ok: false, error: { code: ErrorCodes.hostUnavailable, message: `The mock host is ${this.#status.state}` } };
    }
    const port = this.#port;
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        port.postMessage({ kind: "cancel", id } satisfies ToHost);
        resolve({ ok: false, error: { code: ErrorCodes.timeout, message: `${method} timed out after ${timeoutMs} ms` } });
      }, timeoutMs);
      this.#pending.set(id, { method, resolve: resolve as Pending["resolve"], timer });
      port.postMessage({ kind: "call", id, method, params } satisfies ToHost);
    });
  }

  /** Stops the process; resolves once it has exited. */
  stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const child = this.#child;
    if (!child) {
      this.#setStatus({ state: "stopped", pid: null });
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
    });
  }
}
