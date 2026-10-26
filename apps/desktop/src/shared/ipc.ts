/** Channels between the renderer (through the preload bridge) and main. */
export const IpcChannels = {
  workspaceGet: "mockix:workspace-get",
  workspaceOpen: "mockix:workspace-open",
  workspaceCreateExample: "mockix:workspace-create-example",
  workspaceChanged: "mockix:workspace-changed",
  mocksList: "mockix:mocks-list",
  mocksStart: "mockix:mocks-start",
  mocksStop: "mockix:mocks-stop",
  mocksSend: "mockix:mocks-send",
  mocksCreate: "mockix:mocks-create",
  mocksDelete: "mockix:mocks-delete",
  mocksCreateFromContract: "mockix:mocks-create-from-contract",
  contractsPick: "mockix:contracts-pick",
  routesRead: "mockix:routes-read",
  routesWrite: "mockix:routes-write",
  routesDelete: "mockix:routes-delete",
  routesPreview: "mockix:routes-preview",
  themeGet: "mockix:theme-get",
  themeSet: "mockix:theme-set",
  clipboardWrite: "mockix:clipboard-write",
  workspaceImport: "mockix:workspace-import",
  recordingsList: "mockix:recordings-list",
  recordingsStatus: "mockix:recordings-status",
  recordingsStart: "mockix:recordings-start",
  recordingsStop: "mockix:recordings-stop",
  recordingsExchanges: "mockix:recordings-exchanges",
  recordingsPlan: "mockix:recordings-plan",
  recordingsPreview: "mockix:recordings-preview",
  recordingsConvert: "mockix:recordings-convert",
  recordingsDelete: "mockix:recordings-delete",
  recordingStatusChanged: "mockix:recording-status-changed",
  recordingExchange: "mockix:recording-exchange",
  mocksExport: "mockix:mocks-export",
  mocksCrashHost: "mockix:mocks-crash-host",
  mocksChanged: "mockix:mocks-changed",
  mockStatusChanged: "mockix:mock-status-changed",
  mockRequest: "mockix:mock-request",
  mockCallback: "mockix:mock-callback",
  logsRecent: "mockix:logs-recent",
  logsClear: "mockix:logs-clear",
  appInfo: "mockix:app-info",
  contractsGet: "mockix:contracts-get",
  contractsSchema: "mockix:contracts-schema",
  contractsSetMode: "mockix:contracts-set-mode",
  contractsExport: "mockix:contracts-export",
  contractsClear: "mockix:contracts-clear",
  scenariosGet: "mockix:scenarios-get",
  scenariosSet: "mockix:scenarios-set",
  scenariosReset: "mockix:scenarios-reset",
  chaosGet: "mockix:chaos-get",
  chaosSave: "mockix:chaos-save",
  chaosAssign: "mockix:chaos-assign",
  chaosPause: "mockix:chaos-pause",
  chaosRestart: "mockix:chaos-restart",
  mockMessage: "mockix:mock-message",
  liveSource: "mockix:live-source",
  liveConnect: "mockix:live-connect",
  liveSend: "mockix:live-send",
  liveDisconnect: "mockix:live-disconnect",
  grpcExample: "mockix:grpc-example",
  grpcCall: "mockix:grpc-call",
  agentsGet: "mockix:agents-get",
  agentsSetEnabled: "mockix:agents-set-enabled",
  agentsSetTrust: "mockix:agents-set-trust",
  agentsDecide: "mockix:agents-decide",
  agentsRotate: "mockix:agents-rotate",
  agentsChanged: "mockix:agents-changed",
  updatesGet: "mockix:updates-get",
  updatesCheck: "mockix:updates-check",
  updatesInstall: "mockix:updates-install",
  updatesChanged: "mockix:updates-changed",
  linksPending: "mockix:links-pending",
  linkRequest: "mockix:link-request",
  linkDecide: "mockix:link-decide",
  sendixAvailable: "mockix:sendix-available",
  sendixOpen: "mockix:sendix-open",
} as const;

export type MockState = "stopped" | "starting" | "running" | "restarting" | "failed";

export interface ProblemView {
  /** Relative to the workspace, forward slashes. */
  file: string;
  line: number | null;
  message: string;
}

export interface WorkspaceState {
  /** Absolute folder, or null when no workspace is open. */
  dir: string | null;
  /** Problems that are not about a single mock. */
  problems: ProblemView[];
}

export interface RouteSummary {
  id: string;
  method: string;
  path: string;
  mode: string;
  /** Statuses of its responses, in order. */
  statuses: number[];
  /** Response ids, in order. */
  responses: string[];
  /** Route file relative to the mock folder (routes/…yaml). */
  file: string;
  latencyMs: number;
}

export interface MockStatus {
  id: string;
  name: string;
  state: MockState;
  /** Interface the mock listens on. */
  host: string;
  /** Latency added to every route of the mock. */
  latencyMs: number;
  /** Seeds of the data buckets: name and number of items (or keys). */
  buckets: Array<{ name: string; size: number }>;
  proxyTarget: string | null;
  /** OpenAPI contract from mock.yaml, if any. */
  contract: { file: string; mode: ContractModeView } | null;
  /** WebSocket routes and Socket.IO namespaces. */
  realtime: RealtimeSummary[];
  /** gRPC server settings and services, if any. */
  grpc: GrpcSummary | null;
  /** Port the gRPC server is bound to while running. */
  grpcPort: number | null;
  /** Ids of the mock's scenarios (scenarios/*.yaml). */
  scenarios: string[];
  /** Bound port while running; the configured port otherwise (0 = any free port). */
  port: number;
  prefix: string;
  tls: boolean;
  url: string | null;
  routes: RouteSummary[];
  /** Problems in this mock's files; while any exist the mock cannot (re)start with them. */
  problems: ProblemView[];
  /** True when the mock keeps serving its last good version because the files on disk have problems. */
  stale: boolean;
  /** False until the mock has loaded once without problems: there is nothing to start yet. */
  startable: boolean;
  /** Process id of the mock's utilityProcess while it exists. */
  pid: number | null;
  /** Times main restarted the host after a crash during the current run. */
  restarts: number;
  /** Epoch ms when the mock started serving. */
  runningSince: number | null;
  error: { code: string; message: string } | null;
}

export interface CapturedMessage {
  headers: Record<string, string>;
  /** UTF-8 body cut at the capture limit; empty for binary bodies. */
  body: string;
  truncated: boolean;
  binary: boolean;
}

export type RequestKind = "route" | "crud" | "proxy" | "preflight" | "none";

export interface RequestLog {
  seq: number;
  at: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  kind: RequestKind;
  routeId: string | null;
  responseId: string | null;
  latencyMs: number;
  timings: { receiveMs: number; processMs: number; latencyMs: number; chaosMs: number; sendMs: number };
  /** Credentials are already redacted by the core. */
  request: CapturedMessage;
  response: CapturedMessage;
  error: string | null;
  /** What broke the mock's OpenAPI contract (missing in logs from before M6). */
  violations?: ViolationView[];
  /** What the chaos profile did (missing in logs from before M7). */
  chaos?: ChaosDecisionView | null;
}

/* ---------- WebSocket, Socket.IO and gRPC (M8) ---------- */

export interface RealtimeSummary {
  id: string;
  protocol: "ws" | "socketio";
  /** WebSocket path under the prefix, or Socket.IO namespace. */
  path: string;
  file: string;
  description: string | null;
  onConnect: Array<{ afterMs: number; everyMs: number | null; times: number | null; what: string; to: string }>;
  messages: Array<{ id: string; event: string | null; when: string; does: string }>;
  echo: boolean;
}

export type GrpcKind = "unary" | "server" | "client" | "bidi";

export interface GrpcSummary {
  port: number;
  tls: boolean;
  reflection: boolean;
  services: Array<{ service: string; file: string; proto: string; methods: Array<{ name: string; kind: GrpcKind; requestType: string; responseType: string; responses: string[] }> }>;
}

export interface MessageLog {
  at: number;
  protocol: "ws" | "socketio" | "grpc";
  routeId: string;
  connection: string;
  kind: "connect" | "disconnect" | "in" | "out" | "call";
  event: string | null;
  data: string;
  matched: string | null;
  status: string | null;
  durationMs: number | null;
}

export interface MockMessageEvent {
  mockId: string;
  entry: MessageLog;
}

export interface GrpcCallResult {
  status: string;
  details: string;
  messages: unknown[];
  trailers: Record<string, string>;
  durationMs: number;
}

/* ---------- Updates, links and Sendix (M10) ---------- */

export interface UpdateState {
  /** disabled: development builds never update. */
  status: "disabled" | "idle" | "checking" | "current" | "downloading" | "ready" | "error";
  version: string | null;
  percent: number | null;
  message: string | null;
  checkedAt: number | null;
}

/** A mockix:// link waiting for the user's confirmation. */
export interface LinkRequest {
  id: string;
  kind: "import" | "open";
  /** File to import (absolute). */
  collection: string | null;
  /** Workspace to open first (absolute), or null for the open one. */
  workspace: string | null;
}

/** What "Abrir en Sendix" sends. */
export interface SendixRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/* ---------- Agents (MCP, M9) ---------- */

export interface PendingApproval {
  id: string;
  at: number;
  tool: string;
  /** "crear GET /pedidos/:id en tienda" */
  summary: string;
  /** The tool's arguments, as JSON. */
  input: string;
}

export interface AuditView {
  at: number;
  tool: string;
  summary: string;
  write: boolean;
  outcome: "ok" | "error" | "rejected";
  detail: string | null;
  durationMs: number;
}

export interface AgentsState {
  /** The switch (remembered between launches). */
  enabled: boolean;
  running: boolean;
  /** http://127.0.0.1:<port>/mcp while running. */
  url: string | null;
  token: string;
  /** Writes are approved without asking until the app closes. */
  trustSession: boolean;
  pending: PendingApproval[];
  /** Newest first. */
  audit: AuditView[];
  error: string | null;
}

/* ---------- Chaos (M7) ---------- */

export interface ChaosDecisionView {
  profile: string;
  tMs: number;
  latencyMs: number;
  error: number | null;
  drop: boolean;
  timeout: boolean;
  trickleKBps: number | null;
}

export interface ChaosPointView {
  tMs: number;
  latencyMs: number;
  jitterMs: number;
  /** 0..1 */
  errorRate: number;
  errors: Array<{ status: number; weight: number }>;
}

export interface ChaosProfileView {
  name: string;
  file: string;
  description: string | null;
  loop: boolean;
  /** Cycle as written (null: the last point's time). */
  durationMs: number | null;
  cycleMs: number;
  points: ChaosPointView[];
  extras: { dropRate: number; timeoutRate: number; trickleKBps: number | null };
}

/** What the editor sends back to be written into chaos/<file>.yaml. */
export interface ChaosProfileDraft {
  description: string | null;
  loop: boolean;
  durationMs: number | null;
  points: ChaosPointView[];
  extras: { dropRate: number; timeoutRate: number; trickleKBps: number | null };
}

export interface ChaosAssignment {
  mockId: string;
  state: MockState;
  /** Profile of mock.yaml, or null. */
  profile: string | null;
  /** Folder → profile (null: exempt). */
  folders: Record<string, string | null>;
  /** Routes with their own setting (null: exempt). */
  routes: Array<{ routeId: string; profile: string | null }>;
}

export interface ChaosLive {
  mockId: string;
  profile: string | null;
  override: string | null | undefined;
  paused: boolean;
  tMs: number;
  cycleMs: number;
  level: { latencyMs: number; jitterMs: number; errorRate: number; errors: Array<{ status: number; weight: number }> } | null;
  requests: number;
  affected: number;
  routes: Array<{ routeId: string | null; method: string; path: string; requests: number; affected: number; latencyMs: number }>;
  recent: Array<{ seq: number; at: number; method: string; url: string; routeId: string | null; decision: ChaosDecisionView }>;
}

export interface ChaosInfo {
  profiles: ChaosProfileView[];
  /** YAML of each chaos file, by path. */
  sources: Record<string, string>;
  assignments: ChaosAssignment[];
  /** Live state of every running mock. */
  live: ChaosLive[];
}

/* ---------- Contracts (M6) ---------- */

export type ContractModeView = "off" | "warn" | "strict";

export interface ViolationView {
  side: "request" | "response";
  operation: string;
  where: string;
  rule: string;
  message: string;
  status?: number | undefined;
}

export interface ContractRuleView {
  rule: string;
  side: "request" | "response";
  operation: string;
  where: string;
  count: number;
  lastAt: number;
  lastMessage: string;
  lastClient: string;
  lastRequest: { method: string; url: string; body: string } | null;
  routeId: string | null;
  responseId: string | null;
}

export interface ContractLive {
  requests: number;
  failing: number;
  rules: ContractRuleView[];
  clients: Array<{ client: string; requests: number; failing: number }>;
  recent: Array<{ seq: number; at: number; method: string; url: string; status: number; client: string; violations: ViolationView[] }>;
}

export interface ContractInfo {
  mockId: string;
  file: string;
  mode: ContractModeView;
  version: "3.0" | "3.1";
  title: string | null;
  operations: number;
  coverage: Array<{ method: string; path: string; routeId: string | null; hasExample: boolean }>;
  /** The mock's own responses that do not match the contract (operation null: route outside the contract). */
  responseProblems: Array<{ routeId: string; responseId: string; method: string; path: string; status: number; operation: string | null; message: string }>;
  /** Counted while the mock runs; null when it is stopped. */
  live: ContractLive | null;
}

/* ---------- Scenarios (M6) ---------- */

export type ScenarioTriggerView =
  | { kind: "start" }
  | { kind: "request"; method: string; url: string; seq: number | null; status: number | null }
  | { kind: "timer"; afterMs: number }
  | { kind: "manual" };

export interface ScenarioEventView {
  at: number;
  scenario: string;
  key: string;
  from: string | null;
  to: string;
  trigger: ScenarioTriggerView;
}

export interface ScenarioInstanceInfo {
  key: string;
  state: string;
  since: number;
  next: { to: string; at: number } | null;
  waiting: string[];
  final: boolean;
  history: ScenarioEventView[];
}

export interface ScenarioInfo {
  id: string;
  file: string;
  key: string | null;
  initial: string;
  states: string[];
  transitions: Array<{ from: string[]; to: string; on: { method: string; path: string } | null; afterMs: number | null; fired: number }>;
  counts: Record<string, number>;
  instances: ScenarioInstanceInfo[];
  /** The YAML file as it is on disk. */
  source: string;
  /** Routes whose responses depend on this scenario's state. */
  readers: Array<{ routeId: string; method: string; path: string; responses: Array<{ id: string; status: number; when: string; body: string }> }>;
}

export interface ScenariosInfo {
  mockId: string;
  running: boolean;
  /** Mock clock when the snapshot was taken (for "in 4 s"). */
  now: number;
  scenarios: ScenarioInfo[];
  recent: ScenarioEventView[];
}

export interface CallbackLog {
  requestSeq: number;
  at: number;
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  error: string | null;
}

export interface MockRequestEvent {
  mockId: string;
  entry: RequestLog;
}

export interface MockCallbackEvent {
  mockId: string;
  entry: CallbackLog;
}

export interface RecentLogs {
  requests: RequestLog[];
  callbacks: CallbackLog[];
}

export interface TestRequest {
  method: string;
  /** Path after the mock prefix, with its query. */
  path: string;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
}

export interface ProbeResult {
  method: string;
  url: string;
  status: number;
  durationMs: number;
  contentType: string | null;
  headers: Record<string, string>;
  /** First characters of the body. */
  preview: string;
}

export type Theme = "system" | "light" | "dark";

export interface RecordingMeta {
  file: string;
  target: string;
  startedAt: number;
  exchanges: number;
  bytes: number;
}

export interface RecordingStatus {
  active: { file: string; target: string; url: string; count: number; startedAt: number } | null;
}

export interface ExchangeSummary {
  index: number;
  at: number;
  method: string;
  url: string;
  status: number;
  binary: boolean;
}

export interface RedactionRuleView {
  where: "header" | "query" | "json";
  match: string;
  action: "remove" | "faker";
  faker?: string | undefined;
}

export interface RecordingPlanItem {
  method: string;
  path: string;
  exchanges: number;
  responses: number;
  action: "new" | "append" | "same";
  added: number;
}

export interface RecordingPlan {
  suggestedName: string;
  items: RecordingPlanItem[];
  warnings: string[];
  redaction: RedactionRuleView[];
}

export interface RecordingPreview {
  method: string;
  url: string;
  status: number;
  /** Route it becomes, e.g. "GET /clientes/:id". */
  route: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  /** Raw body as recorded (null for binary). */
  rawBody: string | null;
  /** Body as it would go into the mock, redacted. */
  mockBody: string;
}

export interface ImportSummary {
  name: string;
  format: string;
  source: string;
  routes: number;
  responses: number;
  fromExamples: number;
  generated: number;
  warnings: string[];
  skipped: string[];
  /** What a contract (OpenAPI) gave beyond its routes; mirrors the core's ImportExtras. */
  extras?: {
    selectable: number;
    contract: string | null;
    crud: Array<{ bucket: string; path: string; items: number }>;
    scenarios: Array<{ id: string; field: string; states: string[]; transitions: number }>;
    chaos: string[];
    notes: string[];
  };
}

/** An OpenAPI contract picked for a new mock, before it is created: what the dialog pre-fills. */
export interface ContractPreview {
  fileName: string;
  title: string;
  name: string;
  port: number;
  prefix: string;
  operations: number;
  /** False when it cannot be connected as the contract (a Swagger 2 that could not be converted). */
  connectable: boolean;
  /** A Swagger 2.0 source: what gets connected is its conversion to OpenAPI 3. */
  converted: boolean;
}

export interface FromContractOptions {
  name: string;
  port: number;
  prefix: string;
  /** Copy the contract to contracts/ and connect it (warn mode). */
  contract: boolean;
  /** Prepare chaos profiles with the contract's server errors (off until applied). */
  chaos: boolean;
}

/** Mirrors the core's editable route draft (packages/core/src/edit.ts). */
export type BodyDraft =
  | { kind: "none" }
  | { kind: "inline"; text: string }
  | { kind: "json"; value: unknown }
  | { kind: "file"; path: string; text: string | null };

export interface RuleDraft {
  target: string;
  op: string;
  value?: unknown | undefined;
  negate?: boolean | undefined;
}

export interface ResponseDraft {
  id: string;
  default?: boolean | undefined;
  status?: number | undefined;
  headers?: Record<string, string> | undefined;
  body: BodyDraft;
  latency?: number | undefined;
  template?: boolean | undefined;
  description?: string | undefined;
  rules?: { mode?: "all" | "any" | undefined; when: RuleDraft[] } | undefined;
  callbacks?: unknown[] | undefined;
}

export interface RouteDraft {
  id?: string | undefined;
  method?: string | undefined;
  path: string;
  mode?: string | undefined;
  latency?: number | undefined;
  description?: string | undefined;
  crud?: { bucket: string; key?: string | undefined } | undefined;
  responses?: ResponseDraft[] | undefined;
}

export interface RouteDocument {
  file: string;
  draft: RouteDraft;
  /** The YAML exactly as it is on disk. */
  source: string;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  packaged: boolean;
}
