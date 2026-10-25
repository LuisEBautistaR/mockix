import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExchangeSummary, RecordingMeta, RecordingPlan, RecordingPreview, RecordingStatus } from "@shared/ipc";
import { Icon } from "../Icon";
import { CodeEditor } from "./CodeEditor";
import { METHOD_CLASS, bytes, pathPieces, shortMethod, statusText, time, tone } from "../lib/format";
import { useStore } from "../state/store";
import { Notice } from "./Shell";

const ACTION_LABEL = { new: "nueva ruta", append: "añadir", same: "ya existe" } as const;
const pretty = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

function useRecordings() {
  const [list, setList] = useState<RecordingMeta[]>([]);
  const [status, setStatus] = useState<RecordingStatus>({ active: null });
  const workspaceDir = useStore((s) => s.workspace?.dir);
  const refresh = useCallback(async () => setList((await window.mockix.recordings.list()) ?? []), []);
  useEffect(() => {
    void refresh();
    void window.mockix.recordings.status().then((s) => s && setStatus(s));
    const off = window.mockix.recordings.onStatus((s) => {
      setStatus(s);
      void refresh();
    });
    return off;
  }, [refresh, workspaceDir]);
  return { list, status, refresh };
}

export function RecordingsSidebar({ list, status, selected, onSelect }: { list: RecordingMeta[]; status: RecordingStatus; selected: string | null; onSelect(file: string): void }) {
  const active = status.active;
  const previous = list.filter((r) => r.file !== active?.file);
  return (
    <aside className="sidebar" aria-label="Grabaciones">
      <div className="side-head">
        <h2>Grabaciones</h2>
      </div>
      <ul className="tree" role="tree">
        {active && (
          <>
            <li className="side-group">En curso</li>
            <li>
              <button type="button" className="row" aria-selected={selected === active.file} onClick={() => onSelect(active.file)}>
                <Icon name="rec" size={14} className="fold" />
                <span className="name">{new URL(active.target).host}</span>
                <span className="sub mono">{active.count}</span>
              </button>
            </li>
          </>
        )}
        <li className="side-group">{active ? "Anteriores" : "Guardadas"}</li>
        {previous.length === 0 && <li className="side-note">Aún no hay grabaciones. Pon una URL real arriba y pulsa Grabar.</li>}
        {previous.map((r) => (
          <li key={r.file}>
            <button type="button" className="row" aria-selected={selected === r.file} onClick={() => onSelect(r.file)} title={r.file} data-testid={`recording-${r.file}`}>
              <Icon name="rec" size={14} className="fold" />
              <span className="name">{new Date(r.startedAt).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
              <span className="sub mono">{r.exchanges}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="side-block">
        <div className="vars-head">
          <b>Dónde se guardan</b>
        </div>
        <table>
          <tbody>
            <tr>
              <td className="d">Carpeta</td>
              <td className="k">.mockix/recordings/</td>
            </tr>
            <tr>
              <td className="d">En git</td>
              <td>no (crudo, local)</td>
            </tr>
          </tbody>
        </table>
      </div>
    </aside>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="num mono">{`${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`}</span>;
}

export function RecordingsView() {
  const { list, status, refresh } = useRecordings();
  const mocks = useStore((s) => s.mocks);
  const setDialog = useStore((s) => s.setDialog);
  const setNotice = useStore((s) => s.setNotice);
  const [selected, setSelected] = useState<string | null>(null);
  const [target, setTarget] = useState("https://");
  const [port, setPort] = useState("4100");
  const [prefix, setPrefix] = useState("");
  const [into, setInto] = useState<string>("");
  const [name, setName] = useState("");
  const [sub, setSub] = useState<"traffic" | "routes">("routes");
  const [rightSub, setRightSub] = useState<"preview" | "profile">("preview");
  const [exchanges, setExchanges] = useState<ExchangeSummary[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [plan, setPlan] = useState<RecordingPlan | null>(null);
  const [preview, setPreview] = useState<RecordingPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const active = status.active;
  const file = selected ?? active?.file ?? list[0]?.file ?? null;
  const live = active !== null && file === active.file;

  // Exchanges of the selected recording (live ones arrive as events).
  useEffect(() => {
    if (!file) return setExchanges([]);
    let alive = true;
    void window.mockix.recordings.exchanges(file).then((o) => alive && o.ok && setExchanges(o.value));
    const off = window.mockix.recordings.onExchange((ex) => {
      if (live) setExchanges((list) => [...list.filter((e) => e.index !== ex.index), ex]);
    });
    return () => {
      alive = false;
      off();
    };
  }, [file, live]);

  // Conversion plan whenever the recording, the target mock or the prefix change.
  const exchangeCount = exchanges.length;
  useEffect(() => {
    if (!file || exchangeCount === 0) return setPlan(null);
    let alive = true;
    const t = setTimeout(() => {
      void window.mockix.recordings.plan(file, into || null, prefix).then((o) => {
        if (!alive || !o.ok) return;
        setPlan(o.value);
        setName((n) => n || o.value.suggestedName);
      });
    }, live ? 600 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [file, into, prefix, exchangeCount, live]);

  const shown = picked ?? exchanges.find((e) => !e.binary && e.status < 300)?.index ?? exchanges[0]?.index ?? null;
  useEffect(() => {
    const index = shown;
    if (!file || index === null) return setPreview(null);
    let alive = true;
    void window.mockix.recordings.preview(file, index, prefix).then((o) => alive && o.ok && setPreview(o.value));
    return () => {
      alive = false;
    };
  }, [file, shown, prefix]);

  const start = async () => {
    setBusy(true);
    const outcome = await window.mockix.recordings.start(target.trim(), Number(port) || 0);
    setBusy(false);
    if (!outcome.ok) setNotice(`No se pudo grabar: ${outcome.error.message}`);
    else if (outcome.value.active) {
      setSelected(outcome.value.active.file);
      setSub("traffic");
      setPicked(null);
      setName("");
    }
  };
  const stop = async () => {
    await window.mockix.recordings.stop();
    await refresh();
  };
  const convert = async () => {
    if (!file) return;
    setBusy(true);
    const outcome = await window.mockix.recordings.convert(file, into ? { into } : { name: name || plan?.suggestedName || "grabacion" }, prefix);
    setBusy(false);
    if (!outcome.ok) setNotice(`No se pudo convertir: ${outcome.error.message}`);
    else setDialog({ kind: "import-result", summary: outcome.value });
  };
  const remove = async () => {
    if (!file) return;
    const outcome = await window.mockix.recordings.remove(file);
    if (!outcome.ok) setNotice(outcome.error.message);
    setSelected(null);
    await refresh();
  };

  const meta = list.find((r) => r.file === file);
  const validTarget = /^https?:\/\/[^\s/]+/.test(target.trim());
  const sorted = useMemo(() => [...exchanges].sort((a, b) => b.at - a.at), [exchanges]);

  return (
    <>
      <RecordingsSidebar list={list} status={status} selected={file} onSelect={(f) => (setSelected(f), setPicked(null))} />
      <main className="main">
        <Notice />
        <div className="reqline">
          {active && (
            <span className="rec-chip" data-testid="rec-chip">
              Grabando <Elapsed since={active.startedAt} />
            </span>
          )}
          <div className="urlbox">
            <span className="lbl">Proxy</span>
            {active ? (
              <span className="url mono">
                <span className="host" data-testid="rec-proxy">{active.url.replace(/^https?:\/\//, "")}</span>
                <span className="arrow">→</span>
                {active.target}
              </span>
            ) : (
              <>
                <span className="lbl inline">
                  localhost:
                  <input className="mono port-in" value={port} onChange={(e) => setPort(e.target.value)} aria-label="Puerto del proxy" data-testid="rec-port" />
                </span>
                <span className="arrow">→</span>
                <input className="url-in mono" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://api.real.example" aria-label="API real" data-testid="rec-target" />
              </>
            )}
            <span className="tail">
              {live ? `${active!.count} intercambios` : meta ? `${meta.exchanges} intercambios · ${bytes(meta.bytes)}` : ""}
            </span>
          </div>
          {active ? (
            <button type="button" className="btn btn-secondary" onClick={stop} data-testid="rec-stop">
              <Icon name="stop" size={14} /> Detener
            </button>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={start} disabled={busy || !validTarget} data-testid="rec-start">
              <Icon name="rec" size={14} /> Grabar
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={convert} disabled={busy || !file || live || exchanges.length === 0} data-testid="rec-convert">
            Convertir en mocks
          </button>
        </div>
        <div className="split">
          <div className="pane">
            <div className="subtabs" role="tablist">
              <button type="button" className="subtab" role="tab" aria-selected={sub === "traffic"} onClick={() => setSub("traffic")} data-testid="rec-sub-traffic">
                Tráfico <span className="n mono">{exchanges.length}</span>
              </button>
              <button type="button" className="subtab" role="tab" aria-selected={sub === "routes"} onClick={() => setSub("routes")} data-testid="rec-sub-routes">
                Rutas detectadas <span className="n mono">{plan?.items.length ?? 0}</span>
              </button>
              <span className="end">
                {file && !live && (
                  <button type="button" className="link-btn" onClick={remove} title="Mover la grabación a la papelera">
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </span>
            </div>
            <div className="toolbar convert-opts">
              <label className="field-inline">
                Quitar prefijo
                <input className="mini-select mono" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="/v1" aria-label="Prefijo" data-testid="rec-prefix" />
              </label>
              <label className="field-inline">
                Destino
                <select className="mini-select" value={into} onChange={(e) => setInto(e.target.value)} aria-label="Destino" data-testid="rec-into">
                  <option value="">mock nuevo</option>
                  {mocks.filter((m) => m.startable).map((m) => (
                    <option key={m.id} value={m.id}>
                      añadir a {m.name}
                    </option>
                  ))}
                </select>
              </label>
              {!into && (
                <label className="field-inline">
                  Nombre
                  <input className="mini-select mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} aria-label="Nombre del mock nuevo" data-testid="rec-name" />
                </label>
              )}
            </div>
            <div className="pane-body">
              {!file && <p className="note">Graba tráfico real: Mockix se pone delante de la API, tu cliente apunta al proxy y cada petición queda guardada.</p>}
              {sub === "routes" && plan && (
                <>
                  <table className="kv" data-testid="rec-plan">
                    <colgroup>
                      <col />
                      <col style={{ width: 54 }} />
                      <col style={{ width: 86 }} />
                      <col style={{ width: 120 }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Ruta inferida</th>
                        <th className="r">Pet.</th>
                        <th className="r">Respuestas</th>
                        <th>Al convertir</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.items.map((p) => (
                        <tr key={`${p.method} ${p.path}`}>
                          <td className="cond">
                            <span className={`meth ${METHOD_CLASS[p.method] ?? ""}`}>{shortMethod(p.method)}</span>{" "}
                            {pathPieces(p.path).map((x, i) => (x.param ? <span key={i} className="p">{x.text}</span> : <span key={i}>{x.text}</span>))}
                          </td>
                          <td className="hits">{p.exchanges}</td>
                          <td className="hits">{p.responses}</td>
                          <td className={p.action === "same" ? "d" : "ui"}>{p.action === "append" ? `añadir ${p.added} respuesta${p.added === 1 ? "" : "s"}` : ACTION_LABEL[p.action]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {plan.warnings.length > 0 && (
                    <>
                      <div className="section-label">Avisos</div>
                      <ul className="report-list pad">
                        {plan.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
              {sub === "traffic" && (
                <ul className="log">
                  {sorted.map((e) => (
                    <li key={e.index} className="lg" aria-selected={e.index === shown} onClick={() => setPicked(e.index)} data-testid="rec-row">
                      <span className="time mono">{time(e.at)}</span>
                      <span className={`st mono ${tone(e.status)}`}>{statusText(e.status)}</span>
                      <span className={`meth ${METHOD_CLASS[e.method] ?? ""}`}>{shortMethod(e.method)}</span>
                      <span className="pth mono">{e.url}</span>
                      <span className="why">{e.binary && <span className="tag">binario</span>}</span>
                      <span className="tot mono">#{e.index + 1}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className="pane">
            <div className="resp-head">
              <div className="status-line">
                <span className="status">
                  <Icon name="contract" size={14} /> Redacción
                </span>
                <span className="metric">
                  Reglas <b className="mono">{plan?.redaction.length ?? 0}</b>
                </span>
                {preview && (
                  <span className="metric">
                    Se convierte en <b className="mono">{preview.route}</b>
                  </span>
                )}
              </div>
            </div>
            <div className="subtabs" role="tablist">
              <button type="button" className="subtab" role="tab" aria-selected={rightSub === "preview"} onClick={() => setRightSub("preview")}>
                Vista previa
              </button>
              <button type="button" className="subtab" role="tab" aria-selected={rightSub === "profile"} onClick={() => setRightSub("profile")}>
                Perfil de redacción <span className="n mono">{plan?.redaction.length ?? 0}</span>
              </button>
            </div>
            <div className="pane-body">
              {rightSub === "preview" && preview && (
                <>
                  <div className="section-label">
                    Grabado <span>crudo, solo en .mockix/ · {preview.method} {preview.url}</span>
                  </div>
                  <div className="code-block viewer">
                    <CodeEditor
                      key={`raw-${preview.url}-${preview.status}`}
                      value={`${preview.method} ${preview.url}\n${Object.entries(preview.requestHeaders).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${preview.status}\n${Object.entries(preview.responseHeaders).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${preview.rawBody === null ? "(binario)" : pretty(preview.rawBody)}`}
                      language="text"
                      readOnly
                      label="Intercambio grabado"
                      testId="rec-raw"
                    />
                  </div>
                  <div className="section-label">
                    Irá al mock <span>sin credenciales; datos sensibles como plantillas</span>
                  </div>
                  <div className="code-block viewer">
                    <CodeEditor key={`mock-${preview.url}-${preview.status}`} value={preview.mockBody} language="json" readOnly label="Cuerpo que irá al mock" testId="rec-mock" />
                  </div>
                </>
              )}
              {rightSub === "profile" && plan && (
                <>
                  <table className="kv">
                    <colgroup>
                      <col style={{ width: 80 }} />
                      <col />
                      <col style={{ width: "38%" }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Dónde</th>
                        <th>Nombres</th>
                        <th>Se sustituye por</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.redaction.map((r, i) => (
                        <tr key={i}>
                          <td className="d">{r.where === "json" ? "campo JSON" : r.where === "header" ? "cabecera" : "query"}</td>
                          <td className="mono k" title={r.match}>
                            {r.match}
                          </td>
                          <td className="mono">{r.action === "remove" ? "se quita" : `{{faker '${(r.faker ?? "").split(" ")[0]}'}}`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="note pad-top">
                    El perfil se cambia en <span className="mono">mockix.workspace.yaml</span> → <span className="mono">redaction</span> y vale para todo el workspace (también para <span className="mono">mockix convert</span>).
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
