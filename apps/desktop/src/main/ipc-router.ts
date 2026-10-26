import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from "electron";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { MOCK_FILE, WORKSPACE_FILE, WorkspaceExistsError, writeEmptyWorkspace, writeExampleWorkspace } from "@mockix/core";
import { ErrorCodes, type Outcome } from "@shared/rpc";
import { IpcChannels, type AppInfo, type Theme, type WorkspaceState } from "@shared/ipc";
import type { RouteDraft } from "@mockix/core";
import type { WorkspaceEditor } from "./editor";
import type { Insight } from "./insight";
import type { LiveTester } from "./live";
import type { AgentsService } from "./agents";
import type { LinkService } from "./links";
import type { UpdateService } from "./updates";
import type { LogStore } from "./log-store";
import type { Recorder } from "./recorder";
import type { MockManager } from "./mock-manager";
import type { WorkspaceService } from "./workspace";
import { isTrustedSender } from "./security";

const forbidden: Outcome<never> = { ok: false, error: { code: ErrorCodes.forbidden, message: "Untrusted sender" } };
const invalid = (message: string): Outcome<never> => ({ ok: false, error: { code: ErrorCodes.invalidParams, message } });
const mockId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** A path inside the mock: starts with "/", no scheme or host can be smuggled in. */
const probePath = z.string().max(2048).regex(/^\/(?!\/)[^\s#]*$/);
const testRequest = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  path: probePath,
  headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), z.string().max(8192)).optional(),
  body: z.string().max(1024 * 1024).optional(),
});
const routeId = z.string().regex(/^[a-z0-9][a-z0-9_/-]{0,127}$/);
const folder = z.string().max(200).regex(/^[a-z0-9_/-]*$/i);
/** Shape check only; the core validates every field before anything is written. */
const routeDraft = z
  .object({ path: z.string().max(2048) })
  .passthrough()
  .refine((d) => JSON.stringify(d).length < 5 * 1024 * 1024, "The route is too large");
const theme = z.enum(["system", "light", "dark"]);

type Guarded = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<Outcome<unknown>> | Outcome<unknown>;

/** Checks the sender and the mock id before any handler runs. */
function withMock(handler: (id: string, ...rest: unknown[]) => Promise<Outcome<unknown>>): Guarded {
  return (event, rawId, ...rest) => {
    if (!isTrustedSender(event.senderFrame)) return forbidden;
    const id = mockId.safeParse(rawId);
    if (!id.success) return invalid("Invalid mock id");
    return handler(id.data, ...rest);
  };
}

export interface RouterDeps {
  mocks: MockManager;
  workspace: WorkspaceService;
  editor: WorkspaceEditor;
  recorder: Recorder;
  insight: Insight;
  live: LiveTester;
  agents: AgentsService;
  updates: UpdateService;
  links: LinkService;
  logs: LogStore;
  /** Persists the theme for the next launch. */
  rememberTheme(theme: Theme): Promise<void>;
  /** Remembers the folder for the next launch. */
  rememberWorkspace(dir: string): Promise<void>;
  testMode: boolean;
}

/** The renderer's only door to main: named channels, trusted sender, validated arguments. */
export function registerIpcRouter({ mocks, workspace, editor, recorder, insight, live, agents, updates, links, logs, rememberWorkspace, rememberTheme, testMode }: RouterDeps): void {
  const broadcast = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };

  const pickFolder = async (title: string, create: boolean): Promise<string | null> => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = { title, properties: create ? ["openDirectory", "createDirectory"] : ["openDirectory"] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };

  const openFolder = async (dir: string): Promise<Outcome<WorkspaceState>> => {
    if (!existsSync(join(dir, WORKSPACE_FILE))) {
      // A mock's own folder is not a workspace: point at the one that holds it instead of nesting mocks in it.
      if (existsSync(join(dir, MOCK_FILE))) {
        const parent = dirname(dir);
        const where = basename(parent) === "mocks" ? `abre ${dirname(parent)}` : "abre la carpeta que contiene su carpeta mocks/";
        return { ok: false, error: { code: ErrorCodes.notWorkspace, message: `Esa carpeta es el mock «${basename(dir)}», no un workspace: ${where}.` } };
      }
      // Any other folder becomes an empty workspace; mocks already under mocks/ load as they are.
      await writeEmptyWorkspace(dir);
    }
    await workspace.open(dir);
    await rememberWorkspace(dir);
    return { ok: true, value: workspace.state };
  };

  ipcMain.handle(IpcChannels.workspaceGet, (event) => (isTrustedSender(event.senderFrame) ? workspace.state : null));

  ipcMain.handle(IpcChannels.workspaceOpen, async (event): Promise<Outcome<WorkspaceState | null>> => {
    if (!isTrustedSender(event.senderFrame)) return forbidden;
    const dir = await pickFolder("Abrir carpeta de trabajo", false);
    return dir ? openFolder(dir) : { ok: true, value: null };
  });

  ipcMain.handle(IpcChannels.workspaceCreateExample, async (event): Promise<Outcome<WorkspaceState | null>> => {
    if (!isTrustedSender(event.senderFrame)) return forbidden;
    const dir = await pickFolder("Carpeta para el workspace de ejemplo", true);
    if (!dir) return { ok: true, value: null };
    try {
      await writeExampleWorkspace(dir);
    } catch (err) {
      if (err instanceof WorkspaceExistsError) return { ok: false, error: { code: ErrorCodes.workspaceExists, message: "That folder already has a Mockix workspace" } };
      throw err;
    }
    return openFolder(dir);
  });

  ipcMain.handle(IpcChannels.mocksList, (event) => (isTrustedSender(event.senderFrame) ? mocks.list() : null));
  ipcMain.handle(IpcChannels.mocksStart, withMock((id) => mocks.start(id)));
  ipcMain.handle(IpcChannels.mocksStop, withMock((id) => mocks.stop(id)));
  ipcMain.handle(
    IpcChannels.mocksSend,
    withMock(async (id, raw) => {
      const test = testRequest.safeParse(raw);
      return test.success ? mocks.send(id, test.data) : invalid("Invalid test request");
    }),
  );
  ipcMain.handle(IpcChannels.mocksCreate, async (event, rawName, rawPort, rawPrefix): Promise<Outcome<null>> => {
    if (!isTrustedSender(event.senderFrame)) return forbidden;
    const name = mockId.safeParse(rawName);
    const port = z.number().int().min(0).max(65535).safeParse(rawPort);
    const prefix = z.string().max(200).safeParse(rawPrefix ?? "");
    if (!name.success || !port.success || !prefix.success) return invalid("Invalid mock settings");
    return editor.createMock(name.data, port.data, prefix.data);
  });
  ipcMain.handle(
    IpcChannels.routesRead,
    withMock(async (id, rawRoute) => {
      const route = routeId.safeParse(rawRoute);
      return route.success ? editor.read(id, route.data) : invalid("Invalid route id");
    }),
  );
  ipcMain.handle(
    IpcChannels.routesWrite,
    withMock(async (id, rawRoute, rawDraft, rawFolder) => {
      const route = rawRoute === null ? { success: true as const, data: null } : routeId.safeParse(rawRoute);
      const draft = routeDraft.safeParse(rawDraft);
      const dir = folder.safeParse(rawFolder ?? "");
      if (!route.success || !draft.success || !dir.success) return invalid("Invalid route");
      return editor.write(id, route.data, draft.data as unknown as RouteDraft, dir.data);
    }),
  );
  ipcMain.handle(
    IpcChannels.routesDelete,
    withMock(async (id, rawRoute) => {
      const route = routeId.safeParse(rawRoute);
      return route.success ? editor.remove(id, route.data) : invalid("Invalid route id");
    }),
  );
  ipcMain.handle(
    IpcChannels.routesPreview,
    withMock(async (id, rawMethod, rawPattern, rawText) => {
      const parsed = z.tuple([z.string().max(10), z.string().max(2048), z.string().max(2 * 1024 * 1024)]).safeParse([rawMethod, rawPattern, rawText]);
      return parsed.success ? editor.preview(id, ...parsed.data) : invalid("Invalid preview");
    }),
  );
  const recordingFile = z.string().regex(/^[A-Za-z0-9._-]+\.jsonl$/);
  const trusted = (event: Electron.IpcMainInvokeEvent) => isTrustedSender(event.senderFrame);
  ipcMain.handle(IpcChannels.recordingsList, async (event) => (trusted(event) ? recorder.list() : null));
  ipcMain.handle(IpcChannels.recordingsStatus, (event) => (trusted(event) ? recorder.status : null));
  ipcMain.handle(IpcChannels.recordingsStart, async (event, rawTarget, rawPort) => {
    if (!trusted(event)) return forbidden;
    const target = z.url({ protocol: /^https?$/ }).safeParse(rawTarget);
    const port = z.number().int().min(0).max(65535).safeParse(rawPort);
    if (!target.success || !port.success) return invalid("Invalid target or port");
    return recorder.start(target.data.replace(/\/+$/, ""), port.data);
  });
  ipcMain.handle(IpcChannels.recordingsStop, async (event) => (trusted(event) ? recorder.stop() : forbidden));
  ipcMain.handle(IpcChannels.recordingsExchanges, async (event, raw) => {
    if (!trusted(event)) return forbidden;
    const file = recordingFile.safeParse(raw);
    return file.success ? recorder.exchanges(file.data) : invalid("Invalid recording");
  });
  ipcMain.handle(IpcChannels.recordingsPlan, async (event, raw, rawInto, rawPrefix) => {
    if (!trusted(event)) return forbidden;
    const file = recordingFile.safeParse(raw);
    const into = rawInto === null ? { success: true as const, data: null } : mockId.safeParse(rawInto);
    const prefix = z.string().max(200).regex(/^(\/[^/\s?#]+)*$/).safeParse(rawPrefix ?? "");
    if (!file.success || !into.success || !prefix.success) return invalid("Invalid plan request");
    return recorder.plan(file.data, into.data, prefix.data);
  });
  ipcMain.handle(IpcChannels.recordingsPreview, async (event, raw, rawIndex, rawPrefix) => {
    if (!trusted(event)) return forbidden;
    const file = recordingFile.safeParse(raw);
    const index = z.number().int().min(0).safeParse(rawIndex);
    const prefix = z.string().max(200).regex(/^(\/[^/\s?#]+)*$/).safeParse(rawPrefix ?? "");
    if (!file.success || !index.success || !prefix.success) return invalid("Invalid preview request");
    return recorder.preview(file.data, index.data, prefix.data);
  });
  ipcMain.handle(IpcChannels.recordingsConvert, async (event, raw, rawTarget, rawPrefix) => {
    if (!trusted(event)) return forbidden;
    const file = recordingFile.safeParse(raw);
    const target = z.union([z.object({ name: mockId }).strict(), z.object({ into: mockId }).strict()]).safeParse(rawTarget);
    const prefix = z.string().max(200).regex(/^(\/[^/\s?#]+)*$/).safeParse(rawPrefix ?? "");
    if (!file.success || !target.success || !prefix.success) return invalid("Invalid conversion");
    return recorder.convert(file.data, target.data, prefix.data);
  });
  ipcMain.handle(IpcChannels.recordingsDelete, async (event, raw) => {
    if (!trusted(event)) return forbidden;
    const file = recordingFile.safeParse(raw);
    return file.success ? recorder.remove(file.data) : invalid("Invalid recording");
  });
  recorder.on("status", (status) => broadcast(IpcChannels.recordingStatusChanged, status));
  recorder.on("exchange", (ex) => broadcast(IpcChannels.recordingExchange, ex));

  ipcMain.handle(IpcChannels.workspaceImport, async (event) => {
    if (!isTrustedSender(event.senderFrame)) return forbidden;
    if (!workspace.state.dir) return { ok: false, error: { code: ErrorCodes.noWorkspace, message: "No workspace is open" } };
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = {
      title: "Importar a un mock nuevo",
      properties: ["openFile"],
      filters: [
        { name: "OpenAPI, Postman, HAR o Mockoon", extensions: ["json", "yaml", "yml", "har"] },
        { name: "Todos los archivos", extensions: ["*"] },
      ],
    };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, value: null };
    return editor.importFile(picked.filePaths[0]);
  });
  ipcMain.handle(
    IpcChannels.mocksExport,
    withMock(async (id) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options: Electron.SaveDialogOptions = { title: "Exportar como OpenAPI 3.1", defaultPath: `${id}.openapi.yaml`, filters: [{ name: "OpenAPI (YAML)", extensions: ["yaml", "yml"] }] };
      const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { ok: true, value: null };
      return editor.exportOpenApi(id, picked.filePath);
    }),
  );
  ipcMain.handle(IpcChannels.clipboardWrite, (event, raw): Outcome<null> => {
    if (!isTrustedSender(event.senderFrame)) return forbidden;
    const text = z.string().max(5 * 1024 * 1024).safeParse(raw);
    if (!text.success) return invalid("Invalid text");
    clipboard.writeText(text.data);
    return { ok: true, value: null };
  });
  ipcMain.handle(IpcChannels.themeGet, (event): Theme | null => (isTrustedSender(event.senderFrame) ? (nativeTheme.themeSource as Theme) : null));
  ipcMain.handle(IpcChannels.themeSet, async (event, raw): Promise<Outcome<Theme>> => {
    if (!isTrustedSender(event.senderFrame)) return forbidden;
    const value = theme.safeParse(raw);
    if (!value.success) return invalid("Invalid theme");
    nativeTheme.themeSource = value.data;
    await rememberTheme(value.data);
    return { ok: true, value: value.data };
  });
  ipcMain.handle(
    IpcChannels.mocksCrashHost,
    withMock(async (id) =>
      testMode ? mocks.crashHost(id) : { ok: false, error: { code: ErrorCodes.unknownMethod, message: "Test hooks are disabled" } },
    ),
  );

  ipcMain.handle(
    IpcChannels.logsRecent,
    withMock(async (id, rawLimit) => {
      const limit = z.number().int().min(1).max(1000).safeParse(rawLimit);
      return limit.success ? { ok: true, value: logs.recent(id, limit.data) } : invalid("Invalid limit");
    }),
  );
  ipcMain.handle(
    IpcChannels.logsClear,
    withMock(async (id) => {
      logs.clear(id);
      return { ok: true, value: null };
    }),
  );

  const violation = z.object({
    side: z.enum(["request", "response"]),
    operation: z.string().max(2048),
    where: z.string().max(512),
    rule: z.string().max(2048),
    message: z.string().max(4096),
    status: z.number().int().min(100).max(599).optional(),
  });
  const scenarioId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
  ipcMain.handle(IpcChannels.contractsGet, withMock((id) => insight.contract(id)));
  ipcMain.handle(
    IpcChannels.contractsSchema,
    withMock(async (id, raw) => {
      const v = violation.safeParse(raw);
      return v.success ? insight.schema(id, v.data as never) : invalid("Invalid violation");
    }),
  );
  ipcMain.handle(
    IpcChannels.contractsSetMode,
    withMock(async (id, raw) => {
      const mode = z.enum(["off", "warn", "strict"]).safeParse(raw);
      return mode.success ? insight.setMode(id, mode.data) : invalid("Invalid contract mode");
    }),
  );
  ipcMain.handle(
    IpcChannels.contractsExport,
    withMock(async (id) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options: Electron.SaveDialogOptions = {
        title: "Exportar violaciones del contrato",
        defaultPath: `${id}.contrato.xml`,
        filters: [
          { name: "JUnit (XML)", extensions: ["xml"] },
          { name: "JSON", extensions: ["json"] },
        ],
      };
      const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { ok: true, value: null };
      return insight.exportReport(id, picked.filePath);
    }),
  );
  ipcMain.handle(IpcChannels.contractsClear, withMock((id) => insight.clear(id)));
  ipcMain.handle(IpcChannels.scenariosGet, withMock((id) => insight.scenarios(id)));
  ipcMain.handle(
    IpcChannels.scenariosSet,
    withMock(async (id, rawScenario, rawKey, rawState) => {
      const parsed = z.tuple([scenarioId, z.string().max(512), z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)]).safeParse([rawScenario, rawKey, rawState]);
      return parsed.success ? insight.setScenario(id, ...parsed.data) : invalid("Invalid scenario state");
    }),
  );
  ipcMain.handle(
    IpcChannels.scenariosReset,
    withMock(async (id, raw) => {
      const scenario = scenarioId.nullable().safeParse(raw ?? null);
      return scenario.success ? insight.resetScenario(id, scenario.data) : invalid("Invalid scenario");
    }),
  );

  ipcMain.handle(IpcChannels.chaosGet, async (event) => (trusted(event) ? insight.chaos() : forbidden));
  const point = z.object({
    tMs: z.number().min(0).max(86_400_000),
    latencyMs: z.number().min(0).max(300_000),
    jitterMs: z.number().min(0).max(300_000),
    errorRate: z.number().min(0).max(1),
    errors: z.array(z.object({ status: z.number().int().min(400).max(599), weight: z.number().positive().max(1000) })).max(20),
  });
  const draft = z.object({
    description: z.string().max(500).nullable(),
    loop: z.boolean(),
    durationMs: z.number().min(0).max(86_400_000).nullable(),
    points: z.array(point).min(1).max(200),
    extras: z.object({ dropRate: z.number().min(0).max(1), timeoutRate: z.number().min(0).max(1), trickleKBps: z.number().positive().max(1_000_000).nullable() }),
  });
  ipcMain.handle(IpcChannels.chaosSave, async (event, rawName, rawDraft) => {
    if (!trusted(event)) return forbidden;
    const name = scenarioId.safeParse(rawName);
    const value = draft.safeParse(rawDraft);
    return name.success && value.success ? insight.saveChaosProfile(name.data, value.data) : invalid("Invalid chaos profile");
  });
  ipcMain.handle(
    IpcChannels.chaosAssign,
    withMock(async (id, raw) => {
      const profile = scenarioId.nullable().safeParse(raw ?? null);
      return profile.success ? insight.assignChaos(id, profile.data) : invalid("Invalid chaos profile");
    }),
  );
  ipcMain.handle(
    IpcChannels.chaosPause,
    withMock(async (id, raw) => (typeof raw === "boolean" ? insight.chaosControl(id, raw ? "pause" : "resume") : invalid("Invalid pause flag"))),
  );
  ipcMain.handle(IpcChannels.chaosRestart, withMock((id) => insight.chaosControl(id, "restart")));

  const liveFile = z.string().max(300).regex(/^(routes|grpc)\/[A-Za-z0-9_./-]+\.yaml$/).refine((f) => !f.includes(".."), "Invalid file");
  const realtimeId = z.string().regex(/^[a-z0-9][a-z0-9_/-]{0,127}$/);
  const grpcName = z.string().regex(/^[A-Za-z_][\w.]{0,200}$/);
  ipcMain.handle(
    IpcChannels.liveSource,
    withMock(async (id, raw) => {
      const file = liveFile.safeParse(raw);
      return file.success ? live.source(id, file.data) : invalid("Invalid file");
    }),
  );
  ipcMain.handle(
    IpcChannels.liveConnect,
    withMock(async (id, raw) => {
      const route = realtimeId.safeParse(raw);
      return route.success ? live.connect(id, route.data) : invalid("Invalid route");
    }),
  );
  ipcMain.handle(
    IpcChannels.liveSend,
    withMock(async (id, rawRoute, rawText, rawEvent) => {
      const parsed = z.tuple([realtimeId, z.string().max(1024 * 1024), z.string().max(200).nullable()]).safeParse([rawRoute, rawText, rawEvent ?? null]);
      return parsed.success ? live.send(id, ...parsed.data) : invalid("Invalid message");
    }),
  );
  ipcMain.handle(
    IpcChannels.liveDisconnect,
    withMock(async (id, raw) => {
      const route = realtimeId.safeParse(raw);
      return route.success ? live.disconnect(id, route.data) : invalid("Invalid route");
    }),
  );
  ipcMain.handle(
    IpcChannels.grpcExample,
    withMock(async (id, rawService, rawMethod) => {
      const parsed = z.tuple([grpcName, grpcName]).safeParse([rawService, rawMethod]);
      return parsed.success ? live.example(id, ...parsed.data) : invalid("Invalid method");
    }),
  );
  ipcMain.handle(
    IpcChannels.grpcCall,
    withMock(async (id, rawService, rawMethod, rawText) => {
      const parsed = z.tuple([grpcName, grpcName, z.string().max(4 * 1024 * 1024)]).safeParse([rawService, rawMethod, rawText]);
      return parsed.success ? live.call(id, ...parsed.data) : invalid("Invalid call");
    }),
  );

  ipcMain.handle(IpcChannels.agentsGet, (event) => (trusted(event) ? agents.state : null));
  ipcMain.handle(IpcChannels.agentsSetEnabled, async (event, raw) => {
    if (!trusted(event)) return forbidden;
    if (typeof raw !== "boolean") return invalid("Invalid switch");
    return { ok: true, value: await agents.setEnabled(raw) };
  });
  ipcMain.handle(IpcChannels.agentsSetTrust, (event, raw) => {
    if (!trusted(event)) return forbidden;
    if (typeof raw !== "boolean") return invalid("Invalid switch");
    return { ok: true, value: agents.setTrust(raw) };
  });
  ipcMain.handle(IpcChannels.agentsDecide, (event, rawId, rawDecision) => {
    if (!trusted(event)) return forbidden;
    const parsed = z.tuple([z.string().uuid(), z.enum(["approve", "reject", "trust"])]).safeParse([rawId, rawDecision]);
    if (!parsed.success) return invalid("Invalid decision");
    return agents.decide(...parsed.data) ? { ok: true, value: null } : { ok: false, error: { code: ErrorCodes.notFound, message: "That request is no longer waiting" } };
  });
  ipcMain.handle(IpcChannels.agentsRotate, async (event) => (trusted(event) ? { ok: true, value: await agents.rotateToken() } : forbidden));
  agents.on("changed", (state) => broadcast(IpcChannels.agentsChanged, state));

  ipcMain.handle(IpcChannels.updatesGet, (event) => (trusted(event) ? updates.state : null));
  ipcMain.handle(IpcChannels.updatesCheck, async (event) => (trusted(event) ? { ok: true, value: await updates.check() } : forbidden));
  ipcMain.handle(IpcChannels.updatesInstall, (event) => {
    if (!trusted(event)) return forbidden;
    updates.install();
    return { ok: true, value: null };
  });
  updates.on("changed", (state) => broadcast(IpcChannels.updatesChanged, state));

  ipcMain.handle(IpcChannels.linksPending, (event) => (trusted(event) ? links.pending() : null));
  links.on("request", (request) => broadcast(IpcChannels.linkRequest, request));
  ipcMain.handle(IpcChannels.linkDecide, async (event, rawId, rawAccept) => {
    if (!trusted(event)) return forbidden;
    const parsed = z.tuple([z.string().uuid(), z.boolean()]).safeParse([rawId, rawAccept]);
    if (!parsed.success) return invalid("Invalid decision");
    const request = links.take(parsed.data[0]);
    if (!request) return { ok: false, error: { code: ErrorCodes.notFound, message: "That link is no longer waiting" } };
    if (!parsed.data[1]) return { ok: true, value: null };
    if (request.workspace && request.workspace !== workspace.state.dir) await openFolder(request.workspace);
    if (request.kind === "open") return { ok: true, value: null };
    return editor.importFile(request.collection!);
  });

  // "Abrir en Sendix": only when Sendix registered its protocol, and only on the user's click.
  const sendixInstalled = () => process.platform === "win32" && app.getApplicationNameForProtocol("sendix://") !== "";
  const sendixRequest = z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
    url: z.string().max(4096).regex(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|[\w.-]+)(:\d+)?\//),
    headers: z.record(z.string().max(200), z.string().max(4096)).optional(),
    body: z.string().max(64 * 1024).optional(),
  });
  ipcMain.handle(IpcChannels.sendixAvailable, (event) => (trusted(event) ? sendixInstalled() : false));
  ipcMain.handle(IpcChannels.sendixOpen, async (event, raw) => {
    if (!trusted(event)) return forbidden;
    const req = sendixRequest.safeParse(raw);
    if (!req.success) return invalid("Invalid request");
    if (!sendixInstalled()) return { ok: false, error: { code: ErrorCodes.notFound, message: "Sendix no está instalado" } };
    const q = new URLSearchParams({ method: req.data.method, url: req.data.url });
    if (req.data.body) q.set("body", req.data.body);
    if (req.data.headers && Object.keys(req.data.headers).length) q.set("headers", JSON.stringify(req.data.headers));
    await shell.openExternal(`sendix://request?${q.toString()}`);
    return { ok: true, value: null };
  });

  ipcMain.handle(IpcChannels.appInfo, (event): AppInfo | null => {
    if (!isTrustedSender(event.senderFrame)) return null;
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
    };
  });

  workspace.on("changed", () => broadcast(IpcChannels.workspaceChanged, workspace.state));
  mocks.on("list", (list) => broadcast(IpcChannels.mocksChanged, list));
  mocks.on("status", (status) => broadcast(IpcChannels.mockStatusChanged, status));
  mocks.on("request", (event) => {
    logs.add(event.mockId, event.entry);
    broadcast(IpcChannels.mockRequest, event);
  });
  mocks.on("callback", (event) => {
    logs.addCallback(event.mockId, event.entry);
    broadcast(IpcChannels.mockCallback, event);
  });
  mocks.on("message", (event) => broadcast(IpcChannels.mockMessage, event));
}
