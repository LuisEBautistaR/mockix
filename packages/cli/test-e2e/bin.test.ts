/**
 * Runs the built binary (packages/cli/dist/bin.js) as a real process: what
 * `npm i -g` and the Docker image will execute.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const bin = resolve(import.meta.dirname, "../dist/bin.js");
const children: ChildProcessWithoutNullStreams[] = [];
const dirs: string[] = [];

function run(args: string[]) {
  const child = spawn(process.execPath, [bin, ...args]);
  children.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  const exit = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, exit, out: () => out, err: () => err };
}

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill();
});
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mockix-bin-"));
  dirs.push(dir);
  const init = run(["init", dir]);
  expect(await init.exit).toBe(0);
  return dir;
}

describe("mockix binary", () => {
  it("prints its version", async () => {
    const p = run(["--version"]);
    expect(await p.exit).toBe(0);
    expect(p.out().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("creates, validates and serves a workspace", async () => {
    const dir = await workspace();
    const check = run(["validate", dir]);
    expect(await check.exit).toBe(0);
    expect(check.out()).toContain("Workspace válido: 1 mock, 13 rutas, 2 de tiempo real y 1 servicio gRPC.");

    const p = run(["serve", dir, "-m", "tienda", "-p", "0", "--no-watch"]);
    await expect.poll(() => /^tienda {2}(http:\/\/127\.0\.0\.1:\d+)/m.exec(p.out())?.[1], { timeout: 10_000 }).toBeDefined();
    const url = /^tienda {2}(http:\/\/127\.0\.0\.1:\d+)/m.exec(p.out())![1];

    const res = await fetch(`${url}/v1/productos`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total: number }).total).toBe(3);
    await expect.poll(() => p.out()).toMatch(/GET\s+\/v1\/productos\s+200 .*productos\/listar → ok/);

    p.child.kill();
    await p.exit;
    await expect(fetch(`${url}/v1/salud`)).rejects.toThrow();
  });

  it("fails with exit code 1 when the port is taken", async () => {
    const dir = await workspace();
    const first = run(["serve", dir, "-m", "tienda", "-p", "0", "--no-watch"]);
    await expect.poll(() => /:(\d+)\/v1/.exec(first.out())?.[1], { timeout: 10_000 }).toBeDefined();
    const port = /:(\d+)\/v1/.exec(first.out())![1]!;

    const second = run(["serve", dir, "-m", "tienda", "-p", port, "--no-watch"]);
    expect(await second.exit).toBe(1);
    expect(second.err()).toContain("PORT_IN_USE");
  });

  it("speaks MCP over stdio", async () => {
    const dir = await workspace();
    const client = new Client({ name: "prueba", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin, "mcp", dir], stderr: "pipe" });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain("upsert_route");
      const res = (await client.callTool({ name: "list_mocks", arguments: {} })) as { content: Array<{ text: string }> };
      expect(JSON.parse(res.content[0]!.text)).toMatchObject([{ name: "tienda", state: "stopped" }]);
    } finally {
      await client.close();
    }
  });
});
