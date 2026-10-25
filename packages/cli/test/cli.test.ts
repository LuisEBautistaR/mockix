import { createServer } from "node:http";
import { WebSocket } from "ws";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCli } from "../src/args.js";
import { main, type Io } from "../src/main.js";
import { formatCallbackLine, formatLogLine } from "../src/serve.js";

function capture(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

const dirs: string[] = [];
async function exampleWorkspace(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mockix-cli-"));
  dirs.push(d);
  expect(await main(["init", d], capture(), new AbortController().signal)).toBe(0);
  return d;
}
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

describe("parseCli", () => {
  it("defaults serve to the current folder, all mocks and watching", () => {
    expect(parseCli(["serve"])).toEqual({ ok: true, command: { kind: "serve", dir: ".", mocks: [], port: null, host: null, watch: true, seed: null, adminToken: null, contract: null, chaos: null, report: null, failOnViolation: false } });
  });

  it("reads folder, mocks, port, host and --no-watch", () => {
    expect(parseCli(["serve", "ws", "-m", "tienda", "-p", "0", "--host", "0.0.0.0", "--no-watch", "--seed", "42", "--admin-token", "token-de-prueba"])).toEqual({
      ok: true,
      command: { kind: "serve", dir: "ws", mocks: ["tienda"], port: 0, host: "0.0.0.0", watch: false, seed: 42, adminToken: "token-de-prueba", contract: null, chaos: null, report: null, failOnViolation: false },
    });
    expect(parseCli(["serve", "-m", "a", "-m", "b"])).toMatchObject({ ok: true, command: { mocks: ["a", "b"] } });
  });

  it("parses init and validate, help and version", () => {
    expect(parseCli(["init", "nuevo"])).toEqual({ ok: true, command: { kind: "init", dir: "nuevo" } });
    expect(parseCli(["validate"])).toEqual({ ok: true, command: { kind: "validate", dir: ".", failOnViolation: false } });
    expect(parseCli(["mcp", "ws", "--read-only"])).toEqual({ ok: true, command: { kind: "mcp", dir: "ws", readOnly: true } });
    expect(parseCli(["mcp"])).toEqual({ ok: true, command: { kind: "mcp", dir: ".", readOnly: false } });
    expect(parseCli([])).toEqual({ ok: true, command: { kind: "help" } });
    expect(parseCli(["serve", "--help"])).toEqual({ ok: true, command: { kind: "help" } });
    expect(parseCli(["-v"])).toEqual({ ok: true, command: { kind: "version" } });
  });

  it.each([
    [["serve", "-m", "a", "--port", "abc"], "Puerto no válido: abc"],
    [["serve", "-m", "a", "--port=-1"], "Puerto no válido: -1"],
    [["serve", "--port"], "Falta el valor de --port"],
    [["serve", "--port", "3000"], "--port necesita exactamente un --mock"],
    [["serve", "--watch-all"], "Opción desconocida: --watch-all"],
    [["deploy"], "Comando desconocido: deploy"],
    [["serve", "a", "b"], "Argumento inesperado: b"],
    [["serve", "--host", " "], "--host no puede estar vacío"],
    [["validate", "-m", "a"], "Las opciones de serve no se usan con validate"],
    [["serve", "--seed", "-3"], "Falta el valor de --seed"],
    [["serve", "--seed", "x"], "Semilla no válida: x (un entero positivo)"],
    [["serve", "--admin-token", "corto"], "--admin-token necesita al menos 12 caracteres"],
    [["import"], "Falta el archivo a importar"],
    [["import", "a.json", "--format", "raml"], "Formato desconocido: raml"],
    [["export", "postman"], "Solo se exporta a OpenAPI: mockix export openapi [carpeta] -m <mock>"],
    [["export", "openapi"], "export necesita exactamente un --mock"],
    [["serve", "--out", "x"], "Las opciones de import o export no se usan con serve"],
    [["record"], "record necesita --target con la URL http(s) de la API real"],
    [["record", "--target", "ftp://x"], "record necesita --target con la URL http(s) de la API real"],
    [["convert"], "Falta la grabación (un .jsonl de .mockix/recordings)"],
    [["convert", "a.jsonl", "--name", "x", "--into", "y"], "Usa --name (mock nuevo) o --into (mock existente), no los dos"],
    [["replay", "a.jsonl", "-p", "x"], "Puerto no válido: x"],
    [["serve", "--contract", "loose"], "Modo de contrato no válido: loose (off, warn o strict)"],
    [["serve", "--chaos", "Red 3G"], "Perfil de caos no válido: Red 3G"],
    [["serve", "--read-only"], "--read-only solo se usa con mcp"],
    [["mcp", "ws", "otro"], "Argumento inesperado: otro"],
    [["validate", "--chaos", "red-3g"], "Las opciones de serve no se usan con validate"],
    [["serve", "--report", "r.txt"], "--report necesita un archivo .xml (JUnit) o .json"],
    [["validate", "--report", "r.xml"], "Las opciones de serve no se usan con validate"],
  ])("rejects %j", (argv, message) => {
    expect(parseCli(argv)).toEqual({ ok: false, message });
  });
});

describe("import and export", () => {
  it("parses import and export", () => {
    expect(parseCli(["import", "col.json", "ws", "--name", "tienda-api", "-p", "4000", "--prefix", "/v1"])).toEqual({
      ok: true,
      command: { kind: "import", file: "col.json", dir: "ws", format: null, name: "tienda-api", port: 4000, prefix: "/v1" },
    });
    expect(parseCli(["export", "openapi", "ws", "-m", "tienda", "-o", "api.yaml"])).toEqual({ ok: true, command: { kind: "export", dir: "ws", mock: "tienda", out: "api.yaml" } });
  });

  it("imports a collection into a workspace, and exports a mock that imports back", async () => {
    const ws = await exampleWorkspace();
    const fixture = join(import.meta.dirname, "../../core/test/fixtures/postman-tienda.json");
    const io = capture();
    expect(await main(["import", fixture, ws, "-p", "0"], io, new AbortController().signal)).toBe(0);
    expect(io.lines[0]).toBe('Mock "tienda-api" creado desde postman (Tienda API (postman-tienda.json)).');
    expect(io.lines[1]).toContain("7 rutas, 8 respuestas: 6 de ejemplos, 2 generadas.");
    expect(io.lines.some((l) => l.startsWith("  Omitido: ") && l.includes("tienda.Pagos"))).toBe(true);

    const check = capture();
    expect(await main(["validate", ws], check, new AbortController().signal)).toBe(0);
    expect(check.lines[0]).toBe("Workspace válido: 2 mocks, 17 rutas, 4 de tiempo real y 2 servicios gRPC.");

    const out = join(ws, "tienda.openapi.yaml");
    expect(await main(["export", "openapi", ws, "-m", "tienda", "-o", out], capture(), new AbortController().signal)).toBe(0);
    expect(await readFile(out, "utf8")).toContain("openapi: 3.1.0");
    const back = capture();
    expect(await main(["import", out, ws, "--name", "tienda-copia", "-p", "0"], back, new AbortController().signal)).toBe(0);
    expect(back.lines[0]).toContain('Mock "tienda-copia" creado desde openapi');
    expect(await main(["validate", ws], capture(), new AbortController().signal)).toBe(0);

    const bad = capture();
    expect(await main(["import", join(ws, "mockix.workspace.yaml"), ws], bad, new AbortController().signal)).toBe(1);
    expect(bad.errors[0]).toContain("No se reconoce el formato");
  });
});

describe("record, convert and replay", () => {
  it("records through the proxy, converts on stop, and replays the recording as a cassette", async () => {
    const ws = await exampleWorkspace();
    const api = createServer((req, res) => {
      res.writeHead(req.url?.includes("9001") ? 404 : 200, { "Content-Type": "application/json", "Set-Cookie": "s=secreto-real" });
      res.end(JSON.stringify(req.url?.includes("9001") ? { error: "no" } : { id: 7, token: "tok-real-123" }));
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    const target = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

    const io = capture();
    const stop = new AbortController();
    const done = main(["record", ws, "--target", target, "-p", "0", "--prefix", "/v1", "--convert", "real"], io, stop.signal);
    await expect.poll(() => io.lines.find((l) => l.startsWith("Grabando: ")), { timeout: 10_000 }).toBeDefined();
    const proxy = /Grabando: (http:\/\/\S+) →/.exec(io.lines.find((l) => l.startsWith("Grabando: "))!)![1]!;
    expect(await (await fetch(`${proxy}/v1/cosas/7`, { headers: { Authorization: "Bearer real" } })).json()).toEqual({ id: 7, token: "tok-real-123" });
    expect((await fetch(`${proxy}/v1/cosas/9001`)).status).toBe(404);
    await expect.poll(() => io.lines.filter((l) => l.includes("grabada")).length).toBe(2);
    stop.abort();
    expect(await done).toBe(0);
    api.close();
    expect(io.lines).toContain("Grabación terminada: 2 peticiones.");
    expect(io.lines.some((l) => l.startsWith('Mock "real" creado desde la grabación: 1 rutas'))).toBe(true);

    const route = await readFile(join(ws, "mocks/real/routes/get-cosas-id.yaml"), "utf8");
    expect(route).not.toContain("tok-real-123");
    expect(route).toContain("path: /cosas/:id");
    const recordings = await readdir(join(ws, ".mockix/recordings"));
    expect(recordings).toHaveLength(1);

    const rio = capture();
    const rstop = new AbortController();
    const replay = main(["replay", recordings[0]!, ws, "-p", "0"], rio, rstop.signal);
    await expect.poll(() => rio.lines.find((l) => l.startsWith("Casete en ")), { timeout: 10_000 }).toBeDefined();
    const tape = /Casete en (http:\/\/\S+):/.exec(rio.lines[0]!)![1]!;
    expect(await (await fetch(`${tape}/v1/cosas/7`)).json()).toEqual({ id: 7, token: "tok-real-123" });
    expect((await fetch(`${tape}/v1/otra`)).status).toBe(599);
    rstop.abort();
    expect(await replay).toBe(2);
    expect(rio.errors.some((l) => l.includes("FUERA DEL CASETE: no está en la grabación"))).toBe(true);
    expect(rio.lines.at(-1)).toBe("Casete terminado: 1 de 2 usadas, 1 peticiones fuera del casete.");
  });
});

describe("init and validate", () => {
  it("creates the example and refuses to overwrite it", async () => {
    const ws = await exampleWorkspace();
    const io = capture();
    expect(await main(["init", ws], io, new AbortController().signal)).toBe(1);
    expect(io.errors[0]).toContain("ya es un workspace de Mockix");
  });

  it("validates a good workspace and lists problems with file and line", async () => {
    const ws = await exampleWorkspace();
    const ok = capture();
    expect(await main(["validate", ws], ok, new AbortController().signal)).toBe(0);
    expect(ok.lines).toEqual(["Workspace válido: 1 mock, 13 rutas, 2 de tiempo real y 1 servicio gRPC.", "Contrato de tienda (contracts/tienda.openapi.yaml): 9 de 11 operaciones con mock, 3 rutas fuera del contrato."]);

    // A response that drifted from the contract is a warning, or exit 2 with --fail-on-violation.
    const producto = join(ws, "mocks/tienda/routes/productos/get-producto.yaml");
    const original = await readFile(producto, "utf8");
    await writeFile(producto, original.replace("json: { error: no existe, codigo: PRODUCTO_NO_ENCONTRADO }", "json: { error: no existe }"));
    const drift = capture();
    expect(await main(["validate", ws, "--fail-on-violation"], drift, new AbortController().signal)).toBe(2);
    expect(drift.lines[1]).toContain(", 1 respuesta no cumple.");
    expect(drift.errors).toEqual(["  Aviso: GET /productos/:id → no-existe (404): body.codigo es obligatorio"]);
    await writeFile(producto, original);

    await writeFile(join(ws, "mocks/tienda/routes/salud.yaml"), "path: /salud\nresponses:\n  - id: ok\n    status: 42\n");
    const bad = capture();
    expect(await main(["validate", ws], bad, new AbortController().signal)).toBe(1);
    expect(bad.errors[0]).toBe("1 problema en 1 archivo:");
    expect(bad.errors[1]).toMatch(/^ {2}mocks\/tienda\/routes\/salud\.yaml:4 {2}responses\[0\]\.status: /);
  });
});

describe("serve", () => {
  async function serving(args: string[]) {
    const io = capture();
    const stop = new AbortController();
    const done = main(args, io, stop.signal);
    await expect.poll(() => io.lines.find((l) => /^tienda {2}https?:/.test(l)), { timeout: 10_000 }).toBeDefined();
    const url = /^tienda {2}(\S+?)\/v1 /.exec(io.lines.find((l) => l.startsWith("tienda  "))!)![1]!;
    return { io, stop, done, url };
  }

  it("serves the workspace, logs requests and stops cleanly", async () => {
    const ws = await exampleWorkspace();
    const { io, stop, done, url } = await serving(["serve", ws, "-m", "tienda", "-p", "0", "--no-watch"]);
    const res = await fetch(`${url}/v1/productos/9001`);
    expect(res.status).toBe(404);
    expect(res.headers.get("server")).toMatch(/^Mockix\/\d+\.\d+\.\d+$/);
    await expect.poll(() => io.lines.some((l) => /GET\s+\/v1\/productos\/9001\s+404 .*productos\/obtener → no-existe/.test(l))).toBe(true);
    stop.abort();
    expect(await done).toBe(0);
    expect(io.lines.at(-1)).toBe("Mocks detenidos.");
    await expect(fetch(`${url}/v1/salud`)).rejects.toThrow();
  });

  it("applies edits live and keeps the last good version when an edit breaks", async () => {
    const ws = await exampleWorkspace();
    const { io, stop, done, url } = await serving(["serve", ws, "-m", "tienda", "-p", "0"]);
    await expect.poll(() => io.lines.some((l) => l.startsWith("Vigilando cambios"))).toBe(true);
    const salud = join(ws, "mocks/tienda/routes/salud.yaml");

    await writeFile(salud, (await readFile(salud, "utf8")).replace("servicio: tienda", "servicio: tienda-v2"));
    await expect.poll(async () => ((await (await fetch(`${url}/v1/salud`)).json()) as { servicio: string }).servicio, { timeout: 5000 }).toBe("tienda-v2");
    expect(io.lines).toContain("tienda: recargado (13 rutas)");

    await writeFile(salud, "path: /salud\nresponses: []\n");
    await expect.poll(() => io.errors.some((l) => l.includes("cambios con problemas")), { timeout: 5000 }).toBe(true);
    expect(((await (await fetch(`${url}/v1/salud`)).json()) as { servicio: string }).servicio).toBe("tienda-v2");

    stop.abort();
    expect(await done).toBe(0);
  });

  it("repeats fake data with --seed and exposes the control API with a token", async () => {
    const ws = await exampleWorkspace();
    const strip = (t: string) => t.replace(/"consultado": "[^"]+"/, "");
    const once = async () => {
      const { stop, done, url, io } = await serving(["serve", ws, "-m", "tienda", "-p", "0", "--no-watch", "--seed", "7", "--admin-token", "token-de-prueba"]);
      const body = strip(await (await fetch(`${url}/v1/clientes/c1`)).text());
      const health = await (await fetch(`${url}/__mockix/health`)).json();
      const denied = (await fetch(`${url}/__mockix/logs`)).status;
      const logs = (await (await fetch(`${url}/__mockix/logs`, { headers: { Authorization: "Bearer token-de-prueba" } })).json()) as Array<{ url: string }>;
      stop.abort();
      await done;
      return { body, health, denied, logs: logs.map((l) => l.url), banner: io.lines.find((l) => l.startsWith("tienda  "))! };
    };
    const a = await once();
    const b = await once();
    expect(a.body).toBe(b.body);
    expect(a.health).toEqual({ status: "ok", mock: "tienda", routes: 13 });
    expect(a.denied).toBe(401);
    expect(a.logs).toEqual(["/v1/clientes/c1"]);
    expect(a.banner).toContain("control en http://127.0.0.1:");
  });

  it("logs contract violations and scenario moves, and writes the report on stop", async () => {
    const ws = await exampleWorkspace();
    const report = join(ws, "contrato.xml");
    const { io, stop, done, url } = await serving(["serve", ws, "-m", "tienda", "-p", "0", "--no-watch", "--report", report, "--fail-on-violation"]);
    expect(io.lines).toContain("  contrato contracts/tienda.openapi.yaml (avisar)");
    expect(io.lines).toContain("  escenarios: pedido");
    const bad = await fetch(`${url}/v1/pedidos`, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "app-movil/3.4.1" }, body: JSON.stringify({ lineas: [{ sku: "A", cantidad: "2" }] }) });
    expect(bad.status).toBe(201);
    expect((await fetch(`${url}/v1/pedidos/ped_7/pago`, { method: "POST" })).status).toBe(200);
    await expect.poll(() => io.lines.some((l) => l.includes("⇢ pedido[ped_7] creado → pagado  (POST /v1/pedidos/ped_7/pago · 200)"))).toBe(true);
    expect(io.lines.find((l) => l.includes("POST   /v1/pedidos  201"))).toContain('⚠ contrato: body.lineas[0].cantidad debe ser integer (recibido "2", un string)');
    stop.abort();
    expect(await done).toBe(2);
    expect(io.lines).toContain("Contrato de tienda: 2 peticiones, 1 no cumplen (1 regla).");
    expect(io.lines).toContain("  1×  POST /pedidos  body.lineas[].cantidad debe ser integer");
    const xml = await readFile(report, "utf8");
    expect(xml).toContain('<testsuite name="contrato tienda" tests="11" failures="1"');
    expect(xml).toContain('name="POST /pedidos"><failure');

    // strict from the command line answers 400 and changes nothing in mock.yaml.
    const strict = await serving(["serve", ws, "-m", "tienda", "-p", "0", "--no-watch", "--contract", "strict"]);
    expect(strict.io.lines).toContain("  contrato contracts/tienda.openapi.yaml (estricto)");
    expect((await fetch(`${strict.url}/v1/productos?limit=500`)).status).toBe(400);
    strict.stop.abort();
    expect(await strict.done).toBe(0);
    expect(await readFile(join(ws, "mocks/tienda/mock.yaml"), "utf8")).toContain("mode: warn");
  });

  it("applies a chaos profile from the command line and marks its effects in the log", async () => {
    const ws = await exampleWorkspace();
    await writeFile(join(ws, "chaos/prueba.yaml"), "todo-falla:\n  points: [{ t: 0s, latency: 5ms, errorRate: 1, errors: [503] }]\n");
    const unknown = capture();
    expect(await main(["serve", ws, "--no-watch", "--chaos", "tormenta"], unknown, new AbortController().signal)).toBe(1);
    expect(unknown.errors[0]).toContain('no hay ningún perfil de caos "tormenta". Perfiles: red-inestable, rampa, pico, red-3g, se-cae-a-los-30s, todo-falla');

    const { io, stop, done, url } = await serving(["serve", ws, "-m", "tienda", "-p", "0", "--no-watch", "--chaos", "todo-falla", "--seed", "3"]);
    expect(io.lines).toContain("  caos: todo-falla (ciclo de 0 s, semilla 3)");
    const res = await fetch(`${url}/v1/salud`);
    expect(res.status).toBe(503);
    expect(res.headers.get("x-mockix")).toBe("chaos");
    await expect.poll(() => io.lines.find((l) => l.includes("GET    /v1/salud"))).toContain("⚡ caos: error 503, +5 ms");
    stop.abort();
    expect(await done).toBe(0);
  });

  it("announces WebSocket, Socket.IO and gRPC endpoints and logs their messages", async () => {
    const ws = await exampleWorkspace();
    const { io, stop, done, url } = await serving(["serve", ws, "-m", "tienda", "-p", "0", "--no-watch"]);
    const wsLine = io.lines.find((l) => l.startsWith("  WebSocket  "))!;
    expect(wsLine).toBe(`  WebSocket  ${url.replace("http", "ws")}/v1/notificaciones`);
    expect(io.lines).toContain(`  Socket.IO  ${url}/pedidos  (path /socket.io)`);
    expect(io.lines.find((l) => l.startsWith("  gRPC  "))).toMatch(/^ {2}gRPC {2}127\.0\.0\.1:\d+ {2}\(tienda\.Catalogo; reflection\)$/);

    const socket = new WebSocket(wsLine.slice("  WebSocket  ".length));
    await new Promise((r) => socket.once("message", r));
    socket.send(JSON.stringify({ tipo: "ping" }));
    await new Promise((r) => socket.once("message", r));
    socket.close();
    await expect.poll(() => io.lines.some((l) => /⇄ WS notificaciones ws\d+ desconectado$/.test(l))).toBe(true);
    expect(io.lines.some((l) => /⇄ WS notificaciones ws\d+ ← \{"tipo":"ping"\} {2}→ pong$/.test(l))).toBe(true);
    stop.abort();
    expect(await done).toBe(0);
  });

  it("refuses to serve a mock with problems, and unknown mock names", async () => {
    const ws = await exampleWorkspace();
    await writeFile(join(ws, "mocks/tienda/mock.yaml"), "port: nada\n");
    const io = capture();
    expect(await main(["serve", ws, "--no-watch"], io, new AbortController().signal)).toBe(1);
    expect(io.errors[0]).toBe('mockix: el mock "tienda" tiene problemas:');

    const io2 = capture();
    expect(await main(["serve", ws, "-m", "pagos"], io2, new AbortController().signal)).toBe(1);
    expect(io2.errors[0]).toBe('mockix: no hay ningún mock "pagos". Mocks: tienda');
  });

  it("explains a folder that is not a workspace", async () => {
    const empty = await mkdtemp(join(tmpdir(), "mockix-vacio-"));
    dirs.push(empty);
    const io = capture();
    expect(await main(["serve", empty], io, new AbortController().signal)).toBe(1);
    expect(io.errors.join("\n")).toContain("mockix init");
  });

  it("formats log lines with route, response, simulated latency and errors", () => {
    const empty = { headers: {}, body: "", truncated: false, binary: false };
    const base = { seq: 1, at: Date.UTC(2026, 9, 24, 17, 42, 31), method: "GET", url: "/v1/inestable", status: 503, durationMs: 121.4, latencyMs: 120, request: empty, response: empty, error: null };
    expect(formatLogLine({ ...base, kind: "route", routeId: "inestable", responseId: "caido" }, "tienda")).toMatch(
      /^\d{2}:\d{2}:\d{2} {2}tienda {2}GET {4}\/v1\/inestable {2}503 {2}121\.4 ms \(120 ms simulados\) {2}inestable → caido$/,
    );
    expect(formatLogLine({ ...base, kind: "proxy", routeId: null, responseId: null, latencyMs: 0, status: 502, error: "ECONNREFUSED" }, null)).toMatch(/→ API real {2}ERROR: ECONNREFUSED$/);
    expect(formatCallbackLine({ requestSeq: 1, at: base.at, method: "POST", url: "http://localhost:4000/h", status: 202, durationMs: 5, error: null }, null)).toMatch(/↪ callback POST http:\/\/localhost:4000\/h {2}202 {2}5 ms$/);
  });
});
