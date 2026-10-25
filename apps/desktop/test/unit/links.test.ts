import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeExampleWorkspace } from "@mockix/core";
import { LinkService } from "../../src/main/links";
import type { LinkRequest } from "@shared/ipc";

const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "mockix-links-"));
  dirs.push(dir);
  const ws = join(dir, "ws");
  await writeExampleWorkspace(ws);
  const collection = join(dir, "tienda.postman_collection.json");
  await writeFile(collection, '{"info":{"schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},"item":[]}');
  const logs: string[] = [];
  const links = new LinkService((m) => logs.push(m));
  const got: LinkRequest[] = [];
  links.on("request", (r) => got.push(r));
  return { dir, ws, collection, links, got, logs };
}

const link = (action: string, params: Record<string, string>) => `mockix://${action}?${new URLSearchParams(params).toString()}`;

describe("mockix:// links", () => {
  it("finds the link among the command line arguments", () => {
    expect(LinkService.fromArgv(["Mockix.exe", "--flag", "mockix://import?collection=x"])).toBe("mockix://import?collection=x");
    expect(LinkService.fromArgv(["Mockix.exe", "."])).toBeNull();
  });

  it("turns a valid import or open link into a request that waits for the user", async () => {
    const { ws, collection, links, got } = await setup();
    await links.handle(link("import", { collection, workspace: ws }));
    await links.handle(link("open", { workspace: ws }));
    expect(got).toMatchObject([
      { kind: "import", collection, workspace: ws },
      { kind: "open", collection: null, workspace: ws },
    ]);
    expect(links.pending()).toHaveLength(2);
    expect(links.take(got[0]!.id)).toMatchObject({ kind: "import" });
    expect(links.take(got[0]!.id)).toBeNull();
  });

  it("ignores links with relative paths, missing files, other extensions or folders that are not workspaces", async () => {
    const { dir, ws, collection, links, got, logs } = await setup();
    await links.handle(link("import", { collection: "tienda.json" }));
    await links.handle(link("import", { collection: join(dir, "no-existe.json") }));
    await links.handle(link("import", { collection: join(dir, "malo.exe") }));
    await links.handle(link("import", { collection, workspace: dir }));
    await links.handle(link("open", { workspace: dir }));
    await links.handle(link("borrar", { workspace: ws }));
    await links.handle("no es un enlace");
    expect(got).toEqual([]);
    expect(logs).toHaveLength(7);
  });
});
