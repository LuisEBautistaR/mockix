import { DatabaseSync, type StatementSync } from "node:sqlite";
import { join } from "node:path";
import type { CallbackLog, RequestLog } from "@shared/ipc";

/** Requests kept per mock; older ones are pruned. */
const KEEP_PER_MOCK = 5_000;
const PRUNE_EVERY = 200;

/**
 * The live log on disk (userData/mockix.db), so it survives restarts. Bodies
 * are already cut to the capture limit and credentials already redacted by the
 * core before anything reaches main.
 */
export class LogStore {
  readonly #db: DatabaseSync;
  readonly #insert: StatementSync;
  readonly #insertCallback: StatementSync;
  readonly #recent: StatementSync;
  readonly #recentCallbacks: StatementSync;
  readonly #prune: StatementSync;
  readonly #pruneCallbacks: StatementSync;
  readonly #clear: StatementSync;
  readonly #clearCallbacks: StatementSync;
  #inserts = 0;

  constructor(userDataDir: string, file = "mockix.db") {
    this.#db = new DatabaseSync(join(userDataDir, file));
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY,
        mock TEXT NOT NULL,
        at INTEGER NOT NULL,
        entry TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_mock ON requests (mock, id);
      CREATE TABLE IF NOT EXISTS callbacks (
        id INTEGER PRIMARY KEY,
        mock TEXT NOT NULL,
        at INTEGER NOT NULL,
        entry TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS callbacks_mock ON callbacks (mock, id);
    `);
    this.#insert = this.#db.prepare("INSERT INTO requests (mock, at, entry) VALUES (?, ?, ?)");
    this.#insertCallback = this.#db.prepare("INSERT INTO callbacks (mock, at, entry) VALUES (?, ?, ?)");
    this.#recent = this.#db.prepare("SELECT entry FROM requests WHERE mock = ? ORDER BY id DESC LIMIT ?");
    this.#recentCallbacks = this.#db.prepare("SELECT entry FROM callbacks WHERE mock = ? ORDER BY id DESC LIMIT ?");
    const pruneSql = (table: string) =>
      `DELETE FROM ${table} WHERE mock = ? AND id <= (SELECT id FROM ${table} WHERE mock = ? ORDER BY id DESC LIMIT 1 OFFSET ${KEEP_PER_MOCK})`;
    this.#prune = this.#db.prepare(pruneSql("requests"));
    this.#pruneCallbacks = this.#db.prepare(pruneSql("callbacks"));
    this.#clear = this.#db.prepare("DELETE FROM requests WHERE mock = ?");
    this.#clearCallbacks = this.#db.prepare("DELETE FROM callbacks WHERE mock = ?");
  }

  add(mock: string, entry: RequestLog): void {
    this.#insert.run(mock, entry.at, JSON.stringify(entry));
    if (++this.#inserts % PRUNE_EVERY === 0) {
      this.#prune.run(mock, mock);
      this.#pruneCallbacks.run(mock, mock);
    }
  }

  addCallback(mock: string, entry: CallbackLog): void {
    this.#insertCallback.run(mock, entry.at, JSON.stringify(entry));
  }

  /** Newest first. */
  recent(mock: string, limit: number): { requests: RequestLog[]; callbacks: CallbackLog[] } {
    const parse = <T>(rows: unknown[]) => rows.map((r) => JSON.parse((r as { entry: string }).entry) as T);
    return {
      requests: parse<RequestLog>(this.#recent.all(mock, limit)),
      callbacks: parse<CallbackLog>(this.#recentCallbacks.all(mock, limit)),
    };
  }

  clear(mock: string): void {
    this.#clear.run(mock);
    this.#clearCallbacks.run(mock);
  }

  close(): void {
    this.#db.close();
  }
}
