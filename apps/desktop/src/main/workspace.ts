import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { loadWorkspace, watchWorkspace, type WorkspaceLoad, type WorkspaceWatcher } from "@mockix/core";
import type { WorkspaceState } from "@shared/ipc";

type Events = { changed: [WorkspaceLoad | null] };

/**
 * The open workspace folder. Main is the only process that reads it: it loads
 * the files, watches them, and hands resolved mock definitions to the hosts.
 */
export class WorkspaceService extends EventEmitter<Events> {
  #dir: string | null = null;
  #load: WorkspaceLoad | null = null;
  #watcher: WorkspaceWatcher | null = null;
  #queue: Promise<void> = Promise.resolve();
  readonly #log: (message: string, detail?: unknown) => void;

  constructor(log: (message: string, detail?: unknown) => void) {
    super();
    this.#log = log;
  }

  get state(): WorkspaceState {
    return { dir: this.#dir, problems: this.#load?.problems.map((p) => ({ ...p })) ?? [] };
  }

  get current(): WorkspaceLoad | null {
    return this.#load;
  }

  async open(dir: string): Promise<WorkspaceLoad> {
    this.close();
    this.#dir = resolve(dir);
    await this.reload();
    this.#watcher = watchWorkspace(this.#dir, () => {
      void this.reload();
    });
    return this.#load!;
  }

  /** Reloads are serialised so a slow load never overwrites a newer one. */
  reload(): Promise<void> {
    this.#queue = this.#queue.then(async () => {
      if (!this.#dir) return;
      try {
        this.#load = await loadWorkspace(this.#dir);
        this.emit("changed", this.#load);
      } catch (err) {
        this.#log("Could not load the workspace", err);
      }
    });
    return this.#queue;
  }

  close(): void {
    this.#watcher?.close();
    this.#watcher = null;
    this.#dir = null;
    this.#load = null;
  }
}
