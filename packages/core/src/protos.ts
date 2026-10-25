/**
 * .proto files → protobufjs JSON descriptors. The loader resolves imports
 * (next to the file, then from protos/ of the workspace, plus Google's
 * well-known types) and never reads outside the workspace; the server only
 * ever sees the JSON, so a mock definition stays plain data.
 */
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import protobuf from "protobufjs";

export interface LoadedProto {
  json: Record<string, unknown>;
  root: protobuf.Root;
}

const toPosix = (p: string) => p.split(sep).join("/");

export async function loadProto(workspaceDir: string, file: string): Promise<{ ok: true; proto: LoadedProto } | { ok: false; message: string }> {
  if (isAbsolute(file)) return { ok: false, message: `${file}: usa una ruta relativa al workspace, como protos/catalogo.proto` };
  let realRoot: string;
  let real: string;
  try {
    realRoot = await realpath(workspaceDir);
    real = await realpath(resolve(workspaceDir, file));
  } catch {
    return { ok: false, message: `no existe ${file}` };
  }
  if (!real.startsWith(realRoot + sep)) return { ok: false, message: `${file} está fuera del workspace` };

  const root = new protobuf.Root();
  const outside: string[] = [];
  root.resolvePath = (origin, target) => {
    // Well-known types come with protobufjs.
    if (target.startsWith("google/protobuf/")) return target;
    if (isAbsolute(target)) return target;
    const candidates = [origin ? join(dirname(origin), target) : target, join(realRoot, "protos", target), join(realRoot, target)];
    const found = candidates.find((c) => resolve(c).startsWith(realRoot + sep)) ?? candidates[0]!;
    if (!resolve(found).startsWith(realRoot + sep)) outside.push(target);
    return found;
  };
  try {
    await root.load(real, { keepCase: true });
    root.resolveAll();
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(realRoot + sep, "").split("\n", 1)[0]!;
    return { ok: false, message: `${toPosix(relative(realRoot, real))}: ${message}` };
  }
  if (outside.length) return { ok: false, message: `${file}: importa ${outside[0]}, que está fuera del workspace` };
  return { ok: true, proto: { json: root.toJSON() as Record<string, unknown>, root } };
}
