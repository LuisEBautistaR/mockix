import { Faker, base, en, es, es_MX } from "@faker-js/faker";
import { describe, expect, it } from "vitest";
import { BucketStore, TemplateEngine, TemplateError, checkTemplate, seededRandom, type RequestContext, type TemplateDeps } from "@mockix/core";

function engine(seed = 1, over: Partial<TemplateDeps> = {}) {
  const faker = new Faker({ locale: [es_MX, es, en, base] });
  faker.seed(seed);
  return new TemplateEngine({
    faker,
    random: seededRandom(seed),
    now: () => Date.UTC(2026, 9, 25, 12, 0, 0),
    buckets: new BucketStore({ productos: [{ id: "p1", nombre: "Café", precio: 10, tags: ["a"] }], config: { modo: "x" } }),
    vars: new Map([["moneda", "MXN"]]),
    env: { API_KEY: "k-123" },
    ...over,
  });
}

const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  method: "POST",
  path: "/pedidos/7",
  query: { tienda: "cdmx", tag: ["a", "b"] },
  headers: { "x-rol": "admin", authorization: `Bearer x.${Buffer.from(JSON.stringify({ sub: "u1", rol: "ventas" })).toString("base64url")}.y` },
  cookies: { sesion: "s1" },
  params: { id: "7" },
  body: { raw: '{"cliente":{"id":1043},"lineas":[{"sku":"CAF"},{"sku":"OAX"}]}', parsed: { cliente: { id: 1043 }, lineas: [{ sku: "CAF" }, { sku: "OAX" }] } },
  requestNumber: 1,
  ...over,
});

describe("TemplateEngine", () => {
  it("leaves text without mustaches untouched", () => {
    expect(engine().render('{"a":1}', ctx())).toBe('{"a":1}');
  });

  it("reads the request", () => {
    const e = engine();
    expect(e.render("{{urlParam 'id'}}|{{queryParam 'tienda'}}|{{queryParam 'falta' 'def'}}|{{header 'X-Rol'}}|{{cookie 'sesion'}}|{{method}}|{{path}}", ctx())).toBe("7|cdmx|def|admin|s1|POST|/pedidos/7");
    expect(e.render("{{body 'cliente.id'}}|{{body 'lineas[1].sku'}}|{{body 'cliente'}}|{{body 'nada' 'n/a'}}", ctx())).toBe('1043|OAX|{"id":1043}|n/a');
    expect(e.render("{{len (body 'lineas')}}", ctx())).toBe("2");
    expect(e.render("{{jwtPayload 'rol'}}", ctx())).toBe("ventas");
    expect(e.render("{{params.id}}-{{query.tienda}}-{{body.cliente.id}}", ctx())).toBe("7-cdmx-1043");
  });

  it("uses variables, allow-listed env and data buckets", () => {
    const e = engine();
    expect(e.render("{{setVar 'x' 5}}{{getVar 'x'}}-{{getVar 'moneda'}}-{{envVar 'API_KEY'}}-{{envVar 'PATH' 'oculta'}}", ctx())).toBe("5-MXN-k-123-oculta");
    expect(e.render("{{data 'productos' '0.nombre'}}|{{data 'config'}}|{{dataFind 'productos' 'id' 'p1' 'precio'}}|{{dataFind 'productos' 'id' 'zz' 'precio'}}", ctx())).toBe('Café|{"modo":"x"}|10|');
  });

  it("produces the same fake data and random values with the same seed", () => {
    const tpl = "{{faker 'person.fullName'}} {{faker 'number.int' min=1 max=9}} {{uuid}} {{int 1 1000}} {{float 1 2 3}} {{oneOf 'a' 'b' 'c'}} {{boolean}}";
    const a = engine(42).render(tpl, ctx());
    expect(engine(42).render(tpl, ctx())).toBe(a);
    expect(engine(43).render(tpl, ctx())).not.toBe(a);
  });

  it("formats dates and offsets", () => {
    const e = engine();
    expect(e.render("{{now}}|{{now 'date'}}|{{now 'unix'}}|{{now 'iso' add='1d'}}", ctx())).toBe("2026-10-25T12:00:00.000Z|2026-10-25|1792929600|2026-10-26T12:00:00.000Z");
  });

  it("repeats blocks with separators and frame data", () => {
    const e = engine();
    expect(e.render("[{{#repeat 3}}{{@index}}{{/repeat}}]", ctx())).toBe("[0,1,2]");
    expect(e.render("{{#repeat 2 comma=false}}x{{#if @last}}!{{/if}}{{/repeat}}", ctx())).toBe("xx!");
    expect(e.render("{{#repeat 5000}}.{{/repeat}}", ctx()).length).toBe(1000 * 2 - 1);
  });

  it("supports logic and string helpers as subexpressions", () => {
    const e = engine();
    expect(e.render("{{#if (eq (urlParam 'id') '7')}}si{{else}}no{{/if}} {{#if (and (gt 5 3) (not false))}}ok{{/if}} {{#if (includes (queryParam 'tag') 'b')}}b{{/if}}", ctx())).toBe("si ok b");
    expect(e.render("{{uppercase 'abc'}} {{lowercase 'ABC'}} {{concat 'a' 1 'b'}} {{json (array 1 2)}} {{base64 'hola'}} {{base64Decode 'aG9sYQ=='}} {{default '' 'x'}}", ctx())).toBe('ABC abc a1b [1,2] aG9sYQ== hola x');
  });

  it("refuses unknown helpers, missing faker methods and prototype access", () => {
    const e = engine();
    expect(() => e.render("{{exec 'rm'}}", ctx())).toThrow(TemplateError);
    expect(() => e.render("{{faker 'person.constructor'}}", ctx())).toThrow(/no existe/);
    expect(() => e.render("{{faker 'nada.algo'}}", ctx())).toThrow(/no existe/);
    expect(e.render("{{params.constructor.name}}", ctx())).toBe("");
  });

  it("accepts a mustache right before a closing brace, and real triple-stashes", () => {
    const e = engine();
    expect(e.render('{"a":{"n":{{urlParam \'id\'}}}}', ctx())).toBe('{"a":{"n":7}}');
    expect(e.render("{{{urlParam 'id'}}}", ctx())).toBe("7");
    expect(e.render("{{! nota }}}{{#if true}}{{urlParam 'id'}}}{{/if}}", ctx())).toBe("}7}");
    expect(() => checkTemplate('{"n": {{int 1 9}}}')).not.toThrow();
  });

  it("checks syntax and helper names without rendering", () => {
    expect(() => checkTemplate("{{#repeat 2}}x")).toThrow(TemplateError);
    expect(() => checkTemplate("{{noExiste 1}}")).toThrow(/noExiste/);
    expect(() => checkTemplate("{{faker 'person.firstName'}} {{#each (array 1 2)}}{{this}}{{/each}}")).not.toThrow();
  });
});
