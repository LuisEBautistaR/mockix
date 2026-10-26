/**
 * What every importer produces: a mock described with route drafts (the same
 * shape the editor writes), plus a report of what was converted, generated,
 * skipped or needs attention. writeImported() turns it into files.
 */
import { parse as parseYaml } from "yaml";
import type { RouteDraft } from "../edit.js";

export type ImportFormat = "openapi" | "postman" | "har" | "mockoon";

export interface ImportedRoute {
  /** Subfolder of routes/ ("" for none). */
  folder: string;
  draft: RouteDraft;
}

export interface ImportedMock {
  name: string;
  port: number;
  prefix: string;
  latency?: number;
  cors?: boolean;
  proxy?: { target: string; keepPrefix?: boolean } | undefined;
  variables: Record<string, string>;
  buckets: Record<string, unknown>;
  routes: ImportedRoute[];
  /** Binary bodies for mocks/<name>/files/ (recordings), by file name. */
  files?: Record<string, Uint8Array> | undefined;
  /** More files of the mock, by path inside its folder (WebSocket routes, gRPC services). */
  extraFiles?: Record<string, string> | undefined;
  /** Files for the workspace itself, by path (protos/…). */
  workspaceFiles?: Record<string, string> | undefined;
  /** .proto files to copy into protos/ (from = as the source wrote it, to = workspace path). */
  protoSources?: Array<{ from: string; to: string; service: string; extraFile: string }> | undefined;
  /** gRPC server of the mock. */
  grpc?: { port: number } | undefined;
  /** 5xx codes the source documents (OpenAPI): what the prepared chaos profiles answer with. */
  serverErrors?: number[] | undefined;
}

export interface ImportReport {
  format: ImportFormat;
  /** Where the source came from (file name or title). */
  source: string;
  routes: number;
  responses: number;
  /** Responses taken from examples in the source. */
  fromExamples: number;
  /** Responses generated (from a schema, or a placeholder). */
  generated: number;
  /** Things left out, with the reason. */
  skipped: string[];
  /** Things converted with a caveat. */
  warnings: string[];
  /** What a contract (OpenAPI) gave beyond its routes; absent for other formats. */
  extras?: ImportExtras;
}

/** The rest of a mock built from a contract, for the report. */
export interface ImportExtras {
  /** Responses that answer when asked for by status code (X-Mockix-Respuesta or ?mockix_respuesta=). */
  selectable: number;
  /** Where the contract was copied and connected (contracts/…), or null. */
  contract: string | null;
  /** Data buckets with one CRUD route each. */
  crud: Array<{ bucket: string; path: string; items: number }>;
  /** State machines deduced from a status field. */
  scenarios: Array<{ id: string; field: string; states: string[]; transitions: number }>;
  /** Chaos profiles prepared (off until applied). */
  chaos: string[];
  /** Why something was not deduced. */
  notes: string[];
}

export interface ImportResult {
  mock: ImportedMock;
  report: ImportReport;
  /** The source itself, when it can be the mock's contract (OpenAPI). */
  contractSource?: { text: string; fileName: string };
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export function newReport(format: ImportFormat, source: string): ImportReport {
  return { format, source, routes: 0, responses: 0, fromExamples: 0, generated: 0, skipped: [], warnings: [] };
}

/** JSON or YAML text → value. */
export function parseSource(text: string): unknown {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through: YAML is a superset and gives a better message.
    }
  }
  try {
    return parseYaml(trimmed);
  } catch (err) {
    throw new ImportError(`El archivo no es JSON ni YAML válido: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}

/** Recognises the format from the content. */
export function detectFormat(value: unknown): ImportFormat | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v["openapi"] === "string" || typeof v["swagger"] === "string") return "openapi";
  const info = v["info"] as Record<string, unknown> | undefined;
  if (info && (typeof info["_postman_id"] === "string" || (typeof info["schema"] === "string" && info["schema"].includes("collection")))) return "postman";
  if (v["log"] && typeof v["log"] === "object" && Array.isArray((v["log"] as Record<string, unknown>)["entries"])) return "har";
  if (Array.isArray(v["routes"]) && ("lastMigration" in v || "endpointPrefix" in v)) return "mockoon";
  return null;
}

/** A mock name from free text: lowercase slug, never empty. */
/**
 * A mock name from the API's address: api.tienda-demo.test → tienda-demo
 * (generic labels like api or www are skipped). IPs and localhost say
 * nothing about the API, so they give the fallback.
 */
export function nameFromUrl(url: string, fallback: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return fallback;
  }
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return fallback;
  const labels = host.split(".").filter((l) => !/^(api|www|app|rest|gateway|localhost)$/i.test(l));
  return slugify(labels.length > 1 ? labels[labels.length - 2]! : (labels[0] ?? ""), fallback);
}

export function slugify(text: string, fallback = "importado"): string {
  const s = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return /^[a-z0-9]/.test(s) ? s : fallback;
}

/** Literal "{{" in imported bodies must not be read as templates. */
export function escapeMustaches(text: string): string {
  return text.replace(/\{\{/g, "\\{{");
}

/** A body for a draft: JSON stays JSON (pretty), anything else stays as text. */
export function bodyFromText(text: string, template: boolean): { kind: "inline"; text: string } {
  let out = text;
  try {
    out = `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  } catch {
    // Not JSON: keep as is.
  }
  return { kind: "inline", text: template ? out : out };
}
