import { useEffect, useState } from "react";
import type { AppInfo } from "@shared/ipc";
import { Icon, type IconName } from "../Icon";
import { STATE_LABEL, folderName } from "../lib/format";
import { useStore } from "../state/store";

export function TitleBar() {
  const workspace = useStore((s) => s.workspace);
  const mocks = useStore((s) => s.mocks);
  const selected = useStore((s) => s.selectedMock);
  const setDialog = useStore((s) => s.setDialog);
  const toggleMock = useStore((s) => s.toggleMock);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const mock = mocks.find((m) => m.id === selected) ?? null;
  const live = mock?.state === "running";
  const dark = theme === "dark" || (theme === "system" && document.documentElement.dataset.theme === "dark");

  return (
    <header className="titlebar">
      <span className="wordmark">Mockix</span>
      <span className="crumb" data-testid="workspace-dir" title={workspace?.dir ?? undefined}>
        {workspace?.dir ? <b>{folderName(workspace.dir)}</b> : "Sin espacio de trabajo"}
      </span>
      <button type="button" className="cmd" onClick={() => setDialog({ kind: "quick-open" })} disabled={!workspace?.dir} title="Buscar una ruta" data-testid="quick-open">
        <Icon name="search" size={14} />
        Buscar rutas y mocks
        <kbd>Ctrl K</kbd>
      </button>
      {mock && (
        <>
          <span className="mockpill" title={`Mock ${mock.name}`}>
            <span className={live ? "dot-on" : "dot-off"} aria-hidden="true" />
            <b>{mock.name}</b>
            <span className="mono port">:{mock.port}</span>
            <span className="pill-state">{STATE_LABEL[mock.state]}</span>
          </span>
          <button type="button" className="tb-btn" onClick={() => toggleMock(mock.id)} title={live ? "Detener mock" : "Iniciar mock"} aria-label={live ? `Detener ${mock.name}` : `Iniciar ${mock.name}`}>
            <Icon name={live ? "stop" : "play"} size={16} />
          </button>
        </>
      )}
      <button type="button" className="tb-btn" onClick={() => setTheme(dark ? "light" : "dark")} title="Cambiar tema" aria-label={dark ? "Cambiar a tema claro" : "Cambiar a tema oscuro"} data-testid="theme-toggle">
        <Icon name={dark ? "sun" : "moon"} size={16} />
      </button>
    </header>
  );
}

const VIEWS: Array<{ view: "recordings" | "scenarios" | "chaos" | "contracts"; icon: IconName; label: string }> = [
  { view: "recordings", icon: "rec", label: "Grabaciones" },
  { view: "scenarios", icon: "flow", label: "Escenarios" },
  { view: "chaos", icon: "zig", label: "Perfiles de caos" },
  { view: "contracts", icon: "contract", label: "Contratos" },
];

export function Rail() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  return (
    <nav className="rail" aria-label="Secciones">
      <button type="button" title="Mocks y rutas" aria-label="Mocks y rutas" aria-current={view === "mocks" ? "page" : undefined} onClick={() => setView("mocks")} data-testid="rail-mocks">
        <Icon name="server" size={18} />
      </button>
      {VIEWS.map((v) => (
        <button key={v.view} type="button" title={v.label} aria-label={v.label} aria-current={view === v.view ? "page" : undefined} onClick={() => setView(v.view)} data-testid={`rail-${v.view}`}>
          <Icon name={v.icon} size={18} />
        </button>
      ))}
      <span className="spacer" />
      <button type="button" title="Agentes (MCP)" aria-label="Agentes (MCP)" aria-current={view === "agents" ? "page" : undefined} onClick={() => setView("agents")} data-testid="rail-agents">
        <Icon name="bot" size={18} />
      </button>
      <button type="button" title="Ajustes" aria-label="Ajustes" aria-current={view === "settings" ? "page" : undefined} onClick={() => setView("settings")} data-testid="rail-settings">
        <Icon name="sliders" size={18} />
      </button>
    </nav>
  );
}

export function StatusBar() {
  const mocks = useStore((s) => s.mocks);
  const agents = useStore((s) => s.agents);
  const workspace = useStore((s) => s.workspace);
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void window.mockix.app.info().then(setInfo);
  }, []);
  const running = mocks.filter((m) => m.state === "running");
  return (
    <footer className="statusbar">
      <span className={running.length ? "ok-dot" : "off-dot"}>{running.length === 0 ? "Ningún mock en marcha" : running.length === 1 ? "1 mock en marcha" : `${running.length} mocks en marcha`}</span>
      {running.length > 0 && (
        <span>
          {running.map((m, i) => (
            <span key={m.id}>
              {i > 0 ? " · " : ""}
              {m.name} <span className="mono">:{m.port}</span>
            </span>
          ))}
        </span>
      )}
      {workspace?.dir && (
        <span className="ws-path">
          Espacio de trabajo <span className="mono">{workspace.dir}</span>
        </span>
      )}
      <span className="end">
        <span data-testid="status-mcp">{agents?.running ? `MCP: ${agents.url?.replace(/^http:\/\//, "").replace(/\/mcp$/, "")}${agents.pending.length ? ` · ${agents.pending.length} esperando` : ""}` : "MCP: apagado"}</span>
        {info && (
          <span>
            Mockix {info.version}
            {info.packaged ? "" : " (desarrollo)"}
          </span>
        )}
      </span>
    </footer>
  );
}

export function Notice() {
  const notice = useStore((s) => s.notice);
  const setNotice = useStore((s) => s.setNotice);
  if (!notice) return null;
  return (
    <div className="notice" role="status" data-testid="notice">
      <span>{notice}</span>
      <button type="button" className="link-btn" onClick={() => setNotice(null)}>
        Cerrar
      </button>
    </div>
  );
}
