import { useEffect, useMemo, useState } from "react";
import type { GrpcCallResult, GrpcKind, MockStatus } from "@shared/ipc";
import { Icon } from "../Icon";
import { CodeEditor } from "./CodeEditor";
import { time } from "../lib/format";
import { useStore, type LiveTarget, type MessageRow } from "../state/store";

const secs = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`);
const KIND_LABEL: Record<GrpcKind, string> = { unary: "unario", server: "stream del servidor", client: "stream del cliente", bidi: "bidireccional" };
const pretty = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

function useSource(mockId: string, file: string | undefined) {
  const [source, setSource] = useState("");
  useEffect(() => {
    if (!file) return;
    let alive = true;
    void window.mockix.live.source(mockId, file).then((o) => alive && setSource(o.ok ? o.value : ""));
    return () => {
      alive = false;
    };
  }, [mockId, file]);
  return source;
}

function MessageList({ rows, empty }: { rows: MessageRow[]; empty: string }) {
  return (
    <ul className="log" data-testid="live-messages">
      {rows.slice(0, 200).map((m) => (
        <li key={m.key} className={`lg msg ${m.kind}`}>
          <span className="time mono">{time(m.at)}</span>
          <span className="mono d">{m.connection}</span>
          <span className="dir mono" aria-label={m.kind}>
            {m.kind === "in" ? "←" : m.kind === "out" ? "→" : m.kind === "connect" ? "●" : m.kind === "disconnect" ? "○" : "⇄"}
          </span>
          <span className="pth mono" title={m.data}>
            {m.event && <b>{m.event} </b>}
            {m.kind === "connect" ? "conectado" : m.kind === "disconnect" ? "desconectado" : m.data}
          </span>
          <span className="why">
            {m.status && <span className={`tag${m.status === "OK" ? "" : " err"}`}>{m.status}</span>}
            {m.matched && <span className="mono d">{m.matched}</span>}
            {m.durationMs !== null && <span className="mono d">{m.durationMs} ms</span>}
          </span>
        </li>
      ))}
      {rows.length === 0 && <li className="note">{empty}</li>}
    </ul>
  );
}

function StartHint({ mock }: { mock: MockStatus }) {
  const toggleMock = useStore((s) => s.toggleMock);
  return (
    <div className="empty">
      <span>El mock está detenido.</span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void toggleMock(mock.id)}>
        <Icon name="play" size={12} /> Iniciar {mock.name}
      </button>
    </div>
  );
}

function RealtimePanel({ mock, id }: { mock: MockStatus; id: string }) {
  const route = mock.realtime.find((r) => r.id === id)!;
  const all = useStore((s) => s.messages);
  const setNotice = useStore((s) => s.setNotice);
  const [left, setLeft] = useState<"definition" | "yaml">("definition");
  const [connected, setConnected] = useState(false);
  const [text, setText] = useState(route.protocol === "ws" ? '{ "tipo": "ping" }' : "{}");
  const [event, setEvent] = useState(route.messages.find((m) => m.event)?.event ?? "");
  const [ack, setAck] = useState<string | null>(null);
  const source = useSource(mock.id, route.file);
  const running = mock.state === "running";
  const rows = useMemo(() => all.filter((m) => m.mockId === mock.id && m.routeId === id), [all, mock.id, id]);
  useEffect(() => {
    if (!running) setConnected(false);
  }, [running]);
  useEffect(() => () => void window.mockix.live.disconnect(mock.id, id), [mock.id, id]);

  const host = mock.url ?? `http://${mock.host}:${mock.port}`;
  const url = route.protocol === "ws" ? `${host.replace(/^http/, "ws")}${mock.prefix}${route.path}` : `${host}${route.path === "/" ? "" : route.path}`;
  const connect = async () => {
    if (connected) {
      await window.mockix.live.disconnect(mock.id, id);
      setConnected(false);
      return;
    }
    const outcome = await window.mockix.live.connect(mock.id, id);
    if (!outcome.ok) setNotice(outcome.error.message);
    else setConnected(true);
  };
  const send = async () => {
    const outcome = await window.mockix.live.send(mock.id, id, text, route.protocol === "socketio" ? event : null);
    if (!outcome.ok) setNotice(outcome.error.message);
    else setAck(route.protocol === "socketio" ? (outcome.value.ack === null ? "sin ack" : JSON.stringify(outcome.value.ack)) : null);
  };

  return (
    <>
      <div className="reqline">
        <div className="urlbox">
          <span className="lbl">
            {route.protocol === "ws" ? "WebSocket" : "Socket.IO"}
            <b>{route.path}</b>
          </span>
          <div className="url">
            <span className="host mono" data-testid="live-url">
              {url}
            </span>
          </div>
          <div className="tail">{route.protocol === "socketio" ? "path /socket.io" : route.file}</div>
        </div>
        <button type="button" className="btn btn-secondary" onClick={connect} disabled={!running} data-testid="live-connect">
          <Icon name={connected ? "stop" : "play"} size={14} /> {connected ? "Desconectar" : "Conectar"}
        </button>
      </div>
      <div className="split">
        <div className="pane">
          <div className="subtabs" role="tablist">
            <button type="button" className="subtab" role="tab" aria-selected={left === "definition"} onClick={() => setLeft("definition")}>
              Definición
            </button>
            <button type="button" className="subtab" role="tab" aria-selected={left === "yaml"} onClick={() => setLeft("yaml")}>
              YAML
            </button>
          </div>
          <div className="pane-body">
            {left === "yaml" ? (
              <div className="code-block viewer">
                <CodeEditor key={`src-${route.file}-${source.length}`} value={source} language="text" readOnly label="Definición de la ruta" testId="live-yaml" />
              </div>
            ) : (
              <>
                {route.description && <p className="note pad-top">{route.description}</p>}
                <div className="section-label">
                  Al conectar <span>lo que el servidor envía solo</span>
                </div>
                {route.onConnect.length === 0 ? (
                  <p className="note">Nada.</p>
                ) : (
                  <table className="kv" data-testid="live-onconnect">
                    <colgroup>
                      <col style={{ width: "28%" }} />
                      <col />
                      <col style={{ width: 80 }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Cuándo</th>
                        <th>{route.protocol === "ws" ? "Mensaje" : "Evento y datos"}</th>
                        <th>A quién</th>
                      </tr>
                    </thead>
                    <tbody>
                      {route.onConnect.map((s, i) => (
                        <tr key={i}>
                          <td className="ui">
                            {s.everyMs !== null ? `cada ${secs(s.everyMs)}${s.times ? ` (${s.times} veces)` : ""}` : s.afterMs ? `a los ${secs(s.afterMs)}` : "al conectar"}
                          </td>
                          <td className="mono" title={s.what}>
                            {s.what}
                          </td>
                          <td className="d">{s.to === "self" ? "al cliente" : s.to === "all" ? "a todos" : s.to === "others" ? "a los demás" : s.to}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="section-label">
                  {route.protocol === "ws" ? "Mensajes" : "Eventos"} <span>se responde la primera cuyas reglas se cumplen</span>
                </div>
                {route.messages.length === 0 ? (
                  <p className="note">{route.echo ? "Sin reglas: devuelve cada mensaje (eco)." : "Sin respuestas."}</p>
                ) : (
                  <table className="kv" data-testid="live-rules">
                    <colgroup>
                      <col style={{ width: "18%" }} />
                      {route.protocol === "socketio" && <col style={{ width: "16%" }} />}
                      <col style={{ width: "30%" }} />
                      <col />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Id</th>
                        {route.protocol === "socketio" && <th>Evento</th>}
                        <th>Cuándo</th>
                        <th>Qué hace</th>
                      </tr>
                    </thead>
                    <tbody>
                      {route.messages.map((m) => (
                        <tr key={m.id}>
                          <td className="mono">{m.id}</td>
                          {route.protocol === "socketio" && <td className="mono k">{m.event}</td>}
                          <td className="cond wrap" title={m.when}>
                            {m.when}
                          </td>
                          <td className="mono d wrap" title={m.does}>
                            {m.does}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {route.protocol === "ws" && route.echo && route.messages.length > 0 && <p className="note pad-top">Lo que no coincide con ninguna regla vuelve tal cual (eco).</p>}
              </>
            )}
          </div>
        </div>
        <div className="pane">
          <div className="subtabs" role="tablist">
            <button type="button" className="subtab" role="tab" aria-selected>
              Mensajes <span className="n mono">{rows.length}</span>
            </button>
          </div>
          <div className="pane-body">
            {!running && <StartHint mock={mock} />}
            <form
              className="send-box"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              {route.protocol === "socketio" && (
                <label className="field-inline">
                  Evento
                  <input className="mini-select mono" value={event} onChange={(e) => setEvent(e.target.value)} list={`events-${id}`} aria-label="Evento" data-testid="live-event" />
                  <datalist id={`events-${id}`}>
                    {[...new Set(route.messages.map((m) => m.event).filter(Boolean))].map((ev) => (
                      <option key={ev!} value={ev!} />
                    ))}
                  </datalist>
                </label>
              )}
              <textarea className="mono" value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Mensaje" data-testid="live-text" />
              <div className="send-foot">
                {ack !== null && (
                  <span className="mono d" data-testid="live-ack">
                    ack: {ack}
                  </span>
                )}
                <button type="submit" className="btn btn-primary btn-sm" disabled={!connected} data-testid="live-send">
                  Enviar
                </button>
              </div>
            </form>
            <MessageList rows={rows} empty={running ? "Conecta para probar, o conecta tu cliente a la URL de arriba." : "Sin mensajes."} />
          </div>
        </div>
      </div>
    </>
  );
}

function GrpcPanel({ mock, service }: { mock: MockStatus; service: string }) {
  const svc = mock.grpc?.services.find((s) => s.service === service);
  const all = useStore((s) => s.messages);
  const setNotice = useStore((s) => s.setNotice);
  const [method, setMethod] = useState(svc?.methods[0]?.name ?? "");
  const [left, setLeft] = useState<"methods" | "yaml">("methods");
  const [text, setText] = useState("{}");
  const [result, setResult] = useState<GrpcCallResult | null>(null);
  const [busy, setBusy] = useState(false);
  const source = useSource(mock.id, svc?.file);
  const running = mock.state === "running";
  const rows = useMemo(() => all.filter((m) => m.mockId === mock.id && m.protocol === "grpc" && m.routeId.startsWith(`${service}/`)), [all, mock.id, service]);

  useEffect(() => {
    if (!method) return;
    let alive = true;
    void window.mockix.live.grpcExample(mock.id, service, method).then((o) => alive && o.ok && setText(o.value));
    setResult(null);
    return () => {
      alive = false;
    };
  }, [mock.id, service, method]);

  if (!svc || !mock.grpc) return null;
  const current = svc.methods.find((m) => m.name === method);
  const address = `${mock.host}:${mock.grpcPort ?? (mock.grpc.port || "puerto libre")}`;
  const call = async () => {
    setBusy(true);
    const outcome = await window.mockix.live.grpcCall(mock.id, service, method, text);
    setBusy(false);
    if (!outcome.ok) setNotice(outcome.error.message);
    else setResult(outcome.value);
  };

  return (
    <>
      <div className="reqline">
        <div className="urlbox">
          <span className="lbl">
            gRPC<b>{service}</b>
          </span>
          <div className="url">
            <span className="host mono" data-testid="grpc-address">
              {address}
            </span>
          </div>
          <div className="tail">
            {svc.proto}
            {mock.grpc.tls ? " · TLS" : ""}
            {mock.grpc.reflection ? " · reflection" : ""}
          </div>
        </div>
      </div>
      <div className="split">
        <div className="pane">
          <div className="subtabs" role="tablist">
            <button type="button" className="subtab" role="tab" aria-selected={left === "methods"} onClick={() => setLeft("methods")}>
              Métodos <span className="n mono">{svc.methods.length}</span>
            </button>
            <button type="button" className="subtab" role="tab" aria-selected={left === "yaml"} onClick={() => setLeft("yaml")}>
              YAML
            </button>
          </div>
          <div className="pane-body">
            {left === "yaml" ? (
              <div className="code-block viewer">
                <CodeEditor key={`src-${svc.file}-${source.length}`} value={source} language="text" readOnly label="Definición del servicio" testId="grpc-yaml" />
              </div>
            ) : (
              <>
                <table className="kv" data-testid="grpc-methods">
                  <colgroup>
                    <col style={{ width: "28%" }} />
                    <col style={{ width: "24%" }} />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Método</th>
                      <th>Tipo</th>
                      <th>Respuestas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {svc.methods.map((m) => (
                      <tr key={m.name} className={`clickable${m.name === method ? " sel" : ""}`} onClick={() => setMethod(m.name)} data-testid={`grpc-method-${m.name}`}>
                        <td className="mono">{m.name}</td>
                        <td className="d">{KIND_LABEL[m.kind]}</td>
                        <td className="mono" title={`${m.requestType} → ${m.responseType}`}>
                          {m.responses.length ? m.responses.join(", ") : <span className="d">ejemplo generado del esquema</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {current && (
                  <p className="note pad-top">
                    <span className="mono">
                      {current.requestType} → {current.responseType}
                    </span>
                    . Las reglas leen el mensaje con <span className="mono">body.campo</span> y los metadatos con <span className="mono">header.nombre</span>; en un stream del cliente, <span className="mono">body.count</span> y{" "}
                    <span className="mono">body.messages</span>.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
        <div className="pane">
          <div className="subtabs" role="tablist">
            <button type="button" className="subtab" role="tab" aria-selected>
              Probar <span className="n mono">{method}</span>
            </button>
          </div>
          <div className="pane-body">
            {!running && <StartHint mock={mock} />}
            <form
              className="send-box"
              onSubmit={(e) => {
                e.preventDefault();
                void call();
              }}
            >
              <textarea className="mono" value={text} onChange={(e) => setText(e.target.value)} rows={6} aria-label="Mensaje de la petición" data-testid="grpc-request" />
              <div className="send-foot">
                {result && (
                  <span className="status-line">
                    <span className={`tag${result.status === "OK" ? "" : " err"}`} data-testid="grpc-status">
                      {result.status}
                    </span>
                    <span className="mono d">{result.durationMs} ms</span>
                    {result.details && result.status !== "OK" && <span className="d">{result.details}</span>}
                  </span>
                )}
                <button type="submit" className="btn btn-primary btn-sm" disabled={!running || busy || !method} data-testid="grpc-call">
                  Llamar
                </button>
              </div>
            </form>
            {result && result.messages.length > 0 && (
              <div className="code-block viewer">
                <CodeEditor
                  key={`res-${result.durationMs}-${result.messages.length}`}
                  value={pretty(JSON.stringify(result.messages.length === 1 ? result.messages[0] : result.messages))}
                  language="json"
                  readOnly
                  label="Respuesta"
                  testId="grpc-response"
                />
              </div>
            )}
            {result && Object.keys(result.trailers).length > 0 && (
              <p className="note pad-top mono">
                trailers: {Object.entries(result.trailers).map(([k, v]) => `${k}=${v}`).join(", ")}
              </p>
            )}
            <div className="section-label">
              Llamadas <span>de cualquier cliente</span>
            </div>
            <MessageList rows={rows} empty="Sin llamadas todavía." />
          </div>
        </div>
      </div>
    </>
  );
}

export function LivePanel({ mock, target }: { mock: MockStatus; target: LiveTarget }) {
  if (target.kind === "realtime") {
    if (!mock.realtime.some((r) => r.id === target.id)) return <p className="note pad-top">Esta ruta ya no existe.</p>;
    return <RealtimePanel mock={mock} id={target.id} />;
  }
  if (!mock.grpc?.services.some((s) => s.service === target.id)) return <p className="note pad-top">Este servicio ya no existe.</p>;
  return <GrpcPanel mock={mock} service={target.id} />;
}
