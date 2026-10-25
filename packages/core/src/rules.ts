import type { IncomingHttpHeaders } from "node:http";
import type { RuntimeRule } from "./runtime.js";

/** Everything a rule (and, from M2, a template) can read about a request. */
export interface RequestContext {
  method: string;
  /** Path after the mock prefix, without the query. */
  path: string;
  query: Record<string, string | string[]>;
  headers: IncomingHttpHeaders;
  cookies: Record<string, string>;
  params: Record<string, string>;
  body: { raw: string; parsed: unknown };
  /** 1-based count of requests that matched this route since the mock started. */
  requestNumber: number;
  /** Current state of each scenario's instance for this request (read lazily). */
  state?: Record<string, string | undefined>;
}

/** body.items[0].sku → ["items", 0, "sku"] */
function bodyPath(target: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const m of target.slice(4).matchAll(/\.([^.[\]]+)|\[(\d+)\]/g)) out.push(m[1] ?? Number(m[2]));
  return out;
}

export function readTarget(ctx: RequestContext, target: string): unknown {
  if (target === "method") return ctx.method;
  if (target === "path") return ctx.path;
  if (target === "request.number") return ctx.requestNumber;
  if (target === "body") return ctx.body.raw;
  if (target.startsWith("body")) {
    let value: unknown = ctx.body.parsed;
    for (const key of bodyPath(target)) {
      if (value === null || typeof value !== "object") return undefined;
      value = (value as Record<string | number, unknown>)[key];
    }
    return value;
  }
  const dot = target.indexOf(".");
  const scope = target.slice(0, dot);
  const name = target.slice(dot + 1);
  switch (scope) {
    case "query":
      return ctx.query[name];
    case "header": {
      const v = ctx.headers[name.toLowerCase()];
      return Array.isArray(v) ? v.join(", ") : v;
    }
    case "cookie":
      return ctx.cookies[name];
    case "params":
      return ctx.params[name];
    case "state":
      return ctx.state?.[name];
    default:
      return undefined;
  }
}

function same(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === undefined || actual === null) return false;
  if (typeof actual === "object" || typeof expected === "object") return JSON.stringify(actual) === JSON.stringify(expected);
  return String(actual) === String(expected);
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

export function testRule(rule: RuntimeRule, ctx: RequestContext): boolean {
  const actual = readTarget(ctx, rule.target);
  let result: boolean;
  switch (rule.op) {
    case "equals":
      result = Array.isArray(actual) && !Array.isArray(rule.value) ? actual.some((a) => same(a, rule.value)) : same(actual, rule.value);
      break;
    case "regex":
      result = (typeof actual === "string" || typeof actual === "number") && new RegExp(String(rule.value)).test(String(actual));
      break;
    case "exists":
      result = actual !== undefined;
      break;
    case "empty":
      result = isEmpty(actual);
      break;
    case "null":
      result = actual === null;
      break;
    case "contains":
      if (Array.isArray(actual)) result = actual.some((a) => same(a, rule.value));
      else if (typeof actual === "string") result = actual.includes(String(rule.value));
      else if (actual && typeof actual === "object") result = Object.hasOwn(actual, String(rule.value));
      else result = false;
      break;
    case "in":
      result = Array.isArray(rule.value) && rule.value.some((v) => same(actual, v));
      break;
    default: {
      const a = typeof actual === "number" ? actual : typeof actual === "string" && actual.trim() !== "" ? Number(actual) : Number.NaN;
      const b = Number(rule.value);
      result =
        !Number.isNaN(a) &&
        (rule.op === "gt" ? a > b : rule.op === "gte" ? a >= b : rule.op === "lt" ? a < b : a <= b);
    }
  }
  return rule.negate ? !result : result;
}

export function testRules(rules: { mode: "all" | "any"; when: RuntimeRule[] }, ctx: RequestContext): boolean {
  return rules.mode === "all" ? rules.when.every((r) => testRule(r, ctx)) : rules.when.some((r) => testRule(r, ctx));
}
