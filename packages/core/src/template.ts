/**
 * Response templates: Handlebars with a fixed set of helpers written for Mockix.
 * Helper names follow common mock-tool conventions where that helps imported
 * workspaces work (the names are an interface, not code).
 *
 * Safety: only the helpers below exist (knownHelpersOnly), no prototype access,
 * no partials, and limits on loop iterations and output size.
 */
import Handlebars from "handlebars";
import { Faker, base, en, es, es_MX } from "@faker-js/faker";
import { BucketStore } from "./buckets.js";
import { seededRandom } from "./random.js";
import type { RequestContext } from "./rules.js";

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export interface TemplateDeps {
  faker: Faker;
  random: () => number;
  now: () => number;
  buckets: BucketStore;
  /** Mock and workspace variables (mutable through the control API). */
  vars: Map<string, string>;
  /** Allow-listed environment variables, resolved at load time. */
  env: Readonly<Record<string, string>>;
}

const MAX_ITERATIONS = 100_000;
const MAX_REPEAT = 1_000;
const MAX_OUTPUT = 10 * 1024 * 1024;

interface RenderState {
  ctx: RequestContext;
  local: Map<string, unknown>;
  iterations: number;
}

type HelperOptions = Handlebars.HelperOptions & { data: { root: { __state: RenderState } } };

const isOptions = (v: unknown): v is HelperOptions => typeof v === "object" && v !== null && "hash" in v && "data" in v;
/** Positional args of a helper call (Handlebars appends the options object). */
const argsOf = (args: unknown[]): unknown[] => (isOptions(args.at(-1)) ? args.slice(0, -1) : args);
const optionsOf = (args: unknown[]): HelperOptions => args.at(-1) as HelperOptions;
const stateOf = (args: unknown[]): RenderState => optionsOf(args).data.root.__state;

/** An array that prints as JSON, so {{body 'lineas'}} renders JSON yet (len …) and #each still see a list. */
class JsonArray extends Array<unknown> {
  override toString(): string {
    return JSON.stringify([...this]);
  }
}

/**
 * Helper results: objects and arrays print as JSON when output directly, but
 * stay real values inside subexpressions ({{len (body 'lineas')}}).
 */
function out(value: unknown): unknown {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return JsonArray.from(value);
  if (typeof value === "object") {
    const copy = { ...(value as Record<string, unknown>) };
    Object.defineProperty(copy, "toString", { value: () => JSON.stringify(value), enumerable: false });
    return copy;
  }
  return value;
}

/** "items.0.sku" or "items[0].sku" → value */
export function getPath(value: unknown, path: string | undefined): unknown {
  if (path === undefined || path === "") return value;
  let cur = value;
  for (const key of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function base64UrlDecode(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function addOffset(epoch: number, add: unknown): number {
  const m = typeof add === "string" ? /^(-?\d+)\s*(s|m|h|d)$/.exec(add.trim()) : null;
  if (!m) return epoch;
  const unit = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] as "s" | "m" | "h" | "d"];
  return epoch + Number(m[1]) * unit;
}

function formatDate(epoch: number, format: unknown): string | number {
  const d = new Date(epoch);
  switch (format) {
    case "unix":
      return Math.floor(epoch / 1000);
    case "ms":
      return epoch;
    case "date":
      return d.toISOString().slice(0, 10);
    case "time":
      return d.toISOString().slice(11, 19);
    default:
      return d.toISOString();
  }
}

/**
 * JSON templates often end a mustache right before a closing brace:
 * `{"n": {{int 1 9}}}`. Handlebars would read that "}}}" as the end of a
 * triple-stash and fail. Rewrite it as "}}{{!}}}": the empty comment renders
 * nothing, so the output is the same. Real triple-stashes stay untouched.
 */
export function fixTripleClose(src: string): string {
  if (!src.includes("}}}")) return src;
  let out = "";
  let i = 0;
  let open: 2 | 3 | null = null;
  while (i < src.length) {
    if (open === null && src.startsWith("{{", i)) {
      const long = src.startsWith("{{!--", i);
      if (long || src.startsWith("{{!", i)) {
        const end = src.indexOf(long ? "--}}" : "}}", i);
        const stop = end === -1 ? src.length : end + (long ? 4 : 2);
        out += src.slice(i, stop);
        i = stop;
        continue;
      }
      open = src.startsWith("{{{", i) ? 3 : 2;
      out += open === 3 ? "{{{" : "{{";
      i += open;
      continue;
    }
    if (open !== null && src.startsWith("}}", i)) {
      if (src.startsWith("}}}", i)) {
        out += open === 3 ? "}}}" : "}}{{!}}";
        i += open === 3 ? 3 : 2;
      } else {
        out += "}}";
        i += 2;
      }
      open = null;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

export class TemplateEngine {
  readonly #hb = Handlebars.create();
  readonly #cache = new Map<string, HandlebarsTemplateDelegate>();
  readonly #known: Record<string, boolean> = {};
  readonly #deps: TemplateDeps;

  constructor(deps: TemplateDeps) {
    this.#deps = deps;
    this.#register();
  }

  #helper(name: string, fn: Handlebars.HelperDelegate): void {
    this.#hb.registerHelper(name, fn);
    this.#known[name] = true;
  }

  #register(): void {
    const d = this.#deps;
    const ctx = (args: unknown[]) => stateOf(args).ctx;

    // Request
    this.#helper("urlParam", (...a) => out(ctx(a).params[String(argsOf(a)[0])]));
    this.#helper("queryParam", (...a) => {
      const [name, fallback] = argsOf(a);
      return out(ctx(a).query[String(name)] ?? fallback);
    });
    this.#helper("header", (...a) => {
      const [name, fallback] = argsOf(a);
      const v = ctx(a).headers[String(name).toLowerCase()];
      return out((Array.isArray(v) ? v.join(", ") : v) ?? fallback);
    });
    this.#helper("cookie", (...a) => {
      const [name, fallback] = argsOf(a);
      return out(ctx(a).cookies[String(name)] ?? fallback);
    });
    this.#helper("body", (...a) => {
      const [path, fallback] = argsOf(a);
      const v = getPath(ctx(a).body.parsed, path === undefined ? undefined : String(path));
      return out(v === undefined ? fallback : v);
    });
    this.#helper("bodyRaw", (...a) => ctx(a).body.raw);
    this.#helper("method", (...a) => ctx(a).method);
    this.#helper("path", (...a) => ctx(a).path);

    // Variables
    this.#helper("setVar", (...a) => {
      const [name, value] = argsOf(a);
      stateOf(a).local.set(String(name), value);
      return "";
    });
    this.#helper("getVar", (...a) => {
      const name = String(argsOf(a)[0]);
      const local = stateOf(a).local;
      return out(local.has(name) ? local.get(name) : d.vars.get(name));
    });
    this.#helper("envVar", (...a) => {
      const [name, fallback] = argsOf(a);
      return out(d.env[String(name)] ?? fallback);
    });

    // Data buckets
    this.#helper("data", (...a) => {
      const [bucket, path] = argsOf(a);
      return out(getPath(d.buckets.get(String(bucket)), path === undefined ? undefined : String(path)));
    });
    this.#helper("dataRaw", (...a) => {
      const [bucket, path] = argsOf(a);
      return getPath(d.buckets.get(String(bucket)), path === undefined ? undefined : String(path));
    });
    this.#helper("dataFind", (...a) => {
      const [bucket, key, value, path] = argsOf(a);
      const list = d.buckets.get(String(bucket));
      const item = Array.isArray(list) ? list.find((x) => x && typeof x === "object" && String((x as Record<string, unknown>)[String(key)]) === String(value)) : undefined;
      return out(getPath(item, path === undefined ? undefined : String(path)));
    });

    // Generated data
    this.#helper("faker", (...a) => {
      const [path, ...rest] = argsOf(a);
      const hash = optionsOf(a).hash as Record<string, unknown>;
      const m = typeof path === "string" ? /^([a-zA-Z]+)\.([a-zA-Z]+)$/.exec(path) : null;
      const mod = m ? (d.faker as unknown as Record<string, unknown>)[m[1]!] : undefined;
      // Module methods only: nothing inherited from Object, nothing private.
      const name = m?.[2];
      const fn = name && mod && typeof mod === "object" && !(name in Object.prototype) && !name.startsWith("_") ? (mod as Record<string, unknown>)[name] : undefined;
      if (typeof fn !== "function") throw new TemplateError(`faker: "${String(path)}" no existe`);
      const result = Object.keys(hash).length ? fn.call(mod, hash) : fn.apply(mod, rest);
      return out(result);
    });
    this.#helper("uuid", () => d.faker.string.uuid());
    this.#helper("objectId", () => d.faker.database.mongodbObjectId());
    this.#helper("int", (...a) => {
      const [min = 0, max = 100] = argsOf(a).map(Number);
      return Math.floor(min + d.random() * (max - min + 1));
    });
    this.#helper("float", (...a) => {
      const [min = 0, max = 1, decimals = 2] = argsOf(a).map(Number);
      return Number((min + d.random() * (max - min)).toFixed(decimals));
    });
    this.#helper("boolean", () => d.random() < 0.5);
    this.#helper("oneOf", (...a) => {
      const args = argsOf(a);
      const list = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
      return out(list[Math.floor(d.random() * list.length)]);
    });
    this.#helper("array", (...a) => argsOf(a));
    this.#helper("now", (...a) => {
      const [format] = argsOf(a);
      return formatDate(addOffset(d.now(), optionsOf(a).hash["add"]), format);
    });

    // Logic (also as subexpressions: {{#if (eq a b)}})
    this.#helper("eq", (...a) => {
      const [x, y] = argsOf(a);
      return String(x) === String(y);
    });
    this.#helper("neq", (...a) => {
      const [x, y] = argsOf(a);
      return String(x) !== String(y);
    });
    for (const [name, cmp] of [
      ["gt", (x: number, y: number) => x > y],
      ["gte", (x: number, y: number) => x >= y],
      ["lt", (x: number, y: number) => x < y],
      ["lte", (x: number, y: number) => x <= y],
    ] as const) {
      this.#helper(name, (...a) => {
        const [x, y] = argsOf(a).map(Number);
        return cmp(x!, y!);
      });
    }
    this.#helper("and", (...a) => argsOf(a).every(Boolean));
    this.#helper("or", (...a) => argsOf(a).some(Boolean));
    this.#helper("not", (...a) => !argsOf(a)[0]);
    this.#helper("includes", (...a) => {
      const [hay, needle] = argsOf(a);
      return Array.isArray(hay) ? hay.map(String).includes(String(needle)) : String(hay ?? "").includes(String(needle));
    });
    this.#helper("default", (...a) => {
      const [value, fallback] = argsOf(a);
      return out(value === undefined || value === null || value === "" ? fallback : value);
    });

    // Strings and values
    this.#helper("lowercase", (...a) => String(argsOf(a)[0] ?? "").toLowerCase());
    this.#helper("uppercase", (...a) => String(argsOf(a)[0] ?? "").toUpperCase());
    this.#helper("concat", (...a) => argsOf(a).map((x) => String(out(x))).join(""));
    this.#helper("json", (...a) => {
      const [value, indent] = argsOf(a);
      return JSON.stringify(value ?? null, null, typeof indent === "number" ? indent : undefined);
    });
    this.#helper("len", (...a) => {
      const v = argsOf(a)[0];
      return Array.isArray(v) || typeof v === "string" ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0;
    });
    this.#helper("base64", (...a) => Buffer.from(String(argsOf(a)[0] ?? "")).toString("base64"));
    this.#helper("base64Decode", (...a) => Buffer.from(String(argsOf(a)[0] ?? ""), "base64").toString("utf8"));
    this.#helper("jwtPayload", (...a) => {
      const [path] = argsOf(a);
      const auth = ctx(a).headers["authorization"];
      const token = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : "";
      const part = token.split(".")[1];
      if (!part) return "";
      try {
        return out(getPath(JSON.parse(base64UrlDecode(part)), path === undefined ? undefined : String(path)));
      } catch {
        return "";
      }
    });

    // Blocks
    this.#helper("repeat", function (this: unknown, ...a: unknown[]) {
      const options = optionsOf(a);
      const state = stateOf(a);
      const [min, max] = argsOf(a).map(Number);
      let count = max === undefined || Number.isNaN(max) ? min! : Math.floor(min! + d.random() * (max - min! + 1));
      count = Math.max(0, Math.min(Number.isFinite(count) ? count : 0, MAX_REPEAT));
      const sep = options.hash["comma"] === false ? "" : ",";
      const parts: string[] = [];
      for (let i = 0; i < count; i++) {
        if (++state.iterations > MAX_ITERATIONS) throw new TemplateError("demasiadas iteraciones en la plantilla");
        const data = Handlebars.createFrame(options.data);
        Object.assign(data, { index: i, first: i === 0, last: i === count - 1 });
        parts.push(options.fn(this, { data }));
      }
      return parts.join(sep);
    });
    for (const builtin of ["if", "unless", "each", "with", "lookup"]) this.#known[builtin] = true;
  }

  #compile(source: string): HandlebarsTemplateDelegate {
    let tpl = this.#cache.get(source);
    if (!tpl) {
      tpl = this.#hb.compile(fixTripleClose(source), { noEscape: true, strict: false, knownHelpers: this.#known, knownHelpersOnly: true, data: true });
      if (this.#cache.size > 500) this.#cache.delete(this.#cache.keys().next().value!);
      this.#cache.set(source, tpl);
    }
    return tpl;
  }

  /** Throws a TemplateError describing the first syntax problem or unknown helper. */
  check(source: string): void {
    if (!source.includes("{{")) return;
    try {
      this.#hb.precompile(fixTripleClose(source), { knownHelpers: this.#known, knownHelpersOnly: true, data: true });
    } catch (err) {
      throw new TemplateError((err instanceof Error ? err.message : String(err)).split("\n").slice(0, 2).join(" "));
    }
  }

  render(source: string, ctx: RequestContext, local = new Map<string, unknown>()): string {
    if (!source.includes("{{")) return source;
    const state: RenderState = { ctx, local, iterations: 0 };
    const root = {
      __state: state,
      request: { method: ctx.method, path: ctx.path, query: ctx.query, headers: ctx.headers, cookies: ctx.cookies, params: ctx.params, body: ctx.body.parsed },
      params: ctx.params,
      query: ctx.query,
      headers: ctx.headers,
      cookies: ctx.cookies,
      body: ctx.body.parsed,
      state: ctx.state ?? {},
    };
    let result: string;
    try {
      result = this.#compile(source)(root);
    } catch (err) {
      if (err instanceof TemplateError) throw err;
      throw new TemplateError(err instanceof Error ? err.message.split("\n")[0]! : String(err));
    }
    if (result.length > MAX_OUTPUT) throw new TemplateError("la plantilla generó más de 10 MB");
    return result;
  }
}

export interface PreviewData {
  buckets: Record<string, unknown>;
  variables: Record<string, string>;
  env: Record<string, string>;
}

/**
 * Renders a template for the editor's "Vista previa" with a sample request and
 * a fixed seed, so the preview is stable while the user types.
 */
export function previewTemplate(source: string, data: PreviewData, ctx: RequestContext, seed = 1): string {
  const faker = new Faker({ locale: [es_MX, es, en, base] });
  faker.seed(seed);
  const engine = new TemplateEngine({
    faker,
    random: seededRandom(seed),
    now: Date.now,
    buckets: new BucketStore(data.buckets),
    vars: new Map(Object.entries(data.variables)),
    env: data.env,
  });
  return engine.render(source, ctx);
}

/** Syntax and helper-name check without running anything (the loader reports problems at load time). */
let checker: TemplateEngine | null = null;
export function checkTemplate(source: string): void {
  // check() only compiles; the helpers (and so their dependencies) never run.
  checker ??= new TemplateEngine({} as TemplateDeps);
  checker.check(source);
}
