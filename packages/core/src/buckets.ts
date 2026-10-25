/**
 * Data buckets: JSON documents a mock keeps in memory. They start from the
 * seed files in mocks/<name>/data/, CRUD routes and the control API change
 * them, and a reset brings back the seed. Nothing is written back to disk.
 */
export class BucketStore {
  #seed: Record<string, unknown>;
  #data = new Map<string, unknown>();

  constructor(seed: Record<string, unknown>) {
    this.#seed = structuredClone(seed);
    this.reset();
  }

  names(): string[] {
    return [...this.#data.keys()];
  }

  has(name: string): boolean {
    return this.#data.has(name);
  }

  /** The live value (callers that change it must call set). */
  get(name: string): unknown {
    return this.#data.get(name);
  }

  set(name: string, value: unknown): void {
    this.#data.set(name, value);
  }

  /** Back to the seed: one bucket, or all of them. */
  reset(name?: string): void {
    const names = name === undefined ? Object.keys(this.#seed) : [name];
    if (name === undefined) this.#data.clear();
    for (const n of names) {
      if (Object.hasOwn(this.#seed, n)) this.#data.set(n, structuredClone(this.#seed[n]));
      else this.#data.delete(n);
    }
  }

  /** New seeds after a reload: buckets whose seed changed restart from it; the rest keep their live data. */
  reseed(seed: Record<string, unknown>): void {
    const old = this.#seed;
    const changed = (n: string) => JSON.stringify(old[n]) !== JSON.stringify(seed[n]);
    const names = new Set([...Object.keys(old), ...Object.keys(seed)]);
    this.#seed = structuredClone(seed);
    for (const n of names) {
      if (!Object.hasOwn(seed, n)) this.#data.delete(n);
      else if (!Object.hasOwn(old, n) || changed(n)) this.#data.set(n, structuredClone(seed[n]));
    }
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries([...this.#data].map(([k, v]) => [k, structuredClone(v)]));
  }
}
