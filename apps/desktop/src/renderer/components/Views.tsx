import { UpdatesSection } from "./Links";
import { useEffect, useMemo, useState } from "react";
import type { AppInfo, MockStatus, ProblemView } from "@shared/ipc";
import { Icon } from "../Icon";
import { METHOD_CLASS, MODE_LABEL, STATE_LABEL, samplePath, shortMethod, tone } from "../lib/format";
import { runSecurityChecks } from "../security-checks";
import { useStore } from "../state/store";
import { LogPane } from "./LogPane";
import { PathText } from "./Sidebar";

export function Problems({ problems, testId }: { problems: ProblemView[]; testId: string }) {
  return (
    <ul className="problems" data-testid={testId}>
      {problems.map((p, i) => (
        <li key={`${p.file}-${p.line}-${i}`} data-testid="problem-row">
          <span className="mono problem-at">
            {p.file}
            {p.line ? `:${p.line}` : ""}
          </span>
          <span className="problem-msg">{p.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function Welcome() {
  return (
    <div className="welcome">
      <h2 className="section-label">Así se organiza un workspace</h2>
      <pre className="code-block mono">{`MiProyecto/
├─ mockix.workspace.yaml        formato y orden de los mocks
└─ mocks/
   └─ tienda/
      ├─ mock.yaml              puerto, prefijo, CORS, TLS, latencia, proxy
      ├─ data/productos.json    data buckets (CRUD y plantillas)
      └─ routes/
         ├─ salud.yaml          una ruta por archivo
         └─ productos/
            ├─ get-producto.yaml
            └─ get-producto.200.json   cuerpo (plantilla)`}</pre>
      <h2 className="section-label">Una ruta</h2>
      <pre className="code-block mono">{`method: GET
path: /productos/:id
responses:
  - id: ok
    default: true
    body: { file: get-producto.200.json }
  - id: no-existe
    status: 404
    rules:
      when:
        - { target: params.id, op: regex, value: '^9\\d+$' }`}</pre>
      <p className="note">«Crear el ejemplo» escribe un workspace completo (tienda de café de ejemplo) en la carpeta que elijas y lo abre.</p>
      <h2 className="section-label">
        Lo mismo desde la terminal <span>la CLI usa el mismo núcleo que esta app</span>
      </h2>
      <pre className="code-block mono">{`mockix init mi-proyecto        crea el workspace de ejemplo
mockix validate mi-proyecto    revisa todos los archivos (útil en CI)
mockix serve mi-proyecto       sirve los mocks y recarga al guardar`}</pre>
    </div>
  );
}

/** A mock selected with no route open: its state, problems and routes, next to the live log. */
export function MockOverview({ mock }: { mock: MockStatus }) {
  const workspace = useStore((s) => s.workspace);
  const toggleMock = useStore((s) => s.toggleMock);
  const openRoute = useStore((s) => s.openRoute);
  const send = useStore((s) => s.send);
  const setDialog = useStore((s) => s.setDialog);
  const exportOpenApi = useStore((s) => s.exportOpenApi);
  const live = mock.state === "running";
  const transitioning = mock.state === "starting" || mock.state === "restarting";

  return (
    <>
      <div className="reqline">
        <div className="urlbox">
          <span className="lbl">
            Mock<b>{mock.name}</b>
          </span>
          <span className="url mono" data-testid="mock-url">
            {mock.url ? `${mock.url}${mock.prefix}` : `sin escuchar · ${mock.host}:${mock.port === 0 ? "puerto libre" : mock.port}${mock.prefix}`}
          </span>
          <span className={`state state-${mock.state}`} data-testid="mock-state">
            {STATE_LABEL[mock.state]}
          </span>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => toggleMock(mock.id)} disabled={transitioning || (!live && !mock.startable)} data-testid="mock-toggle">
          <Icon name={live || transitioning ? "stop" : "play"} size={14} />
          {live || transitioning ? "Detener" : "Iniciar"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => setDialog({ kind: "new-route", mockId: mock.id })}>
          <Icon name="plus" size={14} /> Nueva ruta
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => exportOpenApi(mock.id)} disabled={!mock.startable} title="Guarda el mock como OpenAPI 3.1" data-testid="export-openapi">
          <Icon name="upload" size={14} /> OpenAPI
        </button>
      </div>
      <div className="split">
        <div className="pane">
          <div className="pane-body">
            {(workspace?.problems.length ?? 0) > 0 && (
              <>
                <h2 className="section-label err-t">Problemas del workspace</h2>
                <Problems problems={workspace!.problems} testId="workspace-problems" />
              </>
            )}
            {mock.problems.length > 0 && (
              <>
                <h2 className="section-label err-t">
                  Problemas en los archivos de {mock.name}
                  <span>{mock.stale ? "sigue en marcha con la última versión buena" : "no se puede iniciar hasta corregirlos"}</span>
                </h2>
                <Problems problems={mock.problems} testId="mock-problems" />
              </>
            )}
            <h2 className="section-label">
              Rutas <span>en el orden en que se evalúan</span>
            </h2>
            <table className="kv routes">
              <colgroup>
                <col style={{ width: 58 }} />
                <col />
                <col style={{ width: 92 }} />
                <col style={{ width: "24%" }} />
                <col style={{ width: 80 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Método</th>
                  <th>Ruta</th>
                  <th>Modo</th>
                  <th>Respuestas</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mock.routes.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      Sin rutas todavía: crea una con «Nueva ruta».
                    </td>
                  </tr>
                )}
                {mock.routes.map((r) => {
                  const sample = r.method === "GET" || r.mode === "crud" ? samplePath(r.path) : null;
                  return (
                    <tr key={r.id} data-testid="route-row" className="clickable" onClick={() => openRoute(mock.id, r.id)}>
                      <td className={`meth ${r.mode === "crud" ? "m-crud" : (METHOD_CLASS[r.method] ?? "")}`}>{r.mode === "crud" ? "CRUD" : shortMethod(r.method)}</td>
                      <td>
                        <PathText path={r.path} />
                      </td>
                      <td className="muted">{MODE_LABEL[r.mode] ?? r.mode}</td>
                      <td className="mono">
                        {r.statuses.map((s, i) => (
                          <span key={i} className={`st ${tone(s)}`}>
                            {s}{" "}
                          </span>
                        ))}
                      </td>
                      <td className="actions">
                        {sample !== null && (
                          <button
                            type="button"
                            className="link-btn"
                            disabled={!live}
                            onClick={(e) => {
                              e.stopPropagation();
                              void send(mock.id, "GET", sample);
                            }}
                            data-testid={`probe-${r.id}`}
                          >
                            Probar
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <h2 className="section-label">
              Mock <span>proceso propio, aislado del resto de la app</span>
            </h2>
            <dl className="facts">
              <dt>Escucha en</dt>
              <dd className="mono">
                {mock.tls ? "https://" : "http://"}
                {mock.host}:{mock.port}
                {mock.prefix}
              </dd>
              <dt>Latencia del mock</dt>
              <dd className="mono">{mock.latencyMs} ms</dd>
              <dt>Proxy</dt>
              <dd className="mono">{mock.proxyTarget ?? "—"}</dd>
              <dt>Proceso</dt>
              <dd className="mono" data-testid="mock-pid">
                {mock.pid ?? "—"}
              </dd>
              <dt>Reinicios</dt>
              <dd className="mono" data-testid="mock-restarts">
                {mock.restarts}
              </dd>
              <dt>Último error</dt>
              <dd className={mock.error ? "mono err-t" : "mono"} data-testid="mock-error">
                {mock.error ? `${mock.error.code} · ${mock.error.message}` : "—"}
              </dd>
            </dl>
            <div className="danger-row">
              <button type="button" className="link-btn" onClick={() => setDialog({ kind: "delete-mock", mockId: mock.id })} data-testid="mock-delete">
                <Icon name="trash" size={14} /> Mover el mock a la papelera
              </button>
            </div>
          </div>
        </div>
        <LogPane mock={mock} />
      </div>
    </>
  );
}

export function SettingsView() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const workspace = useStore((s) => s.workspace);
  const openWorkspace = useStore((s) => s.openWorkspace);
  const checks = useMemo(runSecurityChecks, []);
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void window.mockix.app.info().then(setInfo);
  }, []);

  return (
    <div className="settings">
      <div className="pane-body">
        <h2 className="section-label">Apariencia</h2>
        <div className="toolbar">
          <span className="hint">Tema</span>
          <span className="seg">
            {(
              [
                ["system", "Sistema"],
                ["light", "Claro"],
                ["dark", "Oscuro"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={theme === value} onClick={() => setTheme(value)} data-testid={`theme-${value}`}>
                {label}
              </button>
            ))}
          </span>
        </div>
        <h2 className="section-label">Carpeta de trabajo</h2>
        <dl className="facts">
          <dt>Abierta</dt>
          <dd className="mono">{workspace?.dir ?? "—"}</dd>
        </dl>
        <div className="toolbar">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => openWorkspace("open")}>
            <Icon name="folder" size={14} /> Abrir otra carpeta…
          </button>
        </div>
        <UpdatesSection />
        <h2 className="section-label">
          Aislamiento de la interfaz <span className="mono">{checks.filter((c) => c.passed).length}/{checks.length}</span>
        </h2>
        <ul className="checks">
          {checks.map((check) => (
            <li key={check.id} data-testid={`check-${check.id}`} data-passed={check.passed}>
              <span className={check.passed ? "ok" : "err"}>
                <Icon name={check.passed ? "check" : "x"} size={14} />
              </span>
              <span className="check-label">{check.label}</span>
              <span className={`check-result ${check.passed ? "ok" : "err"}`}>{check.passed ? "CORRECTO" : "FALLA"}</span>
              <span className="check-detail">{check.detail}</span>
            </li>
          ))}
        </ul>
        <h2 className="section-label">Versiones</h2>
        <dl className="facts">
          <dt>Mockix</dt>
          <dd className="mono">{info ? `${info.version}${info.packaged ? "" : " (desarrollo)"}` : "—"}</dd>
          <dt>Electron</dt>
          <dd className="mono">{info?.electron ?? "—"}</dd>
          <dt>Chromium</dt>
          <dd className="mono">{info?.chrome ?? "—"}</dd>
          <dt>Node.js</dt>
          <dd className="mono">{info?.node ?? "—"}</dd>
          <dt>Sistema</dt>
          <dd className="mono">{info ? `${info.platform} ${info.arch}` : "—"}</dd>
        </dl>
      </div>
    </div>
  );
}
