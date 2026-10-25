import { useCallback, useEffect, useMemo, useState } from "react";
import type { ContractInfo, ContractModeView, ContractRuleView, MockStatus } from "@shared/ipc";
import { Icon } from "../Icon";
import { CodeEditor } from "./CodeEditor";
import { Notice } from "./Shell";
import { METHOD_CLASS, pathPieces, shortMethod, statusText, time, tone } from "../lib/format";
import { useStore } from "../state/store";

const MODES: Array<{ mode: ContractModeView; label: string }> = [
  { mode: "off", label: "Apagado" },
  { mode: "warn", label: "Avisar" },
  { mode: "strict", label: "Estricto" },
];
const MODE_LABEL = { off: "apagado", warn: "avisar", strict: "estricto" } as const;

const pretty = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

/** "body.lineas[].cantidad debe ser integer": the target highlighted, the rest as text. */
function RuleText({ rule, where }: { rule: string; where: string }) {
  const generic = where.replace(/\[\d+\]/g, "[]");
  if (!rule.startsWith(generic)) return <>{rule}</>;
  return (
    <>
      <span className="p">{generic}</span>
      {rule.slice(generic.length)}
    </>
  );
}

function Op({ method, path }: { method: string; path: string }) {
  return (
    <>
      <span className={`meth ${METHOD_CLASS[method] ?? ""}`}>{shortMethod(method)}</span>
      {pathPieces(path.replace(/\{([^}]+)\}/g, ":$1")).map((x, i) => (x.param ? <span key={i} className="p">{x.text}</span> : <span key={i}>{x.text}</span>))}
    </>
  );
}

const splitOp = (operation: string) => {
  const i = operation.indexOf(" ");
  return { method: operation.slice(0, i), path: operation.slice(i + 1) };
};

function ContractsSidebar({ mocks, selected, onSelect, failing }: { mocks: MockStatus[]; selected: string | null; onSelect(id: string): void; failing: number | null }) {
  const withContract = mocks.filter((m) => m.contract);
  const without = mocks.filter((m) => !m.contract);
  return (
    <aside className="sidebar" aria-label="Contratos">
      <div className="side-head">
        <h2>Contratos</h2>
      </div>
      <ul className="tree" role="tree">
        {withContract.length === 0 && <li className="side-note">Ningún mock tiene contrato. Añade contract: en su mock.yaml.</li>}
        {withContract.map((m) => (
          <li key={m.id}>
            <button type="button" className="row" aria-selected={selected === m.id} onClick={() => onSelect(m.id)} data-testid={`contract-mock-${m.id}`}>
              <Icon name="contract" size={14} className="fold" />
              <span className="name">{m.name}</span>
              <span className="sub mono">{selected === m.id && failing ? <span className="err-t">{failing}</span> : MODE_LABEL[m.contract!.mode]}</span>
            </button>
          </li>
        ))}
        {without.length > 0 && <li className="side-group">Sin contrato</li>}
        {without.map((m) => (
          <li key={m.id} className="side-note">
            {m.name}
          </li>
        ))}
      </ul>
      <div className="side-block">
        <div className="vars-head">
          <b>Cómo se asocia</b>
        </div>
        <pre className="side-code mono">{"contract:\n  file: contracts/api.yaml\n  mode: warn"}</pre>
      </div>
    </aside>
  );
}

export function ContractsView() {
  const mocks = useStore((s) => s.mocks);
  const toggleMock = useStore((s) => s.toggleMock);
  const setNotice = useStore((s) => s.setNotice);
  const [selected, setSelected] = useState<string | null>(null);
  const [info, setInfo] = useState<ContractInfo | null>(null);
  const [left, setLeft] = useState<"violations" | "coverage">("violations");
  const [right, setRight] = useState<"clients" | "ours">("clients");
  const [picked, setPicked] = useState<string | null>(null);
  const [schema, setSchema] = useState("");

  const current = selected ?? mocks.find((m) => m.contract)?.id ?? null;
  const mock = mocks.find((m) => m.id === current) ?? null;
  const running = mock?.state === "running";

  const load = useCallback(async () => {
    if (!current) return setInfo(null);
    const outcome = await window.mockix.contracts.get(current);
    setInfo(outcome.ok ? outcome.value : null);
  }, [current]);

  useEffect(() => {
    void load();
    if (!running) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [load, running, mock?.contract?.mode, mock?.routes]);

  const requestRules = useMemo(() => info?.live?.rules.filter((r) => r.side === "request") ?? [], [info]);
  const responseRules = useMemo(() => info?.live?.rules.filter((r) => r.side === "response") ?? [], [info]);
  const rule: ContractRuleView | null = requestRules.find((r) => `${r.operation} ${r.rule}` === picked) ?? requestRules[0] ?? null;

  useEffect(() => {
    if (!current || !rule) return setSchema("");
    let alive = true;
    void window.mockix.contracts
      .schema(current, { side: rule.side, operation: rule.operation, where: rule.where, rule: rule.rule, message: rule.lastMessage })
      .then((o) => alive && setSchema(o.ok ? o.value : ""));
    return () => {
      alive = false;
    };
  }, [current, rule?.operation, rule?.rule]);

  const setMode = async (mode: ContractModeView) => {
    if (!current) return;
    const outcome = await window.mockix.contracts.setMode(current, mode);
    if (!outcome.ok) setNotice(outcome.error.message);
    else void load();
  };
  const exportReport = async () => {
    if (!current) return;
    const outcome = await window.mockix.contracts.exportReport(current);
    if (!outcome.ok) setNotice(outcome.error.message);
    else if (outcome.value) setNotice(`Informe del contrato escrito en ${outcome.value.file}`);
  };
  const clear = async () => {
    if (!current) return;
    await window.mockix.contracts.clear(current);
    void load();
  };

  const drift = info?.responseProblems.filter((p) => p.operation !== null) ?? [];
  const outside = info ? [...new Map(info.responseProblems.filter((p) => p.operation === null).map((p) => [p.routeId, p])).values()] : [];
  const uncovered = info?.coverage.filter((c) => !c.routeId) ?? [];
  const covered = info ? info.coverage.length - uncovered.length : 0;

  return (
    <>
      <ContractsSidebar mocks={mocks} selected={current} onSelect={(id) => (setSelected(id), setPicked(null))} failing={info?.live?.failing ?? null} />
      <main className="main">
        <Notice />
        {!mock || !mock.contract || !info ? (
          <div className="welcome">
            <p className="note">
              Asocia un OpenAPI 3.0 o 3.1 a un mock con <span className="mono">contract:</span> en su <span className="mono">mock.yaml</span>. Mockix valida cada petición (ruta, parámetros, cuerpo) y también las respuestas del propio mock.
            </p>
          </div>
        ) : (
          <>
            <div className="reqline">
              <div className="urlbox">
                <span className="lbl">
                  Contrato<b>{info.file.split("/").pop()}</b>
                </span>
                <div className="url">
                  <span className="host">
                    OpenAPI {info.version} · {info.operations} operaciones · {covered} con mock
                  </span>
                </div>
                <div className="tail">
                  Modo{" "}
                  <span className="seg" role="group" aria-label="Modo del contrato">
                    {MODES.map((m) => (
                      <button key={m.mode} type="button" aria-pressed={info.mode === m.mode} onClick={() => void setMode(m.mode)} data-testid={`contract-mode-${m.mode}`}>
                        {m.label}
                      </button>
                    ))}
                  </span>
                </div>
              </div>
              <button type="button" className="btn btn-secondary" onClick={exportReport} data-testid="contract-export">
                <Icon name="download" size={14} /> Exportar JUnit
              </button>
            </div>
            <div className="split">
              <div className="pane">
                <div className="subtabs" role="tablist">
                  <button type="button" className="subtab" role="tab" aria-selected={left === "violations"} onClick={() => setLeft("violations")}>
                    Peticiones que no cumplen <span className={`n mono ${info.live?.failing ? "err-t" : ""}`}>{info.live?.failing ?? 0}</span>
                  </button>
                  <button type="button" className="subtab" role="tab" aria-selected={left === "coverage"} onClick={() => setLeft("coverage")} data-testid="contract-sub-coverage">
                    Cobertura <span className="n mono">{covered}/{info.operations}</span>
                  </button>
                  <span className="end">
                    {info.live && info.live.requests > 0 && (
                      <button type="button" className="link-btn" onClick={clear}>
                        Vaciar contadores
                      </button>
                    )}
                  </span>
                </div>
                <div className="pane-body">
                  {left === "violations" && !running && (
                    <div className="empty">
                      <span>Inicia el mock para validar las peticiones que lleguen.</span>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void toggleMock(mock.id)}>
                        <Icon name="play" size={12} /> Iniciar {mock.name}
                      </button>
                    </div>
                  )}
                  {left === "violations" && running && requestRules.length === 0 && (
                    <p className="note pad-top">{info.live?.requests ? `${info.live.requests} peticiones, todas cumplen el contrato.` : "Aún no ha llegado ninguna petición."}</p>
                  )}
                  {left === "violations" && requestRules.length > 0 && rule && (
                    <>
                      <table className="kv" data-testid="contract-rules">
                        <colgroup>
                          <col />
                          <col style={{ width: "30%" }} />
                          <col style={{ width: 56 }} />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>Regla</th>
                            <th>Operación</th>
                            <th className="r">Veces</th>
                          </tr>
                        </thead>
                        <tbody>
                          {requestRules.map((r) => {
                            const op = splitOp(r.operation);
                            return (
                              <tr key={`${r.operation} ${r.rule}`} className={`clickable${r === rule ? " sel" : ""}`} onClick={() => setPicked(`${r.operation} ${r.rule}`)}>
                                <td className="cond wrap" title={r.rule}>
                                  <RuleText rule={r.rule} where={r.where} />
                                </td>
                                <td className="cond">
                                  <Op {...op} />
                                </td>
                                <td className="hits">{r.count}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {rule.lastRequest && (
                        <>
                          <div className="section-label">
                            Última petición que la rompió{" "}
                            <span>
                              {time(rule.lastAt)} · {rule.lastClient}
                            </span>
                          </div>
                          <div className="code-block viewer">
                            <CodeEditor
                              key={`req-${rule.operation}-${rule.rule}-${rule.lastAt}`}
                              value={`${rule.lastRequest.method} ${rule.lastRequest.url}${rule.lastRequest.body ? `\n\n${pretty(rule.lastRequest.body)}` : ""}`}
                              language="text"
                              readOnly
                              label="Última petición que rompió la regla"
                              testId="contract-last-request"
                            />
                          </div>
                        </>
                      )}
                      <div className="why-box" data-testid="contract-why">
                        {rule.lastMessage}
                      </div>
                      {schema && (
                        <>
                          <div className="section-label">
                            Esquema esperado <span>{info.file}</span>
                          </div>
                          <div className="code-block viewer">
                            <CodeEditor key={`schema-${rule.operation}-${rule.rule}`} value={schema} language="text" readOnly label="Esquema esperado" testId="contract-schema" />
                          </div>
                        </>
                      )}
                    </>
                  )}
                  {left === "coverage" && (
                    <table className="kv" data-testid="contract-coverage">
                      <colgroup>
                        <col />
                        <col style={{ width: "42%" }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>Operación</th>
                          <th>Mock</th>
                        </tr>
                      </thead>
                      <tbody>
                        {info.coverage.map((c) => (
                          <tr key={`${c.method} ${c.path}`}>
                            <td className="cond">
                              <Op method={c.method} path={c.path} />
                            </td>
                            <td className={c.routeId ? "mono" : "d"}>{c.routeId ?? (c.hasExample ? "sin mock · ejemplo en el contrato" : "sin mock · solo esquema")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
              <div className="pane">
                <div className="subtabs" role="tablist">
                  <button type="button" className="subtab" role="tab" aria-selected={right === "clients"} onClick={() => setRight("clients")}>
                    Por cliente <span className="n mono">{info.live?.clients.length ?? 0}</span>
                  </button>
                  <button type="button" className="subtab" role="tab" aria-selected={right === "ours"} onClick={() => setRight("ours")} data-testid="contract-sub-ours">
                    Nuestras respuestas <span className={`n mono ${drift.length + responseRules.length ? "err-t" : ""}`}>{drift.length + responseRules.length}</span>
                  </button>
                </div>
                <div className="pane-body">
                  {right === "clients" && (
                    <>
                      {info.live && info.live.clients.length > 0 ? (
                        <table className="kv" data-testid="contract-clients">
                          <colgroup>
                            <col />
                            <col style={{ width: "18%" }} />
                            <col style={{ width: "18%" }} />
                            <col style={{ width: "14%" }} />
                          </colgroup>
                          <thead>
                            <tr>
                              <th>Cliente (User-Agent)</th>
                              <th className="r">Peticiones</th>
                              <th className="r">No cumplen</th>
                              <th className="r">%</th>
                            </tr>
                          </thead>
                          <tbody>
                            {info.live.clients.map((c) => (
                              <tr key={c.client}>
                                <td className="mono">{c.client}</td>
                                <td className="hits">{c.requests}</td>
                                <td className="hits">{c.failing}</td>
                                <td className="hits">{c.requests ? `${((c.failing / c.requests) * 100).toLocaleString("es-MX", { maximumFractionDigits: 1 })} %` : "–"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <p className="note pad-top">Las peticiones se agrupan por User-Agent (o por Origin) para ver qué cliente se sale del contrato.</p>
                      )}
                      <div className="section-label">
                        En vivo <span>últimas peticiones que no cumplen</span>
                      </div>
                      <ul className="log">
                        {(info.live?.recent ?? []).slice(0, 20).map((r) => (
                          <li key={r.seq} className="lg ctr">
                            <span className="time mono">{time(r.at)}</span>
                            <span className={`st mono ${tone(r.status)}`}>{statusText(r.status)}</span>
                            <span className={`meth ${METHOD_CLASS[r.method] ?? ""}`}>{shortMethod(r.method)}</span>
                            <span className="pth mono">{r.url}</span>
                            <span className="why" title={r.violations.map((v) => v.message).join("\n")}>
                              {r.violations[0]?.where}
                            </span>
                            <span className="tot mono">{r.client}</span>
                          </li>
                        ))}
                        {!info.live?.recent.length && <li className="note">Nada todavía.</li>}
                      </ul>
                    </>
                  )}
                  {right === "ours" && (
                    <>
                      <div className="section-label">
                        Nuestras respuestas que no cumplen <span>el mock también se valida contra el contrato</span>
                      </div>
                      {drift.length + responseRules.length === 0 ? (
                        <p className="note">Todas las respuestas del mock cumplen el contrato.</p>
                      ) : (
                        <table className="kv" data-testid="contract-ours">
                          <colgroup>
                            <col style={{ width: "50%" }} />
                            <col />
                          </colgroup>
                          <thead>
                            <tr>
                              <th>Ruta · respuesta</th>
                              <th>Problema</th>
                            </tr>
                          </thead>
                          <tbody>
                            {drift.map((p) => (
                              <tr key={`s-${p.routeId}-${p.responseId}-${p.message}`}>
                                <td className="cond">
                                  <Op method={p.method} path={p.path} /> · <span className={tone(p.status) === "ok" ? "ok-t" : "err-t"}>{p.status}</span> {p.responseId}
                                </td>
                                <td title={p.message}>{p.message}</td>
                              </tr>
                            ))}
                            {responseRules
                              .filter((r) => !drift.some((p) => p.routeId === r.routeId && p.responseId === r.responseId))
                              .map((r) => (
                                <tr key={`l-${r.operation}-${r.rule}`}>
                                  <td className="cond">
                                    <Op {...splitOp(r.operation)} /> · {r.responseId ?? ""}
                                  </td>
                                  <td title={r.lastMessage}>
                                    {r.lastMessage} <span className="d">({r.count}× en vivo)</span>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      )}
                      {outside.length > 0 && (
                        <>
                          <div className="section-label">
                            Rutas fuera del contrato <span>el mock las sirve, el contrato no las documenta</span>
                          </div>
                          <table className="kv">
                            <tbody>
                              {outside.map((p) => (
                                <tr key={p.routeId}>
                                  <td className="cond">
                                    <Op method={p.method} path={p.path} />
                                  </td>
                                  <td className="mono d">{p.routeId}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </>
                      )}
                      <div className="section-label">
                        Cobertura <span>operaciones del contrato sin mock</span>
                      </div>
                      {uncovered.length === 0 ? (
                        <p className="note">Todas las operaciones tienen mock.</p>
                      ) : (
                        <table className="kv">
                          <tbody>
                            {uncovered.map((c) => (
                              <tr key={`${c.method} ${c.path}`}>
                                <td className="cond">
                                  <Op method={c.method} path={c.path} />
                                </td>
                                <td className="d">{c.hasExample ? "ejemplo en el contrato: sí" : "solo esquema"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </>
                  )}
                  <div className="section-label">Modos</div>
                  <p className="note">
                    <b>Avisar</b> registra cada petición que no cumple y responde igual. <b>Estricto</b> responde <span className="mono">400 application/problem+json</span> con la explicación, útil para que el cliente falle pronto en desarrollo. En CI:{" "}
                    <span className="mono">mockix serve --report contrato.xml --fail-on-violation</span>.
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </>
  );
}
