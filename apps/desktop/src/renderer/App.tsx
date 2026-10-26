import { useEffect } from "react";
import { Dialogs } from "./components/Dialogs";
import { RouteEditor, TabStrip } from "./components/RouteEditor";
import { Notice, Rail, StatusBar, TitleBar } from "./components/Shell";
import { ChaosView } from "./components/Chaos";
import { AgentsView, ApprovalDialog } from "./components/Agents";
import { ContractsView } from "./components/Contracts";
import { LivePanel } from "./components/Live";
import { LinkDialog } from "./components/Links";
import { RecordingsView } from "./components/Recordings";
import { ScenariosView } from "./components/Scenarios";
import { Sidebar } from "./components/Sidebar";
import { MockOverview, Problems, SettingsView, Welcome } from "./components/Views";
import { samplePath } from "./lib/format";
import { useStore } from "./state/store";

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const s = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === "k" && s.workspace?.dir) {
        e.preventDefault();
        s.setDialog({ kind: "quick-open" });
      } else if (key === "s" && s.activeTab && s.drafts[s.activeTab]?.dirty) {
        e.preventDefault();
        void s.save(s.activeTab);
      } else if (key === "enter" && s.activeTab) {
        const d = s.drafts[s.activeTab];
        const mock = s.mocks.find((m) => m.id === s.activeTab!.split("/")[0]);
        const path = d ? samplePath(d.draft.path) : null;
        if (!d || !mock || mock.state !== "running" || d.dirty || path === null) return;
        e.preventDefault();
        const method = d.draft.crud || !d.draft.method || d.draft.method === "ANY" ? "GET" : d.draft.method;
        void s.send(mock.id, method, path, ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function Main() {
  const workspace = useStore((s) => s.workspace);
  const view = useStore((s) => s.view);
  const mocks = useStore((s) => s.mocks);
  const selected = useStore((s) => s.selectedMock);
  const activeTab = useStore((s) => s.activeTab);
  const tabs = useStore((s) => s.tabs);
  const live = useStore((s) => s.live);
  const setDialog = useStore((s) => s.setDialog);

  const tabMock = activeTab ? mocks.find((m) => m.id === activeTab.split("/")[0]) : null;
  const mock = mocks.find((m) => m.id === selected) ?? mocks[0] ?? null;

  return (
    <main className="main">
      <Notice />
      {view === "settings" ? (
        <SettingsView />
      ) : !workspace?.dir ? (
        <Welcome />
      ) : (
        <>
          {tabs.length > 0 && <TabStrip />}
          {live && mocks.some((m) => m.id === live.mockId) ? (
            <LivePanel key={`${live.mockId}/${live.kind}/${live.id}`} mock={mocks.find((m) => m.id === live.mockId)!} target={live} />
          ) : activeTab && tabMock ? (
            <RouteEditor key={activeTab} mock={tabMock} tab={activeTab} />
          ) : mock ? (
            <MockOverview mock={mock} />
          ) : (
            <div className="welcome">
              {workspace.problems.length > 0 ? (
                <>
                  <h2 className="section-label err-t">Problemas del workspace</h2>
                  <Problems problems={workspace.problems} testId="workspace-problems" />
                </>
              ) : (
                <div className="start-mock">
                  <p className="empty-title">Crea tu primer mock</p>
                  <p className="note">Con el contrato OpenAPI de tu API, Mockix crea las rutas y sus respuestas, conecta el contrato y deduce datos, escenarios y perfiles de caos. También puedes empezar con uno vacío.</p>
                  <div className="toolbar">
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => setDialog({ kind: "new-mock", start: "contract" })} data-testid="start-from-contract">
                      Crear mock desde un contrato
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog({ kind: "new-mock", start: "empty" })} data-testid="start-empty">
                      Mock vacío
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}

/** Recordings, scenarios, chaos and contracts own the sidebar and main columns; everything else shares them. */
function Body() {
  const view = useStore((s) => s.view);
  const hasWorkspace = useStore((s) => Boolean(s.workspace?.dir));
  if (view === "recordings" && hasWorkspace) return <RecordingsView />;
  if (view === "scenarios" && hasWorkspace) return <ScenariosView />;
  if (view === "chaos" && hasWorkspace) return <ChaosView />;
  if (view === "contracts" && hasWorkspace) return <ContractsView />;
  if (view === "agents") return <AgentsView />;
  return (
    <>
      <Sidebar />
      <Main />
    </>
  );
}

/** Applies the theme setting to the page; "system" follows the OS live. */
function useTheme() {
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}

export function App() {
  useEffect(() => useStore.getState().init(), []);
  useShortcuts();
  useTheme();
  return (
    <div className="app">
      <TitleBar />
      <Rail />
      <Body />
      <StatusBar />
      <Dialogs />
      <ApprovalDialog />
      <LinkDialog />
    </div>
  );
}
