import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const settingsSchema = z.object({
  lastWorkspace: z.string().optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  /** MCP server for agents; the token is encrypted with the OS keystore when it can be ("enc:" + base64). */
  mcp: z.object({ enabled: z.boolean(), port: z.number().int().min(0).max(65535), token: z.string() }).optional(),
});
export type Settings = z.infer<typeof settingsSchema>;

/** App settings in userData/settings.json. A broken file is ignored, never fatal. */
export class SettingsStore {
  readonly #file: string;
  #value: Settings = {};

  constructor(userDataDir: string) {
    this.#file = join(userDataDir, "settings.json");
  }

  async load(): Promise<Settings> {
    try {
      const parsed = settingsSchema.safeParse(JSON.parse(await readFile(this.#file, "utf8")));
      this.#value = parsed.success ? parsed.data : {};
    } catch {
      this.#value = {};
    }
    return { ...this.#value };
  }

  async update(patch: Partial<Settings>): Promise<void> {
    this.#value = { ...this.#value, ...patch };
    // Atomic write: a crash mid-write leaves the previous file intact.
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#value, null, 2));
    await rename(tmp, this.#file);
  }
}
