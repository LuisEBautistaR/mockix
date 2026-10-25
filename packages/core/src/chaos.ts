/**
 * Chaos profiles: control points over time (latency, jitter, error rate and
 * codes), linearly interpolated, plus effects that apply all along (dropped
 * connections, requests that never get an answer, slow bodies).
 *
 * Every request draws the same five random numbers in the same order whatever
 * happens, so with a seed the sequence of effects repeats run after run.
 */
import type { RuntimeChaosProfile } from "./runtime.js";

export interface ChaosLevel {
  latencyMs: number;
  jitterMs: number;
  errorRate: number;
  errors: Array<{ status: number; weight: number }>;
}

/** What chaos did to one request. */
export interface ChaosDecision {
  profile: string;
  /** Position in the profile's timeline when the request arrived. */
  tMs: number;
  /** Extra latency (curve plus jitter), already rounded. */
  latencyMs: number;
  /** Status of the injected error, or null. */
  error: number | null;
  /** The connection was cut without an answer. */
  drop: boolean;
  /** The request never got an answer. */
  timeout: boolean;
  /** The body was sent at this speed, or null. */
  trickleKBps: number | null;
}

export const affected = (d: ChaosDecision | null): boolean => !!d && (d.latencyMs > 0 || d.error !== null || d.drop || d.timeout || d.trickleKBps !== null);

/** Where in the timeline `elapsed` falls: modulo the cycle when it loops, held at the end otherwise. */
export function timeIn(profile: RuntimeChaosProfile, elapsedMs: number): number {
  const e = Math.max(0, elapsedMs);
  if (profile.cycleMs <= 0) return 0;
  return profile.loop ? e % profile.cycleMs : Math.min(e, profile.cycleMs);
}

/** The curve at t: values interpolated between the surrounding points, codes from the segment's start. */
export function chaosAt(profile: RuntimeChaosProfile, tMs: number): ChaosLevel {
  const pts = profile.points;
  if (pts.length === 0) return { latencyMs: 0, jitterMs: 0, errorRate: 0, errors: [] };
  if (tMs <= pts[0]!.tMs) return { ...pick(pts[0]!), errors: pts[0]!.errors };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (tMs > b.tMs) continue;
    const k = b.tMs === a.tMs ? 1 : (tMs - a.tMs) / (b.tMs - a.tMs);
    const lerp = (x: number, y: number) => x + (y - x) * k;
    return {
      latencyMs: lerp(a.latencyMs, b.latencyMs),
      jitterMs: lerp(a.jitterMs, b.jitterMs),
      errorRate: lerp(a.errorRate, b.errorRate),
      // At a point, its own codes; inside a segment, those of its start.
      errors: k >= 1 && b.errors.length ? b.errors : a.errors.length ? a.errors : b.errors,
    };
  }
  // Past the last point: a looping profile heads back to the first one.
  const last = pts.at(-1)!;
  if (profile.loop && profile.cycleMs > last.tMs) {
    const first = pts[0]!;
    const k = (tMs - last.tMs) / (profile.cycleMs - last.tMs);
    const lerp = (x: number, y: number) => x + (y - x) * k;
    return { latencyMs: lerp(last.latencyMs, first.latencyMs), jitterMs: lerp(last.jitterMs, first.jitterMs), errorRate: lerp(last.errorRate, first.errorRate), errors: last.errors.length ? last.errors : first.errors };
  }
  return { ...pick(last), errors: last.errors };
}

const pick = (p: RuntimeChaosProfile["points"][number]) => ({ latencyMs: p.latencyMs, jitterMs: p.jitterMs, errorRate: p.errorRate });

function weighted(errors: ChaosLevel["errors"], r: number): number {
  const list = errors.length ? errors : [{ status: 500, weight: 1 }];
  const total = list.reduce((n, e) => n + e.weight, 0);
  let x = r * total;
  for (const e of list) {
    x -= e.weight;
    if (x < 0) return e.status;
  }
  return list.at(-1)!.status;
}

/** Decides the effects for one request at t. Always draws five numbers. */
export function decide(profile: RuntimeChaosProfile, tMs: number, random: () => number): ChaosDecision {
  const rDrop = random();
  const rTimeout = random();
  const rError = random();
  const rCode = random();
  const rJitter = random();
  const level = chaosAt(profile, tMs);
  const drop = rDrop < profile.extras.dropRate;
  const timeout = !drop && rTimeout < profile.extras.timeoutRate;
  const error = !drop && !timeout && rError < level.errorRate ? weighted(level.errors, rCode) : null;
  const latencyMs = drop || timeout ? 0 : Math.max(0, Math.round(level.latencyMs + (rJitter * 2 - 1) * level.jitterMs));
  return { profile: profile.name, tMs: Math.round(tMs), latencyMs, error, drop, timeout, trickleKBps: drop || timeout ? null : profile.extras.trickleKBps };
}

/* ---------- What the UI and the control API read ---------- */

export interface ChaosEffectRow {
  seq: number;
  at: number;
  method: string;
  url: string;
  routeId: string | null;
  decision: ChaosDecision;
}

export interface ChaosRouteStat {
  routeId: string | null;
  method: string;
  path: string;
  requests: number;
  affected: number;
  /** Mean extra latency of the affected requests. */
  latencyMs: number;
}

export interface ChaosReport {
  /** Profile the mock applies by default right now (after any runtime override), or null. */
  profile: string | null;
  /** The runtime override, if any (undefined in JSON when none). */
  override: string | null | undefined;
  paused: boolean;
  /** Position of the default profile's timeline and its cycle. */
  tMs: number;
  cycleMs: number;
  level: ChaosLevel | null;
  /** Requests and affected ones in the window (last 60 s). */
  requests: number;
  affected: number;
  routes: ChaosRouteStat[];
  recent: ChaosEffectRow[];
}

const WINDOW_MS = 60_000;
const RECENT_KEEP = 100;

/** Requests of the last minute, by route, and the latest effects. */
export class ChaosTracker {
  #window: Array<{ at: number; key: string; routeId: string | null; method: string; path: string; affected: boolean; latencyMs: number }> = [];
  #recent: ChaosEffectRow[] = [];

  record(row: { seq: number; at: number; method: string; url: string; path: string; routeId: string | null; decision: ChaosDecision | null }): void {
    const hit = affected(row.decision);
    this.#window.push({ at: row.at, key: row.routeId ?? `${row.method} ${row.path}`, routeId: row.routeId, method: row.method, path: row.path, affected: hit, latencyMs: row.decision?.latencyMs ?? 0 });
    if (hit) {
      this.#recent.unshift({ seq: row.seq, at: row.at, method: row.method, url: row.url, routeId: row.routeId, decision: row.decision! });
      if (this.#recent.length > RECENT_KEEP) this.#recent.length = RECENT_KEEP;
    }
  }

  stats(now: number): { requests: number; affected: number; routes: ChaosRouteStat[]; recent: ChaosEffectRow[] } {
    this.#window = this.#window.filter((r) => now - r.at <= WINDOW_MS);
    const by = new Map<string, ChaosRouteStat & { sum: number }>();
    for (const r of this.#window) {
      const s = by.get(r.key) ?? { routeId: r.routeId, method: r.method, path: r.path, requests: 0, affected: 0, latencyMs: 0, sum: 0 };
      s.requests++;
      if (r.affected) {
        s.affected++;
        s.sum += r.latencyMs;
      }
      by.set(r.key, s);
    }
    const routes = [...by.values()].map(({ sum, ...s }) => ({ ...s, latencyMs: s.affected ? Math.round(sum / s.affected) : 0 })).sort((a, b) => b.requests - a.requests);
    return { requests: this.#window.length, affected: this.#window.filter((r) => r.affected).length, routes, recent: structuredClone(this.#recent) };
  }

  clear(): void {
    this.#window = [];
    this.#recent = [];
  }
}
