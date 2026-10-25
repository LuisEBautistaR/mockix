import { useState } from "react";
import type { AgentsState, PendingApproval } from "@shared/ipc";
import { Icon } from "../Icon";
import { CodeEditor } from "./CodeEditor";
import { Notice } from "./Shell";
import { time } from "../lib/format";
import { useStore } from "../state/store";

const OUTCOME = { ok: "hecho", error: "error", rejected: "rechazado" } as const;

/** The pending write the agent is waiting on: shown over any view, so nothing is approved by accident. */
export function ApprovalDialog() {
  const agents = useStore((s) => s.agents);
  const [busy, setBusy] = useState(false);
  const p: PendingApproval | undefined = agents?.pending[0];
  if (!p) return null;
  const decide = async (decision: "approve" | "reject" | "trust") => {
    setBusy(true);
    await window.mockix.agents.decide(p.id, decision);
    setBusy(false);
  };
  return (
    <div className="scrim">
      <div className="modal approval" role="alertdialog" aria-modal="true" aria-label="Un agente quiere hacer un cambio" data-testid="mcp-approval">
        <div className="modal-head">
          <h3>Un agente quiere {p.summary}</h3>
        </div>
        <div className="modal-body">
          <p className="note">
            Herramienta <span className="mono">{p.tool}</span> por MCP, {time(p.at)}.{agents!.pending.length > 1 ? ` Hay ${agents!.pending.length - 1} más esperando.` : ""} Si no respondes en 2 minutos, se rechaza.
          </p>
          <div className="code-block viewer">
            <CodeEditor key={p.id} value={p.input} language="json" readOnly label="Argumentos de la herramienta" lineNumbers={false} />
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="link-btn" onClick={() => void decide("trust")} disabled={busy} data-testid="mcp-trust">
            Confiar en esta sesión
          </button>
          <span className="spacer" />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void decide("reject")} disabled={busy} data-testid="mcp-reject">
            Rechazar
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void decide("approve")} disabled={busy} data-testid="mcp-approve" autoFocus>
            Aprobar
          </button>
        </div>
      </div>
    </div>
  );
}

function clientConfig(state: AgentsState): string {
  return JSON.stringify({ mcpServers: { mockix: { type: "http", url: state.url ?? "http://127.0.0.1:<puerto>/mcp", headers: { Authorization: `Bearer ${state.token}` } } } }, null, 2);
}

export function AgentsView() {
  const agents = useStore((s) => s.agents);
  const setNotice = useStore((s) => s.setNotice);
  const workspace = useStore((s) => s.workspace);
  const [reveal, setReveal] = useState(false);
  if (!agents) return null;
  const copy = async (text: string, what: string) => {
    const outcome = await window.mockix.app.copy(text);
    setNotice(outcome.ok ? `${what} copiado.` : outcome.error.message);
  };
  const toggle = async () => {
    const outcome = await window.mockix.agents.setEnabled(!agents.enabled);
    if (!outcome.ok) setNotice(outcome.error.message);
  };

  return (
    <>
      <aside className="sidebar" aria-label="Agentes">
        <div className="side-head">
          <h2>Agentes (MCP)</h2>
        </div>
        <div className="side-block grow">
          <p className="side-note">
            Un agente de IA (Claude Code, Claude Desktop u otro cliente MCP) puede listar y probar los mocks, leer el log y crear o cambiar rutas. Todo cambio pasa por el mismo validador que el editor.
          </p>
          <p className="side-note">Lo que cambia algo espera tu aprobación aquí, salvo que confíes en la sesión. Todo queda en la auditoría y en .mockix/mcp-audit.jsonl.</p>
        </div>
        <div className="side-block">
          <div className="vars-head">
            <b>Sin la app</b>
          </div>
          <pre className="side-code mono">{"mockix mcp <carpeta>\n# por stdio, sin abrir la app"}</pre>
        </div>
      </aside>
      <main className="main">
        <Notice />
        <div className="reqline">
          <div className="urlbox">
            <span className="lbl">
              MCP<b>{agents.running ? "en marcha" : "apagado"}</b>
            </span>
            <div className="url">
              <span className="host mono" data-testid="mcp-url">
                {agents.url ?? "127.0.0.1 · Streamable HTTP"}
              </span>
            </div>
            <div className="tail">solo este equipo · con token</div>
          </div>
          <button type="button" className={`btn ${agents.enabled ? "btn-secondary" : "btn-primary"}`} onClick={toggle} data-testid="mcp-toggle">
            <Icon name={agents.enabled ? "stop" : "play"} size={14} /> {agents.enabled ? "Apagar" : "Encender"}
          </button>
        </div>
        <div className="split">
          <div className="pane">
            <div className="subtabs" role="tablist">
              <button type="button" className="subtab" role="tab" aria-selected>
                Conexión
              </button>
            </div>
            <div className="pane-body">
              {agents.error && <div className="why-box">No se pudo abrir el servidor: {agents.error}</div>}
              {!workspace?.dir && <p className="note pad-top">Abre una carpeta de trabajo: las herramientas trabajan sobre ella.</p>}
              <table className="kv">
                <colgroup>
                  <col style={{ width: "26%" }} />
                  <col />
                  <col style={{ width: 120 }} />
                </colgroup>
                <tbody>
                  <tr>
                    <td className="d">URL</td>
                    <td className="mono">{agents.url ?? "—"}</td>
                    <td className="actions">
                      {agents.url && (
                        <button type="button" className="link-btn" onClick={() => void copy(agents.url!, "URL")}>
                          <Icon name="copy" size={12} /> Copiar
                        </button>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td className="d">Token</td>
                    <td className="mono" data-testid="mcp-token">
                      {reveal ? agents.token : "•".repeat(16)}
                    </td>
                    <td className="actions">
                      <button type="button" className="link-btn" onClick={() => setReveal(!reveal)}>
                        {reveal ? "Ocultar" : "Ver"}
                      </button>{" "}
                      <button type="button" className="link-btn" onClick={() => void copy(agents.token, "Token")}>
                        <Icon name="copy" size={12} />
                      </button>
                    </td>
                  </tr>
                  <tr>
                    <td className="d">Aprobación</td>
                    <td className="wrap">
                      <label className="field-inline">
                        <input type="checkbox" checked={agents.trustSession} onChange={(e) => void window.mockix.agents.setTrust(e.target.checked)} data-testid="mcp-trust-session" /> Confiar en esta sesión (aprobar sin preguntar hasta cerrar la app)
                      </label>
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
              <div className="section-label">
                Para tu cliente MCP <span>Claude Code: .mcp.json; Claude Desktop: su configuración</span>
                <span className="end">
                  <button type="button" className="link-btn" onClick={() => void copy(clientConfig(agents), "Configuración")} data-testid="mcp-copy-config">
                    <Icon name="copy" size={12} /> Copiar
                  </button>
                </span>
              </div>
              <div className="code-block viewer">
                <CodeEditor key={`${agents.url}-${reveal}`} value={reveal ? clientConfig(agents) : clientConfig({ ...agents, token: "<token>" })} language="json" readOnly label="Configuración del cliente MCP" lineNumbers={false} />
              </div>
              <p className="note pad-top">
                Cambiar el token desconecta a los clientes que tengan el anterior.{" "}
                <button type="button" className="link-btn" onClick={() => void window.mockix.agents.rotateToken()}>
                  Generar otro token
                </button>
              </p>
            </div>
          </div>
          <div className="pane">
            <div className="subtabs" role="tablist">
              <button type="button" className="subtab" role="tab" aria-selected>
                Auditoría <span className="n mono">{agents.audit.length}</span>
              </button>
              {agents.pending.length > 0 && <span className="tag err">{agents.pending.length} esperando</span>}
            </div>
            <div className="pane-body">
              {agents.audit.length === 0 ? (
                <p className="note pad-top">Nada todavía: cada llamada de un agente aparece aquí.</p>
              ) : (
                <table className="kv" data-testid="mcp-audit">
                  <colgroup>
                    <col style={{ width: 82 }} />
                    <col />
                    <col style={{ width: 96 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Hora</th>
                      <th>Qué</th>
                      <th>Resultado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.audit.map((a, i) => (
                      <tr key={`${a.at}-${i}`} title={a.detail ?? undefined}>
                        <td className="mono d">{time(a.at)}</td>
                        <td className="ui wrap">
                          {a.write && <span className="tag">cambia</span>} {a.summary} <span className="mono d">· {a.tool}</span>
                        </td>
                        <td className={a.outcome === "ok" ? "ok-t" : "err-t"}>{OUTCOME[a.outcome]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
