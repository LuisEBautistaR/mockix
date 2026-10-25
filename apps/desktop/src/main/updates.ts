/**
 * Auto-update from GitHub Releases with electron-updater: packaged builds
 * check a few seconds after start and when asked from Ajustes, download in
 * the background and install on restart (or on quit).
 */
import { EventEmitter } from "node:events";
import { app } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateState } from "@shared/ipc";

type Events = { changed: [UpdateState] };

export class UpdateService extends EventEmitter<Events> {
  #state: UpdateState = { status: app.isPackaged ? "idle" : "disabled", version: null, percent: null, message: null, checkedAt: null };
  readonly #log: (message: string, detail?: unknown) => void;

  constructor(log: (message: string, detail?: unknown) => void) {
    super();
    this.#log = log;
    if (!app.isPackaged) return;
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on("checking-for-update", () => this.#set({ status: "checking", message: null }));
    autoUpdater.on("update-available", (info) => this.#set({ status: "downloading", version: info.version, percent: 0 }));
    autoUpdater.on("update-not-available", () => this.#set({ status: "current", checkedAt: Date.now() }));
    autoUpdater.on("download-progress", (p) => this.#set({ status: "downloading", percent: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (info) => this.#set({ status: "ready", version: info.version, percent: 100, checkedAt: Date.now() }));
    autoUpdater.on("error", (err) => {
      this.#log("update check failed", err);
      this.#set({ status: "error", message: "No se pudo consultar GitHub Releases (sin conexión o sin versiones publicadas)", checkedAt: Date.now() });
    });
  }

  get state(): UpdateState {
    return { ...this.#state };
  }

  #set(patch: Partial<UpdateState>): void {
    this.#state = { ...this.#state, ...patch };
    this.emit("changed", this.state);
  }

  /** First check, a little after start so it never slows the window down. */
  start(): void {
    if (!app.isPackaged) return;
    setTimeout(() => void this.check(), 8_000).unref();
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged) return this.state;
    try {
      await electronUpdater.autoUpdater.checkForUpdates();
    } catch {
      // reported through the "error" event
    }
    return this.state;
  }

  install(): void {
    if (this.#state.status === "ready") electronUpdater.autoUpdater.quitAndInstall();
  }
}
