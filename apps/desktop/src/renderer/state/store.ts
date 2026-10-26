/**
 * Renderer state: the open workspace, its mocks, the route tabs and their
 * drafts, and the live log. Everything that touches disk or a mock goes
 * through window.mockix; this store only keeps what the UI shows.
 */
import { create } from "zustand";
import type { AgentsState, CallbackLog, FromContractOptions, ImportSummary, MessageLog, MockStatus, ProbeResult, RequestLog, RouteDocument, RouteDraft, Theme, WorkspaceState } from "@shared/ipc";
import type { RpcError } from "@shared/rpc";

export interface LogRow extends RequestLog {
  mockId: string;
  key: string;
}

export interface CallbackRow extends CallbackLog {
  mockId: string;
  key: string;
}

export interface MessageRow extends MessageLog {
  mockId: string;
  key: string;
}

/** A WebSocket route, Socket.IO namespace or gRPC service open in the main area. */
export type LiveTarget = { mockId: string; kind: "realtime"; id: string } | { mockId: string; kind: "grpc"; id: string };

export interface Tab {
  mockId: string;
  routeId: string;
}

export interface Draft {
  doc: RouteDocument;
  /** What the editor shows; saved = doc.draft. */
  draft: RouteDraft;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  /** Index of the response being edited. */
  response: number;
}

export type View = "mocks" | "settings" | "recordings" | "scenarios" | "chaos" | "contracts" | "agents";
export type Dialog = { kind: "new-mock"; start?: "contract" | "empty" } | { kind: "new-route"; mockId: string } | { kind: "delete-mock"; mockId: string } | { kind: "quick-open" } | { kind: "import-result"; summary: ImportSummary } | null;

const MAX_LOG = 1000;
const tabKey = (t: Tab) => `${t.mockId}/${t.routeId}`;
export const requestKey = (mockId: string, r: RequestLog) => `${mockId}-r-${r.at}-${r.seq}`;
export const callbackKey = (mockId: string, r: CallbackLog) => `${mockId}-c-${r.at}-${r.requestSeq}-${r.url}`;

interface State {
  workspace: WorkspaceState | null;
  mocks: MockStatus[];
  selectedMock: string | null;
  tabs: Tab[];
  activeTab: string | null;
  drafts: Record<string, Draft>;
  log: LogRow[];
  callbacks: CallbackRow[];
  messages: MessageRow[];
  live: LiveTarget | null;
  agents: AgentsState | null;
  selectedLog: string | null;
  lastProbe: { at: number; result?: ProbeResult; error?: RpcError } | null;
  notice: string | null;
  view: View;
  dialog: Dialog;
  theme: Theme;

  init(): () => void;
  setNotice(text: string | null): void;
  setView(view: View): void;
  setDialog(dialog: Dialog): void;
  selectMock(id: string): void;
  openWorkspace(kind: "open" | "example"): Promise<void>;
  openRoute(mockId: string, routeId: string): Promise<void>;
  openLive(target: LiveTarget): void;
  closeTab(key: string): void;
  activate(key: string): void;
  updateDraft(key: string, fn: (d: RouteDraft) => RouteDraft): void;
  selectResponse(key: string, index: number): void;
  save(key: string): Promise<boolean>;
  revert(key: string): void;
  createMock(name: string, port: number, prefix: string): Promise<string | null>;
  /** Creates a mock from the contract picked in the dialog and shows the report; returns the error message, or null. */
  createFromContract(options: FromContractOptions): Promise<string | null>;
  /** Moves the mock folder to the OS trash; returns the error message, or null. */
  deleteMock(mockId: string): Promise<string | null>;
  importFile(): Promise<void>;
  exportOpenApi(mockId: string): Promise<void>;
  createRoute(mockId: string, draft: RouteDraft, folder: string): Promise<string | null>;
  deleteRoute(key: string): Promise<void>;
  toggleMock(id: string): Promise<void>;
  send(mockId: string, method: string, path: string, body?: string): Promise<void>;
  loadLog(mockId: string): Promise<void>;
  clearLog(mockId: string): Promise<void>;
  selectLog(key: string | null): void;
  setTheme(theme: Theme): Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  workspace: null,
  mocks: [],
  selectedMock: null,
  tabs: [],
  activeTab: null,
  drafts: {},
  log: [],
  callbacks: [],
  messages: [],
  live: null,
  agents: null,
  selectedLog: null,
  lastProbe: null,
  notice: null,
  view: "mocks",
  dialog: null,
  theme: "system",

  init() {
    const api = window.mockix;
    const offs = [
      api.workspace.onChange((workspace) => set({ workspace })),
      api.mocks.onList((mocks) => {
        set((s) => ({ mocks, selectedMock: s.selectedMock && mocks.some((m) => m.id === s.selectedMock) ? s.selectedMock : (mocks[0]?.id ?? null) }));
        // Tabs whose route disappeared from disk close; open drafts reload when clean.
        for (const tab of get().tabs) {
          const mock = mocks.find((m) => m.id === tab.mockId);
          if (!mock || !mock.routes.some((r) => r.id === tab.routeId)) {
            if (!get().drafts[tabKey(tab)]?.dirty) get().closeTab(tabKey(tab));
          }
        }
      }),
      api.mocks.onStatus((status) =>
        set((s) => {
          const i = s.mocks.findIndex((m) => m.id === status.id);
          return { mocks: i === -1 ? [...s.mocks, status] : s.mocks.map((m) => (m.id === status.id ? status : m)) };
        }),
      ),
      api.mocks.onRequest(({ mockId, entry }) => {
        const row = { mockId, key: requestKey(mockId, entry), ...entry };
        set((s) => ({ log: [row, ...s.log].slice(0, MAX_LOG), selectedLog: s.selectedLog === "latest" ? "latest" : s.selectedLog }));
      }),
      api.mocks.onCallback(({ mockId, entry }) => set((s) => ({ callbacks: [{ mockId, key: callbackKey(mockId, entry), ...entry }, ...s.callbacks].slice(0, MAX_LOG) }))),
      api.agents.onChange((agents) => set({ agents })),
      api.mocks.onMessage(({ mockId, entry }) => set((s) => ({ messages: [{ mockId, key: `${mockId}-m-${entry.at}-${entry.connection}-${s.messages.length}-${Math.random()}`, ...entry }, ...s.messages].slice(0, MAX_LOG) }))),
    ];
    void api.workspace.get().then((w) => w && set((s) => ({ workspace: s.workspace ?? w })));
    void api.mocks.list().then((list) => list && set((s) => (s.mocks.length ? {} : { mocks: list, selectedMock: s.selectedMock ?? list[0]?.id ?? null })));
    void api.app.theme().then((theme) => theme && set({ theme }));
    void api.agents.get().then((agents) => agents && set((s) => ({ agents: s.agents ?? agents })));
    return () => offs.forEach((off) => off());
  },

  setNotice: (notice) => set({ notice }),
  setView: (view) => set({ view }),
  setDialog: (dialog) => set({ dialog }),
  selectMock: (id) => set({ selectedMock: id, view: "mocks" }),

  async openWorkspace(kind) {
    set({ notice: null });
    const outcome = kind === "open" ? await window.mockix.workspace.open() : await window.mockix.workspace.createExample();
    if (!outcome.ok) {
      set({ notice: outcome.error.code === "WORKSPACE_EXISTS" ? "Esa carpeta ya tiene un workspace de Mockix: ábrela con «Abrir carpeta»." : outcome.error.message });
    } else if (outcome.value) {
      set({ workspace: outcome.value, tabs: [], activeTab: null, drafts: {}, selectedMock: null, view: "mocks", lastProbe: null });
    }
  },

  async openRoute(mockId, routeId) {
    const key = tabKey({ mockId, routeId });
    set((s) => ({ selectedMock: mockId, view: "mocks", live: null, tabs: s.tabs.some((t) => tabKey(t) === key) ? s.tabs : [...s.tabs, { mockId, routeId }], activeTab: key }));
    if (get().drafts[key]) return;
    const outcome = await window.mockix.routes.read(mockId, routeId);
    if (!outcome.ok) {
      set({ notice: `No se puede abrir ${routeId}: ${outcome.error.message}` });
      get().closeTab(key);
      return;
    }
    const firstDefault = Math.max(0, outcome.value.draft.responses?.findIndex((r) => r.default) ?? 0);
    set((s) => ({ drafts: { ...s.drafts, [key]: { doc: outcome.value, draft: structuredClone(outcome.value.draft), dirty: false, saving: false, error: null, response: firstDefault } } }));
  },

  closeTab(key) {
    set((s) => {
      const tabs = s.tabs.filter((t) => tabKey(t) !== key);
      const drafts = { ...s.drafts };
      delete drafts[key];
      const index = s.tabs.findIndex((t) => tabKey(t) === key);
      const next = s.activeTab === key ? (tabs[Math.max(0, index - 1)] ?? null) : null;
      return { tabs, drafts, activeTab: s.activeTab === key ? (next ? tabKey(next) : null) : s.activeTab };
    });
  },

  activate: (key) => set({ activeTab: key, live: null, view: "mocks", selectedMock: key.split("/")[0] ?? null }),

  openLive: (target) => set({ live: target, activeTab: null, view: "mocks", selectedMock: target.mockId }),

  updateDraft(key, fn) {
    set((s) => {
      const d = s.drafts[key];
      if (!d) return {};
      const draft = fn(structuredClone(d.draft));
      const dirty = JSON.stringify(draft) !== JSON.stringify(d.doc.draft);
      const response = Math.min(d.response, Math.max(0, (draft.responses?.length ?? 1) - 1));
      return { drafts: { ...s.drafts, [key]: { ...d, draft, dirty, error: null, response } } };
    });
  },

  selectResponse: (key, index) => set((s) => (s.drafts[key] ? { drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, response: index } } } : {})),

  async save(key) {
    const d = get().drafts[key];
    if (!d) return false;
    const [mockId, ...rest] = key.split("/");
    const routeId = rest.join("/");
    set((s) => ({ drafts: { ...s.drafts, [key]: { ...d, saving: true, error: null } } }));
    const outcome = await window.mockix.routes.write(mockId!, routeId, d.draft);
    if (!outcome.ok) {
      set((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, saving: false, error: outcome.error.message } } }));
      return false;
    }
    const newKey = `${mockId}/${outcome.value.id}`;
    const fresh = await window.mockix.routes.read(mockId!, outcome.value.id);
    set((s) => {
      const drafts = { ...s.drafts };
      delete drafts[key];
      if (fresh.ok) drafts[newKey] = { doc: fresh.value, draft: structuredClone(fresh.value.draft), dirty: false, saving: false, error: null, response: d.response };
      return {
        drafts,
        tabs: s.tabs.map((t) => (tabKey(t) === key ? { mockId: mockId!, routeId: outcome.value.id } : t)),
        activeTab: s.activeTab === key ? newKey : s.activeTab,
      };
    });
    return true;
  },

  revert: (key) => set((s) => (s.drafts[key] ? { drafts: { ...s.drafts, [key]: { ...s.drafts[key]!, draft: structuredClone(s.drafts[key]!.doc.draft), dirty: false, error: null } } } : {})),

  async createMock(name, port, prefix) {
    const outcome = await window.mockix.mocks.create(name, port, prefix);
    if (!outcome.ok) return outcome.error.message;
    set({ selectedMock: name });
    return null;
  },

  async createFromContract(options) {
    const outcome = await window.mockix.mocks.createFromContract(options);
    if (!outcome.ok) return outcome.error.message;
    set({ dialog: { kind: "import-result", summary: outcome.value }, selectedMock: outcome.value.name, view: "mocks" });
    return null;
  },

  async deleteMock(mockId) {
    const outcome = await window.mockix.mocks.remove(mockId);
    if (!outcome.ok) return outcome.error.message;
    set((s) => {
      const tabs = s.tabs.filter((t) => t.mockId !== mockId);
      const drafts = Object.fromEntries(Object.entries(s.drafts).filter(([key]) => !key.startsWith(`${mockId}/`)));
      const activeTab = s.activeTab?.startsWith(`${mockId}/`) ? (tabs[0] ? tabKey(tabs[0]) : null) : s.activeTab;
      return {
        tabs,
        drafts,
        activeTab,
        dialog: null,
        selectedMock: s.selectedMock === mockId ? null : s.selectedMock,
        live: s.live?.mockId === mockId ? null : s.live,
        notice: `El mock «${mockId}» está en la papelera.`,
      };
    });
    return null;
  },

  async importFile() {
    set({ notice: null });
    const outcome = await window.mockix.workspace.importFile();
    if (!outcome.ok) set({ notice: `No se pudo importar: ${outcome.error.message}` });
    else if (outcome.value) set({ dialog: { kind: "import-result", summary: outcome.value }, selectedMock: outcome.value.name, view: "mocks" });
  },

  async exportOpenApi(mockId) {
    const outcome = await window.mockix.mocks.exportOpenApi(mockId);
    if (!outcome.ok) set({ notice: `No se pudo exportar: ${outcome.error.message}` });
    else if (outcome.value) set({ notice: `OpenAPI 3.1 escrito en ${outcome.value.file}` });
  },

  async createRoute(mockId, draft, folder) {
    const outcome = await window.mockix.routes.write(mockId, null, draft, folder);
    if (!outcome.ok) return outcome.error.message;
    await get().openRoute(mockId, outcome.value.id);
    return null;
  },

  async deleteRoute(key) {
    const [mockId, ...rest] = key.split("/");
    const outcome = await window.mockix.routes.remove(mockId!, rest.join("/"));
    if (!outcome.ok) set({ notice: outcome.error.message });
    else get().closeTab(key);
  },

  async toggleMock(id) {
    const mock = get().mocks.find((m) => m.id === id);
    if (!mock) return;
    set({ notice: null });
    const outcome = mock.state === "stopped" || mock.state === "failed" ? await window.mockix.mocks.start(id) : await window.mockix.mocks.stop(id);
    if (!outcome.ok && outcome.error.code === "HAS_PROBLEMS") set({ notice: "Corrige los problemas del mock para poder iniciarlo." });
  },

  async send(mockId, method, path, body) {
    set({ selectedLog: "latest" });
    const outcome = await window.mockix.mocks.send(mockId, { method, path, ...(body ? { body } : {}) });
    set({ lastProbe: outcome.ok ? { at: Date.now(), result: outcome.value } : { at: Date.now(), error: outcome.error } });
    if (!outcome.ok) set({ notice: `Probar: ${outcome.error.message}` });
  },

  async loadLog(mockId) {
    const outcome = await window.mockix.logs.recent(mockId, 300);
    if (!outcome.ok) return;
    const stored = outcome.value.requests.map((r) => ({ mockId, key: requestKey(mockId, r), ...r }));
    const storedCallbacks = outcome.value.callbacks.map((r) => ({ mockId, key: callbackKey(mockId, r), ...r }));
    set((s) => {
      const seen = new Set(stored.map((r) => r.key));
      const seenCb = new Set(storedCallbacks.map((r) => r.key));
      return {
        log: [...s.log.filter((r) => !seen.has(r.key)), ...stored].sort((a, b) => b.at - a.at).slice(0, MAX_LOG),
        callbacks: [...s.callbacks.filter((r) => !seenCb.has(r.key)), ...storedCallbacks].sort((a, b) => b.at - a.at).slice(0, MAX_LOG),
      };
    });
  },

  async clearLog(mockId) {
    await window.mockix.logs.clear(mockId);
    set((s) => ({ log: s.log.filter((r) => r.mockId !== mockId), callbacks: s.callbacks.filter((r) => r.mockId !== mockId), selectedLog: null }));
  },

  selectLog: (key) => set({ selectedLog: key }),

  async setTheme(theme) {
    const outcome = await window.mockix.app.setTheme(theme);
    if (outcome.ok) set({ theme: outcome.value });
  },
}));

export { tabKey };
