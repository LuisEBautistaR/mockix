import { app, BrowserWindow, nativeTheme, safeStorage } from "electron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDevelopmentCsp, registerAppScheme, serveRenderer } from "./protocol";
import { denyPermissions, hardenApp, setDevelopmentOrigin } from "./security";
import { WorkspaceEditor } from "./editor";
import { Insight } from "./insight";
import { LiveTester } from "./live";
import { AgentsService, type AgentsSettings } from "./agents";
import { LinkService } from "./links";
import { UpdateService } from "./updates";
import { publishRunning, type RunningMock } from "@mockix/core";
import { Recorder } from "./recorder";
import { LogStore } from "./log-store";
import { MockManager } from "./mock-manager";
import { registerIpcRouter } from "./ipc-router";
import { SettingsStore } from "./settings";
import { WorkspaceService } from "./workspace";
import { createMainWindow } from "./window";

const mainDir = dirname(fileURLToPath(import.meta.url));
const devUrl = !app.isPackaged ? (process.env["ELECTRON_RENDERER_URL"] ?? null) : null;
/** Test hooks (e.g. crashing a mock host on purpose) exist only in unpackaged builds started with MOCKIX_TEST=1. */
const testMode = !app.isPackaged && process.env["MOCKIX_TEST"] === "1";
/** Unpackaged builds can be pointed at a workspace and an isolated profile (tests, development). */
const envWorkspace = !app.isPackaged ? (process.env["MOCKIX_WORKSPACE"] ?? null) : null;
if (!app.isPackaged && process.env["MOCKIX_USER_DATA"]) app.setPath("userData", process.env["MOCKIX_USER_DATA"]);

const log = (message: string, detail?: unknown): void => {
  if (detail === undefined) console.log(`[main] ${message}`);
  else console.error(`[main] ${message}`, detail);
};

// No fuse covers Chromium's debugging switches: a packaged build refuses to run with them.
const DEBUG_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "remote-allow-origins"];
const debugging = DEBUG_SWITCHES.some((s) => app.commandLine.hasSwitch(s) || process.argv.some((arg) => arg === `--${s}` || arg.startsWith(`--${s}=`)));
if (app.isPackaged && debugging) {
  console.error("Mockix no se ejecuta con opciones de depuración remota.");
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerAppScheme();
  hardenApp();
  setDevelopmentOrigin(devUrl);

  const mocks = new MockManager({ hostEntry: join(mainDir, "host.js"), testMode, log });
  const workspace = new WorkspaceService(log);
  const recorder = new Recorder(workspace, join(mainDir, "host.js"), log);
  const live = new LiveTester(workspace, mocks);
  const links = new LinkService(log);
  const updates = new UpdateService(log);
  if (app.isPackaged) app.setAsDefaultProtocolClient("mockix");
  const firstLink = LinkService.fromArgv(process.argv);

  // .mockix/running.json (and Sendix environments) follow the running mocks.
  let publishTimer: NodeJS.Timeout | null = null;
  const publish = () => {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      const dir = workspace.state.dir;
      if (!dir) return;
      const running: Record<string, RunningMock> = {};
      for (const m of mocks.list()) {
        if (m.state !== "running" || !m.url) continue;
        running[m.id] = { url: m.url, prefix: m.prefix, baseUrl: `${m.url}${m.prefix}`, grpc: m.grpcPort ? `${m.host}:${m.grpcPort}` : null };
      }
      void publishRunning(dir, running, "escritorio").catch((err: unknown) => log("could not write running.json", err));
    }, 300);
  };
  mocks.on("status", publish);
  mocks.on("list", publish);
  workspace.on("changed", (load) => void mocks.setWorkspace(load));
  let mainWindow: BrowserWindow | null = null;
  let agents: AgentsService | null = null;
  let quitting = false;

  app.on("second-instance", (_event, argv) => {
    const link = LinkService.fromArgv(argv);
    if (link) void links.handle(link);
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    denyPermissions();
    serveRenderer(join(mainDir, "../renderer"));
    if (devUrl) applyDevelopmentCsp(devUrl);

    const settings = new SettingsStore(app.getPath("userData"));
    const saved = await settings.load();
    nativeTheme.themeSource = saved.theme ?? "system";
    const initial = envWorkspace ?? (saved.lastWorkspace && existsSync(saved.lastWorkspace) ? saved.lastWorkspace : null);
    if (initial) await workspace.open(initial);

    const logs = new LogStore(app.getPath("userData"));
    app.on("will-quit", () => logs.close());
    // The MCP token is kept encrypted with the OS keystore (DPAPI on Windows) when it is available.
    const readToken = (stored: string | undefined) => {
      if (!stored) return "";
      if (stored.startsWith("enc:")) {
        try {
          return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
        } catch {
          return "";
        }
      }
      return stored.replace(/^plain:/, "");
    };
    const writeToken = (token: string) => (safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(token).toString("base64")}` : `plain:${token}`);
    agents = new AgentsService(
      { workspace, mocks, logs, recorder },
      {
        version: app.getVersion(),
        settings: { ...(saved.mcp ? { enabled: saved.mcp.enabled, port: saved.mcp.port, token: readToken(saved.mcp.token) } : {}) },
        save: (s: AgentsSettings) => settings.update({ mcp: { enabled: s.enabled, port: s.port, token: writeToken(s.token) } }),
      },
    );
    await agents.init();
    registerIpcRouter({
      mocks,
      workspace,
      editor: new WorkspaceEditor(workspace),
      recorder,
      insight: new Insight(workspace, mocks),
      live,
      agents,
      updates,
      links,
      logs,
      rememberWorkspace: (dir) => settings.update({ lastWorkspace: dir }),
      rememberTheme: (theme) => settings.update({ theme }),
      testMode,
    });
    mainWindow = createMainWindow(join(mainDir, "../preload/index.cjs"), devUrl);
    mainWindow.on("closed", () => (mainWindow = null));
    updates.start();
    if (firstLink) mainWindow.webContents.once("did-finish-load", () => void links.handle(firstLink));
  });

  app.on("window-all-closed", () => app.quit());
  // Stop every mock (and free its port) before the app goes away.
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    workspace.close();
    live.closeAll();
    void Promise.all([mocks.stopAll(), recorder.stop(), agents?.stop()]).finally(() => app.quit());
  });
}
