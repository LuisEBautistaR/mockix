/**
 * What an OpenAPI contract says beyond one route per operation, turned into
 * the rest of a mock:
 *
 * - every documented response can be asked for by its status code
 *   (X-Mockix-Respuesta header or ?mockix_respuesta=), so error paths are testable;
 * - a plain resource (list, read by id, create, change, delete) becomes a data
 *   bucket seeded from the contract with one CRUD route;
 * - a status field with fixed values plus actions like POST /pedidos/{id}/pago
 *   becomes a state machine the read route answers from;
 * - the server errors the contract documents feed the chaos profiles.
 *
 * Everything deduced goes to the report so it can be reviewed.
 */
import { stringify } from "yaml";
import type { ResponseDraft } from "../edit.js";
import { previewTemplate } from "../template.js";
import { slugify, type ImportExtras, type ImportReport, type ImportedRoute } from "./model.js";
import { templateFromSchema } from "./schema-template.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Header and query parameter that pick a response by its status code. */
export const PICK_HEADER = "x-mockix-respuesta";
export const PICK_QUERY = "mockix_respuesta";

/** One operation of the contract and the route made from it. */
export interface SourceOperation {
  path: string;
  method: string;
  op: Obj;
  route: ImportedRoute;
  /** Schema and example of a 2xx response (the first documented). */
  success: { schema: unknown; example: unknown; hasExample: boolean } | null;
}

export interface Enriched {
  routes: ImportedRoute[];
  buckets: Record<string, unknown>;
  extraFiles: Record<string, string>;
  serverErrors: number[];
  extras: ImportExtras;
}

/** Every response but the default answers when asked for by its code. */
export function addPicker(responses: ResponseDraft[]): number {
  let n = 0;
  for (const r of responses) {
    if (r.default) continue;
    const code = String(r.status ?? 200);
    r.rules = {
      mode: "any",
      when: [
        { target: `header.${PICK_HEADER}`, op: "equals", value: code },
        { target: `query.${PICK_QUERY}`, op: "equals", value: code },
      ],
    };
    n++;
  }
  return n;
}

const STATUS_FIELD = /^(estado|status|estatus|state|situacion|etapa)$/i;
const CANCEL = /^(cancel|anul|rechaz|baja)/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** A state name the scenario format accepts, from an enum value. */
function stateName(value: string): string {
  return norm(value)
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
}

/** The properties of an object schema. */
function propertiesOf(schema: unknown): { props: Obj } | null {
  return isObj(schema) && isObj(schema["properties"]) ? { props: schema["properties"] } : null;
}

function statusFieldOf(schema: unknown): { field: string; values: string[] } | null {
  const own = propertiesOf(schema);
  if (!own) return null;
  const candidates: Array<[string, unknown]> = Object.entries(own.props);
  // One level down too: many APIs wrap the data ({ resultado: { estado } }).
  for (const value of Object.values(own.props)) {
    const inner = propertiesOf(value);
    if (inner) candidates.push(...Object.entries(inner.props));
  }
  for (const [name, value] of candidates) {
    if (!STATUS_FIELD.test(name) || !isObj(value) || !Array.isArray(value["enum"])) continue;
    const values = value["enum"].filter((v): v is string => typeof v === "string");
    if (values.length >= 2) return { field: name, values };
  }
  return null;
}

/** Template text that prints the original enum value for the current state. */
function stateExpression(id: string, values: string[], names: string[]): string {
  if (values.every((v, i) => v === names[i])) return `{{state.${id}}}`;
  const parts = values.map((v, i) => `${i === 0 ? "{{#if" : "{{else if"} (eq state.${id} '${names[i]}')}}${v.replace(/[{}"\\]/g, "")}`);
  return `${parts.join("")}{{/if}}`;
}

/** Sets the first "field": value of a JSON or template text to the state expression. */
function wireState(text: string, field: string, expression: string): string | null {
  const re = new RegExp(`("${escapeRe(field)}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,\\n\\r}\\]]+)`);
  if (!re.test(text)) return null;
  return text.replace(re, (_m, head: string) => `${head}"${expression}"`);
}

/** Concrete sample objects for a bucket: the contract's examples, or values rendered from the schema. */
function seedItems(list: SourceOperation, itemSchema: unknown, envelope: string | null, key: string, keyType: string): Obj[] | null {
  const ex = list.success?.hasExample ? list.success.example : undefined;
  const fromExample = Array.isArray(ex) ? ex : envelope && isObj(ex) && Array.isArray(ex[envelope]) ? ex[envelope] : null;
  let items: Obj[] = (fromExample ?? []).filter(isObj).slice(0, 5) as Obj[];
  if (!items.length) {
    const template = templateFromSchema(itemSchema);
    for (let seed = 1; seed <= 3; seed++) {
      try {
        const text = previewTemplate(template, { buckets: {}, variables: {}, env: {} }, { method: "GET", path: "/", query: {}, headers: {}, cookies: {}, params: {}, body: { raw: "", parsed: undefined }, requestNumber: seed, state: {} }, seed);
        const value = JSON.parse(text) as unknown;
        if (isObj(value)) items.push(value);
      } catch {
        return null;
      }
    }
  }
  // Keys must be unique for the CRUD route to find each one.
  const seen = new Set<string>();
  items = items.map((item, i) => {
    const k = item[key];
    if (k === undefined || k === null || seen.has(String(k))) return { ...item, [key]: keyType === "integer" || keyType === "number" ? i + 1 : `${key}-${i + 1}` };
    seen.add(String(k));
    return item;
  });
  return items.length ? items : null;
}

interface Resource {
  base: string;
  param: string;
  list?: SourceOperation;
  item?: SourceOperation;
  create?: SourceOperation;
  writes: SourceOperation[];
  remove?: SourceOperation;
  actions: Array<{ name: string; op: SourceOperation }>;
}

const toMockParam = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "_");
const lastLiteral = (base: string) => base.split("/").filter((s) => s && !s.startsWith("{")).pop() ?? "datos";

export function enrichOpenApi(ops: SourceOperation[], routes: ImportedRoute[], report: ImportReport, selectable: number): Enriched {
  const extras: ImportExtras = { selectable, contract: null, crud: [], scenarios: [], chaos: [], notes: [] };
  const buckets: Record<string, unknown> = {};
  const extraFiles: Record<string, string> = {};

  // Server errors documented anywhere: what the chaos profiles answer with.
  const serverErrors = [...new Set(ops.flatMap((o) => Object.keys(isObj(o.op["responses"]) ? o.op["responses"] : {}).filter((c) => /^5\d\d$/.test(c)).map(Number)))].sort();

  const resources = new Map<string, Resource>();
  const resource = (base: string, param: string) => {
    const r = resources.get(base) ?? { base, param, writes: [], actions: [] };
    if (!r.param) r.param = param;
    resources.set(base, r);
    return r;
  };
  for (const o of ops) {
    const item = /^(.*)\/\{([^}]+)\}$/.exec(o.path);
    const action = /^(.*)\/\{([^}]+)\}\/([A-Za-z0-9_-]+)$/.exec(o.path);
    if (item) {
      const r = resource(item[1]!, item[2]!);
      if (o.method === "get") r.item = o;
      else if (o.method === "put" || o.method === "patch") r.writes.push(o);
      else if (o.method === "delete") r.remove = o;
    } else if (action && ["post", "put", "patch"].includes(o.method)) {
      resource(action[1]!, action[2]!).actions.push({ name: action[3]!, op: o });
    } else if (!o.path.endsWith("}") && (o.method === "get" || o.method === "post")) {
      // A collection: its item path (and so its parameter) may come later in the contract.
      const r = resources.get(o.path) ?? { base: o.path, param: "", writes: [], actions: [] };
      resources.set(o.path, r);
      if (o.method === "get") r.list = o;
      else r.create = o;
    }
  }

  // An example answers with the id that was asked for, not the one written in the contract.
  for (const o of ops) {
    for (const param of [...o.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!)) {
      // Only a string value without a template in it: a number id stays as the contract wrote it.
      const re = new RegExp(`("${escapeRe(param)}"\\s*:\\s*)"(?:[^"\\\\{]|\\\\.)*"`);
      for (const r of o.route.draft.responses ?? []) {
        if (r.body.kind === "inline" && re.test(r.body.text)) r.body = { kind: "inline", text: r.body.text.replace(re, (_m, head: string) => `${head}"{{urlParam '${toMockParam(param)}'}}"`) };
      }
    }
  }

  const replaced = new Set<ImportedRoute>();
  const crudAt = new Map<ImportedRoute, ImportedRoute>();
  const usedNames = new Set<string>();

  for (const r of resources.values()) {
    if (!r.item || !r.param) continue;
    const name = slugify(lastLiteral(r.base), "datos");
    const itemSchema = r.item.success?.schema;
    const props = propertiesOf(itemSchema)?.props ?? null;

    // A status field with fixed values and actions that move it: a scenario.
    const status = statusFieldOf(itemSchema);
    if (status) {
      const names = status.values.map(stateName);
      const valid = names.every((n) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(n)) && new Set(names).size === names.length;
      const transitions: Array<{ from: string[]; to: string; on: { method: string; path: string } }> = [];
      if (valid) {
        const pick = (word: string) => {
          let best = -1;
          let len = 2;
          const tokens = [norm(word), ...norm(word).split(/[-_]/)];
          names.forEach((n, i) => {
            for (const t of tokens) {
              const l = commonPrefix(t, n);
              if (l > len) {
                len = l;
                best = i;
              }
            }
          });
          return best;
        };
        for (const a of r.actions) {
          const to = pick(a.name);
          if (to > 0) transitions.push({ from: names.slice(0, to), to: names[to]!, on: { method: a.op.method.toUpperCase(), path: toMockPathOf(a.op.path) } });
        }
        const cancel = names.findIndex((n) => CANCEL.test(n));
        if (r.remove && cancel > 0 && !transitions.some((t) => t.to === names[cancel])) {
          transitions.push({ from: names.slice(0, cancel), to: names[cancel]!, on: { method: "DELETE", path: toMockPathOf(r.remove.path) } });
        }
      }
      if (!valid) {
        extras.notes.push(`${r.base}: el campo ${status.field} tiene valores que no sirven como estados; no se crea escenario`);
      } else if (!transitions.length) {
        extras.notes.push(`${r.base}: el campo ${status.field} tiene estados, pero ninguna operación del contrato los cambia; no se crea escenario`);
      } else {
        let id = name;
        for (let n = 2; usedNames.has(id); n++) id = `${name}-${n}`;
        usedNames.add(id);
        const expression = stateExpression(id, status.values, names);
        const def = r.item.route.draft.responses?.find((x) => x.default) ?? r.item.route.draft.responses?.[0];
        const wired = def && def.body.kind === "inline" ? wireState(def.body.text, status.field, expression) : null;
        if (def && wired !== null && def.body.kind === "inline") {
          def.body = { kind: "inline", text: wired };
          const scenario = { description: `Deducido del contrato: el campo ${status.field} de ${r.base}/{${r.param}}. Revisa los estados y las transiciones.`, key: `params.${toMockParam(r.param)}`, initial: names[0], states: names, transitions };
          extraFiles[`scenarios/${id}.yaml`] = `# Deducido del contrato al importarlo: revísalo y ajústalo.\n${stringify(scenario)}`;
          extras.scenarios.push({ id, field: status.field, states: names, transitions: transitions.length });
          // GET answers from the state; a CRUD route would answer the stored copy instead.
          continue;
        }
        extras.notes.push(`${r.base}: no se encontró ${status.field} en la respuesta de GET para conectarlo al escenario`);
      }
    }

    // A plain resource: list, read, and something that writes. One CRUD route over a bucket.
    if (!r.list || !props) continue;
    if (!r.create && !r.writes.length && !r.remove) continue;
    const key = r.param in props ? r.param : "id" in props ? "id" : null;
    if (!key) {
      extras.notes.push(`${r.base}: los registros no tienen un campo ${r.param} ni id; se dejan rutas fijas`);
      continue;
    }
    const listSchema = r.list.success?.schema;
    let envelope: { items: string; total?: string } | null = null;
    if (isObj(listSchema) && listSchema["type"] !== "array") {
      const lp = isObj(listSchema["properties"]) ? Object.entries(listSchema["properties"]) : [];
      const arrays = lp.filter(([, v]) => isObj(v) && v["type"] === "array");
      const counts = lp.filter(([, v]) => isObj(v) && (v["type"] === "integer" || v["type"] === "number"));
      if (arrays.length === 1 && arrays.length + counts.length === lp.length && counts.length <= 1) {
        envelope = { items: arrays[0]![0], ...(counts[0] ? { total: counts[0][0] } : {}) };
      } else {
        extras.notes.push(`${r.base}: la lista viene dentro de un objeto con otros campos; se dejan rutas fijas`);
        continue;
      }
    } else if (!isObj(listSchema)) {
      extras.notes.push(`${r.base}: la lista no tiene esquema; se dejan rutas fijas`);
      continue;
    }
    const keyType = isObj(props[key]) && typeof props[key]["type"] === "string" ? (props[key]["type"] as string) : "string";
    const items = seedItems(r.list, itemSchema, envelope?.items ?? null, key, keyType);
    if (!items) {
      extras.notes.push(`${r.base}: no se pudieron generar datos de ejemplo; se dejan rutas fijas`);
      continue;
    }
    let bucket = name;
    for (let n = 2; bucket in buckets || usedNames.has(bucket); n++) bucket = `${name}-${n}`;
    usedNames.add(bucket);
    buckets[bucket] = items;
    const crud: ImportedRoute = {
      folder: r.list.route.folder,
      draft: {
        id: r.list.route.folder ? `${r.list.route.folder}/${bucket}` : bucket,
        path: toMockPathOf(r.base),
        description: `Datos de ${r.base}: listar, leer, crear, cambiar y borrar sobre data/${bucket}.json (deducido del contrato)`,
        crud: { bucket, key, ...(envelope ? { list: envelope } : {}) },
      },
    };
    for (const o of [r.list, r.item, r.create, r.remove, ...r.writes]) if (o) replaced.add(o.route);
    crudAt.set(r.list.route, crud);
    extras.crud.push({ bucket, path: toMockPathOf(r.base), items: items.length });
  }

  const out: ImportedRoute[] = [];
  for (const route of routes) {
    const crud = crudAt.get(route);
    if (crud) out.push(crud);
    else if (!replaced.has(route)) out.push(route);
  }
  if (!extras.crud.length && !extras.scenarios.length && !extras.notes.length) {
    extras.notes.push("El contrato no tiene recursos que se lean por id (GET /recurso/{id}): no hay datos con CRUD ni escenarios que deducir. Sus operaciones quedan como rutas con todas sus respuestas.");
  }
  if (extras.crud.length) report.warnings.push("Las rutas CRUD responden con sus propios errores (404, 409…), no con los del contrato, y no se eligen con X-Mockix-Respuesta");
  return { routes: out, buckets, extraFiles, serverErrors, extras };
}

/** /pedidos/{id}/pago → /pedidos/:id/pago (same rule as the routes). */
function toMockPathOf(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_m, name: string) => `:${toMockParam(name)}`);
}

/** Chaos profiles for a mock made from a contract, using the server errors it documents. Left off: the user applies them. */
export function chaosProfilesFor(mock: string, serverErrors: number[]): { names: string[]; text: string } {
  const codes = serverErrors.length ? serverErrors : [500, 503];
  const base = mock.slice(0, 50);
  const weighted = Object.fromEntries(codes.map((c) => [c, 1]));
  const profiles = {
    [`${base}-lenta`]: { description: "Red lenta y constante, como un celular con poca señal.", points: [{ t: "0s", latency: "400ms", jitter: "150ms" }], extras: { trickleKBps: 64 } },
    [`${base}-inestable`]: {
      description: `Va bien, falla a los 30 s con los errores del contrato (${codes.join(", ")}) y se recupera.`,
      duration: "60s",
      points: [
        { t: "0s", latency: "50ms", jitter: "10ms", errorRate: 0 },
        { t: "20s", latency: "150ms", jitter: "50ms", errorRate: 0.02, errors: weighted },
        { t: "30s", latency: "800ms", jitter: "300ms", errorRate: 0.2, errors: weighted },
        { t: "45s", latency: "50ms", jitter: "10ms", errorRate: 0 },
      ],
      extras: { dropRate: 0.02, timeoutRate: 0.01 },
    },
    [`${base}-caida`]: {
      description: `Responde bien 30 s y luego todo falla con ${codes[0]} (sin bucle).`,
      loop: false,
      points: [
        { t: "0s", latency: "40ms" },
        { t: "30s", latency: "40ms" },
        { t: "30.1s", errorRate: 1, errors: [codes[0]] },
      ],
    },
  };
  const header = `# Perfiles de caos preparados para el mock "${mock}" con los errores que documenta su contrato.\n# Están apagados: elígelos en «Perfiles de caos» o en mock.yaml → chaos: { profile: <perfil> }.\n`;
  return { names: Object.keys(profiles), text: header + stringify(profiles) };
}
