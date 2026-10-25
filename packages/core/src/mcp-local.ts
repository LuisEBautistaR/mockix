/**
 * The MCP backend of the CLI: mocks run in this process. After every write
 * the running mocks pick up the new files, like `mockix serve` does.
 */
import { loadWorkspace, type WorkspaceLoad } from "./loader.js";
import type { McpBackend } from "./mcp.js";
import { RecordingWriter } from "./record/index.js";
import { startMock, type MockHandle } from "./server.js";

export class LocalBackend implements McpBackend {
  readonly workspace: string;
  readonly #serverHeader: string;
  readonly #running = new Map<string, MockHandle>();
  #recording: { proxy: MockHandle; writer: RecordingWriter } | null = null;

  constructor(workspace: string, options: { serverHeader?: string } = {}) {
    this.workspace = workspace;
    this.#serverHeader = options.serverHeader ?? "Mockix";
  }

  load(): Promise<WorkspaceLoad> {
    return loadWorkspace(this.workspace);
  }

  async status() {
    const load = await this.load();
    return load.mocks.map((m) => {
      const h = this.#running.get(m.name);
      return { name: m.name, state: h ? "running" : "stopped", url: h?.url ?? null, prefix: m.config?.prefix ?? "", grpcPort: h?.grpcPort ?? null };
    });
  }

  #handle(name: string): MockHandle {
    const h = this.#running.get(name);
    if (!h) throw new Error(`${name} no está en marcha: usa start_mock`);
    return h;
  }

  async start(name: string): Promise<{ url: string }> {
    const running = this.#running.get(name);
    if (running) return { url: running.url };
    const mock = (await this.load()).mocks.find((m) => m.name === name);
    if (!mock?.config) throw new Error(`${name} tiene problemas: ${mock?.problems.map((p) => `${p.file}: ${p.message}`).join("; ") ?? "no existe"}`);
    const handle = await startMock(mock.config, { serverHeader: this.#serverHeader });
    this.#running.set(name, handle);
    return { url: handle.url };
  }

  async stop(name: string): Promise<void> {
    const h = this.#running.get(name);
    this.#running.delete(name);
    await h?.stop();
  }

  /** Applies the files to the running mocks (restarting those whose port or TLS changed). */
  async changed(): Promise<void> {
    const load = await this.load();
    for (const [name, handle] of this.#running) {
      const config = load.mocks.find((m) => m.name === name)?.config;
      if (!config) continue;
      if (!handle.update(config).applied) {
        await handle.stop();
        this.#running.set(name, await startMock(config, { serverHeader: this.#serverHeader }));
      }
    }
  }

  async logs(name: string, limit: number) {
    return this.#handle(name).logs(limit);
  }

  async scenarios(name: string) {
    return this.#handle(name).scenarios();
  }

  async setScenario(name: string, id: string, key: string, state: string) {
    return this.#handle(name).setScenario(id, key, state);
  }

  async chaos(name: string) {
    return this.#handle(name).chaos();
  }

  async setChaos(name: string, profile: string | null | undefined) {
    const h = this.#handle(name);
    h.setChaos(profile);
    return h.chaos();
  }

  async contract(name: string) {
    return this.#handle(name).contract();
  }

  async recordStart(target: string, port: number) {
    if (this.#recording) throw new Error("Ya hay una grabación en curso: usa record_stop");
    const writer = new RecordingWriter(this.workspace, target);
    const proxy = await startMock(
      { name: "grabacion", port, routes: [], cors: false, proxy: { target, keepPrefix: true, insecure: false, headers: {} } },
      { serverHeader: this.#serverHeader, onProxied: (ex) => void writer.add(ex) },
    );
    this.#recording = { proxy, writer };
    return { url: proxy.url, file: writer.file.split(/[\\/]/).pop()! };
  }

  async recordStop() {
    const r = this.#recording;
    if (!r) return null;
    this.#recording = null;
    await r.proxy.stop();
    await r.writer.flush();
    return { file: r.writer.file.split(/[\\/]/).pop()!, count: r.writer.count };
  }

  async close(): Promise<void> {
    await this.recordStop();
    await Promise.all([...this.#running.values()].map((h) => h.stop()));
    this.#running.clear();
  }
}
