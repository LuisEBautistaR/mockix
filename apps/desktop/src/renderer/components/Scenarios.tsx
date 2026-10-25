import { useCallback, useEffect, useMemo, useState } from "react";
import type { MockStatus, ScenarioEventView, ScenarioInfo, ScenarioInstanceInfo, ScenariosInfo } from "@shared/ipc";
import { Icon } from "../Icon";
import { CodeEditor } from "./CodeEditor";
import { Notice } from "./Shell";
import { METHOD_CLASS, pathPieces, shortMethod, time, tone } from "../lib/format";
import { useStore } from "../state/store";

const seconds = (ms: number) => {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s * 10) / 10} s`.replace(".0 s", " s");
  if (s < 3600) return `${Math.round(s / 6) / 10} min`.replace(".0 min", " min");
  return `${Math.round(s / 360) / 10} h`.replace(".0 h", " h");
};

function triggerText(t: ScenarioEventView["trigger"]): string {
  switch (t.kind) {
    case "request":
      return `${t.method} ${t.url}${t.status ? ` · ${t.status}` : ""}`;
    case "timer":
      return `tiempo: ${seconds(t.afterMs)} en el estado anterior`;
    case "manual":
      return "forzado a mano";
    default:
      return "primera petición con esta clave";
  }
}

function TransitionTrigger({ t }: { t: ScenarioInfo["transitions"][number] }) {
  if (t.on)
    return (
      <>
        {t.on.method !== "ANY" && <span className={`meth ${METHOD_CLASS[t.on.method] ?? ""}`}>{shortMethod(t.on.method)}</span>}
        {pathPieces(t.on.path).map((x, i) => (x.param ? <span key={i} className="p">{x.text}</span> : <span key={i}>{x.text}</span>))}
      </>
    );
  return <>tras {seconds(t.afterMs ?? 0)}</>;
}

/* ---------- Diagram: states in columns by distance from the initial state ---------- */

const NW = 92;
const NH = 34;
const GX = 46;
const GY = 58;
const PAD = 26;

function layout(s: ScenarioInfo): Map<string, { x: number; y: number; col: number; row: number }> {
  const depth = new Map<string, number>([[s.initial, 0]]);
  const queue = [s.initial];
  while (queue.length) {
    const st = queue.shift()!;
    for (const t of s.transitions) {
      if (!t.from.includes(st) || depth.has(t.to)) continue;
      depth.set(t.to, depth.get(st)! + 1);
      queue.push(t.to);
    }
  }
  const max = Math.max(0, ...depth.values());
  for (const st of s.states) if (!depth.has(st)) depth.set(st, max + 1);
  const rows = new Map<number, number>();
  const out = new Map<string, { x: number; y: number; col: number; row: number }>();
  for (const st of s.states) {
    const col = depth.get(st)!;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    out.set(st, { x: PAD + col * (NW + GX), y: 22 + row * (NH + GY), col, row });
  }
  return out;
}

function Diagram({ scenario, instance }: { scenario: ScenarioInfo; instance: ScenarioInstanceInfo | null }) {
  const pos = layout(scenario);
  const final = new Set(scenario.states.filter((st) => !scenario.transitions.some((t) => t.from.includes(st))));
  const walked = new Set((instance?.history ?? []).filter((h) => h.from).map((h) => `${h.from}>${h.to}`));
  const edges = new Map<string, { from: string; to: string; labels: string[]; timed: boolean }>();
  for (const t of scenario.transitions) {
    for (const from of t.from) {
      const key = `${from}>${t.to}`;
      const label = t.on ? `${t.on.method === "ANY" ? "" : `${t.on.method} `}${t.on.path.split("/").filter(Boolean).at(-1) ?? "/"}` : `tras ${seconds(t.afterMs ?? 0)}`;
      const e = edges.get(key) ?? { from, to: t.to, labels: [], timed: false };
      e.labels.push(label);
      e.timed ||= t.afterMs !== null;
      edges.set(key, e);
    }
  }
  const all = [...pos.values()];
  const width = Math.max(...all.map((p) => p.x + NW)) + PAD;
  const height = Math.max(...all.map((p) => p.y + NH)) + 26;
  const start = pos.get(scenario.initial)!;

  const paths = [...edges.values()].map((e) => {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    const done = walked.has(`${e.from}>${e.to}`) ? " done" : "";
    let d: string;
    let end: [number, number];
    let angle: number;
    let label: [number, number];
    if (e.from === e.to) {
      d = `M${a.x + NW - 30} ${a.y} C${a.x + NW - 30} ${a.y - 26}, ${a.x + NW - 6} ${a.y - 26}, ${a.x + NW - 8} ${a.y - 6}`;
      end = [a.x + NW - 8, a.y - 1];
      angle = 90;
      label = [a.x + NW - 18, a.y - 26];
    } else if (a.row === b.row && b.col > a.col) {
      const y = a.y + NH / 2;
      d = `M${a.x + NW} ${y} L${b.x - 2} ${y}`;
      end = [b.x - 1, y];
      angle = 0;
      label = [(a.x + NW + b.x) / 2, a.y - 7];
    } else if (a.row === b.row) {
      const x1 = a.x + NW / 2;
      const x2 = b.x + NW / 2;
      d = `M${x1} ${a.y} C${x1} ${a.y - 34}, ${x2} ${b.y - 34}, ${x2} ${b.y - 2}`;
      end = [x2, b.y - 1];
      angle = 90;
      label = [(x1 + x2) / 2, a.y - 30];
    } else {
      const down = b.y > a.y;
      const x1 = a.x + NW / 2 + (b.col > a.col ? 14 : b.col < a.col ? -14 : 0);
      const y1 = down ? a.y + NH : a.y;
      const x2 = b.x + (b.col > a.col ? 18 : b.col < a.col ? NW - 18 : NW / 2);
      const y2 = down ? b.y - 2 : b.y + NH + 2;
      const bend = down ? 30 : -30;
      d = `M${x1} ${y1} C${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
      end = [x2, down ? b.y - 1 : b.y + NH + 1];
      angle = down ? 90 : -90;
      label = [(x1 + x2) / 2 + (x1 === x2 ? 32 : 0), (y1 + y2) / 2 + 4];
    }
    return (
      <g key={`${e.from}>${e.to}`}>
        <path className={`dg-edge${done}`} d={d} />
        <path className={`dg-arrow${done}`} transform={`translate(${end[0]} ${end[1]}) rotate(${angle})`} d="M0 0 L-7 -4 L-7 4 Z" />
        <text className={`dg-lbl${e.timed ? " time" : ""}`} x={label[0]} y={label[1]} textAnchor="middle">
          {e.labels.join(" · ")}
        </text>
      </g>
    );
  });

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ maxWidth: width }} role="img" aria-label={`Máquina de estados ${scenario.id}: ${scenario.states.join(", ")}${instance ? `; ${instance.key} está en ${instance.state}` : ""}`} data-testid="scenario-diagram">
      <circle className="dg-start" cx={PAD - 14} cy={start.y + NH / 2} r={4.5} />
      <path className="dg-edge done" d={`M${PAD - 10} ${start.y + NH / 2} L${PAD - 2} ${start.y + NH / 2}`} />
      {paths}
      {scenario.states.map((st) => {
        const p = pos.get(st)!;
        const cls = `${instance?.state === st ? " cur" : ""}${final.has(st) ? " final" : ""}`;
        return (
          <g key={st} className={`dg-node${cls}`} data-testid={`state-${st}`}>
            <rect x={p.x} y={p.y} width={NW} height={NH} rx={4} />
            <text x={p.x + 10} y={p.y + 21}>
              {st}
            </text>
            <text className="cnt" x={p.x + NW - 10} y={p.y + 21} textAnchor="end">
              {scenario.counts[st] ?? 0}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- View ---------- */

function ScenariosSidebar({ mocks, selected, onSelect, info }: { mocks: MockStatus[]; selected: { mock: string; id: string } | null; onSelect(mock: string, id: string): void; info: ScenariosInfo | null }) {
  const withScenarios = mocks.filter((m) => m.scenarios.length);
  return (
    <aside className="sidebar" aria-label="Escenarios">
      <div className="side-head">
        <h2>Escenarios</h2>
      </div>
      <ul className="tree" role="tree">
        {withScenarios.length === 0 && <li className="side-note">Ningún mock tiene escenarios. Crea uno en mocks/&lt;mock&gt;/scenarios/&lt;id&gt;.yaml.</li>}
        {withScenarios.map((m) => (
          <li key={m.id}>
            <div className="side-group">{m.name}</div>
            <ul>
              {m.scenarios.map((id) => {
                const count = info?.mockId === m.id ? info.scenarios.find((s) => s.id === id)?.instances.length : undefined;
                return (
                  <li key={id}>
                    <button type="button" className="row" aria-selected={selected?.mock === m.id && selected.id === id} onClick={() => onSelect(m.id, id)} data-testid={`scenario-${m.id}-${id}`}>
                      <Icon name="flow" size={14} className="fold" />
                      <span className="name">{id}</span>
                      <span className="sub mono">{count ?? ""}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      <div className="side-block">
        <div className="vars-head">
          <b>En las rutas</b>
        </div>
        <table>
          <tbody>
            <tr>
              <td className="d">Reglas</td>
              <td className="k">state.&lt;id&gt;</td>
            </tr>
            <tr>
              <td className="d">Plantillas</td>
              <td className="k">{"{{state.<id>}}"}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </aside>
  );
}

export function ScenariosView() {
  const mocks = useStore((s) => s.mocks);
  const toggleMock = useStore((s) => s.toggleMock);
  const setNotice = useStore((s) => s.setNotice);
  const [choice, setChoice] = useState<{ mock: string; id: string } | null>(null);
  const [info, setInfo] = useState<ScenariosInfo | null>(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [left, setLeft] = useState<"diagram" | "yaml">("diagram");
  const [right, setRight] = useState<"instances" | "readers">("instances");
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [forcing, setForcing] = useState(false);
  const [forceKey, setForceKey] = useState("");
  const [forceState, setForceState] = useState("");
  const [, setTick] = useState(0);

  const first = mocks.find((m) => m.scenarios.length);
  const selected = choice ?? (first ? { mock: first.id, id: first.scenarios[0]! } : null);
  const mock = mocks.find((m) => m.id === selected?.mock) ?? null;
  const running = mock?.state === "running";

  const load = useCallback(async () => {
    if (!selected) return setInfo(null);
    const outcome = await window.mockix.scenarios.get(selected.mock);
    if (outcome.ok) {
      setInfo(outcome.value);
      setFetchedAt(Date.now());
    } else setInfo(null);
  }, [selected?.mock]);

  useEffect(() => {
    void load();
    if (!running) return;
    const t = setInterval(() => void load(), 1000);
    return () => clearInterval(t);
  }, [load, running, mock?.scenarios.join(",")]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);

  const scenario = info?.scenarios.find((s) => s.id === selected?.id) ?? null;
  const instance = scenario?.instances.find((i) => i.key === pickedKey) ?? scenario?.instances[0] ?? null;
  const now = (info?.now ?? Date.now()) + (Date.now() - fetchedAt);
  const events = useMemo(() => info?.recent.filter((e) => e.scenario === selected?.id && e.trigger.kind !== "start").slice(0, 30) ?? [], [info, selected?.id]);

  const force = async () => {
    if (!selected || !scenario) return;
    const outcome = await window.mockix.scenarios.set(selected.mock, selected.id, forceKey.trim(), forceState || scenario.initial);
    if (!outcome.ok) setNotice(outcome.error.message);
    else {
      setPickedKey(forceKey.trim() || null);
      setForcing(false);
      void load();
    }
  };
  const reset = async () => {
    if (!selected) return;
    const outcome = await window.mockix.scenarios.reset(selected.mock, selected.id);
    if (!outcome.ok) setNotice(outcome.error.message);
    setPickedKey(null);
    void load();
  };

  return (
    <>
      <ScenariosSidebar mocks={mocks} selected={selected} onSelect={(m, id) => (setChoice({ mock: m, id }), setPickedKey(null), setForcing(false))} info={info} />
      <main className="main">
        <Notice />
        {!scenario || !mock ? (
          <div className="welcome">
            <p className="note">
              Un escenario es una máquina de estados con una instancia por clave (por ejemplo, una por pedido). Las peticiones y el tiempo la hacen avanzar, y las rutas responden según el estado con{" "}
              <span className="mono">state.&lt;id&gt;</span>.
            </p>
          </div>
        ) : (
          <>
            <div className="reqline">
              <div className="urlbox">
                <span className="lbl">
                  Escenario<b>{scenario.id}</b>
                </span>
                <span className="lbl">
                  Clave<b>{scenario.key ?? "única"}</b>
                </span>
                <div className="url">
                  <span className="host">{scenario.file}</span>
                </div>
                <div className="tail">
                  {scenario.states.length} estados · {scenario.transitions.length} transiciones
                </div>
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => (setForcing((f) => !f), setForceKey(instance?.key ?? ""), setForceState(instance?.state ?? scenario.initial))} disabled={!running} data-testid="scenario-force">
                Forzar estado
              </button>
              <button type="button" className="btn btn-secondary" onClick={reset} disabled={!running || scenario.instances.length === 0} data-testid="scenario-reset">
                Reiniciar instancias
              </button>
            </div>
            {forcing && (
              <form
                className="toolbar force-bar"
                onSubmit={(e) => {
                  e.preventDefault();
                  void force();
                }}
              >
                {scenario.key && (
                  <label className="field-inline">
                    {scenario.key}
                    <input className="mini-select mono" value={forceKey} onChange={(e) => setForceKey(e.target.value)} placeholder="ped_1043" aria-label="Clave de la instancia" data-testid="force-key" autoFocus />
                  </label>
                )}
                <label className="field-inline">
                  Estado
                  <select className="mini-select" value={forceState} onChange={(e) => setForceState(e.target.value)} aria-label="Estado" data-testid="force-state">
                    {scenario.states.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="btn btn-primary btn-sm" disabled={Boolean(scenario.key) && !forceKey.trim()} data-testid="force-apply">
                  Aplicar
                </button>
                <button type="button" className="link-btn" onClick={() => setForcing(false)}>
                  Cancelar
                </button>
              </form>
            )}
            <div className="split">
              <div className="pane">
                <div className="subtabs" role="tablist">
                  <button type="button" className="subtab" role="tab" aria-selected={left === "diagram"} onClick={() => setLeft("diagram")}>
                    Diagrama
                  </button>
                  <button type="button" className="subtab" role="tab" aria-selected={left === "yaml"} onClick={() => setLeft("yaml")}>
                    YAML
                  </button>
                  <span className="end">
                    {instance && (
                      <span className="hint">
                        Instancia <b className="mono">{instance.key || "única"}</b>
                      </span>
                    )}
                  </span>
                </div>
                <div className="pane-body">
                  {left === "diagram" && (
                    <>
                      <div className="section-label">
                        Máquina de estados <span>{instance ? `resaltado: estado actual de ${instance.key || "la instancia"}` : "sin instancias todavía"}</span>
                      </div>
                      <div className="diagram">
                        <Diagram scenario={scenario} instance={instance} />
                      </div>
                      <p className="note pad-top">El número de cada estado son las instancias que están en él ahora. La línea más oscura es el camino que ya recorrió la instancia resaltada.</p>
                      <div className="section-label">
                        Transiciones <span>veces que se han disparado desde que arrancó el mock</span>
                      </div>
                      <table className="kv" data-testid="scenario-transitions">
                        <colgroup>
                          <col style={{ width: "36%" }} />
                          <col />
                          <col style={{ width: 56 }} />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>De → a</th>
                            <th>Disparador</th>
                            <th className="r">Veces</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scenario.transitions.map((t, i) => (
                            <tr key={i}>
                              <td className="ui">
                                {t.from.join(", ")} → {t.to}
                              </td>
                              <td className="cond">
                                <TransitionTrigger t={t} />
                              </td>
                              <td className="hits">{t.fired}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                  {left === "yaml" && (
                    <>
                      <div className="section-label">
                        Definición <span>{scenario.file}</span>
                      </div>
                      <div className="code-block viewer">
                        <CodeEditor key={`yaml-${scenario.id}`} value={scenario.source} language="text" readOnly label="Definición del escenario" testId="scenario-yaml" />
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="pane">
                <div className="subtabs" role="tablist">
                  <button type="button" className="subtab" role="tab" aria-selected={right === "instances"} onClick={() => setRight("instances")}>
                    Instancias <span className="n mono">{scenario.instances.length}</span>
                  </button>
                  <button type="button" className="subtab" role="tab" aria-selected={right === "readers"} onClick={() => setRight("readers")} data-testid="scenario-sub-readers">
                    Rutas que leen el estado <span className="n mono">{scenario.readers.length}</span>
                  </button>
                </div>
                <div className="pane-body">
                  {right === "instances" && !running && (
                    <div className="empty">
                      <span>Las instancias viven mientras el mock está en marcha.</span>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void toggleMock(mock.id)}>
                        <Icon name="play" size={12} /> Iniciar {mock.name}
                      </button>
                    </div>
                  )}
                  {right === "instances" && running && scenario.instances.length === 0 && (
                    <p className="note pad-top">
                      Aún no hay instancias: la primera petición con {scenario.key ? <span className="mono">{scenario.key}</span> : "este escenario"} crea una en <b>{scenario.initial}</b>.
                    </p>
                  )}
                  {right === "instances" && scenario.instances.length > 0 && (
                    <>
                      <table className="kv" data-testid="scenario-instances">
                        <colgroup>
                          <col style={{ width: "24%" }} />
                          <col style={{ width: "19%" }} />
                          <col style={{ width: "16%" }} />
                          <col />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>Clave</th>
                            <th>Estado</th>
                            <th>Desde</th>
                            <th>Siguiente</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scenario.instances.map((inst) => {
                            const left = inst.next ? Math.max(0, inst.next.at - now) : 0;
                            const total = inst.next ? Math.max(1, inst.next.at - inst.since) : 1;
                            return (
                              <tr key={inst.key} className={`clickable${inst === instance ? " sel" : ""}`} onClick={() => setPickedKey(inst.key)} data-testid={`instance-${inst.key}`}>
                                <td className="mono">{inst.key || "única"}</td>
                                <td className="ui">
                                  <b>{inst.state}</b>
                                </td>
                                <td className="mono d">{time(inst.since)}</td>
                                <td className={inst.next ? "ui" : "d"}>
                                  {inst.next ? (
                                    <>
                                      <span className="prog">
                                        <i style={{ width: `${Math.min(100, ((total - left) / total) * 100)}%` }} />
                                      </span>
                                      {inst.next.to} en <span className="mono">{seconds(left)}</span>
                                    </>
                                  ) : inst.final ? (
                                    "estado final"
                                  ) : (
                                    `espera ${inst.waiting.join(" o ")}`
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {instance && (
                        <>
                          <div className="section-label">
                            Historial de {instance.key || "la instancia"} <span>qué la hizo avanzar</span>
                          </div>
                          <table className="kv" data-testid="scenario-history">
                            <colgroup>
                              <col style={{ width: "17%" }} />
                              <col style={{ width: "32%" }} />
                              <col />
                            </colgroup>
                            <thead>
                              <tr>
                                <th>Hora</th>
                                <th>Transición</th>
                                <th>Disparada por</th>
                              </tr>
                            </thead>
                            <tbody>
                              {instance.history.map((h, i) => (
                                <tr key={i}>
                                  <td className="mono d">{time(h.at)}</td>
                                  <td className="ui">
                                    {h.from ? `${h.from} → ` : "→ "}
                                    {h.to}
                                  </td>
                                  <td className={h.trigger.kind === "request" ? "cond" : "d"}>{triggerText(h.trigger)}</td>
                                </tr>
                              ))}
                              {instance.next && (
                                <tr className="ph">
                                  <td className="mono">{time(instance.next.at)}</td>
                                  <td>
                                    {instance.state} → {instance.next.to}
                                  </td>
                                  <td>programada</td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </>
                      )}
                      <div className="section-label">
                        Eventos recientes <span>de todas las instancias</span>
                      </div>
                      <ul className="log">
                        {events.map((e, i) => (
                          <li key={`${e.at}-${e.key}-${i}`} className="lg scn">
                            <span className="time mono">{time(e.at)}</span>
                            <span className="mono k">{e.key || "única"}</span>
                            <span className="ui">
                              {e.from ?? "·"} → <b>{e.to}</b>
                            </span>
                            <span className="pth mono d">{triggerText(e.trigger)}</span>
                          </li>
                        ))}
                        {events.length === 0 && <li className="note">Nada todavía.</li>}
                      </ul>
                    </>
                  )}
                  {right === "readers" &&
                    (scenario.readers.length === 0 ? (
                      <p className="note pad-top">
                        Ninguna ruta lee este estado. Usa <span className="mono">{`{ target: state.${scenario.id}, op: equals, value: … }`}</span> en las reglas de una respuesta.
                      </p>
                    ) : (
                      scenario.readers.map((r) => (
                        <div key={r.routeId}>
                          <div className="section-label">
                            Cómo responde{" "}
                            <span className="mono">
                              {r.method} {r.path}
                            </span>{" "}
                            <span>según el estado</span>
                          </div>
                          <table className="kv">
                            <colgroup>
                              <col style={{ width: "26%" }} />
                              <col style={{ width: "24%" }} />
                              <col />
                            </colgroup>
                            <thead>
                              <tr>
                                <th>Estado</th>
                                <th>Respuesta</th>
                                <th>Cuerpo</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.responses.map((x) => (
                                <tr key={x.id}>
                                  <td className="ui">{x.when}</td>
                                  <td className="ui">
                                    <span className={`mono ${tone(x.status) === "ok" ? "ok-t" : "err-t"}`}>{x.status}</span> {x.id}
                                  </td>
                                  <td className="mono d" title={x.body}>
                                    {x.body}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))
                    ))}
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </>
  );
}
