/**
 * `mockix mcp`: the MCP server over stdio, for agents that start it
 * themselves (Claude Code, Claude Desktop…). stdout carries the protocol, so
 * everything for people goes to stderr. Every call lands in
 * .mockix/mcp-audit.jsonl.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LocalBackend, createMcpServer, isWorkspace, loadWorkspace, type AuditEntry } from "@mockix/core";
import type { Io } from "./main.js";

export async function mcpCommand(cmd: { dir: string; readOnly: boolean }, io: Io, stop: AbortSignal, version: string): Promise<number> {
  const dir = resolve(cmd.dir);
  const load = await loadWorkspace(dir);
  if (!(await isWorkspace(dir))) {
    io.err(`mockix: ${dir} no es un workspace de Mockix (crea uno con «mockix init»)`);
    return 1;
  }
  const auditFile = join(dir, ".mockix", "mcp-audit.jsonl");
  const audit = (entry: AuditEntry) => {
    void mkdir(join(dir, ".mockix"), { recursive: true }).then(() => appendFile(auditFile, `${JSON.stringify(entry)}\n`));
    io.err(`mcp  ${entry.tool}  ${entry.outcome}${entry.detail ? `: ${entry.detail.split("\n")[0]}` : ""}`);
  };
  const backend = new LocalBackend(dir, { serverHeader: `Mockix/${version}` });
  const server = createMcpServer(backend, { name: "mockix", version, readOnly: cmd.readOnly, audit });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  io.err(`MCP de Mockix por stdio sobre ${dir}${cmd.readOnly ? " (solo lectura)" : ""}. Auditoría en .mockix/mcp-audit.jsonl`);
  await new Promise<void>((done) => {
    if (stop.aborted) return done();
    stop.addEventListener("abort", () => done(), { once: true });
    process.stdin.once("end", () => done());
    transport.onclose = () => done();
  });
  await server.close().catch(() => undefined);
  await backend.close();
  return 0;
}
