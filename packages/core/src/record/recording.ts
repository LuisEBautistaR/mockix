/**
 * Recording files: what the recording proxy saw, raw, one JSON object per line
 * (JSONL). They live in <workspace>/.mockix/recordings/, which is local and
 * git-ignored, because they may contain credentials. Converting a recording
 * into a mock redacts them (see import/exchanges.ts).
 */
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Exchange } from "../import/exchanges.js";

export const RECORDINGS_DIR = join(".mockix", "recordings");

export interface RecordingMeta {
  /** File name without folder, e.g. 2026-10-25T10-42-07-api.tienda-demo.test.jsonl */
  file: string;
  target: string;
  startedAt: number;
  exchanges: number;
  bytes: number;
}

interface HeaderLine {
  mockix: "recording";
  v: 1;
  target: string;
  startedAt: number;
}

interface ExchangeLine {
  at: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  /** base64 of a binary response body. */
  responseBase64?: string;
}

export function recordingsDir(workspaceDir: string): string {
  return join(resolve(workspaceDir), RECORDINGS_DIR);
}

/** A safe file name for a new recording of `target`. */
export function recordingFileName(target: string, at = Date.now()): string {
  let host = "destino";
  try {
    host = new URL(target).host.replace(/[^A-Za-z0-9.-]+/g, "-");
  } catch {
    // keep the default
  }
  return `${new Date(at).toISOString().slice(0, 19).replace(/:/g, "-")}-${host}.jsonl`;
}

function safeName(file: string): string {
  const name = basename(file);
  if (!/^[A-Za-z0-9._-]+\.jsonl$/.test(name)) throw new Error(`Not a recording file name: ${file}`);
  return name;
}

/** Appends exchanges to a recording, creating it (with its header line) on first use. */
export class RecordingWriter {
  readonly file: string;
  readonly target: string;
  #ready: Promise<void>;
  #count = 0;

  constructor(workspaceDir: string, target: string, file = recordingFileName(target)) {
    this.file = join(recordingsDir(workspaceDir), safeName(file));
    this.target = target;
    const header: HeaderLine = { mockix: "recording", v: 1, target, startedAt: Date.now() };
    this.#ready = mkdir(recordingsDir(workspaceDir), { recursive: true }).then(() => writeFile(this.file, `${JSON.stringify(header)}\n`, { flag: "wx" }));
  }

  get count(): number {
    return this.#count;
  }

  /** Lines are written in order even when calls overlap. */
  add(ex: Exchange): Promise<void> {
    const line: ExchangeLine = {
      at: ex.at ?? Date.now(),
      method: ex.method,
      url: ex.url,
      requestHeaders: ex.requestHeaders,
      requestBody: ex.requestBody,
      status: ex.status,
      responseHeaders: ex.responseHeaders,
      responseBody: ex.responseBody,
      ...(ex.binary && ex.responseBytes ? { responseBase64: Buffer.from(ex.responseBytes).toString("base64") } : {}),
    };
    this.#count++;
    this.#ready = this.#ready.then(() => appendFile(this.file, `${JSON.stringify(line)}\n`));
    return this.#ready;
  }

  flush(): Promise<void> {
    return this.#ready;
  }
}

export async function readRecording(file: string): Promise<{ target: string; startedAt: number; exchanges: Exchange[] }> {
  const lines = (await readFile(file, "utf8")).split("\n").filter((l) => l.trim());
  const header = JSON.parse(lines[0] ?? "{}") as Partial<HeaderLine>;
  if (header.mockix !== "recording") throw new Error(`${basename(file)} is not a Mockix recording`);
  const exchanges: Exchange[] = [];
  for (const raw of lines.slice(1)) {
    let line: ExchangeLine;
    try {
      line = JSON.parse(raw) as ExchangeLine;
    } catch {
      continue; // a line cut by a crash: skip it
    }
    const bytes = line.responseBase64 ? Buffer.from(line.responseBase64, "base64") : undefined;
    exchanges.push({
      method: line.method,
      url: line.url,
      requestHeaders: line.requestHeaders,
      requestBody: line.requestBody,
      status: line.status,
      responseHeaders: line.responseHeaders,
      responseBody: line.responseBody,
      binary: bytes !== undefined,
      responseBytes: bytes ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : undefined,
      at: line.at,
    });
  }
  return { target: header.target ?? "", startedAt: header.startedAt ?? 0, exchanges };
}

/** Recordings of a workspace, newest first. */
export async function listRecordings(workspaceDir: string): Promise<RecordingMeta[]> {
  const dir = recordingsDir(workspaceDir);
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: RecordingMeta[] = [];
  for (const file of names) {
    try {
      const abs = join(dir, file);
      const [text, info] = await Promise.all([readFile(abs, "utf8"), stat(abs)]);
      const lines = text.split("\n").filter((l) => l.trim());
      const header = JSON.parse(lines[0] ?? "{}") as Partial<HeaderLine>;
      if (header.mockix !== "recording") continue;
      out.push({ file, target: header.target ?? "", startedAt: header.startedAt ?? info.mtimeMs, exchanges: lines.length - 1, bytes: info.size });
    } catch {
      // unreadable file: not listed
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export function recordingPath(workspaceDir: string, file: string): string {
  return join(recordingsDir(workspaceDir), safeName(file));
}
