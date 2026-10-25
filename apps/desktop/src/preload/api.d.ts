import type { Outcome } from "../shared/rpc";
import type {
  AgentsState,
  AppInfo,
  ChaosInfo,
  ChaosProfileDraft,
  ContractInfo,
  ContractModeView,
  ExchangeSummary,
  GrpcCallResult,
  ImportSummary,
  LinkRequest,
  MockCallbackEvent,
  MockMessageEvent,
  MockRequestEvent,
  MockStatus,
  ProbeResult,
  RecentLogs,
  RecordingMeta,
  RecordingPlan,
  RecordingPreview,
  RecordingStatus,
  RouteDocument,
  RouteDraft,
  ScenariosInfo,
  SendixRequest,
  TestRequest,
  UpdateState,
  ViolationView,
  Theme,
  WorkspaceState,
} from "../shared/ipc";

/** What the preload exposes to the renderer as window.mockix. Nothing else crosses the bridge. */
export interface MockixApi {
  workspace: {
    get(): Promise<WorkspaceState | null>;
    /** Shows the folder picker; resolves with null when the user cancels. */
    open(): Promise<Outcome<WorkspaceState | null>>;
    /** Picks a folder, writes the example workspace into it and opens it. */
    createExample(): Promise<Outcome<WorkspaceState | null>>;
    /** Picks an OpenAPI, Postman, HAR or Mockoon file and imports it as a new mock; null when cancelled. */
    importFile(): Promise<Outcome<ImportSummary | null>>;
    onChange(listener: (state: WorkspaceState) => void): () => void;
  };
  mocks: {
    list(): Promise<MockStatus[] | null>;
    start(id: string): Promise<Outcome<MockStatus>>;
    stop(id: string): Promise<Outcome<MockStatus>>;
    /** Sends a test request to the running mock (from main) and returns what came back. */
    send(id: string, request: TestRequest): Promise<Outcome<ProbeResult>>;
    /** Creates mocks/<name>/ with its mock.yaml. */
    create(name: string, port: number, prefix: string): Promise<Outcome<null>>;
    /** Asks where to save and writes the mock as OpenAPI 3.1; null when cancelled. */
    exportOpenApi(id: string): Promise<Outcome<{ file: string } | null>>;
    /** Test builds only (MOCKIX_TEST=1); answers UNKNOWN_METHOD otherwise. */
    crashHost(id: string): Promise<Outcome<{ scheduled: true }>>;
    onList(listener: (mocks: MockStatus[]) => void): () => void;
    onStatus(listener: (status: MockStatus) => void): () => void;
    onRequest(listener: (event: MockRequestEvent) => void): () => void;
    onCallback(listener: (event: MockCallbackEvent) => void): () => void;
    /** WebSocket and Socket.IO messages and gRPC calls of running mocks. */
    onMessage(listener: (event: MockMessageEvent) => void): () => void;
  };
  live: {
    /** A WebSocket route's or gRPC service's YAML. */
    source(mockId: string, file: string): Promise<Outcome<string>>;
    /** Opens a test connection from main to a WebSocket route or Socket.IO namespace. */
    connect(mockId: string, routeId: string): Promise<Outcome<null>>;
    /** Sends a message (WebSocket) or emits an event (Socket.IO; the ack comes back). */
    send(mockId: string, routeId: string, text: string, event: string | null): Promise<Outcome<{ ack: unknown }>>;
    disconnect(mockId: string, routeId: string): Promise<Outcome<null>>;
    /** An example request for a gRPC method, generated from its message type. */
    grpcExample(mockId: string, service: string, method: string): Promise<Outcome<string>>;
    grpcCall(mockId: string, service: string, method: string, text: string): Promise<Outcome<GrpcCallResult>>;
  };
  routes: {
    read(mockId: string, routeId: string): Promise<Outcome<RouteDocument>>;
    /** routeId null creates a new route file in `folder` (under routes/). */
    write(mockId: string, routeId: string | null, draft: RouteDraft, folder?: string): Promise<Outcome<{ file: string; id: string }>>;
    /** Moves the route file to the OS trash. */
    remove(mockId: string, routeId: string): Promise<Outcome<{ file: string }>>;
    /** Renders a body template with a sample request. */
    preview(mockId: string, method: string, path: string, text: string): Promise<Outcome<{ text: string }>>;
  };
  recordings: {
    list(): Promise<RecordingMeta[] | null>;
    status(): Promise<RecordingStatus | null>;
    /** Starts the recording proxy in front of `target`. */
    start(target: string, port: number): Promise<Outcome<RecordingStatus>>;
    stop(): Promise<Outcome<{ file: string | null; count: number }>>;
    exchanges(file: string): Promise<Outcome<ExchangeSummary[]>>;
    /** What converting would do (into = null for a new mock). */
    plan(file: string, into: string | null, prefix: string): Promise<Outcome<RecordingPlan>>;
    preview(file: string, index: number, prefix: string): Promise<Outcome<RecordingPreview>>;
    convert(file: string, target: { name: string } | { into: string }, prefix: string): Promise<Outcome<ImportSummary>>;
    /** Moves the recording to the OS trash. */
    remove(file: string): Promise<Outcome<null>>;
    onStatus(listener: (status: RecordingStatus) => void): () => void;
    onExchange(listener: (exchange: ExchangeSummary) => void): () => void;
  };
  contracts: {
    /** Coverage and the mock's own responses from the files, plus what the running mock counted. */
    get(mockId: string): Promise<Outcome<ContractInfo>>;
    /** The schema a violation was checked against, as YAML. */
    schema(mockId: string, violation: ViolationView): Promise<Outcome<string>>;
    /** Writes contract.mode in mock.yaml. */
    setMode(mockId: string, mode: ContractModeView): Promise<Outcome<null>>;
    /** Asks where to save (JUnit .xml or .json); null when cancelled. */
    exportReport(mockId: string): Promise<Outcome<{ file: string } | null>>;
    clear(mockId: string): Promise<Outcome<null>>;
  };
  scenarios: {
    /** Definitions, and live instances while the mock runs. */
    get(mockId: string): Promise<Outcome<ScenariosInfo>>;
    /** Forces an instance into a state (the mock must be running). */
    set(mockId: string, scenario: string, key: string, state: string): Promise<Outcome<null>>;
    /** Drops the instances of one scenario, or of all with null. */
    reset(mockId: string, scenario: string | null): Promise<Outcome<null>>;
  };
  chaos: {
    /** Profiles, where each mock applies them, and the live state of running mocks. */
    get(): Promise<Outcome<ChaosInfo>>;
    /** Writes the profile back into its chaos/*.yaml file. */
    save(name: string, draft: ChaosProfileDraft): Promise<Outcome<null>>;
    /** Sets the profile of a whole mock in mock.yaml (null removes it). */
    assign(mockId: string, profile: string | null): Promise<Outcome<null>>;
    pause(mockId: string, paused: boolean): Promise<Outcome<null>>;
    /** Back to t = 0 for a running mock. */
    restart(mockId: string): Promise<Outcome<null>>;
  };
  agents: {
    get(): Promise<AgentsState | null>;
    /** Turns the MCP server on or off (remembered between launches). */
    setEnabled(enabled: boolean): Promise<Outcome<AgentsState>>;
    /** Approve writes without asking until the app closes. */
    setTrust(trust: boolean): Promise<Outcome<AgentsState>>;
    decide(id: string, decision: "approve" | "reject" | "trust"): Promise<Outcome<null>>;
    rotateToken(): Promise<Outcome<AgentsState>>;
    onChange(listener: (state: AgentsState) => void): () => void;
  };
  updates: {
    get(): Promise<UpdateState | null>;
    check(): Promise<Outcome<UpdateState>>;
    /** Restarts into the downloaded version. */
    install(): Promise<Outcome<null>>;
    onChange(listener: (state: UpdateState) => void): () => void;
  };
  links: {
    /** mockix:// links waiting for confirmation (one may arrive before the page loads). */
    pending(): Promise<LinkRequest[] | null>;
    /** Accepting an import link imports the collection (after opening its workspace). */
    decide(id: string, accept: boolean): Promise<Outcome<ImportSummary | null>>;
    onRequest(listener: (request: LinkRequest) => void): () => void;
  };
  sendix: {
    /** Whether Sendix registered sendix:// on this machine. */
    available(): Promise<boolean>;
    open(request: SendixRequest): Promise<Outcome<null>>;
  };
  logs: {
    /** Stored requests and callbacks of a mock, newest first (they survive restarts). */
    recent(id: string, limit: number): Promise<Outcome<RecentLogs>>;
    clear(id: string): Promise<Outcome<null>>;
  };
  app: {
    info(): Promise<AppInfo | null>;
    theme(): Promise<Theme | null>;
    setTheme(theme: Theme): Promise<Outcome<Theme>>;
    /** Writes text to the system clipboard (the page has no clipboard permission). */
    copy(text: string): Promise<Outcome<null>>;
  };
}

declare global {
  interface Window {
    mockix: MockixApi;
  }
}
