import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import {
  MockStartError,
  RecordingWriter,
  convertRecording,
  loadWorkspace,
  mergeIntoMock,
  nameFromUrl,
  readRecording,
  recordingPath,
  startCassette,
  startMock,
  writeImported,
  type Exchange,
} from "@mockix/core";
import type { Io } from "./main.js";

const time = (epoch: number) => new Date(epoch).toTimeString().slice(0, 8);
const waitFor = (stop: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (stop.aborted) resolve();
    else stop.addEventListener("abort", () => resolve(), { once: true });
  });

/** A recording given by path, or by name inside <workspace>/.mockix/recordings. */
function locate(dir: string, file: string): string {
  if (isAbsolute(file) || file.includes("/") || file.includes("\\")) return resolve(file);
  const inside = recordingPath(dir, file.endsWith(".jsonl") ? file : `${file}.jsonl`);
  return existsSync(inside) ? inside : resolve(file);
}

async function workspaceOk(dir: string, io: Io): Promise<boolean> {
  const load = await loadWorkspace(dir);
  if (load.problems.some((p) => p.file === "mockix.workspace.yaml" && p.line === null)) {
    io.err(`mockix: ${resolve(dir)} no es un workspace de Mockix (crea uno con «mockix init»)`);
    return false;
  }
  return true;
}

export async function convertCommand(cmd: { file: string; dir: string; name: string | null; into: string | null; prefix: string }, io: Io, exchanges?: Exchange[]): Promise<number> {
  if (!(await workspaceOk(cmd.dir, io))) return 1;
  const file = locate(cmd.dir, cmd.file);
  let recorded = exchanges;
  let target = "";
  if (!recorded) {
    try {
      const r = await readRecording(file);
      recorded = r.exchanges;
      target = r.target;
    } catch (err) {
      io.err(`mockix: no se puede leer la grabación ${cmd.file}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (recorded.length === 0) {
    io.err("mockix: la grabación está vacía");
    return 1;
  }
  const load = await loadWorkspace(cmd.dir);
  const suggested = cmd.name ?? (target ? nameFromUrl(target, "grabacion") : "grabacion");
  const result = convertRecording(recorded, { name: suggested, source: basename(file), prefix: cmd.prefix, ...(load.redaction ? { redaction: load.redaction } : {}) });

  if (cmd.into) {
    const mock = load.mocks.find((m) => m.name === cmd.into);
    if (!mock?.config) {
      io.err(mock ? `mockix: el mock "${cmd.into}" tiene problemas; corrígelos antes de añadirle rutas` : `mockix: no hay ningún mock "${cmd.into}"`);
      return 1;
    }
    const merged = await mergeIntoMock(cmd.dir, cmd.into, mock.config, result);
    io.out(`Grabación añadida a "${cmd.into}": ${merged.newRoutes} rutas nuevas, ${merged.appended} respuestas nuevas, ${merged.unchanged} rutas sin cambios.`);
    for (const w of result.report.warnings) io.out(`  Aviso: ${w}`);
    for (const f of merged.failed) io.err(`  No se pudo escribir ${f}`);
    return merged.failed.length ? 1 : 0;
  }
  const written = await writeImported(cmd.dir, result, cmd.name ? { name: cmd.name } : {});
  io.out(`Mock "${written.name}" creado desde la grabación: ${written.routes} rutas, ${result.report.responses} respuestas.`);
  for (const w of written.report.warnings) io.out(`  Aviso: ${w}`);
  for (const s of written.report.skipped) io.out(`  Omitido: ${s}`);
  return written.failed.length ? 1 : 0;
}

export async function recordCommand(
  cmd: { dir: string; target: string; port: number; host: string | null; prefix: string; convert: string | null },
  io: Io,
  stop: AbortSignal,
  serverHeader: string,
): Promise<number> {
  if (!(await workspaceOk(cmd.dir, io))) return 1;
  const writer = new RecordingWriter(cmd.dir, cmd.target);
  let proxy;
  try {
    proxy = await startMock(
      { name: "grabacion", host: cmd.host ?? "127.0.0.1", port: cmd.port, routes: [], cors: false, proxy: { target: cmd.target, keepPrefix: true, insecure: false, headers: {} } },
      {
        serverHeader,
        onProxied: (ex) => {
          void writer.add(ex);
          io.out(`${time(ex.at ?? Date.now())}  ${ex.method.padEnd(6)} ${ex.url}  ${ex.status}  grabada (${writer.count})`);
        },
      },
    );
  } catch (err) {
    io.err(`mockix: no se pudo iniciar el proxy: ${err instanceof MockStartError ? `${err.code}, ${err.message}` : String(err)}`);
    return 1;
  }
  proxy.on("request", (e) => {
    if (e.error) io.err(`${time(e.at)}  ${e.method.padEnd(6)} ${e.url}  ${e.status}  ERROR: ${e.error}`);
  });
  io.out(`Grabando: ${proxy.url} → ${cmd.target}. Apunta tu cliente al proxy; Ctrl+C para terminar.`);
  io.out(`Archivo: ${writer.file} (local, no va a git: puede contener credenciales)`);
  await waitFor(stop);
  await proxy.stop();
  await writer.flush();
  io.out(`Grabación terminada: ${writer.count} peticiones.`);
  if (writer.count === 0) return 0;
  if (cmd.convert) return convertCommand({ file: writer.file, dir: cmd.dir, name: cmd.convert, into: null, prefix: cmd.prefix }, io);
  io.out(`Siguiente paso: mockix convert ${basename(writer.file)} ${cmd.dir === "." ? "" : cmd.dir}${cmd.prefix ? ` --prefix ${cmd.prefix}` : ""}`.replace(/\s+$/, ""));
  return 0;
}

export async function replayCommand(cmd: { file: string; dir: string; port: number; host: string | null; strict: boolean }, io: Io, stop: AbortSignal, serverHeader: string): Promise<number> {
  const file = locate(cmd.dir, cmd.file);
  let exchanges: Exchange[];
  try {
    exchanges = (await readRecording(file)).exchanges;
  } catch (err) {
    io.err(`mockix: no se puede leer la grabación ${cmd.file}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  let tape;
  try {
    tape = await startCassette(exchanges, { port: cmd.port, host: cmd.host ?? "127.0.0.1", strict: cmd.strict, serverHeader });
  } catch (err) {
    io.err(`mockix: no se pudo iniciar el casete: ${err instanceof MockStartError ? `${err.code}, ${err.message}` : String(err)}`);
    return 1;
  }
  tape.on("request", (e) =>
    (e.index === null ? io.err : io.out)(`${time(e.at)}  ${e.method.padEnd(6)} ${e.url}  ${e.status}  ${e.index === null ? `FUERA DEL CASETE: ${e.reason}` : `grabada #${e.index + 1}`}`),
  );
  io.out(`Casete en ${tape.url}: ${tape.total} respuestas grabadas${cmd.strict ? ", en orden estricto" : ""}. Ctrl+C para terminar.`);
  await waitFor(stop);
  await tape.stop();
  const misses = tape.misses();
  io.out(`Casete terminado: ${tape.total - tape.remaining()} de ${tape.total} usadas, ${misses.length} peticiones fuera del casete.`);
  return misses.length ? 2 : 0;
}
