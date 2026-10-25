/**
 * What other tools see of the running mocks: .mockix/running.json (mock →
 * URL), and, when the folder is also a Sendix workspace, an environment per
 * mock with its baseUrl, so Sendix offers "Mock tienda" as one more
 * environment. Environments Mockix did not write are never touched.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface RunningMock {
  /** Origin the mock listens on (http://127.0.0.1:3000). */
  url: string;
  prefix: string;
  /** url + prefix: what a client uses as base URL. */
  baseUrl: string;
  /** host:port of the gRPC server, if any. */
  grpc: string | null;
}

export const RUNNING_FILE = join(".mockix", "running.json");
const SENDIX_WORKSPACE = "sendix.workspace.json";

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/** Stable id from the mock name, so the environment keeps its identity between runs. */
const envId = (workspace: string, mock: string) => {
  const h = createHash("sha256").update(`${workspace}\0${mock}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export async function publishRunning(workspace: string, mocks: Record<string, RunningMock>, source: string): Promise<void> {
  await mkdir(join(workspace, ".mockix"), { recursive: true });
  await writeAtomic(join(workspace, RUNNING_FILE), `${JSON.stringify({ format: 1, source, updatedAt: new Date().toISOString(), mocks }, null, 2)}\n`);

  const isSendix = await stat(join(workspace, SENDIX_WORKSPACE)).then(() => true, () => false);
  if (!isSendix) return;
  const dir = join(workspace, "environments");
  await mkdir(dir, { recursive: true });
  for (const [name, m] of Object.entries(mocks)) {
    const file = join(dir, `Mock ${name}.postman_environment.json`);
    let current: Record<string, unknown> | null = null;
    try {
      current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    } catch {
      current = null;
    }
    // Someone else's environment with the same name: leave it alone.
    if (current && !(current["x-mockix"] && typeof current["x-mockix"] === "object")) continue;
    const values = Array.isArray(current?.["values"]) ? (current!["values"] as Array<Record<string, unknown>>).filter((v) => v["key"] !== "baseUrl" && v["key"] !== "grpcTarget") : [];
    values.unshift({ key: "baseUrl", value: m.baseUrl, type: "default", enabled: true });
    if (m.grpc) values.push({ key: "grpcTarget", value: m.grpc, type: "default", enabled: true });
    const env = {
      ...(current ?? {}),
      id: (current?.["id"] as string | undefined) ?? envId(workspace, name),
      name: `Mock ${name}`,
      values,
      _postman_variable_scope: "environment",
      "x-mockix": { mock: name, updatedAt: new Date().toISOString() },
    };
    await writeAtomic(file, `${JSON.stringify(env, null, 2)}\n`);
  }
}
