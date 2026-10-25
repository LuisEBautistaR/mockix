import { describe, expect, it } from "vitest";
import { compilePath, stripPrefix, testRule, testRules, type RequestContext } from "@mockix/core";

describe("compilePath", () => {
  it("matches fixed paths and ignores a trailing slash", () => {
    const m = compilePath("/productos");
    expect(m("/productos")).toEqual({});
    expect(m("/productos/")).toEqual({});
    expect(m("/productos/1")).toBeNull();
    expect(m("/producto")).toBeNull();
  });

  it("captures named params, decoded", () => {
    const m = compilePath("/productos/:id/resenas/:n");
    expect(m("/productos/prd%207/resenas/3")).toEqual({ id: "prd 7", n: "3" });
    expect(m("/productos//resenas/3")).toBeNull();
    expect(m("/productos/%E0%A4%A/resenas/3")).toBeNull();
  });

  it("matches the rest of the path with a trailing star", () => {
    const m = compilePath("/archivos/*");
    expect(m("/archivos/a/b.pdf")).toEqual({ "*": "a/b.pdf" });
    expect(m("/archivos")).toEqual({ "*": "" });
    expect(m("/otros/a")).toBeNull();
  });

  it("supports the root path", () => {
    expect(compilePath("/")("/")).toEqual({});
    expect(compilePath("/")("/x")).toBeNull();
  });

  it("treats a leading caret as a regular expression with named groups", () => {
    const m = compilePath("^/v(?<version>\\d+)/salud$");
    expect(m("/v2/salud")).toEqual({ version: "2" });
    expect(m("/vx/salud")).toBeNull();
  });

  it("strips the mock prefix only on a segment boundary", () => {
    expect(stripPrefix("/v1", "/v1/productos")).toBe("/productos");
    expect(stripPrefix("/v1", "/v1")).toBe("/");
    expect(stripPrefix("/v1", "/v10/productos")).toBeNull();
    expect(stripPrefix("", "/x")).toBe("/x");
  });
});

const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  method: "POST",
  path: "/pedidos",
  query: { tienda: "cdmx", tag: ["a", "b"] },
  headers: { "x-rol": "invitado", "content-type": "application/json" },
  cookies: { sesion: "s1" },
  params: { id: "9001" },
  body: { raw: '{"cliente":1043,"lineas":[{"sku":"CAF","cantidad":2}],"notas":null,"tags":[]}', parsed: { cliente: 1043, lineas: [{ sku: "CAF", cantidad: 2 }], notas: null, tags: [] } },
  requestNumber: 3,
  ...over,
});
const rule = (target: string, op: Parameters<typeof testRule>[0]["op"], value?: unknown, negate = false) => ({ target, op, value, negate });

describe("rules", () => {
  it.each([
    [rule("body.cliente", "equals", 1043), true],
    [rule("body.cliente", "equals", "1043"), true],
    [rule("body.lineas[0].sku", "equals", "CAF"), true],
    [rule("body.lineas[0].cantidad", "gt", 1), true],
    [rule("body.lineas[1].sku", "exists"), false],
    [rule("body.notas", "null"), true],
    [rule("body.tags", "empty"), true],
    [rule("body.lineas", "empty"), false],
    [rule("body", "contains", '"sku":"CAF"'), true],
    [rule("header.X-Rol", "equals", "invitado"), true],
    [rule("cookie.sesion", "regex", "^s\\d$"), true],
    [rule("params.id", "regex", "^9\\d+$"), true],
    [rule("params.id", "in", ["9001", "9002"]), true],
    [rule("query.tag", "equals", "b"), true],
    [rule("query.tag", "contains", "a"), true],
    [rule("query.falta", "exists"), false],
    [rule("query.falta", "empty"), true],
    [rule("method", "equals", "POST"), true],
    [rule("path", "equals", "/pedidos"), true],
    [rule("request.number", "gte", 3), true],
    [rule("request.number", "lt", 3), false],
    [rule("query.tienda", "gt", 1), false],
    [rule("header.x-rol", "equals", "admin", true), true],
  ])("%j → %s", (r, expected) => {
    expect(testRule(r, ctx())).toBe(expected);
  });

  it("combines with all and any", () => {
    const when = [rule("method", "equals", "POST"), rule("params.id", "equals", "1")];
    expect(testRules({ mode: "all", when }, ctx())).toBe(false);
    expect(testRules({ mode: "any", when }, ctx())).toBe(true);
  });

  it("reads form bodies as objects", () => {
    expect(testRule(rule("body.nombre", "equals", "Ana"), ctx({ body: { raw: "nombre=Ana", parsed: { nombre: "Ana" } } }))).toBe(true);
  });
});
