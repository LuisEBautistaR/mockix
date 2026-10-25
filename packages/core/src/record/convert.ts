/**
 * A recording → routes: a new mock, or new routes and responses added to an
 * existing one. Uses the same converter as the HAR importer, with the
 * workspace's redaction profile, and keeps binary bodies as files.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readRoute, writeRoute, type ResponseDraft } from "../edit.js";
import { DEFAULT_REDACTION, answerKey, exchangesToRoutes, type Exchange, type RedactionRule } from "../import/exchanges.js";
import { newReport, slugify, type ImportResult, type ImportedRoute } from "../import/model.js";
import type { MockConfig } from "../runtime.js";

export interface RecordingConvertOptions {
  /** Suggested name for a new mock. */
  name: string;
  source: string;
  prefix?: string;
  redaction?: RedactionRule[];
}

export function convertRecording(exchanges: Exchange[], options: RecordingConvertOptions): ImportResult {
  const report = newReport("har", options.source);
  const converted = exchangesToRoutes(exchanges, { prefix: options.prefix ?? "", redaction: options.redaction ?? DEFAULT_REDACTION, binaryFiles: true });
  report.routes = converted.routes.length;
  report.responses = converted.responses;
  report.fromExamples = converted.responses;
  report.warnings.push(...converted.warnings);
  if (converted.redacted) report.warnings.push(converted.redacted === 1 ? "1 valor sensible sustituido por datos falsos" : `${converted.redacted} valores sensibles sustituidos por datos falsos`);
  return {
    mock: { name: slugify(options.name, "grabacion"), port: 3000, prefix: options.prefix ?? "", variables: {}, buckets: {}, routes: converted.routes, files: converted.files },
    report,
  };
}

export type PlanAction = "new" | "append" | "same";

export interface PlanItem {
  method: string;
  path: string;
  /** How many recorded exchanges went into this route. */
  exchanges: number;
  /** Distinct answers seen. */
  responses: number;
  action: PlanAction;
  /** Responses that would be added to the existing route. */
  added: number;
}

const draftText = (r: ResponseDraft) => (r.body.kind === "inline" ? r.body.text : r.body.kind === "json" ? JSON.stringify(r.body.value) : r.body.kind === "file" ? (r.body.text ?? `file:${r.body.path}`) : "");
const sameAnswer = (a: ResponseDraft, b: ResponseDraft) => answerKey(a.status ?? 200, draftText(a)) === answerKey(b.status ?? 200, draftText(b));

/** What converting into `target` (null = a new mock) would do, route by route. */
export function planMerge(target: MockConfig | null, result: ImportResult, exchanges: Exchange[], prefix = ""): PlanItem[] {
  return result.mock.routes.map((route) => {
    const method = route.draft.method ?? "GET";
    const path = route.draft.path;
    const responses = route.draft.responses ?? [];
    const count = exchanges.filter((e) => e.method.toUpperCase() === method).filter((e) => {
      const p = new URL(e.url, "http://x").pathname;
      const local = prefix && p.startsWith(`${prefix}/`) ? p.slice(prefix.length) : p;
      return matches(path, local);
    }).length;
    const existing = target?.routes.find((r) => r.method === method && r.path === path);
    if (!existing) return { method, path, exchanges: count, responses: responses.length, action: "new", added: responses.length };
    const have = new Set(existing.responses.map((e) => answerKey(e.status, e.body?.kind === "text" ? e.body.text : e.body ? `file:/${e.body.path}` : "")));
    const added = responses.filter((r) => !have.has(answerKey(r.status ?? 200, draftText(r)))).length;
    return { method, path, exchanges: count, responses: responses.length, action: added ? "append" : "same", added };
  });
}

function matches(pattern: string, path: string): boolean {
  const a = pattern.split("/");
  const b = path.split("/");
  return a.length === b.length && a.every((s, i) => s.startsWith(":") || s === b[i]);
}

export interface MergeResult {
  newRoutes: number;
  appended: number;
  unchanged: number;
  files: number;
  failed: string[];
}

/** Adds a converted recording to an existing mock: new routes as files, new answers as responses of existing routes. */
export async function mergeIntoMock(workspaceDir: string, mock: string, config: MockConfig, result: ImportResult): Promise<MergeResult> {
  const out: MergeResult = { newRoutes: 0, appended: 0, unchanged: 0, files: 0, failed: [] };
  const root = join(resolve(workspaceDir), "mocks", mock);
  if (result.mock.files && Object.keys(result.mock.files).length) {
    await mkdir(join(root, "files"), { recursive: true });
    for (const [name, bytes] of Object.entries(result.mock.files)) {
      await writeFile(join(root, "files", name), bytes);
      out.files++;
    }
  }
  for (const route of result.mock.routes as ImportedRoute[]) {
    const method = route.draft.method ?? "GET";
    const existing = config.routes.find((r) => r.method === method && r.path === route.draft.path);
    try {
      if (!existing) {
        await writeRoute(workspaceDir, mock, route.draft, null, "grabadas");
        out.newRoutes++;
        continue;
      }
      const doc = await readRoute(workspaceDir, mock, existing.id);
      const current = doc.draft.responses ?? [];
      const additions = (route.draft.responses ?? []).filter((r) => !current.some((c) => sameAnswer(c, r)));
      if (additions.length === 0) {
        out.unchanged++;
        continue;
      }
      const ids = new Set(current.map((c) => c.id));
      for (const a of additions) {
        let id = a.id === "ok" ? `grabada-${a.status ?? 200}` : a.id;
        for (let n = 2; ids.has(id); n++) id = `${a.id}-${n}`;
        ids.add(id);
        current.push({ ...a, id, default: false });
      }
      await writeRoute(workspaceDir, mock, { ...doc.draft, responses: current }, existing.id);
      out.appended += additions.length;
    } catch (err) {
      out.failed.push(`${method} ${route.draft.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
