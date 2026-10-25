import { useEffect, useState } from "react";
import type { LinkRequest, UpdateState } from "@shared/ipc";
import { Icon } from "../Icon";
import { useStore } from "../state/store";

/** A mockix:// link (from Sendix) waiting for the user: nothing happens until they confirm. */
export function LinkDialog() {
  const setDialog = useStore((s) => s.setDialog);
  const setNotice = useStore((s) => s.setNotice);
  const workspace = useStore((s) => s.workspace);
  const [queue, setQueue] = useState<LinkRequest[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.mockix.links.pending().then((list) => list && setQueue(list));
    return window.mockix.links.onRequest((r) => setQueue((q) => (q.some((x) => x.id === r.id) ? q : [...q, r])));
  }, []);
  const r = queue[0];
  if (!r) return null;
  const decide = async (accept: boolean) => {
    setBusy(true);
    const outcome = await window.mockix.links.decide(r.id, accept);
    setBusy(false);
    setQueue((q) => q.slice(1));
    if (!outcome.ok) setNotice(outcome.error.message);
    else if (outcome.value) setDialog({ kind: "import-result", summary: outcome.value });
  };
  const target = r.workspace ?? workspace?.dir ?? null;
  return (
    <div className="scrim">
      <div className="modal approval" role="alertdialog" aria-modal="true" aria-label="Enlace de otra aplicación" data-testid="link-dialog">
        <div className="modal-head">
          <h3>{r.kind === "import" ? "Otra aplicación quiere crear un mock" : "Otra aplicación quiere abrir una carpeta"}</h3>
        </div>
        <div className="modal-body">
          <dl className="facts">
            {r.collection && (
              <>
                <dt>Importar</dt>
                <dd className="mono">{r.collection}</dd>
              </>
            )}
            <dt>{r.kind === "import" ? "En" : "Carpeta"}</dt>
            <dd className="mono">{target ?? "ninguna carpeta abierta"}</dd>
          </dl>
          <p className="note">Llegó por un enlace mockix:// (por ejemplo, desde Sendix). Solo se hace si lo confirmas.</p>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void decide(false)} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void decide(true)} disabled={busy || (r.kind === "import" && !target)} data-testid="link-accept" autoFocus>
            {r.kind === "import" ? "Importar" : "Abrir"}
          </button>
        </div>
      </div>
    </div>
  );
}

const UPDATE_TEXT: Record<UpdateState["status"], string> = {
  disabled: "Las versiones de desarrollo no se actualizan solas.",
  idle: "Se busca una versión nueva al arrancar.",
  checking: "Buscando una versión nueva…",
  current: "Tienes la última versión.",
  downloading: "Descargando la versión nueva…",
  ready: "La versión nueva está lista.",
  error: "No se pudo buscar.",
};

export function UpdatesSection() {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    void window.mockix.updates.get().then(setState);
    return window.mockix.updates.onChange(setState);
  }, []);
  if (!state) return null;
  return (
    <>
      <h2 className="section-label">Actualizaciones</h2>
      <div className="toolbar">
        <span className="hint" data-testid="update-status">
          {UPDATE_TEXT[state.status]}
          {state.version && state.status !== "current" ? ` (${state.version}${state.status === "downloading" && state.percent !== null ? `, ${state.percent} %` : ""})` : ""}
          {state.status === "error" && state.message ? ` ${state.message}.` : ""}
        </span>
        {state.status === "ready" ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void window.mockix.updates.install()}>
            Reiniciar y actualizar
          </button>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" disabled={state.status === "disabled" || state.status === "checking" || state.status === "downloading"} onClick={() => void window.mockix.updates.check()}>
            <Icon name="download" size={14} /> Buscar ahora
          </button>
        )}
      </div>
    </>
  );
}
