import { useEffect, useMemo, useState } from "react";
import type { CapturedMessage, MockStatus, RequestLog } from "@shared/ipc";
import { Icon } from "../Icon";
import { CodeEditor } from "./CodeEditor";
import { METHOD_CLASS, bytes, chaosText, curlFor, ms, responseSize, shortMethod, statusText, time, tone } from "../lib/format";
import { useStore, type CallbackRow, type LogRow } from "../state/store";

const PHASES = [
  ["receiveMs", "Recepción"],
  ["processMs", "Proceso"],
  ["latencyMs", "Latencia"],
  ["chaosMs", "Caos"],
  ["sendMs", "Envío"],
] as const;

/** The signature: where the time went, as stacked stone layers. Stones mean sequence, never status. */
export function Strata({ row }: { row: RequestLog }) {
  const parts = PHASES.map(([key, label], i) => ({ label, value: row.timings[key], layer: i + 1 }));
  const shown = parts.filter((p) => p.value > 0.05);
  const simulated = row.timings.latencyMs + row.timings.chaosMs;
  const total = row.durationMs;
  return (
    <div className="strata" data-testid="strata">
      <div className="strata-bar" role="img" aria-label={`Desglose de tiempos: ${shown.map((p) => `${p.label} ${ms(p.value)}`).join(", ")}`}>
        {shown.map((p) => (
          <i key={p.label} className={`s${p.layer}`} style={{ flex: Math.max(p.value, total / 200) }} title={`${p.label} ${ms(p.value)}`} />
        ))}
      </div>
      <div className="strata-legend">
        {shown.map((p) => (
          <span key={p.label} className={`s${p.layer} legend`}>
            {p.label} <b>{ms(p.value)}</b>
          </span>
        ))}
        <span className="note">
          {simulated > 0 ? `simulado ${ms(simulated)} · ` : ""}total <b>{ms(total)}</b>
        </span>
      </div>
    </div>
  );
}

function Captured({ title, message }: { title: string; message: CapturedMessage }) {
  const headers = Object.entries(message.headers);
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(message.body), null, 2);
    } catch {
      return message.body;
    }
  }, [message.body]);
  return (
    <>
      <div className="section-label">
        Cabeceras <span>{title}</span>
      </div>
      <table className="kv">
        <colgroup>
          <col style={{ width: "36%" }} />
          <col />
        </colgroup>
        <tbody>
          {headers.length === 0 && (
            <tr>
              <td colSpan={2} className="muted">
                Sin cabeceras.
              </td>
            </tr>
          )}
          {headers.map(([k, v]) => (
            <tr key={k}>
              <td className="mono k">{k}</td>
              <td className={v === "[redactado]" ? "mono muted" : "mono"}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section-label">
        Cuerpo <span>{message.binary ? "binario, no se muestra" : message.truncated ? "recortado a 64 KB" : message.body ? "" : "vacío"}</span>
      </div>
      {!message.binary && message.body && (
        <div className="code-block viewer">
          <CodeEditor value={pretty} language="json" readOnly label={`Cuerpo de ${title}`} lineNumbers />
        </div>
      )}
    </>
  );
}

type Sub = "log" | "request" | "response";

export function LogPane({ mock }: { mock: MockStatus }) {
  const log = useStore((s) => s.log);
  const callbacks = useStore((s) => s.callbacks);
  const selectedLog = useStore((s) => s.selectedLog);
  const selectLog = useStore((s) => s.selectLog);
  const loadLog = useStore((s) => s.loadLog);
  const clearLog = useStore((s) => s.clearLog);
  const createRoute = useStore((s) => s.createRoute);
  const setNotice = useStore((s) => s.setNotice);
  const workspaceDir = useStore((s) => s.workspace?.dir);
  const [sub, setSub] = useState<Sub>("log");
  const [onlyErrors, setOnlyErrors] = useState(false);

  useEffect(() => {
    void loadLog(mock.id);
  }, [mock.id, workspaceDir, loadLog]);

  const rows = useMemo(() => log.filter((r) => r.mockId === mock.id), [log, mock.id]);
  const visible = useMemo(() => (onlyErrors ? rows.filter((r) => r.status >= 400 || r.error) : rows), [rows, onlyErrors]);
  const items = useMemo(() => {
    const cbs = onlyErrors ? [] : callbacks.filter((c) => c.mockId === mock.id);
    return [...visible.map((r) => ({ type: "request" as const, at: r.at, row: r })), ...cbs.map((c) => ({ type: "callback" as const, at: c.at, row: c }))].sort((a, b) => b.at - a.at);
  }, [visible, callbacks, mock.id, onlyErrors]);
  const current: LogRow | null = (selectedLog === "latest" || !selectedLog ? rows[0] : rows.find((r) => r.key === selectedLog)) ?? null;

  const fromLog = async (row: LogRow) => {
    const path = new URL(row.url, "http://x").pathname;
    const local = mock.prefix && path.startsWith(mock.prefix) ? path.slice(mock.prefix.length) || "/" : path;
    const contentType = row.response.headers["content-type"];
    const error = await createRoute(
      mock.id,
      {
        method: row.method === "HEAD" ? "GET" : row.method,
        path: local,
        responses: [
          {
            id: "ok",
            default: true,
            status: row.status,
            ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
            body: row.response.binary ? { kind: "none" } : { kind: "inline", text: row.response.body },
            template: false,
          },
        ],
      },
      "desde-log",
    );
    if (error) setNotice(`No se pudo crear la ruta: ${error}`);
  };

  const copyCurl = async (row: LogRow) => {
    const url = `${mock.url ?? `http://${mock.host}:${mock.port}`}${row.url}`;
    await window.mockix.app.copy(curlFor(row.method, url, row.request.headers, row.request.body));
    setNotice("cURL copiado al portapapeles.");
  };

  return (
    <div className="pane log-pane">
      {current ? (
        <div className="resp-head" data-testid="log-head">
          <div className="status-line">
            <span className={`status ${tone(current.status)}`}>
              <span className="code-n mono">{current.status}</span>
              {statusText(current.status).replace(/^\d+\s*/, "")}
            </span>
            <span className="metric">
              {current.kind === "proxy" ? "API real" : current.kind === "crud" ? "CRUD" : "Respuesta"} <b>{current.responseId ?? (current.kind === "none" ? "sin ruta" : current.routeId ?? "—")}</b>
            </span>
            <span className="metric">
              Tiempo <b className="mono">{ms(current.durationMs)}</b>
            </span>
            <span className="metric">
              Tamaño <b className="mono">{bytes(responseSize(current))}</b>
            </span>
            <span className="end">
              <button type="button" className="icon-btn" title="Crear ruta desde este registro" aria-label="Crear ruta desde este registro" onClick={() => fromLog(current)} data-testid="route-from-log">
                <Icon name="plus" size={14} />
              </button>
              <button type="button" className="icon-btn" title="Copiar como cURL" aria-label="Copiar como cURL" onClick={() => copyCurl(current)}>
                <Icon name="copy" size={14} />
              </button>
            </span>
          </div>
          <Strata row={current} />
          {current.error && <p className="why-box">{current.error}</p>}
        </div>
      ) : (
        <div className="resp-head empty-head">
          <p className="note">{mock.state === "running" ? `Esperando peticiones en ${mock.url}${mock.prefix}` : "Inicia el mock y prueba una ruta: aquí verás cada petición con su desglose de tiempos."}</p>
        </div>
      )}
      <div className="subtabs" role="tablist">
        <button type="button" className="subtab" role="tab" aria-selected={sub === "log"} onClick={() => setSub("log")}>
          Log en vivo <span className="n mono">{rows.length}</span>
        </button>
        <button type="button" className="subtab" role="tab" aria-selected={sub === "request"} onClick={() => setSub("request")} disabled={!current} data-testid="log-sub-request">
          Petición
        </button>
        <button type="button" className="subtab" role="tab" aria-selected={sub === "response"} onClick={() => setSub("response")} disabled={!current} data-testid="log-sub-response">
          Respuesta
        </button>
        <span className="end">
          <span className="seg">
            <button type="button" aria-pressed={!onlyErrors} onClick={() => setOnlyErrors(false)}>
              Todos
            </button>
            <button type="button" aria-pressed={onlyErrors} onClick={() => setOnlyErrors(true)}>
              Errores
            </button>
          </span>
          <button type="button" className="link-btn" onClick={() => clearLog(mock.id)} disabled={items.length === 0} data-testid="clear-log">
            Vaciar
          </button>
        </span>
      </div>
      <div className="pane-body">
        {sub === "request" && current && <Captured title={`${current.method} ${current.url}`} message={current.request} />}
        {sub === "response" && current && <Captured title={statusText(current.status)} message={current.response} />}
        {sub === "log" && (
          <ul className="log" data-testid="live-log">
            {items.length === 0 && <li className="note">El log muestra cada petición que reciba el mock y se guarda entre sesiones.</li>}
            {items.map((item) =>
              item.type === "request" ? (
                <RequestRow key={item.row.key} row={item.row} selected={item.row.key === current?.key} onSelect={() => selectLog(item.row.key)} />
              ) : (
                <CallbackRowView key={item.row.key} row={item.row} />
              ),
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function RequestRow({ row, selected, onSelect }: { row: LogRow; selected: boolean; onSelect(): void }) {
  return (
    <li className="lg" aria-selected={selected} onClick={onSelect} data-testid="log-row" title={row.error ?? undefined}>
      <span className="time mono">{time(row.at)}</span>
      <span className={`st mono ${tone(row.status)}`}>{statusText(row.status)}</span>
      <span className={`meth ${METHOD_CLASS[row.method] ?? ""}`}>{shortMethod(row.method)}</span>
      <span className="pth mono">{row.url}</span>
      <span className="why">
        {row.responseId && <span>{row.responseId}</span>}
        {row.chaos && chaosText(row.chaos) && (
          <span className={`tag chaos${row.chaos.error !== null || row.chaos.drop || row.chaos.timeout ? " err" : ""}`} title={`Perfil de caos ${row.chaos.profile} en t = ${Math.round(row.chaos.tMs / 100) / 10} s`} data-testid="log-chaos">
            caos: {chaosText(row.chaos)}
          </span>
        )}
        {row.error && row.chaos && (row.chaos.drop || row.chaos.timeout) ? null : row.error ? (
          <span className="tag err">{row.kind === "proxy" ? "error de proxy" : "error de plantilla"}</span>
        ) : row.kind === "crud" ? (
          <span className="tag">CRUD</span>
        ) : row.kind === "proxy" ? (
          <span className="tag">API real</span>
        ) : row.kind === "none" ? (
          <span className="tag">sin ruta</span>
        ) : row.kind === "preflight" ? (
          <span className="tag">preflight</span>
        ) : row.latencyMs > 0 ? (
          <span className="tag">+{row.latencyMs} ms</span>
        ) : null}
      </span>
      <span className="tot mono">{ms(row.durationMs)}</span>
    </li>
  );
}

function CallbackRowView({ row }: { row: CallbackRow }) {
  return (
    <li className="lg cb" data-testid="callback-row" title={row.error ?? undefined}>
      <span className="time mono">{time(row.at)}</span>
      <span className={`st mono ${row.error ? "err" : tone(row.status ?? 0)}`}>{row.error ? "error" : statusText(row.status ?? 0)}</span>
      <span className="cb-arrow" aria-label="Callback enviado">
        ↪
      </span>
      <span className="pth mono">
        {row.method} {row.url}
      </span>
      <span className="why">
        <span className={row.error ? "tag err" : "tag"}>callback</span>
      </span>
      <span className="tot mono">{ms(row.durationMs)}</span>
    </li>
  );
}
