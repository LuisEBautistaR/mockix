/**
 * mockix:// links (Sendix: "crear mock desde esta colección"). A link never
 * does anything by itself: it is validated, shown to the user, and only acts
 * after they confirm in the window.
 *
 *   mockix://import?collection=<file>[&workspace=<folder>]
 *   mockix://open?workspace=<folder>
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { LinkRequest } from "@shared/ipc";

const PROTOCOL = "mockix:";
const MAX_COLLECTION = 50 * 1024 * 1024;

const absolute = z.string().min(3).max(1024).refine((p) => isAbsolute(p) && !p.includes("\0"), "una ruta absoluta");
const importLink = z.object({ collection: absolute.refine((p) => /\.(json|ya?ml|har)$/i.test(p), "un .json, .yaml o .har"), workspace: absolute.optional() });
const openLink = z.object({ workspace: absolute });

type Events = { request: [LinkRequest] };

export class LinkService extends EventEmitter<Events> {
  readonly #pending = new Map<string, LinkRequest>();
  readonly #log: (message: string, detail?: unknown) => void;

  constructor(log: (message: string, detail?: unknown) => void) {
    super();
    this.#log = log;
  }

  /**
   * Points mockix:// at this app when it no longer does, and says whether it had to.
   * An update or another installation can remove or redirect it while Mockix runs.
   */
  static ensureRegistered(app: { isDefaultProtocolClient(scheme: string): boolean; setAsDefaultProtocolClient(scheme: string): boolean }): boolean {
    const scheme = PROTOCOL.slice(0, -1);
    return !app.isDefaultProtocolClient(scheme) && app.setAsDefaultProtocolClient(scheme);
  }

  /** The first mockix:// argument of a command line (Windows passes links as arguments). */
  static fromArgv(argv: readonly string[]): string | null {
    return argv.find((a) => a.toLowerCase().startsWith(`${PROTOCOL}//`)) ?? null;
  }

  async handle(raw: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return this.#log("ignored a malformed mockix:// link");
    }
    if (url.protocol !== PROTOCOL) return;
    const params = Object.fromEntries(url.searchParams);
    const action = url.hostname || url.pathname.replace(/^\/+/, "");
    let request: LinkRequest | null = null;
    if (action === "import") {
      const parsed = importLink.safeParse(params);
      if (!parsed.success) return this.#log("ignored an invalid mockix://import link", parsed.error.issues);
      const info = await stat(parsed.data.collection).catch(() => null);
      if (!info?.isFile() || info.size > MAX_COLLECTION) return this.#log("ignored mockix://import: the collection is missing or too large");
      if (parsed.data.workspace && !(await stat(join(parsed.data.workspace, "mockix.workspace.yaml")).catch(() => null))) {
        return this.#log("ignored mockix://import: the folder is not a Mockix workspace");
      }
      request = { id: randomUUID(), kind: "import", collection: parsed.data.collection, workspace: parsed.data.workspace ?? null };
    } else if (action === "open") {
      const parsed = openLink.safeParse(params);
      if (!parsed.success || !(await stat(join(parsed.data.workspace, "mockix.workspace.yaml")).catch(() => null))) return this.#log("ignored an invalid mockix://open link");
      request = { id: randomUUID(), kind: "open", collection: null, workspace: parsed.data.workspace };
    } else return this.#log(`ignored mockix://${action}: unknown action`);
    this.#pending.set(request.id, request);
    this.emit("request", request);
  }

  /** The confirmed request (removed), or null for an unknown or answered id. */
  take(id: string): LinkRequest | null {
    const r = this.#pending.get(id) ?? null;
    this.#pending.delete(id);
    return r;
  }

  pending(): LinkRequest[] {
    return [...this.#pending.values()];
  }
}
