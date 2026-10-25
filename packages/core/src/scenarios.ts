/**
 * Stateful scenarios: declarative state machines, one instance per key
 * (params.id → one per order). Requests move instances along transitions
 * whose trigger they match; timed transitions advance on their own.
 *
 * Time is evaluated lazily (an instance catches up whenever it is read), so
 * results depend only on the clock, never on when a timer happened to fire.
 */
import { compilePath, type PathMatcher } from "./path.js";
import { readTarget, testRules, type RequestContext } from "./rules.js";
import type { RuntimeScenario } from "./runtime.js";

export type ScenarioTrigger =
  | { kind: "start" }
  | { kind: "request"; method: string; url: string; seq: number | null; status: number | null }
  | { kind: "timer"; afterMs: number }
  | { kind: "manual" };

export interface ScenarioEvent {
  at: number;
  scenario: string;
  key: string;
  from: string | null;
  to: string;
  trigger: ScenarioTrigger;
}

export interface ScenarioInstanceView {
  key: string;
  state: string;
  since: number;
  /** Next timed transition, if the state has one. */
  next: { to: string; at: number } | null;
  /** Requests that would move it now ("POST /pedidos/:id/pago"). */
  waiting: string[];
  final: boolean;
  history: ScenarioEvent[];
}

export interface ScenarioView {
  id: string;
  file: string;
  key: string | null;
  initial: string;
  states: string[];
  transitions: Array<{ from: string[]; to: string; on: { method: string; path: string } | null; afterMs: number | null; fired: number }>;
  /** Instances in each state right now. */
  counts: Record<string, number>;
  instances: ScenarioInstanceView[];
}

interface Instance {
  key: string;
  state: string;
  since: number;
  history: ScenarioEvent[];
}

interface Compiled {
  def: RuntimeScenario;
  matchers: Array<PathMatcher | null>;
  fired: number[];
  instances: Map<string, Instance>;
}

const HISTORY_KEEP = 20;
const INSTANCES_KEEP = 1000;
const EVENTS_KEEP = 100;

export class ScenarioEngine {
  #list: Compiled[] = [];
  #recent: ScenarioEvent[] = [];
  readonly #now: () => number;
  readonly #emit: (event: ScenarioEvent) => void;

  constructor(scenarios: RuntimeScenario[], now: () => number, emit: (event: ScenarioEvent) => void = () => {}) {
    this.#now = now;
    this.#emit = emit;
    this.update(scenarios);
  }

  get size(): number {
    return this.#list.length;
  }

  get hasTimers(): boolean {
    return this.#list.some((s) => s.def.transitions.some((t) => t.afterMs !== null));
  }

  /** New definitions; instances survive when their scenario still has their state. */
  update(scenarios: RuntimeScenario[]): void {
    const old = new Map(this.#list.map((s) => [s.def.id, s]));
    this.#list = scenarios.map((def) => {
      const prev = old.get(def.id);
      const instances = new Map<string, Instance>();
      if (prev) for (const [k, inst] of prev.instances) if (def.states.includes(inst.state)) instances.set(k, inst);
      const sameTransitions = prev && JSON.stringify(prev.def.transitions) === JSON.stringify(def.transitions);
      return {
        def,
        matchers: def.transitions.map((t) => (t.on ? compilePath(t.on.path) : null)),
        fired: sameTransitions ? prev.fired : def.transitions.map(() => 0),
        instances,
      };
    });
  }

  #record(inst: Instance, event: ScenarioEvent): void {
    inst.history.push(event);
    if (inst.history.length > HISTORY_KEEP) inst.history.shift();
    this.#recent.unshift(event);
    if (this.#recent.length > EVENTS_KEEP) this.#recent.length = EVENTS_KEEP;
    if (event.trigger.kind !== "request") this.#emit(event);
  }

  #touch(s: Compiled, key: string): Instance {
    let inst = s.instances.get(key);
    if (!inst) {
      const at = this.#now();
      inst = { key, state: s.def.initial, since: at, history: [] };
      if (s.instances.size >= INSTANCES_KEEP) {
        const oldest = [...s.instances.values()].sort((a, b) => a.since - b.since)[0]!;
        s.instances.delete(oldest.key);
      }
      s.instances.set(key, inst);
      this.#record(inst, { at, scenario: s.def.id, key, from: null, to: s.def.initial, trigger: { kind: "start" } });
    }
    this.#advance(s, inst);
    return inst;
  }

  /** Applies the timed transitions that are due, in order. */
  #advance(s: Compiled, inst: Instance): void {
    const now = this.#now();
    for (let guard = 0; guard < 100; guard++) {
      const i = s.def.transitions.findIndex((t) => t.afterMs !== null && t.from.includes(inst.state));
      if (i === -1) return;
      const t = s.def.transitions[i]!;
      const due = inst.since + t.afterMs!;
      if (due > now) return;
      const from = inst.state;
      inst.state = t.to;
      inst.since = due;
      s.fired[i]!++;
      this.#record(inst, { at: due, scenario: s.def.id, key: inst.key, from, to: t.to, trigger: { kind: "timer", afterMs: t.afterMs! } });
    }
  }

  #keyOf(s: Compiled, ctx: RequestContext): string | undefined {
    if (s.def.key === null) return "";
    const v = readTarget(ctx, s.def.key);
    if (v === undefined || v === null || v === "") return undefined;
    return Array.isArray(v) ? String(v[0]) : typeof v === "object" ? JSON.stringify(v) : String(v);
  }

  /**
   * Moves the instances this request triggers (at most one transition per
   * scenario). `base` is the request without route params: each trigger
   * matches its own path. Returns the events so the caller can fill in seq
   * and status once the response is out.
   */
  onRequest(base: Omit<RequestContext, "params" | "requestNumber">, url: string): ScenarioEvent[] {
    const events: ScenarioEvent[] = [];
    for (const s of this.#list) {
      for (const [i, t] of s.def.transitions.entries()) {
        if (!t.on) continue;
        if (t.on.method !== "ANY" && t.on.method !== base.method) continue;
        const params = s.matchers[i]!(base.path);
        if (!params) continue;
        const ctx: RequestContext = { ...base, params, requestNumber: 0 };
        if (t.on.rules.length && !testRules({ mode: "all", when: t.on.rules }, ctx)) continue;
        const key = this.#keyOf(s, ctx);
        if (key === undefined) continue;
        const inst = this.#touch(s, key);
        if (!t.from.includes(inst.state)) continue;
        const from = inst.state;
        const at = this.#now();
        inst.state = t.to;
        inst.since = at;
        s.fired[i]!++;
        const event: ScenarioEvent = { at, scenario: s.def.id, key, from, to: t.to, trigger: { kind: "request", method: base.method, url, seq: null, status: null } };
        this.#record(inst, event);
        events.push(event);
        break;
      }
    }
    return events;
  }

  /** Request-triggered events reach listeners here, once seq and status are known. */
  announce(events: ScenarioEvent[]): void {
    for (const e of events) this.#emit(e);
  }

  /** state.<id> for this request: its instance's current state, or undefined when the key is missing. */
  read(id: string, ctx: RequestContext): string | undefined {
    const s = this.#list.find((x) => x.def.id === id);
    if (!s) return undefined;
    const key = this.#keyOf(s, ctx);
    return key === undefined ? undefined : this.#touch(s, key).state;
  }

  /** A lazy `state` object for rules and templates: each scenario is read only if used. */
  view(ctx: RequestContext): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const s of this.#list) {
      let cached: { v: string | undefined } | null = null;
      Object.defineProperty(out, s.def.id, {
        enumerable: true,
        get: () => (cached ??= { v: this.read(s.def.id, ctx) }).v,
      });
    }
    return out;
  }

  /** Catches every instance up with the clock (timer events reach listeners on time). */
  tick(): void {
    for (const s of this.#list) for (const inst of s.instances.values()) this.#advance(s, inst);
  }

  snapshot(): ScenarioView[] {
    const now = this.#now();
    this.tick();
    return this.#list.map((s) => {
      const counts = Object.fromEntries(s.def.states.map((st) => [st, 0]));
      const instances = [...s.instances.values()]
        .sort((a, b) => b.since - a.since)
        .map((inst): ScenarioInstanceView => {
          counts[inst.state] = (counts[inst.state] ?? 0) + 1;
          const out = s.def.transitions.filter((t) => t.from.includes(inst.state));
          const timed = out.find((t) => t.afterMs !== null);
          return {
            key: inst.key,
            state: inst.state,
            since: inst.since,
            next: timed ? { to: timed.to, at: Math.max(now, inst.since + timed.afterMs!) } : null,
            waiting: out.filter((t) => t.on).map((t) => `${t.on!.method === "ANY" ? "" : `${t.on!.method} `}${t.on!.path}`),
            final: out.length === 0,
            history: structuredClone(inst.history),
          };
        });
      return {
        id: s.def.id,
        file: s.def.file,
        key: s.def.key,
        initial: s.def.initial,
        states: [...s.def.states],
        transitions: s.def.transitions.map((t, i) => ({ from: [...t.from], to: t.to, on: t.on ? { method: t.on.method, path: t.on.path } : null, afterMs: t.afterMs, fired: s.fired[i]! })),
        counts,
        instances,
      };
    });
  }

  recent(limit = EVENTS_KEEP): ScenarioEvent[] {
    return structuredClone(this.#recent.slice(0, limit));
  }

  /** Forces an instance into a state (created if needed). */
  set(id: string, key: string, state: string): ScenarioEvent {
    const s = this.#list.find((x) => x.def.id === id);
    if (!s) throw new Error(`No existe el escenario "${id}"`);
    if (!s.def.states.includes(state)) throw new Error(`"${state}" no es un estado de ${id} (${s.def.states.join(", ")})`);
    const inst = this.#touch(s, s.def.key === null ? "" : key);
    const event: ScenarioEvent = { at: this.#now(), scenario: id, key: inst.key, from: inst.state, to: state, trigger: { kind: "manual" } };
    inst.state = state;
    inst.since = event.at;
    this.#record(inst, event);
    return event;
  }

  /** Drops the instances of one scenario (or all): they start again from the initial state. */
  reset(id?: string): void {
    for (const s of this.#list) {
      if (id && s.def.id !== id) continue;
      s.instances.clear();
      s.fired = s.def.transitions.map(() => 0);
    }
    if (!id) this.#recent = [];
    else this.#recent = this.#recent.filter((e) => e.scenario !== id);
  }
}
