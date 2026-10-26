import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "../Icon";
import { METHOD_CLASS, ROUTE_METHODS, shortMethod } from "../lib/format";
import { useStore } from "../state/store";
import type { ContractPreview, ImportSummary } from "@shared/ipc";

function Modal({ title, onClose, children, testId }: { title: string; onClose(): void; children: ReactNode; testId: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A new mock from an OpenAPI contract (routes, data, scenarios, chaos and the contract connected) or empty. */
function NewMockDialog({ start }: { start: "contract" | "empty" }) {
  const setDialog = useStore((s) => s.setDialog);
  const createMock = useStore((s) => s.createMock);
  const createFromContract = useStore((s) => s.createFromContract);
  const mocks = useStore((s) => s.mocks);
  const usedPorts = new Set(mocks.map((m) => m.port));
  let suggested = 3000;
  while (usedPorts.has(suggested)) suggested++;
  const [mode, setMode] = useState(start);
  const [preview, setPreview] = useState<ContractPreview | null>(null);
  const [name, setName] = useState("");
  const [port, setPort] = useState(String(suggested));
  const [prefix, setPrefix] = useState("");
  const [connect, setConnect] = useState(true);
  const [chaos, setChaos] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) && /^\d{1,5}$/.test(port) && Number(port) <= 65535 && /^(\/[^/\s?#]+)*$/.test(prefix);
  const fromContract = mode === "contract";
  const valid = fields && (!fromContract || preview !== null) && !busy;

  const pick = async () => {
    setError(null);
    const outcome = await window.mockix.contracts.pick();
    if (!outcome.ok) return setError(outcome.error.message);
    if (!outcome.value) return;
    setPreview(outcome.value);
    setName(outcome.value.name);
    setPort(String(outcome.value.port));
    setPrefix(outcome.value.prefix);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    const err = fromContract ? await createFromContract({ name, port: Number(port), prefix, contract: connect, chaos }) : await createMock(name, Number(port), prefix);
    setBusy(false);
    if (err) setError(err);
    else if (!fromContract) setDialog(null);
  };

  return (
    <Modal title="Nuevo mock" onClose={() => setDialog(null)} testId="dialog-new-mock">
      <form onSubmit={submit} className="modal-body">
        <div className="seg wide">
          <button type="button" aria-pressed={fromContract} onClick={() => setMode("contract")} data-testid="new-mock-from-contract">
            Desde un contrato OpenAPI
          </button>
          <button type="button" aria-pressed={!fromContract} onClick={() => setMode("empty")} data-testid="new-mock-empty">
            Vacío
          </button>
        </div>
        {fromContract && !preview && (
          <div className="pick-contract">
            <p className="hint">Una ruta por operación con sus respuestas, el contrato conectado, datos con CRUD, escenarios y perfiles de caos deducidos del archivo. Al final verás qué se creó.</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void pick()} data-testid="new-mock-pick">
              <Icon name="folder" size={14} /> Elegir contrato…
            </button>
          </div>
        )}
        {fromContract && preview && (
          <p className="picked" data-testid="new-mock-picked">
            <span className="mono">{preview.fileName}</span> · {preview.title} · {preview.operations} {preview.operations === 1 ? "ruta" : "rutas"}{" "}
            <button type="button" className="link-btn" onClick={() => void pick()}>
              Cambiar
            </button>
          </p>
        )}
        {(!fromContract || preview) && (
          <>
            <label className="field">
              Nombre <span className="hint">minúsculas, números y guiones; es la carpeta mocks/&lt;nombre&gt;</span>
              <input autoFocus className="mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="pagos" data-testid="new-mock-name" />
            </label>
            <div className="field-row">
              <label className="field">
                Puerto <span className="hint">0 = uno libre</span>
                <input className="mono" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" data-testid="new-mock-port" />
              </label>
              <label className="field">
                Prefijo <span className="hint">opcional</span>
                <input className="mono" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="/v1" data-testid="new-mock-prefix" />
              </label>
            </div>
          </>
        )}
        {fromContract && preview && (
          <div className="check-col">
            <label className="check-row" title={preview.connectable ? "" : "Es Swagger 2.0: la revisión de peticiones necesita OpenAPI 3"}>
              <input type="checkbox" checked={connect && preview.connectable} disabled={!preview.connectable} onChange={(e) => setConnect(e.target.checked)} data-testid="new-mock-connect" />{" "}
              {preview.connectable ? "Conectar el contrato en modo avisar" : "Conectar el contrato (no disponible: es Swagger 2.0, se necesita OpenAPI 3)"}
            </label>
            <label className="check-row">
              <input type="checkbox" checked={chaos} onChange={(e) => setChaos(e.target.checked)} data-testid="new-mock-chaos" /> Preparar perfiles de caos con sus errores (apagados)
            </label>
          </div>
        )}
        {error && <p className="why-box">{error}</p>}
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog(null)}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!valid} data-testid="new-mock-create">
            Crear mock
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteMockDialog({ mockId }: { mockId: string }) {
  const setDialog = useStore((s) => s.setDialog);
  const deleteMock = useStore((s) => s.deleteMock);
  const mock = useStore((s) => s.mocks.find((m) => m.id === mockId));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = mock?.state === "running" || mock?.state === "starting" || mock?.state === "restarting";

  const confirm = async () => {
    setBusy(true);
    const err = await deleteMock(mockId);
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <Modal title="Mover el mock a la papelera" onClose={() => setDialog(null)} testId="dialog-delete-mock">
      <div className="modal-body">
        <p>
          La carpeta <span className="mono">mocks/{mockId}</span> irá a la papelera de Windows, con sus {mock?.routes.length ?? 0} rutas, sus datos y sus archivos. Desde la
          papelera la puedes restaurar.
        </p>
        {running && <p className="hint">El mock está en marcha: se detiene primero.</p>}
        {error && <p className="why-box">{error}</p>}
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog(null)}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={confirm} disabled={busy} data-testid="delete-mock-confirm">
            Mover a la papelera
          </button>
        </div>
      </div>
    </Modal>
  );
}

function NewRouteDialog({ mockId }: { mockId: string }) {
  const setDialog = useStore((s) => s.setDialog);
  const createRoute = useStore((s) => s.createRoute);
  const mock = useStore((s) => s.mocks.find((m) => m.id === mockId));
  const [method, setMethod] = useState<string>("GET");
  const [path, setPath] = useState("/");
  const [folder, setFolder] = useState("");
  const [crud, setCrud] = useState(false);
  const [bucket, setBucket] = useState(mock?.buckets[0]?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const folders = useMemo(() => [...new Set((mock?.routes ?? []).map((r) => r.file.replace(/^routes\//, "").split("/").slice(0, -1).join("/")).filter(Boolean))], [mock]);
  const valid = (path.startsWith("/") || path.startsWith("^")) && /^[a-z0-9_/-]*$/i.test(folder) && (!crud || bucket !== "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const err = await createRoute(
      mockId,
      crud
        ? { path, crud: { bucket } }
        : {
            method,
            path,
            responses: [{ id: "ok", default: true, status: method === "POST" ? 201 : 200, body: { kind: "inline", text: "{\n  \"ok\": true\n}\n" } }],
          },
      folder,
    );
    if (err) setError(err);
    else setDialog(null);
  };

  return (
    <Modal title={`Nueva ruta en ${mockId}`} onClose={() => setDialog(null)} testId="dialog-new-route">
      <form onSubmit={submit} className="modal-body">
        <div className="seg wide">
          <button type="button" aria-pressed={!crud} onClick={() => setCrud(false)}>
            Respuestas fijas
          </button>
          <button type="button" aria-pressed={crud} onClick={() => setCrud(true)} disabled={!mock?.buckets.length} title={mock?.buckets.length ? "" : "Añade un JSON en data/ para usar CRUD"}>
            CRUD sobre un bucket
          </button>
        </div>
        <div className="field-row">
          {!crud && (
            <label className="field narrow">
              Método
              <select value={method} onChange={(e) => setMethod(e.target.value)} data-testid="new-route-method">
                {ROUTE_METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            Ruta <span className="hint">después del prefijo{mock?.prefix ? ` ${mock.prefix}` : ""}; :param, * o ^regex</span>
            <input autoFocus className="mono" value={path} onChange={(e) => setPath(e.target.value)} data-testid="new-route-path" />
          </label>
        </div>
        {crud && (
          <label className="field">
            Bucket
            <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
              {mock?.buckets.map((b) => (
                <option key={b.name}>{b.name}</option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Carpeta <span className="hint">opcional, dentro de routes/</span>
          <input className="mono" value={folder} onChange={(e) => setFolder(e.target.value)} list="mockix-folders" placeholder="productos" data-testid="new-route-folder" />
          <datalist id="mockix-folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
        {error && <pre className="why-box">{error}</pre>}
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog(null)}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!valid} data-testid="new-route-create">
            Crear ruta
          </button>
        </div>
      </form>
    </Modal>
  );
}

function QuickOpen() {
  const setDialog = useStore((s) => s.setDialog);
  const mocks = useStore((s) => s.mocks);
  const openRoute = useStore((s) => s.openRoute);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return mocks
      .flatMap((m) => m.routes.map((r) => ({ mock: m.id, route: r, text: `${m.name} ${r.method} ${r.path} ${r.id}`.toLowerCase() })))
      .filter((x) => words.every((w) => x.text.includes(w)))
      .slice(0, 50);
  }, [q, mocks]);
  const choose = (i: number) => {
    const hit = results[i];
    if (!hit) return;
    setDialog(null);
    void openRoute(hit.mock, hit.route.id);
  };
  return (
    <Modal title="Buscar rutas" onClose={() => setDialog(null)} testId="dialog-quick-open">
      <div className="modal-body">
        <input
          autoFocus
          className="mono quick-input"
          value={q}
          placeholder="método, ruta o mock"
          onChange={(e) => {
            setQ(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setIndex((i) => Math.min(results.length - 1, i + 1));
            else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
            else if (e.key === "Enter") choose(index);
          }}
          data-testid="quick-open-input"
        />
        <ul className="quick-list" ref={list}>
          {results.length === 0 && <li className="note">Nada coincide.</li>}
          {results.map((r, i) => (
            <li key={`${r.mock}/${r.route.id}`}>
              <button type="button" className="row" aria-selected={i === index} onClick={() => choose(i)}>
                <span className={`meth ${METHOD_CLASS[r.route.method] ?? ""}`}>{r.route.mode === "crud" ? "CRUD" : shortMethod(r.route.method)}</span>
                <span className="mono path">{r.route.path}</span>
                <span className="sub">{r.mock}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

const FORMAT_LABEL: Record<string, string> = { openapi: "OpenAPI", postman: "colección de Postman", har: "HAR", mockoon: "entorno de Mockoon" };

function ImportResult({ summary }: { summary: ImportSummary }) {
  const setDialog = useStore((s) => s.setDialog);
  return (
    <Modal title="Importación" onClose={() => setDialog(null)} testId="dialog-import">
      <div className="modal-body">
        <p>
          Mock <b className="mono">{summary.name}</b> creado desde {FORMAT_LABEL[summary.format] ?? summary.format}: <span className="muted">{summary.source}</span>
        </p>
        <dl className="facts compact">
          <dt>Rutas</dt>
          <dd className="mono" data-testid="import-routes">
            {summary.routes}
          </dd>
          <dt>Respuestas</dt>
          <dd className="mono">
            {summary.responses} · {summary.fromExamples} de ejemplos · {summary.generated} generadas
          </dd>
        </dl>
        {summary.extras && <ContractExtras extras={summary.extras} />}
        {summary.warnings.length > 0 && (
          <>
            <h3 className="section-label flush">Avisos</h3>
            <ul className="report-list">
              {summary.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </>
        )}
        {summary.skipped.length > 0 && (
          <>
            <h3 className="section-label flush">Omitido</h3>
            <ul className="report-list" data-testid="import-skipped">
              {summary.skipped.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </>
        )}
        <div className="modal-foot">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setDialog(null)} autoFocus>
            Listo
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** What a contract gave beyond its routes. */
function ContractExtras({ extras }: { extras: NonNullable<ImportSummary["extras"]> }) {
  return (
    <>
      <h3 className="section-label flush">Además, desde el contrato</h3>
      <ul className="report-list full" data-testid="import-extras">
        {extras.contract && (
          <li>
            Contrato conectado en modo avisar: <span className="mono">{extras.contract}</span>
          </li>
        )}
        {extras.selectable > 0 && (
          <li>
            {extras.selectable} {extras.selectable === 1 ? "respuesta de error responde" : "respuestas de error responden"} si la pides con la cabecera <span className="mono">X-Mockix-Respuesta: 404</span> (o el código que quieras) o con <span className="mono">?mockix_respuesta=404</span>
          </li>
        )}
        {extras.crud.map((c) => (
          <li key={c.bucket}>
            Datos: <span className="mono">data/{c.bucket}.json</span> con {c.items} registros y CRUD en <span className="mono">{c.path}</span>
          </li>
        ))}
        {extras.scenarios.map((s) => (
          <li key={s.id}>
            Escenario deducido <b>{s.id}</b> del campo <span className="mono">{s.field}</span>: {s.states.join(" → ")} ({s.transitions} {s.transitions === 1 ? "transición" : "transiciones"}). Revísalo en Escenarios.
          </li>
        ))}
        {extras.chaos.length > 0 && <li>Perfiles de caos listos, apagados: {extras.chaos.join(", ")}</li>}
      </ul>
      {extras.notes.length > 0 && (
        <>
          <h3 className="section-label flush">No se dedujo</h3>
          <ul className="report-list">
            {extras.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  if (!dialog) return null;
  if (dialog.kind === "new-mock") return <NewMockDialog start={dialog.start ?? "contract"} />;
  if (dialog.kind === "new-route") return <NewRouteDialog mockId={dialog.mockId} />;
  if (dialog.kind === "delete-mock") return <DeleteMockDialog mockId={dialog.mockId} />;
  if (dialog.kind === "import-result") return <ImportResult summary={dialog.summary} />;
  return <QuickOpen />;
}
