import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, stringify } from "yaml";
import {
  Contract,
  checkMockResponses,
  contractCoverage,
  chaosProfileFile,
  contractJUnit,
  type ChaosReport,
  type ContractReport,
  type MockConfig,
  type ScenarioEvent,
  type ScenarioView,
} from "@mockix/core";
import { ErrorCodes, type Outcome } from "@shared/rpc";
import type { ChaosInfo, ChaosLive, ChaosProfileDraft, ContractInfo, ContractLive, ContractModeView, ScenarioInfo, ScenariosInfo, ViolationView } from "@shared/ipc";
import type { MockManager } from "./mock-manager";
import type { WorkspaceService } from "./workspace";

/** Writes next to the file and renames, so watchers and readers never see half a file. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

const noContract = (id: string): Outcome<never> => ({ ok: false, error: { code: ErrorCodes.notFound, message: `Mock "${id}" has no contract in mock.yaml` } });
const notLoaded = (id: string): Outcome<never> => ({ ok: false, error: { code: ErrorCodes.hasProblems, message: `Mock "${id}" has problems or does not exist` } });

interface Static {
  contract: Contract;
  info: Omit<ContractInfo, "live" | "mockId">;
}

/** The shape of a response condition on state.<id>, for the "how it answers by state" table. */
function stateCondition(rules: MockConfig["routes"][number]["responses"][number]["rules"], id: string): string | null {
  const own = rules?.when.filter((w) => w.target === `state.${id}`) ?? [];
  if (!own.length) return null;
  return own
    .map((w) => {
      const values = w.op === "in" && Array.isArray(w.value) ? w.value.map(String) : w.op === "equals" ? [String(w.value)] : [`${w.op} ${String(w.value ?? "")}`.trim()];
      return `${w.negate ? "no " : ""}${values.join(", ")}`;
    })
    .join(rules!.mode === "all" ? " y " : " o ");
}

/**
 * What the Contracts and Scenarios views show: the static part comes from the
 * workspace files (coverage, the mock's own responses, definitions), the live
 * part from the running mock's host.
 */
export class Insight {
  readonly #workspace: WorkspaceService;
  readonly #mocks: MockManager;
  readonly #static = new WeakMap<MockConfig, Static>();

  constructor(workspace: WorkspaceService, mocks: MockManager) {
    this.#workspace = workspace;
    this.#mocks = mocks;
  }

  #config(id: string): MockConfig | null {
    return this.#workspace.current?.mocks.find((m) => m.name === id)?.config ?? this.#mocks.configOf(id);
  }

  #analyse(config: MockConfig): Static | null {
    if (!config.contract) return null;
    let cached = this.#static.get(config);
    if (!cached) {
      const contract = new Contract(config.contract.document);
      const info = config.contract.document["info"] as { title?: unknown } | undefined;
      cached = {
        contract,
        info: {
          file: config.contract.file,
          mode: config.contract.mode,
          version: contract.version,
          title: typeof info?.title === "string" ? info.title : null,
          operations: contract.operations.length,
          coverage: contractCoverage(config, contract),
          responseProblems: config.contract.responses ? checkMockResponses(config, contract) : [],
        },
      };
      this.#static.set(config, cached);
    }
    return cached;
  }

  async #live(id: string): Promise<ContractReport | null> {
    if (!this.#mocks.isRunning(id)) return null;
    const outcome = await this.#mocks.call(id, "mock.contract", {});
    return outcome.ok ? (outcome.value as ContractReport | null) : null;
  }

  async contract(id: string): Promise<Outcome<ContractInfo>> {
    const config = this.#config(id);
    if (!config) return notLoaded(id);
    const analysed = this.#analyse(config);
    if (!analysed) return noContract(id);
    const report = await this.#live(id);
    const live: ContractLive | null = report ? { requests: report.requests, failing: report.failing, rules: report.rules, clients: report.clients, recent: report.recent } : null;
    return { ok: true, value: { mockId: id, ...analysed.info, live } };
  }

  /** The schema a violation was checked against, as YAML. */
  schema(id: string, violation: ViolationView): Outcome<string> {
    const config = this.#config(id);
    const analysed = config ? this.#analyse(config) : null;
    if (!analysed) return noContract(id);
    const schema = analysed.contract.expectedSchema(violation);
    return { ok: true, value: schema === null ? "" : stringify(schema, { lineWidth: 0 }) };
  }

  /** Writes contract.mode in mock.yaml (comments and the rest stay as they are). */
  async setMode(id: string, mode: ContractModeView): Promise<Outcome<null>> {
    const dir = this.#workspace.state.dir;
    if (!dir) return { ok: false, error: { code: ErrorCodes.noWorkspace, message: "No workspace is open" } };
    if (!this.#config(id)?.contract) return noContract(id);
    const file = join(dir, "mocks", id, "mock.yaml");
    const doc = parseDocument(await readFile(file, "utf8"));
    doc.setIn(["contract", "mode"], mode);
    await writeAtomic(file, doc.toString());
    await this.#workspace.reload();
    return { ok: true, value: null };
  }

  async exportReport(id: string, file: string): Promise<Outcome<{ file: string }>> {
    const config = this.#config(id);
    const analysed = config ? this.#analyse(config) : null;
    if (!config?.contract || !analysed) return noContract(id);
    const report = (await this.#live(id)) ?? {
      mock: id,
      file: config.contract.file,
      mode: config.contract.mode,
      operations: analysed.contract.operations.length,
      requests: 0,
      failing: 0,
      rules: [],
      clients: [],
      recent: [],
    };
    const drift = analysed.info.responseProblems.filter((p) => p.operation !== null);
    const text = file.toLowerCase().endsWith(".json")
      ? `${JSON.stringify({ ...report, responseProblems: drift }, null, 2)}\n`
      : contractJUnit([{ report, operations: analysed.contract.operations, responseProblems: drift }]);
    await writeFile(file, text);
    return { ok: true, value: { file } };
  }

  async clear(id: string): Promise<Outcome<null>> {
    const outcome = await this.#mocks.call(id, "mock.contract", { clear: true });
    return outcome.ok ? { ok: true, value: null } : outcome;
  }

  async scenarios(id: string): Promise<Outcome<ScenariosInfo>> {
    const config = this.#config(id);
    if (!config) return notLoaded(id);
    const dir = this.#workspace.state.dir;
    let views: ScenarioView[];
    let recent: ScenarioEvent[] = [];
    let now = Date.now();
    const running = this.#mocks.isRunning(id);
    const live = running ? await this.#mocks.call(id, "mock.scenarios", {}) : null;
    if (live?.ok) {
      views = live.value.views as ScenarioView[];
      recent = live.value.recent as ScenarioEvent[];
      now = live.value.now;
    } else {
      views = config.scenarios.map((s) => ({
        id: s.id,
        file: s.file,
        key: s.key,
        initial: s.initial,
        states: s.states,
        transitions: s.transitions.map((t) => ({ from: t.from, to: t.to, on: t.on ? { method: t.on.method, path: t.on.path } : null, afterMs: t.afterMs, fired: 0 })),
        counts: Object.fromEntries(s.states.map((st) => [st, 0])),
        instances: [],
      }));
    }
    const scenarios: ScenarioInfo[] = [];
    for (const v of views) {
      let source = "";
      try {
        if (dir) source = await readFile(join(dir, "mocks", id, v.file), "utf8");
      } catch {
        // deleted meanwhile: the next reload drops it
      }
      const readers = config.routes
        .map((r) => {
          const responses = r.responses
            .map((resp) => {
              const when = stateCondition(resp.rules, v.id);
              const usesTemplate = resp.body?.kind === "text" && resp.body.text.includes(`state.${v.id}`);
              if (when === null && !usesTemplate && !resp.default) return null;
              const body = resp.body?.kind === "text" ? resp.body.text.replace(/\s+/g, " ").trim().slice(0, 120) : resp.body ? `(archivo ${resp.body.path})` : "";
              return { id: resp.id, status: resp.status, when: when ?? (resp.default ? "otros" : "cualquiera"), body, reads: when !== null || usesTemplate };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);
          if (!responses.some((x) => x.reads)) return null;
          return { routeId: r.id, method: r.method, path: r.path, responses: responses.map(({ reads: _reads, ...rest }) => rest) };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      scenarios.push({ ...v, source, readers });
    }
    return { ok: true, value: { mockId: id, running, now, scenarios, recent } };
  }

  async setScenario(id: string, scenario: string, key: string, state: string): Promise<Outcome<null>> {
    const outcome = await this.#mocks.call(id, "mock.scenarioSet", { id: scenario, key, state });
    return outcome.ok ? { ok: true, value: null } : outcome;
  }

  /** Profiles of chaos/, where each mock applies them, and what the running mocks are doing. */
  async chaos(): Promise<Outcome<ChaosInfo>> {
    const load = this.#workspace.current;
    const dir = this.#workspace.state.dir;
    if (!load || !dir) return { ok: false, error: { code: ErrorCodes.noWorkspace, message: "No workspace is open" } };
    const sources: Record<string, string> = {};
    const durations = new Map<string, number | null>();
    for (const p of Object.values(load.chaos)) {
      if (sources[p.file] !== undefined) continue;
      try {
        sources[p.file] = await readFile(join(dir, p.file), "utf8");
        const doc = parseDocument(sources[p.file]!).toJS() as Record<string, { duration?: unknown }> | null;
        for (const [name, def] of Object.entries(doc ?? {})) durations.set(name, def && def.duration !== undefined ? -1 : null);
      } catch {
        sources[p.file] = "";
      }
    }
    const profiles = Object.values(load.chaos).map((p) => ({ ...p, durationMs: durations.get(p.name) === -1 ? p.cycleMs : null }));
    const assignments = this.#mocks.list().map((status) => {
      const config = this.#config(status.id);
      return {
        mockId: status.id,
        state: status.state,
        profile: config?.chaos.profile ?? null,
        folders: config?.chaos.folders ?? {},
        routes: config?.routes.filter((r) => r.chaos !== undefined).map((r) => ({ routeId: r.id, profile: r.chaos ?? null })) ?? [],
      };
    });
    const live: ChaosLive[] = [];
    for (const a of assignments) {
      if (!this.#mocks.isRunning(a.mockId)) continue;
      const outcome = await this.#mocks.call(a.mockId, "mock.chaos", {});
      if (outcome.ok) live.push({ mockId: a.mockId, ...(outcome.value as ChaosReport) });
    }
    return { ok: true, value: { profiles, sources, assignments, live } };
  }

  /** Writes one profile back into its chaos/*.yaml file (the rest of the file, comments included, stays). */
  async saveChaosProfile(name: string, draft: ChaosProfileDraft): Promise<Outcome<null>> {
    const load = this.#workspace.current;
    const dir = this.#workspace.state.dir;
    const profile = load?.chaos[name];
    if (!dir || !profile) return { ok: false, error: { code: ErrorCodes.notFound, message: `No chaos profile named "${name}"` } };
    const secs = (ms: number) => `${Math.round(ms) / 1000}s`;
    const value: Record<string, unknown> = {};
    if (draft.description) value["description"] = draft.description;
    if (!draft.loop) value["loop"] = false;
    if (draft.durationMs !== null) value["duration"] = secs(draft.durationMs);
    value["points"] = draft.points.map((p) => {
      const point: Record<string, unknown> = { t: secs(p.tMs) };
      if (p.latencyMs) point["latency"] = `${Math.round(p.latencyMs)}ms`;
      if (p.jitterMs) point["jitter"] = `${Math.round(p.jitterMs)}ms`;
      if (p.errorRate) point["errorRate"] = Math.round(p.errorRate * 10_000) / 10_000;
      if (p.errors.length) point["errors"] = p.errors.every((e) => e.weight === 1) ? p.errors.map((e) => e.status) : Object.fromEntries(p.errors.map((e) => [String(e.status), e.weight]));
      return point;
    });
    const extras: Record<string, number> = {};
    if (draft.extras.dropRate) extras["dropRate"] = draft.extras.dropRate;
    if (draft.extras.timeoutRate) extras["timeoutRate"] = draft.extras.timeoutRate;
    if (draft.extras.trickleKBps) extras["trickleKBps"] = draft.extras.trickleKBps;
    if (Object.keys(extras).length) value["extras"] = extras;

    const checked = chaosProfileFile.safeParse(value);
    if (!checked.success) {
      const issue = checked.error.issues[0]!;
      return { ok: false, error: { code: ErrorCodes.invalidParams, message: `${issue.path.join(".")}: ${issue.message}` } };
    }
    const file = join(dir, profile.file);
    const doc = parseDocument(await readFile(file, "utf8"));
    const node = doc.createNode(value);
    // One line per point and for the extras, as people write them.
    if (isMap(node)) {
      const points = node.get("points", true);
      if (isSeq(points)) for (const item of points.items) if (isMap(item)) item.flow = true;
      const ex = node.get("extras", true);
      if (isMap(ex)) ex.flow = true;
    }
    doc.set(name, node);
    await writeAtomic(file, doc.toString());
    await this.#workspace.reload();
    return { ok: true, value: null };
  }

  /** Sets (or removes, with null) the profile of a whole mock in its mock.yaml. */
  async assignChaos(id: string, profile: string | null): Promise<Outcome<null>> {
    const dir = this.#workspace.state.dir;
    if (!dir) return { ok: false, error: { code: ErrorCodes.noWorkspace, message: "No workspace is open" } };
    if (profile && !this.#workspace.current?.chaos[profile]) return { ok: false, error: { code: ErrorCodes.notFound, message: `No chaos profile named "${profile}"` } };
    const file = join(dir, "mocks", id, "mock.yaml");
    const doc = parseDocument(await readFile(file, "utf8"));
    const current = doc.get("chaos", true);
    if (isMap(current)) {
      if (profile) current.set("profile", profile);
      else current.delete("profile");
      if (current.items.length === 0) doc.delete("chaos");
    } else if (profile) doc.set("chaos", doc.createNode({ profile }));
    else doc.delete("chaos");
    await writeAtomic(file, doc.toString());
    await this.#workspace.reload();
    return { ok: true, value: null };
  }

  async chaosControl(id: string, action: "pause" | "resume" | "restart"): Promise<Outcome<null>> {
    const outcome = await this.#mocks.call(id, "mock.chaosControl", { action });
    return outcome.ok ? { ok: true, value: null } : outcome;
  }

  async resetScenario(id: string, scenario: string | null): Promise<Outcome<null>> {
    const outcome = await this.#mocks.call(id, "mock.scenarioReset", scenario ? { id: scenario } : {});
    return outcome.ok ? { ok: true, value: null } : outcome;
  }
}
