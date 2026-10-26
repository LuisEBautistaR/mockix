/**
 * Launches the built app (out/) with real Electron: a hardened window, a
 * workspace folder whose mocks run in their own processes, live reload of the
 * files, recovery after a crash, and the folder remembered between launches.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeEmptyWorkspace, writeExampleWorkspace } from "@mockix/core";

const root = resolve(import.meta.dirname, "../..");
const shots = resolve(root, "test-results/screens");
const temps: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

test.afterAll(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

/** The example workspace with its mock moved to a free port, so tests never clash with a real 3000. */
async function exampleWorkspace(port = 0): Promise<string> {
  const dir = await temp("mockix-e2e-ws-");
  await writeExampleWorkspace(dir);
  const file = join(dir, "mocks/tienda/mock.yaml");
  await writeFile(file, (await readFile(file, "utf8")).replace("port: 3000", `port: ${port}`));
  return dir;
}

interface Launch {
  testMode?: boolean;
  workspace?: string | null;
  userData?: string;
  /** Extra command line arguments (a mockix:// link, as Windows passes it). */
  args?: string[];
}

async function launch(opts: Launch = {}): Promise<{ app: ElectronApplication; win: Page }> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env["ELECTRON_RENDERER_URL"];
  delete env["MOCKIX_WORKSPACE"];
  if (opts.testMode ?? true) env["MOCKIX_TEST"] = "1";
  else delete env["MOCKIX_TEST"];
  if (opts.workspace) env["MOCKIX_WORKSPACE"] = opts.workspace;
  env["MOCKIX_USER_DATA"] = opts.userData ?? (await temp("mockix-e2e-profile-"));
  const app = await electron.launch({ args: [".", ...(opts.args ?? [])], cwd: root, env });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return { app, win };
}

async function startTienda(win: Page): Promise<string> {
  await expect(win.getByTestId("mock-state")).toHaveText("Detenido", { timeout: 20_000 });
  await win.getByTestId("mock-toggle").click();
  await expect(win.getByTestId("mock-state")).toHaveText("En marcha", { timeout: 20_000 });
  const url = await win.getByTestId("mock-url").textContent();
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  return url!;
}

test("opens a hardened window and the bridge rejects bad calls", async () => {
  const { app, win } = await launch();
  try {
    await expect(win.getByTestId("create-example")).toBeVisible();
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      // Not in Electron's typings, but it reports the preferences actually applied to the page.
      const contents = w.webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences };
      const p = contents.getLastWebPreferences();
      return { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, webviewTag: p.webviewTag, url: w.webContents.getURL() };
    });
    expect(prefs).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, url: "app://mockix/index.html" });

    // Main validates every argument: odd ids, unknown mocks and smuggled URLs never reach a host.
    expect(await win.evaluate(() => window.mockix.mocks.start("../etc"))).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(await win.evaluate(() => window.mockix.mocks.start({ id: "demo" } as never))).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(await win.evaluate(() => window.mockix.mocks.start("otro"))).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await win.evaluate(() => window.mockix.mocks.send("otro", { method: "GET", path: "//evil.test/x" }))).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(await win.evaluate(() => window.mockix.routes.write("otro", null, { path: "/x" } as never, "../.."))).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });

    // The page cannot reach localhost itself: the CSP only allows its own origin.
    expect(await win.evaluate(() => fetch("http://127.0.0.1:9/").then(() => "reached", () => "blocked"))).toBe("blocked");

    // Security checks run on the workspace screen.
    const ws = await exampleWorkspace();
    await app.evaluate(async ({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    }, ws);
    await win.getByTestId("open-workspace").click();
    await expect(win.getByTestId("mock-row-tienda")).toBeVisible();
    await win.getByTestId("rail-settings").click();
    for (const id of ["no-node", "bridge", "csp", "origin"]) {
      await expect(win.getByTestId(`check-${id}`)).toHaveAttribute("data-passed", "true");
    }

    // Last, because Playwright then waits for the blocked navigation: no popups and no navigation away from app://.
    expect(await win.evaluate(() => window.open("https://example.com/") === null)).toBe(true);
    await win.evaluate(() => {
      location.href = "https://example.com/";
    });
    await win.waitForTimeout(500);
    expect(win.url()).toBe("app://mockix/index.html");
  } finally {
    await app.close();
  }
});

test("opens a folder without mockix.workspace.yaml and refuses a mock's own folder", async () => {
  // A folder with a mock but no workspace file, as an older build left behind when "Nuevo mock" failed.
  const dir = await temp("mockix-e2e-plain-");
  const orphan = join(dir, "mocks", "documentos");
  await mkdir(join(orphan, "routes"), { recursive: true });
  await writeFile(join(orphan, "mock.yaml"), "port: 0\n");
  const { app, win } = await launch();
  const pick = (folder: string) =>
    app.evaluate(async ({ dialog }, f) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog;
    }, folder);
  try {
    await pick(orphan);
    await win.getByTestId("open-workspace").click();
    await expect(win.getByTestId("notice")).toContainText(`Esa carpeta es el mock «documentos», no un workspace: abre ${dir}.`);
    expect(await readdir(orphan)).toEqual(["mock.yaml", "routes"]);

    await pick(dir);
    await win.getByTestId("open-workspace").click();
    await expect(win.getByTestId("mock-row-documentos")).toBeVisible();
    expect(await readFile(join(dir, "mockix.workspace.yaml"), "utf8")).toContain("format: 1");

    await win.getByTestId("new-mock").click();
    await win.getByTestId("new-mock-empty").click();
    await win.getByTestId("new-mock-name").fill("pruebas");
    await win.getByTestId("new-mock-port").fill("0");
    await win.getByTestId("new-mock-prefix").fill("/v3/run");
    await win.getByTestId("new-mock-create").click();
    await expect(win.getByTestId("mock-row-pruebas")).toBeVisible();
    expect(await readFile(join(dir, "mocks", "pruebas", "mock.yaml"), "utf8")).toContain("prefix: /v3/run");
  } finally {
    await app.close();
  }
});

test("creates a mock from an OpenAPI contract with its contract, data, scenario and chaos", async () => {
  const ws = await temp("mockix-e2e-contract-");
  await writeEmptyWorkspace(ws);
  const source = await temp("mockix-e2e-source-");
  await writeExampleWorkspace(source);
  const contract = join(source, "contracts", "tienda.openapi.yaml");
  const { app, win } = await launch({ workspace: ws });
  try {
    await app.evaluate(async ({ dialog }, f) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog;
    }, contract);
    await win.getByTestId("start-from-contract").click();
    await win.getByTestId("new-mock-pick").click();
    await expect(win.getByTestId("new-mock-picked")).toContainText("tienda.openapi.yaml");
    await expect(win.getByTestId("new-mock-name")).toHaveValue("tienda-demo");
    await expect(win.getByTestId("new-mock-prefix")).toHaveValue("/v1");
    await win.getByTestId("new-mock-port").fill("0");
    await win.getByTestId("new-mock-create").click();

    const extras = win.getByTestId("import-extras");
    await expect(extras).toContainText("contracts/tienda-demo.openapi.yaml");
    await expect(extras).toContainText("data/productos.json");
    await expect(extras).toContainText("Escenario deducido pedidos");
    await expect(extras).toContainText("tienda-demo-inestable");
    await win.getByTestId("dialog-import").getByRole("button", { name: "Listo" }).click();

    await expect(win.getByTestId("mock-row-tienda-demo")).toBeVisible();
    await expect(win.getByTestId("mock-state")).toHaveText("Detenido", { timeout: 20_000 });
    await win.getByTestId("mock-toggle").click();
    await expect(win.getByTestId("mock-state")).toHaveText("En marcha", { timeout: 20_000 });
    const url = (await win.getByTestId("mock-url").textContent())!;
    const list = (await (await fetch(`${url}/productos`)).json()) as { data: unknown[] };
    expect(list.data).toHaveLength(3);
    expect((await fetch(`${url}/pedidos/ped_9?mockix_respuesta=410`)).status).toBe(410);
    expect((await fetch(`${url}/pedidos/ped_9`, { headers: { "X-Mockix-Respuesta": "410" } })).status).toBe(410);
    expect(await readdir(join(ws, "chaos"))).toEqual(["tienda-demo.yaml"]);
    expect(await readFile(join(ws, "mocks", "tienda-demo", "mock.yaml"), "utf8")).toContain("contracts/tienda-demo.openapi.yaml");
  } finally {
    await app.close();
  }
});

test("moves a running mock to the trash after confirming, and stops it first", async () => {
  const ws = await exampleWorkspace();
  const { win, app } = await launch({ workspace: ws });
  try {
    const url = await startTienda(win);
    await win.getByTestId("mock-delete").click();
    await expect(win.getByTestId("dialog-delete-mock")).toContainText("mocks/tienda");
    await expect(win.getByTestId("dialog-delete-mock")).toContainText("se detiene primero");
    // Cancelling leaves everything as it was.
    await win.getByTestId("dialog-delete-mock").getByRole("button", { name: "Cancelar" }).click();
    await expect(win.getByTestId("mock-state")).toHaveText("En marcha");

    await win.getByTestId("mock-delete").click();
    await win.getByTestId("delete-mock-confirm").click();
    await expect(win.getByTestId("notice")).toContainText("El mock «tienda» está en la papelera.");
    await expect(win.getByTestId("mock-row-tienda")).toHaveCount(0);
    expect(await readdir(join(ws, "mocks"))).toEqual([]);
    expect(await readFile(join(ws, "mockix.workspace.yaml"), "utf8")).not.toContain("tienda");
    await expect(fetch(`${url}/salud`)).rejects.toThrow();
  } finally {
    await app.close();
  }
});

test("serves a workspace mock in its own process and reloads edits live", async () => {
  const ws = await exampleWorkspace();
  const { app, win } = await launch({ workspace: ws });
  try {
    await expect(win.getByTestId("route-row")).toHaveCount(13);
    const url = await startTienda(win);
    const pid = Number(await win.getByTestId("mock-pid").textContent());
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(await app.evaluate(() => process.pid));

    // A real client outside the app.
    const res = await fetch(`${url}/productos?categoria=ninguna`);
    expect(res.status).toBe(200);
    expect(res.headers.get("server")).toMatch(/^Mockix\/\d+\.\d+\.\d+$/);
    expect(await res.json()).toEqual({ data: [], total: 0 });
    await expect(win.getByTestId("log-row").first()).toContainText("/v1/productos?categoria=ninguna");
    await expect(win.getByTestId("log-row").first()).toContainText("vacio");

    await win.getByTestId("probe-salud").click();
    await expect(win.getByTestId("log-row").first()).toContainText("/v1/salud");
    await expect(win.getByTestId("log-head")).toContainText("200");

    // Templates, CRUD and callbacks.
    const cliente = (await (await fetch(`${url}/clientes/c9`)).json()) as { id: string; tienda: string };
    expect(cliente).toMatchObject({ id: "c9", tienda: "cdmx-centro" });
    expect((await fetch(`${url}/inventario/CAF-VER-500`, { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"stock":1}' })).status).toBe(200);
    await expect(win.getByTestId("log-row").first()).toContainText("CRUD");
    expect((await fetch(`${url}/pedidos`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"cliente":1043,"lineas":[1,2]}' })).status).toBe(201);
    await expect(win.getByTestId("callback-row").first()).toContainText("localhost:4000/webhooks/pedidos", { timeout: 10_000 });

    // Edit a route file: the running mock picks it up without a restart.
    const salud = join(ws, "mocks/tienda/routes/salud.yaml");
    const original = await readFile(salud, "utf8");
    await writeFile(salud, original.replace("servicio: tienda", "servicio: tienda-v2"));
    await expect.poll(async () => ((await (await fetch(`${url}/salud`)).json()) as { servicio: string }).servicio, { timeout: 10_000 }).toBe("tienda-v2");

    // Break it: the problem shows with file and line, and the last good version keeps serving.
    await writeFile(salud, "path: /salud\nresponses:\n  - id: ok\n    status: 42\n");
    await expect(win.getByTestId("mock-problems")).toContainText("mocks/tienda/routes/salud.yaml:4", { timeout: 10_000 });
    await expect(win.getByTestId("mock-problems")).toContainText("responses[0].status");
    expect(((await (await fetch(`${url}/salud`)).json()) as { servicio: string }).servicio).toBe("tienda-v2");
    await win.screenshot({ path: resolve(shots, "m1-problems.png") });

    // Fix it: problems go away and the fix is served.
    await writeFile(salud, original);
    await expect(win.getByTestId("mock-problems")).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(async () => ((await (await fetch(`${url}/salud`)).json()) as { servicio: string }).servicio, { timeout: 10_000 }).toBe("tienda");

    await win.screenshot({ path: resolve(shots, "m1-running-light.png") });
    await win.emulateMedia({ colorScheme: "dark" });
    await win.waitForTimeout(300);
    await win.screenshot({ path: resolve(shots, "m1-running-dark.png") });
    await win.emulateMedia({ colorScheme: "light" });

    await win.getByTestId("mock-toggle").click();
    await expect(win.getByTestId("mock-state")).toHaveText("Detenido");
    await expect(win.getByTestId("mock-pid")).toHaveText("—");
    await expect(fetch(`${url}/salud`)).rejects.toThrow();
  } finally {
    await app.close();
  }
});

test("creates a mock, a route and a response in the editor, tests it and reads the log", async () => {
  const ws = await exampleWorkspace();
  const { app, win } = await launch({ workspace: ws });
  try {
    // New mock through the dialog (port 0: any free one).
    await win.getByTestId("new-mock").click();
    await win.getByTestId("new-mock-empty").click();
    await win.getByTestId("new-mock-name").fill("pagos");
    await win.getByTestId("new-mock-port").fill("0");
    await win.getByTestId("new-mock-prefix").fill("/api");
    await win.getByTestId("new-mock-create").click();
    await expect(win.getByTestId("mock-row-pagos")).toBeVisible();
    expect(await readFile(join(ws, "mocks/pagos/mock.yaml"), "utf8")).toContain("port: 0");

    // New route; it opens in a tab.
    await win.getByTestId("new-route").click();
    await win.getByTestId("new-route-method").selectOption("POST");
    await win.getByTestId("new-route-path").fill("/cobros/:id");
    await win.getByTestId("new-route-create").click();
    await expect(win.getByTestId("tab")).toContainText("/cobros/:id");
    expect(await readFile(join(ws, "mocks/pagos/routes/post-cobros-id.yaml"), "utf8")).toContain("path: /cobros/:id");

    // Edit the response: status, a template body, and a second response with a rule.
    await win.getByTestId("response-status").fill("201");
    const editor = win.getByTestId("body-editor");
    await editor.click();
    await win.keyboard.press("Control+A");
    await win.keyboard.type('{ "cobro": "{{urlParam \'id\'}}", "estado": "aprobado" }');
    await expect(win.getByTestId("tab").locator(".unsaved")).toBeVisible();
    await win.getByTestId("body-preview").click();
    await expect(win.getByTestId("body-preview-view")).toContainText('"cobro": "1"');
    await win.getByTestId("add-response").click();
    await win.getByTestId("response-status").fill("402");
    await win.getByTestId("sub-rules").click();
    await win.getByTestId("add-rule").click();
    await win.getByLabel("Objetivo").fill("params.id");
    await win.getByLabel("Valor").fill("rechazar");
    await win.getByTestId("route-save").click();
    await expect(win.getByTestId("tab").locator(".unsaved")).toHaveCount(0);
    await expect(win.getByTestId("route-source")).toContainText("status: 201");
    const yaml = await readFile(join(ws, "mocks/pagos/routes/post-cobros-id.yaml"), "utf8");
    expect(yaml).toContain("status: 201");
    expect(yaml).toContain("status: 402");
    expect(yaml).toContain("target: params.id");

    // Start the mock from the title bar and test the route: the log shows it with its strata.
    await win.getByRole("button", { name: "Iniciar pagos" }).click();
    await expect(win.getByTestId("route-test")).toBeEnabled({ timeout: 20_000 });
    await win.getByTestId("route-test").click();
    await expect(win.getByTestId("log-row").first()).toContainText("/api/cobros/1");
    await expect(win.getByTestId("log-row").first()).toContainText("201 Created");
    await expect(win.getByTestId("strata")).toContainText("Recepción");
    await expect(win.getByTestId("strata")).toContainText("total");
    await win.getByTestId("log-sub-response").click();
    await expect(win.getByTestId("live-log")).toHaveCount(0);
    await expect(win.locator(".log-pane")).toContainText('"estado": "aprobado"');

    // A real client hits the rule.
    const url = (await win.evaluate(() => window.mockix.mocks.list()))!.find((m) => m.id === "pagos")!.url!;
    expect((await fetch(`${url}/api/cobros/rechazar`, { method: "POST" })).status).toBe(402);

    await win.screenshot({ path: resolve(shots, "m3-editor-light.png") });
    await win.getByTestId("theme-toggle").click();
    await win.waitForTimeout(400);
    await win.screenshot({ path: resolve(shots, "m3-editor-dark.png") });

    // Quick open finds routes of every mock.
    await win.keyboard.press("Control+K");
    await win.getByTestId("quick-open-input").fill("productos id");
    await win.keyboard.press("Enter");
    await expect(win.getByTestId("tab").nth(1)).toContainText("/productos/:id");
    await win.screenshot({ path: resolve(shots, "m3-template-dark.png") });

    // Deleting the route moves it to the trash and closes its tab.
    await win.getByTestId("tab").first().click();
    await win.getByTestId("route-delete").click();
    await expect(win.getByTestId("tab")).toHaveCount(1);
    await expect.poll(async () => readFile(join(ws, "mocks/pagos/routes/post-cobros-id.yaml"), "utf8").then(() => "existe", () => "borrado")).toBe("borrado");
  } finally {
    await app.close();
  }
});

test("imports a Postman collection with its report, and exports a mock as OpenAPI", async () => {
  const ws = await exampleWorkspace();
  const collection = resolve(root, "../../packages/core/test/fixtures/postman-tienda.json");
  const exported = join(await temp("mockix-e2e-export-"), "tienda.openapi.yaml");
  const { app, win } = await launch({ workspace: ws });
  try {
    await app.evaluate(async ({ dialog }, files) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [files.collection] })) as typeof dialog.showOpenDialog;
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: files.exported })) as typeof dialog.showSaveDialog;
    }, { collection, exported });

    await win.getByTestId("import").click();
    await expect(win.getByTestId("dialog-import")).toContainText("tienda-api");
    await expect(win.getByTestId("import-routes")).toHaveText("7");
    await expect(win.getByTestId("import-skipped")).toContainText("tienda.Pagos");
    await win.screenshot({ path: resolve(shots, "m4-import.png") });
    await win.getByRole("button", { name: "Listo" }).click();
    await expect(win.getByTestId("mock-row-tienda-api")).toBeVisible();

    // The imported mock got a free port next to tienda's, and answers like its examples.
    await expect(win.getByTestId("mock-state")).toHaveText("Detenido");
    await win.getByTestId("mock-toggle").click();
    await expect(win.getByTestId("mock-state")).toHaveText("En marcha", { timeout: 20_000 });
    const url = await win.getByTestId("mock-url").textContent();
    expect((await fetch(`${url}/productos/9001`)).status).toBe(404);
    expect(await (await fetch(`${url}/productos?categoria=ninguna`)).json()).toEqual({ data: [], total: 0 });

    await win.getByTestId("mock-row-tienda").click();
    await win.getByTestId("export-openapi").click();
    await expect(win.getByTestId("notice")).toContainText("OpenAPI 3.1 escrito");
    expect(await readFile(exported, "utf8")).toContain("/productos/{id}");
  } finally {
    await app.close();
  }
});

test("records real traffic through the proxy and turns it into a mock without secrets", async () => {
  const ws = await exampleWorkspace();
  const api = createHttpServer((req, res) => {
    const missing = req.url?.includes("9001");
    res.writeHead(missing ? 404 : 200, { "Content-Type": "application/json", "Set-Cookie": "sesion=secreto-real" });
    res.end(JSON.stringify(missing ? { error: "no existe" } : { id: Number(req.url?.split("/").pop()), nombre: "Cosa", token: "tok-real-123" }));
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const { app, win } = await launch({ workspace: ws });
  try {
    await win.getByTestId("rail-recordings").click();
    await win.getByTestId("rec-port").fill("0");
    await win.getByTestId("rec-target").fill(target);
    await win.getByTestId("rec-start").click();
    await expect(win.getByTestId("rec-chip")).toBeVisible({ timeout: 20_000 });
    const proxy = `http://${await win.getByTestId("rec-proxy").textContent()}`;

    // The client talks to the proxy and gets the real answers.
    const first = await fetch(`${proxy}/v1/cosas/7`, { headers: { Authorization: "Bearer secreto-del-cliente" } });
    expect(await first.json()).toEqual({ id: 7, nombre: "Cosa", token: "tok-real-123" });
    await fetch(`${proxy}/v1/cosas/8`);
    expect((await fetch(`${proxy}/v1/cosas/9001`)).status).toBe(404);
    await expect(win.getByTestId("rec-row")).toHaveCount(3);
    await win.getByTestId("rec-stop").click();
    await expect(win.getByTestId("rec-chip")).toHaveCount(0);

    await win.getByTestId("rec-sub-routes").click();
    await win.getByTestId("rec-prefix").fill("/v1");
    await expect(win.getByTestId("rec-plan")).toContainText("/cosas/:id");
    await win.getByTestId("rec-name").fill("real");
    await win.screenshot({ path: resolve(shots, "m5-recordings.png") });
    await win.getByTestId("rec-convert").click();
    await expect(win.getByTestId("dialog-import")).toContainText("real");
    await win.getByRole("button", { name: "Listo" }).click();

    // The new mock answers like the API did, with the secrets replaced.
    await win.getByTestId("rail-mocks").click();
    await win.getByTestId("mock-row-real").click();
    await win.getByTestId("mock-toggle").click();
    await expect(win.getByTestId("mock-state")).toHaveText("En marcha", { timeout: 20_000 });
    const url = await win.getByTestId("mock-url").textContent();
    const body = (await (await fetch(`${url}/cosas/8`)).json()) as { id: number; token: string };
    expect(body.id).toBe(8);
    expect(body.token).not.toBe("tok-real-123");
    expect((await fetch(`${url}/cosas/9001`)).status).toBe(404);

    const routes = join(ws, "mocks/real/routes");
    const text = (await Promise.all((await readdir(routes, { recursive: true })).filter((f) => f.endsWith(".yaml")).map((f) => readFile(join(routes, f), "utf8")))).join("\n");
    expect(text).toContain("/cosas/:id");
    for (const secret of ["tok-real-123", "secreto-real", "secreto-del-cliente"]) expect(text).not.toContain(secret);
  } finally {
    await app.close();
    api.close();
  }
});

test("runs the order scenario and checks requests against the contract", async () => {
  const ws = await exampleWorkspace();
  const exported = join(await temp("mockix-e2e-contract-"), "contrato.xml");
  const { app, win } = await launch({ workspace: ws });
  try {
    await app.evaluate(async ({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
    }, exported);
    const base = await startTienda(win);

    // Scenarios: a request moves ped_1, the UI forces ped_2, the routes answer by state.
    await win.getByTestId("rail-scenarios").click();
    await expect(win.getByTestId("scenario-diagram")).toBeVisible();
    expect(await (await fetch(`${base}/pedidos/ped_1`)).json()).toEqual({ id: "ped_1", estado: "creado" });
    expect(await (await fetch(`${base}/pedidos/ped_1/pago`, { method: "POST" })).json()).toEqual({ id: "ped_1", estado: "pagado" });
    await expect(win.getByTestId("instance-ped_1")).toContainText("pagado");
    await expect(win.getByTestId("instance-ped_1")).toContainText("enviado en");
    await win.getByTestId("instance-ped_1").click();
    await expect(win.getByTestId("scenario-history")).toContainText("POST /v1/pedidos/ped_1/pago · 200");
    await expect(win.getByTestId("scenario-transitions")).toContainText("creado → pagado");

    await win.getByTestId("scenario-force").click();
    await win.getByTestId("force-key").fill("ped_2");
    await win.getByTestId("force-state").selectOption("cancelado");
    await win.getByTestId("force-apply").click();
    await expect(win.getByTestId("instance-ped_2")).toContainText("cancelado");
    expect((await fetch(`${base}/pedidos/ped_2`)).status).toBe(410);
    await win.getByTestId("instance-ped_1").click();
    await win.screenshot({ path: resolve(shots, "m6-scenarios.png") });
    await win.getByTestId("scenario-sub-readers").click();
    await expect(win.getByText("según el estado").first()).toBeVisible();

    // Contract: a client breaks it, the view groups it by rule and client, strict mode rejects.
    await win.getByTestId("rail-contracts").click();
    const order = (cantidad: unknown) =>
      fetch(`${base}/pedidos`, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "app-movil/3.4.1" }, body: JSON.stringify({ lineas: [{ sku: "CAF-VER-500", cantidad }] }) });
    expect((await order("2")).status).toBe(201);
    expect((await order(3)).status).toBe(201);
    await expect(win.getByTestId("contract-rules")).toContainText("body.lineas[].cantidad debe ser integer");
    await expect(win.getByTestId("contract-why")).toContainText('recibido "2", un string');
    await expect(win.getByTestId("contract-clients")).toContainText("app-movil/3.4.1");
    await win.screenshot({ path: resolve(shots, "m6-contracts.png") });

    await win.getByTestId("contract-mode-strict").click();
    await expect.poll(() => readFile(join(ws, "mocks/tienda/mock.yaml"), "utf8")).toContain("mode: strict");
    await expect.poll(async () => (await order("2")).status, { timeout: 10_000 }).toBe(400);

    await win.getByTestId("contract-export").click();
    await expect(win.getByTestId("notice")).toContainText("Informe del contrato escrito");
    const xml = await readFile(exported, "utf8");
    expect(xml).toContain('<testsuite name="contrato tienda"');
    expect(xml).toContain('name="POST /pedidos"><failure');

    await win.getByTestId("contract-sub-coverage").click();
    await expect(win.getByTestId("contract-coverage")).toContainText("sin mock · solo esquema");
  } finally {
    await app.close();
  }
});

test("applies a chaos profile from the UI, shows its effects live and saves edited points", async () => {
  const ws = await exampleWorkspace();
  await writeFile(join(ws, "chaos/prueba.yaml"), "fallos:\n  points:\n    - { t: 0s, latency: 20ms, errorRate: 0.5, errors: [503] }\n");
  const { app, win } = await launch({ workspace: ws });
  try {
    const base = await startTienda(win);
    await win.getByTestId("rail-chaos").click();
    await expect(win.getByTestId("chaos-chart")).toBeVisible();
    await win.getByTestId("chaos-profile-fallos").click();
    await win.getByTestId("chaos-sub-where").click();
    await win.getByTestId("chaos-assign-tienda").selectOption("fallos");
    await expect.poll(() => readFile(join(ws, "mocks/tienda/mock.yaml"), "utf8")).toContain("profile: fallos");

    // The running mock picks the profile up live: about half the answers are injected 503s.
    await expect
      .poll(async () => {
        const statuses = await Promise.all(Array.from({ length: 16 }, () => fetch(`${base}/salud`).then((r) => r.status)));
        return statuses.includes(503) && statuses.includes(200);
      }, { timeout: 10_000 })
      .toBe(true);
    await win.getByTestId("chaos-sub-effects").click();
    await expect(win.getByTestId("chaos-effects")).toContainText("error 503");
    await expect(win.getByTestId("chaos-affected")).toContainText("Afectadas");
    await win.screenshot({ path: resolve(shots, "m7-chaos.png") });

    // Drag the point up (more latency), drop the errors, save: the file and the mock follow.
    const dot = win.getByTestId("chaos-point-0");
    const box = (await dot.boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.down();
    await win.mouse.move(box.x + box.width / 2, box.y - 40, { steps: 5 });
    await win.mouse.up();
    await expect.poll(async () => Number(await win.getByTestId("chaos-latency-0").inputValue())).toBeGreaterThan(20);
    await win.getByTestId("chaos-errors-0").fill("0");
    await win.getByTestId("chaos-save").click();
    await expect.poll(async () => {
      const text = await readFile(join(ws, "chaos/prueba.yaml"), "utf8");
      return text.includes("fallos:") && !text.includes("errorRate");
    }).toBe(true);
    const saved = await readFile(join(ws, "chaos/prueba.yaml"), "utf8");
    expect(saved).toMatch(/- \{ t: 0s, latency: \d+ms(, errors: \[ 503 \])? \}/);
    await expect
      .poll(async () => (await Promise.all(Array.from({ length: 8 }, () => fetch(`${base}/salud`).then((r) => r.status)))).every((st) => st === 200), { timeout: 10_000 })
      .toBe(true);

    await win.getByTestId("chaos-pause").click();
    await expect(win.getByTestId("chaos-pause")).toContainText("Reanudar caos");
  } finally {
    await app.close();
  }
});

test("tests WebSocket, Socket.IO and gRPC routes from their panel", async () => {
  const ws = await exampleWorkspace();
  const { app, win } = await launch({ workspace: ws });
  try {
    const base = await startTienda(win);

    // WebSocket: main connects, the panel sends, the log shows both sides.
    await win.getByTestId("live-notificaciones").click();
    await expect(win.getByTestId("live-url")).toHaveText(`${base.replace("http", "ws")}/notificaciones`);
    await expect(win.getByTestId("live-rules")).toContainText("body.tipo equals");
    await win.getByTestId("live-connect").click();
    await expect(win.getByTestId("live-messages")).toContainText("hola");
    await win.getByTestId("live-text").fill('{ "tipo": "ping" }');
    await win.getByTestId("live-send").click();
    await expect(win.getByTestId("live-messages")).toContainText("pong");
    await win.screenshot({ path: resolve(shots, "m8-websocket.png") });

    // Socket.IO: an event with its ack.
    await win.getByTestId("live-pedidos-en-vivo").click();
    await win.getByTestId("live-connect").click();
    await expect(win.getByTestId("live-messages")).toContainText("conectado");
    await win.getByTestId("live-event").fill("seguir");
    await win.getByTestId("live-text").fill('{ "id": "p1" }');
    await win.getByTestId("live-send").click();
    await expect(win.getByTestId("live-ack")).toContainText('"sala":"pedido:p1"');

    // gRPC: an example request from the schema, then a real call.
    await win.getByTestId("grpc-tienda.Catalogo").click();
    await expect(win.getByTestId("grpc-methods")).toContainText("stream del servidor");
    await expect(win.getByTestId("grpc-address")).toHaveText(/^127\.0\.0\.1:\d+$/);
    await expect.poll(async () => win.getByTestId("grpc-request").inputValue()).toContain('"id"');
    await win.getByTestId("grpc-request").fill('{ "id": "prd_7Qm2" }');
    await win.getByTestId("grpc-call").click();
    await expect(win.getByTestId("grpc-status")).toHaveText("OK");
    await expect(win.getByTestId("grpc-response")).toContainText("Café de Veracruz 500 g");
    await win.getByTestId("grpc-request").fill('{ "id": "9001" }');
    await win.getByTestId("grpc-call").click();
    await expect(win.getByTestId("grpc-status")).toHaveText("NOT_FOUND");
    await win.getByTestId("grpc-method-ListarProductos").click();
    await win.getByTestId("grpc-call").click();
    await expect(win.getByTestId("grpc-response")).toContainText("prd_9Kc1");
    await win.screenshot({ path: resolve(shots, "m8-grpc.png") });
  } finally {
    await app.close();
  }
});

test("lets an agent change the workspace over MCP only with the user's approval", async () => {
  const ws = await exampleWorkspace();
  const { app, win } = await launch({ workspace: ws });
  try {
    await expect(win.getByTestId("status-mcp")).toHaveText("MCP: apagado");
    await win.getByTestId("rail-agents").click();
    await win.getByTestId("mcp-toggle").click();
    await expect(win.getByTestId("mcp-url")).toHaveText(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const state = (await win.evaluate(() => window.mockix.agents.get()))!;
    expect((await fetch(state.url!, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);

    const client = new Client({ name: "agente-de-prueba", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(state.url!), { requestInit: { headers: { Authorization: `Bearer ${state.token}` } } });
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      return { error: res.isError === true, text: res.content[0]!.text };
    };
    try {
      expect(JSON.parse((await call("list_mocks")).text)).toMatchObject([{ name: "tienda", state: "stopped" }]);

      // A write waits for the user.
      const pending = call("upsert_route", { mock: "tienda", route: { method: "GET", path: "/envios/:id", responses: [{ id: "ok", body: { json: { id: "{{urlParam 'id'}}", estado: "en ruta" } } }] } });
      await expect(win.getByTestId("mcp-approval")).toContainText("Un agente quiere crear o cambiar GET /envios/:id en tienda");
      await win.screenshot({ path: resolve(shots, "m9-approval.png") });
      await win.getByTestId("mcp-approve").click();
      const created = await pending;
      expect(created.error).toBe(false);
      expect(await readFile(join(ws, "mocks/tienda/routes/get-envios-id.yaml"), "utf8")).toContain("/envios/:id");

      // It tests the route and reads the log (no approval needed for that).
      expect((await call("start_mock", { mock: "tienda" })).error).toBe(false);
      const res = JSON.parse((await call("send_request", { mock: "tienda", path: "/envios/E-1" })).text) as { status: number; body: string };
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: "E-1", estado: "en ruta" });
      await expect.poll(async () => JSON.parse((await call("query_logs", { mock: "tienda" })).text)[0]?.url).toBe("/v1/envios/E-1");

      // A rejected write changes nothing.
      const del = call("delete_route", { mock: "tienda", route: "salud" });
      await expect(win.getByTestId("mcp-approval")).toContainText("borrar salud de tienda");
      await win.getByTestId("mcp-reject").click();
      expect(await del).toMatchObject({ error: true, text: "El usuario no aprobó: borrar salud de tienda" });
      expect(await readFile(join(ws, "mocks/tienda/routes/salud.yaml"), "utf8")).toContain("/salud");

      await expect(win.getByTestId("mcp-audit")).toContainText("rechazado");
      await expect(win.getByTestId("mcp-audit")).toContainText("crear o cambiar GET /envios/:id en tienda");
      await expect(win.getByTestId("status-mcp")).toHaveText(/^MCP: 127\.0\.0\.1:\d+$/);
      await win.screenshot({ path: resolve(shots, "m9-agents.png") });
      const audit = (await readFile(join(ws, ".mockix/mcp-audit.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { tool: string; outcome: string });
      expect(audit.map((a) => `${a.tool}:${a.outcome}`)).toEqual(expect.arrayContaining(["upsert_route:ok", "delete_route:rejected", "send_request:ok"]));
    } finally {
      await client.close();
    }
  } finally {
    await app.close();
  }
});

test("imports from a mockix:// link only after confirmation, and tells Sendix where the mock runs", async () => {
  const ws = await exampleWorkspace();
  await writeFile(join(ws, "sendix.workspace.json"), '{ "name": "tienda" }\n');
  const collection = resolve(root, "../../packages/core/test/fixtures/postman-tienda.json");
  const link = `mockix://import?collection=${encodeURIComponent(collection)}&workspace=${encodeURIComponent(ws)}`;
  const { app, win } = await launch({ workspace: ws, args: [link] });
  try {
    await expect(win.getByTestId("link-dialog")).toContainText("postman-tienda.json");
    expect(await readdir(join(ws, "mocks"))).toEqual(["tienda"]);
    await win.getByTestId("link-accept").click();
    await expect(win.getByTestId("dialog-import")).toContainText("tienda-api");
    await win.getByRole("button", { name: "Listo" }).click();
    expect(await readdir(join(ws, "mocks"))).toEqual(["tienda", "tienda-api"]);

    await win.getByTestId("mock-row-tienda").click();
    const base = await startTienda(win);
    await expect
      .poll(async () => JSON.parse(await readFile(join(ws, ".mockix/running.json"), "utf8").catch(() => "{}")).mocks?.tienda?.baseUrl)
      .toBe(base);
    const env = JSON.parse(await readFile(join(ws, "environments/Mock tienda.postman_environment.json"), "utf8")) as { name: string; values: Array<{ key: string; value: string }> };
    expect(env.name).toBe("Mock tienda");
    expect(env.values.find((v) => v.key === "baseUrl")!.value).toBe(base);
  } finally {
    await app.close();
  }
});

test("restarts a crashed mock host on the same port", async () => {
  const { app, win } = await launch({ workspace: await exampleWorkspace() });
  try {
    const url = await startTienda(win);
    const firstPid = await win.getByTestId("mock-pid").textContent();
    expect(await win.evaluate(() => window.mockix.mocks.crashHost("tienda"))).toEqual({ ok: true, value: { scheduled: true } });

    await expect(win.getByTestId("mock-restarts")).toHaveText("1", { timeout: 15_000 });
    await expect(win.getByTestId("mock-state")).toHaveText("En marcha", { timeout: 15_000 });
    await expect(win.getByTestId("mock-pid")).not.toHaveText(firstPid ?? "");
    await expect(win.getByTestId("mock-url")).toHaveText(url);
    expect((await fetch(`${url}/salud`)).status).toBe(200);
  } finally {
    await app.close();
  }
});

test("reports a taken port instead of failing silently", async () => {
  const blocker: Server = createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  const port = (blocker.address() as { port: number }).port;
  const { app, win } = await launch({ testMode: false, workspace: await exampleWorkspace(port) });
  try {
    await expect(win.getByTestId("mock-state")).toHaveText("Detenido", { timeout: 20_000 });
    await win.getByTestId("mock-toggle").click();
    await expect(win.getByTestId("mock-state")).toHaveText("Con errores", { timeout: 20_000 });
    await expect(win.getByTestId("mock-error")).toContainText("PORT_IN_USE");
    await expect(win.getByTestId("mock-pid")).toHaveText("—");

    // Test hooks are off outside test mode.
    expect(await win.evaluate(() => window.mockix.mocks.crashHost("tienda"))).toMatchObject({ ok: false, error: { code: "UNKNOWN_METHOD" } });
  } finally {
    await app.close();
    blocker.close();
  }
});

test("keeps the log between launches", async () => {
  const profile = await temp("mockix-e2e-profile-");
  const ws = await exampleWorkspace();
  const first = await launch({ workspace: ws, userData: profile });
  try {
    const url = await startTienda(first.win);
    await fetch(`${url}/productos/9001`);
    await expect(first.win.getByTestId("log-row").first()).toContainText("/v1/productos/9001");
  } finally {
    await first.app.close();
  }
  const second = await launch({ workspace: ws, userData: profile });
  try {
    await expect(second.win.getByTestId("log-row").first()).toContainText("/v1/productos/9001", { timeout: 20_000 });
    await expect(second.win.getByTestId("log-row").first()).toContainText("no-existe");
    await second.win.getByTestId("clear-log").click();
    await expect(second.win.getByTestId("log-row")).toHaveCount(0);
  } finally {
    await second.app.close();
  }
});

test("creates the example workspace and remembers the folder for the next launch", async () => {
  const profile = await temp("mockix-e2e-profile-");
  const target = await temp("mockix-e2e-nuevo-");
  const first = await launch({ userData: profile });
  try {
    await first.win.screenshot({ path: resolve(shots, "m1-welcome.png") });
    await first.app.evaluate(async ({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    }, target);
    await first.win.getByTestId("create-example").click();
    await expect(first.win.getByTestId("mock-row-tienda")).toBeVisible();
    await expect(first.win.getByTestId("workspace-dir")).toHaveText(target.split(/[\\/]/).at(-1)!);
    expect(await readFile(join(target, "mockix.workspace.yaml"), "utf8")).toContain("format: 1");
  } finally {
    await first.app.close();
  }

  const second = await launch({ userData: profile });
  try {
    await expect(second.win.getByTestId("mock-row-tienda")).toBeVisible({ timeout: 20_000 });
    await expect(second.win.getByTestId("workspace-dir")).toHaveText(target.split(/[\\/]/).at(-1)!);
  } finally {
    await second.app.close();
  }
});
