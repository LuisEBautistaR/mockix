import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";

export interface WorkspaceWatcher {
  close(): void;
}

/** Folders whose changes never affect the mocks: local state, git internals. */
const IGNORED = [".mockix", ".git", "node_modules"];

/**
 * Calls `onChange` once after a burst of edits settles (editors save in
 * several steps). Ignores .mockix/, .git/ and node_modules/.
 */
export function watchWorkspace(dir: string, onChange: (files: string[]) => void, debounceMs = 150): WorkspaceWatcher {
  let timer: NodeJS.Timeout | null = null;
  const pending = new Set<string>();
  let watcher: FSWatcher | null = watch(dir, { recursive: true }, (_event, filename) => {
    const name = filename ? filename.toString() : "";
    if (name && IGNORED.some((d) => name === d || name.startsWith(d + sep) || name.startsWith(`${d}/`))) return;
    pending.add(name.split(sep).join("/"));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const files = [...pending];
      pending.clear();
      onChange(files);
    }, debounceMs);
  });
  watcher.on("error", () => {
    // The folder may have been removed; the owner decides what to do on the next load.
  });
  return {
    close() {
      if (timer) clearTimeout(timer);
      watcher?.close();
      watcher = null;
    },
  };
}
