import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ChaosInfo, ChaosLive, ChaosPointView, ChaosProfileDraft, ChaosProfileView } from "@shared/ipc";
import { Icon } from "../Icon";
import { CodeEditor } from "./CodeEditor";
import { Strata } from "./LogPane";
import { Notice } from "./Shell";
import { METHOD_CLASS, chaosText, pathPieces, shortMethod, time } from "../lib/format";
import { useStore } from "../state/store";

const secs = (ms: number) => `${Math.round(ms / 100) / 10} s`.replace(".0 s", " s");
const pct = (r: number) => `${(Math.round(r * 1000) / 10).toLocaleString("es-MX")} %`;


const toDraft = (p: ChaosProfileView): ChaosProfileDraft => ({
  description: p.description,
  loop: p.loop,
  durationMs: p.durationMs,
  points: structuredClone(p.points),
  extras: { ...p.extras },
});

/** Value at t of a numeric field, interpolated like the core does. */
function sample(points: ChaosPointView[], cycle: number, loop: boolean, t: number, key: "latencyMs" | "jitterMs" | "errorRate"): number {
  if (!points.length) return 0;
  if (t <= points[0]!.tMs) return points[0]![key];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (t > b.tMs) continue;
    const k = b.tMs === a.tMs ? 1 : (t - a.tMs) / (b.tMs - a.tMs);
    return a[key] + (b[key] - a[key]) * k;
  }
  const last = points.at(-1)!;
  if (loop && cycle > last.tMs) return last[key] + (points[0]![key] - last[key]) * ((t - last.tMs) / (cycle - last.tMs));
  return last[key];
}

const nice = (v: number, steps: number[]) => steps.find((s) => s >= v) ?? Math.ceil(v / steps.at(-1)!) * steps.at(-1)!;

/* ---------- Chart: latency (left axis), jitter band, errors (right axis), draggable points ---------- */

function Chart({ draft, onChange, nowMs, selected, onSelect }: { draft: ChaosProfileDraft; onChange(d: ChaosProfileDraft): void; nowMs: number | null; selected: number; onSelect(i: number): void }) {
  const W = 540;
  const H = 230;
  const L = 50;
  const R = 44;
  const T = 14;
  const B = 26;
  const last = draft.points.at(-1)?.tMs ?? 0;
  const cycle = Math.max(draft.durationMs ?? last, last, 10_000);
  const maxLat = nice(Math.max(...draft.points.map((p) => p.latencyMs + p.jitterMs), 100) * 1.15, [200, 400, 600, 800, 1200, 1600, 2000, 3000, 4000, 6000, 8000, 12000]);
  const maxErr = nice(Math.max(...draft.points.map((p) => p.errorRate), 0.05) * 100 * 1.15, [10, 20, 30, 50, 100]);
  const x = (t: number) => L + (t / cycle) * (W - L - R);
  const y = (ms: number) => T + (1 - ms / maxLat) * (H - T - B);
  const ye = (rate: number) => T + (1 - (rate * 100) / maxErr) * (H - T - B);
  const svg = useRef<SVGSVGElement | null>(null);
  const drag = useRef<number | null>(null);

  const toData = (e: ReactPointerEvent) => {
    const box = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const py = ((e.clientY - box.top) / box.height) * H;
    return { t: ((px - L) / (W - L - R)) * cycle, ms: (1 - (py - T) / (H - T - B)) * maxLat };
  };
  const move = (e: ReactPointerEvent) => {
    const i = drag.current;
    if (i === null) return;
    const { t, ms } = toData(e);
    const points = draft.points.map((p) => ({ ...p }));
    const lo = i === 0 ? 0 : points[i - 1]!.tMs;
    const hi = i === points.length - 1 ? (draft.durationMs ?? 86_400_000) : points[i + 1]!.tMs;
    points[i]!.tMs = i === 0 ? 0 : Math.min(hi, Math.max(lo, Math.round(t / 500) * 500));
    points[i]!.latencyMs = Math.max(0, Math.round(ms / 10) * 10);
    onChange({ ...draft, points });
  };

  const steps = 120;
  const band: string[] = [];
  const low: string[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = (cycle * k) / steps;
    const m = sample(draft.points, cycle, draft.loop, t, "latencyMs");
    const j = sample(draft.points, cycle, draft.loop, t, "jitterMs");
    band.push(`${x(t)},${y(Math.min(maxLat, m + j))}`);
    low.unshift(`${x(t)},${y(Math.max(0, m - j))}`);
  }
  const bars = [];
  const buckets = 30;
  for (let k = 0; k < buckets; k++) {
    const t = (cycle * (k + 0.5)) / buckets;
    const e = sample(draft.points, cycle, draft.loop, t, "errorRate");
    if (e > 0.002) bars.push(<rect key={k} className="ch-err" x={x((cycle * k) / buckets) + 1} y={ye(e)} width={Math.max(1, x(cycle / buckets) - x(0) - 2)} height={ye(0) - ye(e)} />);
  }
  const line = [...draft.points.map((p) => `${x(p.tMs)},${y(p.latencyMs)}`), ...(draft.loop && cycle > last && draft.points.length ? [`${x(cycle)},${y(draft.points[0]!.latencyMs)}`] : [`${x(cycle)},${y(draft.points.at(-1)?.latencyMs ?? 0)}`])];
  const tTicks = Array.from({ length: 7 }, (_, k) => (cycle * k) / 6);

  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Curva de caos: ${draft.points.map((p) => `${secs(p.tMs)} ${Math.round(p.latencyMs)} ms y ${pct(p.errorRate)} de errores`).join("; ")}`}
      onPointerMove={move}
      onPointerUp={() => (drag.current = null)}
      onPointerLeave={() => (drag.current = null)}
      data-testid="chaos-chart"
    >
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line className="ch-grid" x1={L} x2={W - R} y1={y(maxLat * f)} y2={y(maxLat * f)} />
          <text className="ch-axis" x={L - 6} y={y(maxLat * f) + 4} textAnchor="end">
            {Math.round(maxLat * f)}
          </text>
          <text className="ch-axis" x={W - R + 6} y={y(maxLat * f) + 4}>
            {Math.round(maxErr * f)}%
          </text>
        </g>
      ))}
      {tTicks.map((t) => (
        <text key={t} className="ch-axis" x={x(t)} y={H - 8} textAnchor="middle">
          {secs(t)}
        </text>
      ))}
      {bars}
      <polygon className="ch-band" points={[...band, ...low].join(" ")} />
      <polyline className="ch-lat" points={line.join(" ")} />
      {draft.points.map((p, i) => (
        <circle
          key={i}
          className={`ch-pt${i === selected ? " sel" : ""}`}
          cx={x(p.tMs)}
          cy={y(p.latencyMs)}
          r={6}
          tabIndex={0}
          aria-label={`Punto ${i + 1}: ${secs(p.tMs)}, ${Math.round(p.latencyMs)} ms`}
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture(e.pointerId);
            drag.current = i;
            onSelect(i);
          }}
          data-testid={`chaos-point-${i}`}
        />
      ))}
      {nowMs !== null && (
        <g>
          <line className="ch-now" x1={x(nowMs)} x2={x(nowMs)} y1={T} y2={H - B} />
          <text className="ch-now-lbl" x={Math.min(x(nowMs) + 5, W - R - 60)} y={T + 10}>
            ahora {secs(nowMs)}
          </text>
        </g>
      )}
    </svg>
  );
}

/* ---------- View ---------- */

function codesText(errors: ChaosPointView["errors"]): string {
  if (!errors.length) return "";
  return errors.every((e) => e.weight === 1) ? errors.map((e) => e.status).join(", ") : errors.map((e) => `${e.status}:${e.weight}`).join(", ");
}

function parseCodes(text: string): ChaosPointView["errors"] | null {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  const out: ChaosPointView["errors"] = [];
  for (const p of parts) {
    const m = /^([45]\d\d)(?::(\d+(?:\.\d+)?))?$/.exec(p);
    if (!m) return null;
    out.push({ status: Number(m[1]), weight: m[2] ? Number(m[2]) : 1 });
  }
  return out;
}

function NumberCell({ value, onChange, scale = 1, suffix, testId, step = 1 }: { value: number; onChange(v: number): void; scale?: number; suffix: string; testId?: string; step?: number }) {
  const [text, setText] = useState(String(Math.round((value / scale) * 100) / 100));
  useEffect(() => setText(String(Math.round((value / scale) * 100) / 100)), [value, scale]);
  return (
    <span className="num-cell">
      <input
        className="mono"
        value={text}
        inputMode="decimal"
        step={step}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value.replace(",", "."));
          if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= 0) onChange(n * scale);
        }}
        aria-label={suffix}
        data-testid={testId}
      />
      <span className="d">{suffix}</span>
    </span>
  );
}

export function ChaosView() {
  const mocks = useStore((s) => s.mocks);
  const log = useStore((s) => s.log);
  const setNotice = useStore((s) => s.setNotice);
  const toggleMock = useStore((s) => s.toggleMock);
  const [info, setInfo] = useState<ChaosInfo | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [draft, setDraft] = useState<ChaosProfileDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [point, setPoint] = useState(0);
  const [left, setLeft] = useState<"curve" | "yaml">("curve");
  const [right, setRight] = useState<"effects" | "where">("effects");
  const [liveMock, setLiveMock] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    const outcome = await window.mockix.chaos.get();
    if (outcome.ok) {
      setInfo(outcome.value);
      setFetchedAt(Date.now());
    }
  }, []);
  const anyRunning = mocks.some((m) => m.state === "running");
  useEffect(() => {
    void load();
    if (!anyRunning) return;
    const t = setInterval(() => void load(), 1000);
    return () => clearInterval(t);
  }, [load, anyRunning, mocks.map((m) => `${m.id}:${m.state}:${m.routes.length}`).join(",")]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);

  const profile = info?.profiles.find((p) => p.name === picked) ?? info?.profiles[0] ?? null;
  useEffect(() => {
    if (profile && !dirty) setDraft(toDraft(profile));
  }, [profile?.name, JSON.stringify(profile), dirty]);
  useEffect(() => {
    setDirty(false);
    setPoint(0);
  }, [profile?.name]);

  const users = useMemo(() => info?.assignments.filter((a) => a.profile === profile?.name || Object.values(a.folders).includes(profile?.name ?? "") || a.routes.some((r) => r.profile === profile?.name)) ?? [], [info, profile?.name]);
  const liveList = info?.live ?? [];
  const live: ChaosLive | null = liveList.find((l) => l.mockId === liveMock) ?? liveList.find((l) => l.profile === profile?.name) ?? null;
  const liveNow = live && live.profile === profile?.name && !live.paused && live.cycleMs > 0 ? (live.tMs + (Date.now() - fetchedAt)) % (profile?.loop ? live.cycleMs : Number.POSITIVE_INFINITY) : null;
  const lastAffected = useMemo(() => (live ? log.find((r) => r.mockId === live.mockId && r.chaos && (r.chaos.latencyMs > 0 || r.chaos.error !== null || r.chaos.drop || r.chaos.timeout)) : undefined), [log, live?.mockId]);

  const change = (d: ChaosProfileDraft) => {
    setDraft(d);
    setDirty(true);
  };
  const setPointField = (i: number, patch: Partial<ChaosPointView>) => draft && change({ ...draft, points: draft.points.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  const addPoint = () => {
    if (!draft) return;
    const lastPoint = draft.points.at(-1)!;
    const t = Math.min(lastPoint.tMs + 10_000, draft.durationMs ?? lastPoint.tMs + 10_000);
    change({ ...draft, points: [...draft.points, { ...lastPoint, tMs: t, errors: [...lastPoint.errors] }] });
    setPoint(draft.points.length);
  };
  const removePoint = (i: number) => {
    if (!draft || draft.points.length <= 1) return;
    change({ ...draft, points: draft.points.filter((_, k) => k !== i) });
    setPoint(Math.max(0, i - 1));
  };
  const save = async () => {
    if (!profile || !draft) return;
    const outcome = await window.mockix.chaos.save(profile.name, draft);
    if (!outcome.ok) setNotice(`No se pudo guardar el perfil: ${outcome.error.message}`);
    else {
      setDirty(false);
      void load();
    }
  };
  const assign = async (mockId: string, name: string | null) => {
    const outcome = await window.mockix.chaos.assign(mockId, name);
    if (!outcome.ok) setNotice(outcome.error.message);
    void load();
  };
  const pause = async () => {
    if (!live) return;
    await window.mockix.chaos.pause(live.mockId, !live.paused);
    void load();
  };

  const byFile = useMemo(() => {
    const groups = new Map<string, ChaosProfileView[]>();
    for (const p of info?.profiles ?? []) groups.set(p.file, [...(groups.get(p.file) ?? []), p]);
    return [...groups];
  }, [info]);

  return (
    <>
      <aside className="sidebar" aria-label="Perfiles de caos">
        <div className="side-head">
          <h2>Perfiles de caos</h2>
        </div>
        <ul className="tree" role="tree">
          {byFile.length === 0 && <li className="side-note">No hay perfiles. Crea chaos/perfiles.yaml en el workspace.</li>}
          {byFile.map(([file, list]) => (
            <li key={file}>
              <div className="side-group">{file}</div>
              <ul>
                {list.map((p) => {
                  const applied = info?.assignments.filter((a) => a.profile === p.name).length ?? 0;
                  return (
                    <li key={p.name}>
                      <button type="button" className="row" aria-selected={profile?.name === p.name} onClick={() => setPicked(p.name)} title={p.description ?? p.name} data-testid={`chaos-profile-${p.name}`}>
                        <Icon name="zig" size={14} className="fold" />
                        <span className="name">{p.name}</span>
                        <span className="sub mono">{applied ? `${applied} mock${applied === 1 ? "" : "s"}` : ""}</span>
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
            <b>Cómo se aplica</b>
          </div>
          <pre className="side-code mono">{"# mock.yaml\nchaos:\n  profile: red-inestable\n  folders: { pedidos: off }"}</pre>
        </div>
      </aside>
      <main className="main">
        <Notice />
        {!profile || !draft ? (
          <div className="welcome">
            <p className="note">Un perfil de caos son puntos en el tiempo (latencia, jitter y errores) con interpolación entre ellos, y efectos extra como conexiones cortadas o cuerpos lentos. Se guardan en chaos/*.yaml.</p>
          </div>
        ) : (
          <>
            <div className="reqline">
              <div className="urlbox">
                <span className="lbl">
                  Perfil<b>{profile.name}</b>
                </span>
                <div className="url">
                  <span className="host">{profile.file}</span>
                </div>
                <div className="tail">
                  {Math.max(draft.durationMs ?? 0, draft.points.at(-1)!.tMs) === 0 ? "constante" : `ciclo ${secs(Math.max(draft.durationMs ?? 0, draft.points.at(-1)!.tMs))} · ${draft.loop ? "en bucle" : "sin bucle"}`}
                </div>
              </div>
              <button type="button" className="btn btn-secondary" onClick={pause} disabled={!live} data-testid="chaos-pause">
                <Icon name={live?.paused ? "play" : "stop"} size={14} /> {live?.paused ? "Reanudar caos" : "Pausar caos"}
              </button>
              <button type="button" className="btn btn-primary" onClick={save} disabled={!dirty} data-testid="chaos-save">
                Aplicar cambios
              </button>
            </div>
            <div className="split">
              <div className="pane">
                <div className="subtabs" role="tablist">
                  <button type="button" className="subtab" role="tab" aria-selected={left === "curve"} onClick={() => setLeft("curve")}>
                    Curva
                  </button>
                  <button type="button" className="subtab" role="tab" aria-selected={left === "yaml"} onClick={() => setLeft("yaml")}>
                    YAML
                  </button>
                  <span className="end">
                    <label className="field-inline">
                      <input type="checkbox" checked={draft.loop} onChange={(e) => change({ ...draft, loop: e.target.checked })} data-testid="chaos-loop" /> en bucle
                    </label>
                  </span>
                </div>
                <div className="pane-body">
                  {left === "yaml" ? (
                    <div className="code-block viewer">
                      <CodeEditor key={`yaml-${profile.file}`} value={info?.sources[profile.file] ?? ""} language="text" readOnly label="Archivo de perfiles" testId="chaos-yaml" />
                    </div>
                  ) : (
                    <>
                      <div className="section-label">
                        Latencia y errores en el tiempo <span>arrastra los puntos para editar</span>
                      </div>
                      <div className="chart">
                        <Chart draft={draft} onChange={change} nowMs={liveNow} selected={point} onSelect={setPoint} />
                      </div>
                      <div className="chart-legend">
                        <span className="k-lat">latencia (ms, eje izquierdo)</span>
                        <span className="k-band">± jitter</span>
                        <span className="k-err">errores (%, eje derecho)</span>
                      </div>
                      <div className="section-label">
                        Puntos de control <span>entre puntos se interpola en línea recta</span>
                        <span className="end">
                          <button type="button" className="link-btn" onClick={addPoint} data-testid="chaos-add-point">
                            <Icon name="plus" size={12} /> Añadir punto
                          </button>
                        </span>
                      </div>
                      <table className="kv editable chaos-points" data-testid="chaos-points">
                        <colgroup>
                          <col style={{ width: 30 }} />
                          <col style={{ width: "15%" }} />
                          <col style={{ width: "18%" }} />
                          <col style={{ width: "16%" }} />
                          <col style={{ width: "15%" }} />
                          <col />
                          <col style={{ width: 30 }} />
                        </colgroup>
                        <thead>
                          <tr>
                            <th />
                            <th>t</th>
                            <th>Latencia</th>
                            <th>Jitter</th>
                            <th>Errores</th>
                            <th>Códigos</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {draft.points.map((p, i) => (
                            <tr key={i} className={i === point ? "sel" : ""} onFocus={() => setPoint(i)}>
                              <td className="ord">{i + 1}</td>
                              <td>{i === 0 ? <span className="mono d">0 s</span> : <NumberCell value={p.tMs} scale={1000} suffix="s" onChange={(v) => setPointField(i, { tMs: v })} testId={`chaos-t-${i}`} />}</td>
                              <td>
                                <NumberCell value={p.latencyMs} suffix="ms" onChange={(v) => setPointField(i, { latencyMs: v })} testId={`chaos-latency-${i}`} />
                              </td>
                              <td>
                                <NumberCell value={p.jitterMs} suffix="ms" onChange={(v) => setPointField(i, { jitterMs: v })} />
                              </td>
                              <td>
                                <NumberCell value={p.errorRate} scale={0.01} suffix="%" onChange={(v) => setPointField(i, { errorRate: Math.min(1, v) })} testId={`chaos-errors-${i}`} />
                              </td>
                              <td>
                                <input
                                  className="mono codes"
                                  defaultValue={codesText(p.errors)}
                                  key={`${profile.name}-${i}-${codesText(p.errors)}`}
                                  placeholder="500, 503:2"
                                  aria-label="Códigos de error"
                                  onBlur={(e) => {
                                    const codes = parseCodes(e.target.value);
                                    if (codes) setPointField(i, { errors: codes });
                                    else setNotice("Códigos como 500, 503 o con peso: 500:1, 503:3");
                                  }}
                                />
                              </td>
                              <td className="actions">
                                {draft.points.length > 1 && (
                                  <button type="button" className="link-btn" onClick={() => removePoint(i)} title="Quitar el punto" aria-label={`Quitar el punto ${i + 1}`}>
                                    <Icon name="x" size={12} />
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="section-label">
                        Efectos extra <span>se suman a la curva en todo el ciclo</span>
                      </div>
                      <table className="kv editable">
                        <colgroup>
                          <col style={{ width: 34 }} />
                          <col style={{ width: "40%" }} />
                          <col />
                        </colgroup>
                        <tbody>
                          {(
                            [
                              ["dropRate", "Conexión cortada", 0.01, "%"],
                              ["timeoutRate", "Sin respuesta (timeout)", 0.01, "%"],
                            ] as const
                          ).map(([key, label, scale, suffix]) => (
                            <tr key={key}>
                              <td className="ck">
                                <input type="checkbox" checked={draft.extras[key] > 0} onChange={(e) => change({ ...draft, extras: { ...draft.extras, [key]: e.target.checked ? 0.01 : 0 } })} aria-label={label} />
                              </td>
                              <td className="ui">{label}</td>
                              <td>
                                <NumberCell value={draft.extras[key]} scale={scale} suffix={suffix} onChange={(v) => change({ ...draft, extras: { ...draft.extras, [key]: Math.min(1, v) } })} />
                              </td>
                            </tr>
                          ))}
                          <tr>
                            <td className="ck">
                              <input type="checkbox" checked={draft.extras.trickleKBps !== null} onChange={(e) => change({ ...draft, extras: { ...draft.extras, trickleKBps: e.target.checked ? 64 : null } })} aria-label="Cuerpo lento" />
                            </td>
                            <td className="ui">Cuerpo lento</td>
                            <td>{draft.extras.trickleKBps !== null && <NumberCell value={draft.extras.trickleKBps} suffix="KB/s" onChange={(v) => v > 0 && change({ ...draft, extras: { ...draft.extras, trickleKBps: v } })} />}</td>
                          </tr>
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              </div>
              <div className="pane">
                <div className="resp-head">
                  {live && live.profile === profile.name ? (
                    <>
                      <div className="status-line">
                        <span className="status">
                          Ahora <span className="mono">t = {secs(liveNow ?? live.tMs)}</span>
                        </span>
                        {live.level && (
                          <>
                            <span className="metric">
                              Latencia <b className="mono">{Math.round(live.level.latencyMs)} ms</b> ± <b className="mono">{Math.round(live.level.jitterMs)}</b>
                            </span>
                            <span className="metric">
                              Errores <b className="mono">{pct(live.level.errorRate)}</b>
                            </span>
                          </>
                        )}
                        <span className="metric" data-testid="chaos-affected">
                          Afectadas <b className="mono">{live.affected}</b> de {live.requests}
                        </span>
                        {live.paused && <span className="tag">en pausa</span>}
                      </div>
                      {lastAffected && <Strata row={lastAffected} />}
                    </>
                  ) : (
                    <div className="status-line">
                      <span className="status">Sin efectos en vivo</span>
                      <span className="metric">ningún mock en marcha aplica {profile.name}</span>
                    </div>
                  )}
                </div>
                <div className="subtabs" role="tablist">
                  <button type="button" className="subtab" role="tab" aria-selected={right === "effects"} onClick={() => setRight("effects")} data-testid="chaos-sub-effects">
                    Efectos aplicados <span className="n mono">{live?.recent.length ?? 0}</span>
                  </button>
                  <button type="button" className="subtab" role="tab" aria-selected={right === "where"} onClick={() => setRight("where")} data-testid="chaos-sub-where">
                    Dónde se aplica <span className="n mono">{users.length}</span>
                  </button>
                  {liveList.length > 1 && (
                    <span className="end">
                      <select className="mini-select" value={live?.mockId ?? ""} onChange={(e) => setLiveMock(e.target.value)} aria-label="Mock en vivo">
                        {liveList.map((l) => (
                          <option key={l.mockId} value={l.mockId}>
                            {l.mockId}
                          </option>
                        ))}
                      </select>
                    </span>
                  )}
                </div>
                <div className="pane-body">
                  {right === "effects" && (
                    <>
                      <ul className="log" data-testid="chaos-effects">
                        {(live?.recent ?? []).slice(0, 40).map((r) => (
                          <li key={r.seq} className="lg chaos-row">
                            <span className="time mono">{time(r.at)}</span>
                            <span className={`meth ${METHOD_CLASS[r.method] ?? ""}`}>{shortMethod(r.method)}</span>
                            <span className="pth mono">{r.url}</span>
                            <span className={`fx mono ${r.decision.error !== null || r.decision.drop || r.decision.timeout ? "err-t" : ""}`}>{chaosText(r.decision)}</span>
                            <span className="tot mono">t {secs(r.decision.tMs)}</span>
                          </li>
                        ))}
                        {!live?.recent.length && <li className="note">{live ? "Nada todavía." : "Inicia un mock que aplique este perfil para ver sus efectos."}</li>}
                      </ul>
                      {live && live.routes.length > 0 && (
                        <>
                          <div className="section-label">
                            Por ruta <span>últimos 60 s</span>
                          </div>
                          <table className="kv" data-testid="chaos-routes">
                            <colgroup>
                              <col />
                              <col style={{ width: "15%" }} />
                              <col style={{ width: "17%" }} />
                              <col style={{ width: "19%" }} />
                            </colgroup>
                            <thead>
                              <tr>
                                <th>Ruta</th>
                                <th className="r">Pet.</th>
                                <th className="r">Afectadas</th>
                                <th className="r">Latencia +</th>
                              </tr>
                            </thead>
                            <tbody>
                              {live.routes.map((r) => (
                                <tr key={`${r.routeId}-${r.method}-${r.path}`}>
                                  <td className="cond">
                                    <span className={`meth ${METHOD_CLASS[r.method] ?? ""}`}>{shortMethod(r.method)}</span>
                                    {r.routeId ? <span className="mono"> {r.routeId}</span> : pathPieces(r.path).map((x, i) => <span key={i}>{x.text}</span>)}
                                  </td>
                                  <td className="hits">{r.requests}</td>
                                  <td className="hits">{r.affected}</td>
                                  <td className="hits">{r.latencyMs} ms</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </>
                      )}
                    </>
                  )}
                  {right === "where" && (
                    <>
                      <table className="kv" data-testid="chaos-where">
                        <colgroup>
                          <col style={{ width: "34%" }} />
                          <col />
                          <col style={{ width: 120 }} />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>Mock</th>
                            <th>Perfil</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {(info?.assignments ?? []).map((a) => (
                            <tr key={a.mockId}>
                              <td className="ui">
                                {a.mockId} <span className="d">(todo el mock)</span>
                              </td>
                              <td>
                                <select className="mini-select" value={a.profile ?? ""} onChange={(e) => void assign(a.mockId, e.target.value || null)} aria-label={`Perfil de ${a.mockId}`} data-testid={`chaos-assign-${a.mockId}`}>
                                  <option value="">sin caos</option>
                                  {info?.profiles.map((p) => (
                                    <option key={p.name} value={p.name}>
                                      {p.name}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="actions">
                                {a.state === "running" ? (
                                  <span className="state state-running">En marcha</span>
                                ) : (
                                  <button type="button" className="link-btn" onClick={() => void toggleMock(a.mockId)}>
                                    Iniciar
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                          {(info?.assignments ?? []).flatMap((a) => [
                            ...Object.entries(a.folders).map(([folder, p]) => (
                              <tr key={`${a.mockId}-f-${folder}`}>
                                <td className="ui">
                                  {a.mockId} / {folder} <span className="d">(carpeta)</span>
                                </td>
                                <td className={p ? "" : "d"}>{p ?? "excluida: sin caos"}</td>
                                <td />
                              </tr>
                            )),
                            ...a.routes.map((r) => (
                              <tr key={`${a.mockId}-r-${r.routeId}`}>
                                <td className="ui">
                                  {a.mockId} / {r.routeId} <span className="d">(ruta)</span>
                                </td>
                                <td className={r.profile ? "" : "d"}>{r.profile ?? "excluida: sin caos"}</td>
                                <td />
                              </tr>
                            )),
                          ])}
                        </tbody>
                      </table>
                      <p className="note pad-top">
                        Las carpetas y rutas se ajustan en <span className="mono">mock.yaml</span> (<span className="mono">chaos.folders</span>) y en cada ruta (<span className="mono">chaos: off</span>). Con <span className="mono">mockix serve --chaos {profile.name} --seed 42</span> la secuencia de efectos se repite en CI.
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </>
  );
}
