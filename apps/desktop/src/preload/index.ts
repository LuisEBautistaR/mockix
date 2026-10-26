/**
 * Runs sandboxed with context isolation: the page cannot reach ipcRenderer or
 * Node, only the named functions below. Arguments are validated again in main.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IpcChannels, type AgentsState, type LinkRequest, type UpdateState, type ExchangeSummary, type MockCallbackEvent, type MockMessageEvent, type MockRequestEvent, type MockStatus, type RecordingStatus, type WorkspaceState } from "@shared/ipc";
import type { MockixApi } from "./api";

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: MockixApi = {
  workspace: {
    get: () => ipcRenderer.invoke(IpcChannels.workspaceGet),
    open: () => ipcRenderer.invoke(IpcChannels.workspaceOpen),
    createExample: () => ipcRenderer.invoke(IpcChannels.workspaceCreateExample),
    importFile: () => ipcRenderer.invoke(IpcChannels.workspaceImport),
    onChange: (listener) => subscribe<WorkspaceState>(IpcChannels.workspaceChanged, listener),
  },
  mocks: {
    list: () => ipcRenderer.invoke(IpcChannels.mocksList),
    start: (id) => ipcRenderer.invoke(IpcChannels.mocksStart, id),
    stop: (id) => ipcRenderer.invoke(IpcChannels.mocksStop, id),
    send: (id, request) => ipcRenderer.invoke(IpcChannels.mocksSend, id, request),
    create: (name, port, prefix) => ipcRenderer.invoke(IpcChannels.mocksCreate, name, port, prefix),
    remove: (id) => ipcRenderer.invoke(IpcChannels.mocksDelete, id),
    exportOpenApi: (id) => ipcRenderer.invoke(IpcChannels.mocksExport, id),
    crashHost: (id) => ipcRenderer.invoke(IpcChannels.mocksCrashHost, id),
    onList: (listener) => subscribe<MockStatus[]>(IpcChannels.mocksChanged, listener),
    onStatus: (listener) => subscribe<MockStatus>(IpcChannels.mockStatusChanged, listener),
    onRequest: (listener) => subscribe<MockRequestEvent>(IpcChannels.mockRequest, listener),
    onCallback: (listener) => subscribe<MockCallbackEvent>(IpcChannels.mockCallback, listener),
    onMessage: (listener) => subscribe<MockMessageEvent>(IpcChannels.mockMessage, listener),
  },
  live: {
    source: (mockId, file) => ipcRenderer.invoke(IpcChannels.liveSource, mockId, file),
    connect: (mockId, routeId) => ipcRenderer.invoke(IpcChannels.liveConnect, mockId, routeId),
    send: (mockId, routeId, text, event) => ipcRenderer.invoke(IpcChannels.liveSend, mockId, routeId, text, event),
    disconnect: (mockId, routeId) => ipcRenderer.invoke(IpcChannels.liveDisconnect, mockId, routeId),
    grpcExample: (mockId, service, method) => ipcRenderer.invoke(IpcChannels.grpcExample, mockId, service, method),
    grpcCall: (mockId, service, method, text) => ipcRenderer.invoke(IpcChannels.grpcCall, mockId, service, method, text),
  },
  routes: {
    read: (mockId, routeId) => ipcRenderer.invoke(IpcChannels.routesRead, mockId, routeId),
    write: (mockId, routeId, draft, folder = "") => ipcRenderer.invoke(IpcChannels.routesWrite, mockId, routeId, draft, folder),
    remove: (mockId, routeId) => ipcRenderer.invoke(IpcChannels.routesDelete, mockId, routeId),
    preview: (mockId, method, path, text) => ipcRenderer.invoke(IpcChannels.routesPreview, mockId, method, path, text),
  },
  recordings: {
    list: () => ipcRenderer.invoke(IpcChannels.recordingsList),
    status: () => ipcRenderer.invoke(IpcChannels.recordingsStatus),
    start: (target, port) => ipcRenderer.invoke(IpcChannels.recordingsStart, target, port),
    stop: () => ipcRenderer.invoke(IpcChannels.recordingsStop),
    exchanges: (file) => ipcRenderer.invoke(IpcChannels.recordingsExchanges, file),
    plan: (file, into, prefix) => ipcRenderer.invoke(IpcChannels.recordingsPlan, file, into, prefix),
    preview: (file, index, prefix) => ipcRenderer.invoke(IpcChannels.recordingsPreview, file, index, prefix),
    convert: (file, target, prefix) => ipcRenderer.invoke(IpcChannels.recordingsConvert, file, target, prefix),
    remove: (file) => ipcRenderer.invoke(IpcChannels.recordingsDelete, file),
    onStatus: (listener) => subscribe<RecordingStatus>(IpcChannels.recordingStatusChanged, listener),
    onExchange: (listener) => subscribe<ExchangeSummary>(IpcChannels.recordingExchange, listener),
  },
  contracts: {
    get: (mockId) => ipcRenderer.invoke(IpcChannels.contractsGet, mockId),
    schema: (mockId, violation) => ipcRenderer.invoke(IpcChannels.contractsSchema, mockId, violation),
    setMode: (mockId, mode) => ipcRenderer.invoke(IpcChannels.contractsSetMode, mockId, mode),
    exportReport: (mockId) => ipcRenderer.invoke(IpcChannels.contractsExport, mockId),
    clear: (mockId) => ipcRenderer.invoke(IpcChannels.contractsClear, mockId),
  },
  scenarios: {
    get: (mockId) => ipcRenderer.invoke(IpcChannels.scenariosGet, mockId),
    set: (mockId, scenario, key, state) => ipcRenderer.invoke(IpcChannels.scenariosSet, mockId, scenario, key, state),
    reset: (mockId, scenario) => ipcRenderer.invoke(IpcChannels.scenariosReset, mockId, scenario),
  },
  chaos: {
    get: () => ipcRenderer.invoke(IpcChannels.chaosGet),
    save: (name, draft) => ipcRenderer.invoke(IpcChannels.chaosSave, name, draft),
    assign: (mockId, profile) => ipcRenderer.invoke(IpcChannels.chaosAssign, mockId, profile),
    pause: (mockId, paused) => ipcRenderer.invoke(IpcChannels.chaosPause, mockId, paused),
    restart: (mockId) => ipcRenderer.invoke(IpcChannels.chaosRestart, mockId),
  },
  agents: {
    get: () => ipcRenderer.invoke(IpcChannels.agentsGet),
    setEnabled: (enabled) => ipcRenderer.invoke(IpcChannels.agentsSetEnabled, enabled),
    setTrust: (trust) => ipcRenderer.invoke(IpcChannels.agentsSetTrust, trust),
    decide: (id, decision) => ipcRenderer.invoke(IpcChannels.agentsDecide, id, decision),
    rotateToken: () => ipcRenderer.invoke(IpcChannels.agentsRotate),
    onChange: (listener) => subscribe<AgentsState>(IpcChannels.agentsChanged, listener),
  },
  updates: {
    get: () => ipcRenderer.invoke(IpcChannels.updatesGet),
    check: () => ipcRenderer.invoke(IpcChannels.updatesCheck),
    install: () => ipcRenderer.invoke(IpcChannels.updatesInstall),
    onChange: (listener) => subscribe<UpdateState>(IpcChannels.updatesChanged, listener),
  },
  links: {
    pending: () => ipcRenderer.invoke(IpcChannels.linksPending),
    decide: (id, accept) => ipcRenderer.invoke(IpcChannels.linkDecide, id, accept),
    onRequest: (listener) => subscribe<LinkRequest>(IpcChannels.linkRequest, listener),
  },
  sendix: {
    available: () => ipcRenderer.invoke(IpcChannels.sendixAvailable),
    open: (request) => ipcRenderer.invoke(IpcChannels.sendixOpen, request),
  },
  logs: {
    recent: (id, limit) => ipcRenderer.invoke(IpcChannels.logsRecent, id, limit),
    clear: (id) => ipcRenderer.invoke(IpcChannels.logsClear, id),
  },
  app: {
    info: () => ipcRenderer.invoke(IpcChannels.appInfo),
    theme: () => ipcRenderer.invoke(IpcChannels.themeGet),
    setTheme: (theme) => ipcRenderer.invoke(IpcChannels.themeSet, theme),
    copy: (text) => ipcRenderer.invoke(IpcChannels.clipboardWrite, text),
  },
};

contextBridge.exposeInMainWorld("mockix", api);
