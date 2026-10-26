import { useEffect, useMemo, useState } from "react";
import type { BodyDraft, MockStatus, ResponseDraft, RuleDraft } from "@shared/ipc";
import { Icon } from "../Icon";
import { CodeEditor } from "./CodeEditor";
import { LogPane } from "./LogPane";
import { COMMON_STATUSES, METHOD_CLASS, MODE_LABEL, ROUTE_METHODS, pathPieces, phrase, samplePath, shortMethod, tone } from "../lib/format";
import { tabKey, useStore, type Draft } from "../state/store";

const RULE_OPS = ["equals", "regex", "exists", "empty", "null", "contains", "in", "gt", "gte", "lt", "lte"] as const;
const OP_LABEL: Record<string, string> = { equals: "=", regex: "~", exists: "existe", empty: "vacío", null: "es null", contains: "contiene", in: "en", gt: ">", gte: "≥", lt: "<", lte: "≤" };
const NO_VALUE = new Set(["exists", "empty", "null"]);

const bodyText = (b: BodyDraft): string =>
  b.kind === "inline" ? b.text : b.kind === "json" ? JSON.stringify(b.value, null, 2) : b.kind === "file" ? (b.text ?? "") : "";

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  const k = Object.keys(headers ?? {}).find((h) => h.toLowerCase() === name.toLowerCase());
  return k ? headers![k] : undefined;
}

function setHeader(headers: Record<string, string> | undefined, name: string, value: string | null): Record<string, string> {
  const out = Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => k.toLowerCase() !== name.toLowerCase()));
  if (value) out[name] = value;
  return out;
}

/** Value typed in a rule cell: numbers, booleans and JSON lists keep their type. */
function parseValue(text: string, op: string): unknown {
  const t = text.trim();
  if (op === "in") {
    try {
      const v = JSON.parse(t.startsWith("[") ? t : `[${t}]`);
      if (Array.isArray(v)) return v;
    } catch {
      return t.split(",").map((x) => x.trim()).filter(Boolean);
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(t) && ["gt", "gte", "lt", "lte", "equals"].includes(op)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  return text;
}
const showValue = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

function conditionText(r: ResponseDraft): string | null {
  if (!r.rules?.when.length) return null;
  const join = r.rules.mode === "any" ? " o " : " y ";
  return r.rules.when.map((w) => `${w.negate ? "no " : ""}${w.target} ${OP_LABEL[w.op] ?? w.op}${NO_VALUE.has(w.op) ? "" : ` ${showValue(w.value)}`}`).join(join);
}

export function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.activeTab);
  const drafts = useStore((s) => s.drafts);
  const activate = useStore((s) => s.activate);
  const closeTab = useStore((s) => s.closeTab);
  const setDialog = useStore((s) => s.setDialog);
  const selected = useStore((s) => s.selectedMock);
  return (
    <div className="tabs" role="tablist" aria-label="Rutas abiertas">
      {tabs.map((t) => {
        const key = tabKey(t);
        const d = drafts[key];
        const method = d?.draft.crud ? "CRUD" : (d?.draft.method ?? "GET");
        return (
          <div key={key} className="tab" role="tab" aria-selected={key === active} onClick={() => activate(key)} title={`${t.mockId} · ${t.routeId}`} data-testid="tab">
            <span className={`meth ${method === "CRUD" ? "m-crud" : (METHOD_CLASS[method] ?? "")}`}>{shortMethod(method)}</span>
            <span className="name">{d?.draft.path ?? t.routeId}</span>
            {d?.dirty ? (
              <>
                <span className="unsaved" title="Cambios sin guardar" />
                <span className="sr-only">sin guardar</span>
              </>
            ) : (
              <button
                type="button"
                className="x"
                aria-label={`Cerrar ${t.routeId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(key);
                }}
              >
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
        );
      })}
      <button type="button" className="tab-new" title="Nueva ruta" aria-label="Nueva ruta" disabled={!selected} onClick={() => selected && setDialog({ kind: "new-route", mockId: selected })}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

/** Path input with a mirror behind it, so :params keep their amber chip while typing. */
function PathInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <span className="path-input">
      <span className="mirror mono" aria-hidden="true">
        {pathPieces(value).map((p, i) =>
          p.param ? (
            <span key={i} className="p">
              {p.text}
            </span>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </span>
      <input className="mono" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} aria-label="Ruta" data-testid="route-path" />
    </span>
  );
}

function RouteLine({ mock, tab, d }: { mock: MockStatus; tab: string; d: Draft }) {
  const updateDraft = useStore((s) => s.updateDraft);
  const save = useStore((s) => s.save);
  const send = useStore((s) => s.send);
  const [sendix, setSendix] = useState(false);
  useEffect(() => {
    void window.mockix.sendix.available().then(setSendix);
  }, []);
  const r = d.draft;
  const live = mock.state === "running";
  const sample = samplePath(r.path);
  const method = r.crud ? "GET" : r.method === "ANY" || !r.method ? "GET" : r.method;
  const response = r.responses?.[d.response];
  const sendBody = ["POST", "PUT", "PATCH"].includes(method) ? (response?.body.kind === "json" || response?.body.kind === "inline" ? "{}" : "{}") : undefined;
  const base = mock.url ? `${mock.url.replace(/^https?:\/\//, "")}${mock.prefix}` : `${mock.host}:${mock.port}${mock.prefix}`;

  return (
    <div className="reqline">
      <div className="urlbox">
        {r.crud ? (
          <span className="method-select m-crud mono">CRUD</span>
        ) : (
          <label className={`method-select mono ${METHOD_CLASS[r.method ?? "GET"] ?? ""}`}>
            <select value={r.method ?? "GET"} onChange={(e) => updateDraft(tab, (x) => ({ ...x, method: e.target.value }))} aria-label="Método" data-testid="route-method">
              {ROUTE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <Icon name="down" size={14} />
          </label>
        )}
        <span className="url">
          <span className="host mono">{base}</span>
          <PathInput value={r.path} onChange={(path) => updateDraft(tab, (x) => ({ ...x, path }))} />
        </span>
        <span className="tail mono" title={d.doc.file}>
          {d.doc.file}
        </span>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!live || sample === null || d.dirty}
        title={!live ? "Inicia el mock para probar" : d.dirty ? "Guarda los cambios para probarlos" : sample === null ? "Las rutas con expresión regular se prueban desde un cliente" : `${method} ${mock.prefix}${sample}`}
        onClick={() => sample !== null && send(mock.id, method, sample, sendBody)}
        data-testid="route-test"
      >
        Probar <kbd>Ctrl ↵</kbd>
      </button>
      {sendix && (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!live || sample === null || d.dirty || !mock.url}
          title="Abrir esta petición en Sendix"
          onClick={() => sample !== null && mock.url && void window.mockix.sendix.open({ method, url: `${mock.url}${mock.prefix}${sample}`, ...(sendBody ? { body: sendBody } : {}) })}
          data-testid="route-sendix"
        >
          Sendix
        </button>
      )}
      {d.dirty && (
        <button type="button" className="btn btn-secondary" onClick={() => save(tab)} disabled={d.saving} data-testid="route-save">
          <Icon name="save" size={14} /> Guardar
        </button>
      )}
    </div>
  );
}

function Chips({ tab, d }: { tab: string; d: Draft }) {
  const updateDraft = useStore((s) => s.updateDraft);
  const selectResponse = useStore((s) => s.selectResponse);
  const responses = d.draft.responses ?? [];
  const add = (copy: boolean) => {
    const base = copy ? structuredClone(responses[d.response]!) : ({ id: "respuesta", status: 200, body: { kind: "inline", text: "{}" } } satisfies ResponseDraft);
    let id = copy ? `${base.id}-copia` : base.id;
    for (let n = 2; responses.some((r) => r.id === id); n++) id = `${copy ? `${base.id}-copia` : base.id}-${n}`;
    const next: ResponseDraft = { ...base, id, default: false };
    if (next.body.kind === "file") next.body = { kind: "inline", text: next.body.text ?? "" };
    updateDraft(tab, (x) => ({ ...x, responses: [...(x.responses ?? []), next] }));
    selectResponse(tab, responses.length);
  };
  const remove = () => {
    if (responses.length < 2) return;
    updateDraft(tab, (x) => {
      const list = (x.responses ?? []).filter((_, i) => i !== d.response);
      if (!list.some((r) => r.default) && list[0]) list[0].default = true;
      return { ...x, responses: list };
    });
    selectResponse(tab, Math.max(0, d.response - 1));
  };
  return (
    <div className="chips" role="group" aria-label="Respuestas de la ruta">
      {responses.map((r, i) => (
        <button key={i} type="button" className="chip" aria-pressed={i === d.response} onClick={() => selectResponse(tab, i)} data-testid={`response-chip-${r.id}`}>
          {r.default && <Icon name="flag" size={14} className="flag" label="Por defecto" />}
          <span className={`c mono ${tone(r.status ?? 200)}`}>{r.status ?? 200}</span>
          {r.id}
        </button>
      ))}
      <button type="button" className="icon-btn" title="Añadir respuesta" aria-label="Añadir respuesta" onClick={() => add(false)} data-testid="add-response">
        <Icon name="plus" size={16} />
      </button>
      <span className="end">
        <button type="button" className="link-btn" onClick={() => add(true)}>
          Duplicar
        </button>
        <button type="button" className="link-btn" onClick={remove} disabled={responses.length < 2}>
          Quitar
        </button>
      </span>
    </div>
  );
}

function BodyPanel({ mock, tab, d, response }: { mock: MockStatus; tab: string; d: Draft; response: ResponseDraft }) {
  const updateDraft = useStore((s) => s.updateDraft);
  const save = useStore((s) => s.save);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [preview, setPreview] = useState<{ text: string; error: boolean } | null>(null);
  const text = bodyText(response.body);
  const patch = (fn: (r: ResponseDraft) => ResponseDraft) =>
    updateDraft(tab, (x) => ({ ...x, responses: (x.responses ?? []).map((r, i) => (i === d.response ? fn(r) : r)) }));
  const contentType = headerValue(response.headers, "Content-Type") ?? "";
  const status = response.status ?? 200;

  useEffect(() => {
    if (mode !== "preview") return;
    let alive = true;
    void window.mockix.routes.preview(mock.id, d.draft.method ?? "GET", d.draft.path, text).then((o) => {
      if (alive) setPreview(o.ok ? { text: o.value.text, error: false } : { text: o.error.message, error: true });
    });
    return () => {
      alive = false;
    };
  }, [mode, text, mock.id, d.draft.method, d.draft.path]);

  const setText = (value: string) =>
    patch((r) => {
      if (r.body.kind === "file") return { ...r, body: { ...r.body, text: value } };
      return { ...r, body: { kind: "inline", text: value } };
    });

  return (
    <>
      <div className="form-row">
        <label className="field-inline">
          Estado
          <span className="mini-select">
            <input
              className={`mono status-in ${tone(status)}`}
              type="number"
              min={100}
              max={599}
              value={status}
              onChange={(e) => patch((r) => ({ ...r, status: Number(e.target.value) || 200 }))}
              list="mockix-statuses"
              aria-label="Código de estado"
              data-testid="response-status"
            />
            <span className="phrase">{phrase(status)}</span>
          </span>
        </label>
        <label className="field-inline">
          Tipo
          <input
            className="mini-select mono wide"
            value={contentType}
            placeholder="automático"
            onChange={(e) => patch((r) => ({ ...r, headers: setHeader(r.headers, "Content-Type", e.target.value) }))}
            list="mockix-types"
            aria-label="Content-Type"
          />
        </label>
        <label className="field-inline">
          Latencia
          <span className="mini-select">
            <input className="mono num-in" type="number" min={0} value={response.latency ?? 0} onChange={(e) => patch((r) => ({ ...r, latency: Math.max(0, Number(e.target.value) || 0) }))} aria-label="Latencia en milisegundos" />
            ms
          </span>
        </label>
        <datalist id="mockix-statuses">
          {COMMON_STATUSES.map((c) => (
            <option key={c} value={c}>{`${c} ${phrase(c)}`}</option>
          ))}
        </datalist>
        <datalist id="mockix-types">
          {["application/json", "text/plain; charset=utf-8", "text/html; charset=utf-8", "application/xml", "text/csv", "application/problem+json"].map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>
      <div className="section-label">
        {response.template === false ? "Cuerpo" : "Plantilla"}
        <span>{response.body.kind === "file" ? response.body.path : response.body.kind === "none" ? "sin cuerpo" : "en línea, dentro del YAML"}</span>
        <span className="end">
          <span className="seg">
            <button type="button" aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>
              {response.template === false ? "Texto" : "Plantilla"}
            </button>
            <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")} disabled={response.template === false} data-testid="body-preview">
              Vista previa
            </button>
          </span>
        </span>
      </div>
      {response.body.kind === "file" && response.body.text === null ? (
        <p className="note">Archivo binario ({response.body.path}): se sirve tal cual y no se edita aquí.</p>
      ) : (
        <div className="code-block editor">
          {mode === "edit" ? (
            <CodeEditor key="edit" value={text} onChange={setText} language={contentType.includes("json") || /^\s*[[{]/.test(text) ? "json" : "text"} label="Cuerpo de la respuesta" testId="body-editor" onSave={() => save(tab)} placeholder="Cuerpo vacío" />
          ) : (
            <CodeEditor key="preview" value={preview?.text ?? ""} language="json" readOnly label="Vista previa de la plantilla" testId="body-preview-view" />
          )}
        </div>
      )}
      {mode === "preview" && preview?.error && <p className="why-box">{preview.text}</p>}
      <div className="body-opts">
        <label className="check-row">
          <input type="checkbox" checked={response.template !== false} onChange={(e) => patch((r) => ({ ...r, template: e.target.checked ? undefined : false }))} />
          Plantilla: {"{{…}}"} se evalúa en cada petición
        </label>
        {response.body.kind === "file" && <span className="hint">se guarda en <span className="mono">{response.body.path}</span></span>}
      </div>
    </>
  );
}

function HeadersPanel({ tab, d, response }: { tab: string; d: Draft; response: ResponseDraft }) {
  const updateDraft = useStore((s) => s.updateDraft);
  const rows = Object.entries(response.headers ?? {});
  const commit = (list: Array<[string, string]>) =>
    updateDraft(tab, (x) => ({ ...x, responses: (x.responses ?? []).map((r, i) => (i === d.response ? { ...r, headers: Object.fromEntries(list.filter(([k]) => k.trim())) } : r)) }));
  return (
    <table className="kv editable">
      <colgroup>
        <col style={{ width: "38%" }} />
        <col />
        <col style={{ width: 34 }} />
      </colgroup>
      <thead>
        <tr>
          <th>Cabecera</th>
          <th>Valor (admite plantillas)</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {[...rows, ["", ""] as [string, string]].map(([k, v], i) => (
          <tr key={i}>
            <td>
              <input className="cell mono" value={k} placeholder="Nombre" aria-label={`Cabecera ${i + 1}`} onChange={(e) => commit(i < rows.length ? rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)) : [...rows, [e.target.value, ""]])} />
            </td>
            <td>
              <input className="cell mono" value={v} placeholder="Valor" aria-label={`Valor ${i + 1}`} onChange={(e) => commit(i < rows.length ? rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)) : [...rows, ["X-Cabecera", e.target.value]])} />
            </td>
            <td>
              {i < rows.length && (
                <button type="button" className="icon-btn" aria-label={`Quitar ${k}`} onClick={() => commit(rows.filter((_, j) => j !== i))}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RulesPanel({ tab, d, response }: { tab: string; d: Draft; response: ResponseDraft }) {
  const updateDraft = useStore((s) => s.updateDraft);
  const rules = response.rules?.when ?? [];
  const mode = response.rules?.mode ?? "all";
  const commit = (when: RuleDraft[], m = mode) =>
    updateDraft(tab, (x) => ({
      ...x,
      responses: (x.responses ?? []).map((r, i) => {
        if (i !== d.response) return r;
        const next = { ...r };
        if (when.length) next.rules = { mode: m, when };
        else delete next.rules;
        return next;
      }),
    }));
  return (
    <>
      <div className="toolbar">
        <span className="hint">Esta respuesta se elige cuando se cumplen</span>
        <span className="seg">
          <button type="button" aria-pressed={mode === "all"} onClick={() => commit(rules, "all")}>
            todas
          </button>
          <button type="button" aria-pressed={mode === "any"} onClick={() => commit(rules, "any")}>
            alguna
          </button>
        </span>
        <span className="end">
          <button type="button" className="link-btn" onClick={() => commit([...rules, { target: "query.x", op: "equals", value: "" }])} data-testid="add-rule">
            Añadir regla
          </button>
        </span>
      </div>
      <table className="kv editable">
        <colgroup>
          <col style={{ width: 34 }} />
          <col style={{ width: "34%" }} />
          <col style={{ width: 110 }} />
          <col />
          <col style={{ width: 34 }} />
        </colgroup>
        <thead>
          <tr>
            <th title="Negar">No</th>
            <th>Objetivo</th>
            <th>Operador</th>
            <th>Valor</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rules.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Sin reglas: {response.default ? "es la respuesta por defecto." : "solo se usará en modo aleatorio o secuencial."}
              </td>
            </tr>
          )}
          {rules.map((rule, i) => {
            const set = (p: Partial<RuleDraft>) => commit(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
            return (
              <tr key={i}>
                <td className="ck">
                  <input type="checkbox" className="check" checked={rule.negate === true} onChange={(e) => set({ negate: e.target.checked || undefined })} aria-label="Negar la regla" />
                </td>
                <td>
                  <input className="cell mono" value={rule.target} onChange={(e) => set({ target: e.target.value })} aria-label="Objetivo" list="mockix-targets" />
                </td>
                <td>
                  <select className="cell" value={rule.op} onChange={(e) => set({ op: e.target.value, ...(NO_VALUE.has(e.target.value) ? { value: undefined } : {}) })} aria-label="Operador">
                    {RULE_OPS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {!NO_VALUE.has(rule.op) && <input className="cell mono" value={showValue(rule.value)} onChange={(e) => set({ value: parseValue(e.target.value, rule.op) })} aria-label="Valor" />}
                </td>
                <td>
                  <button type="button" className="icon-btn" aria-label="Quitar regla" onClick={() => commit(rules.filter((_, j) => j !== i))}>
                    <Icon name="x" size={14} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <datalist id="mockix-targets">
        {["body", "body.", "query.", "header.", "cookie.", "params.", "method", "path", "request.number"].map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <p className="note">
        Objetivos: <span className="mono">body.campo[0]</span>, <span className="mono">query.x</span>, <span className="mono">header.x</span>, <span className="mono">cookie.x</span>,{" "}
        <span className="mono">params.x</span>, <span className="mono">method</span>, <span className="mono">path</span>, <span className="mono">request.number</span>.
      </p>
    </>
  );
}

function LatencyPanel({ mock, tab, d, response }: { mock: MockStatus; tab: string; d: Draft; response: ResponseDraft }) {
  const updateDraft = useStore((s) => s.updateDraft);
  const routeLatency = d.draft.latency ?? 0;
  const total = mock.latencyMs + routeLatency + (response.latency ?? 0);
  return (
    <>
      <table className="kv">
        <tbody>
          <tr>
            <td className="d">Mock {mock.name}</td>
            <td className="mono">{mock.latencyMs} ms</td>
            <td className="muted">en mock.yaml</td>
          </tr>
          <tr>
            <td className="d">Esta ruta</td>
            <td>
              <input className="cell mono num-in" type="number" min={0} value={routeLatency} onChange={(e) => updateDraft(tab, (x) => ({ ...x, latency: Math.max(0, Number(e.target.value) || 0) }))} aria-label="Latencia de la ruta" /> ms
            </td>
            <td className="muted">todas sus respuestas</td>
          </tr>
          <tr>
            <td className="d">Respuesta {response.id}</td>
            <td>
              <input
                className="cell mono num-in"
                type="number"
                min={0}
                value={response.latency ?? 0}
                onChange={(e) => updateDraft(tab, (x) => ({ ...x, responses: (x.responses ?? []).map((r, i) => (i === d.response ? { ...r, latency: Math.max(0, Number(e.target.value) || 0) } : r)) }))}
                aria-label="Latencia de la respuesta"
              />{" "}
              ms
            </td>
            <td className="muted">solo esta respuesta</td>
          </tr>
          <tr>
            <td className="d">
              <b>Total simulado</b>
            </td>
            <td className="mono">
              <b>{total} ms</b>
            </td>
            <td className="muted">los perfiles de caos (M7) se suman a esto</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function DocPanel({ tab, d, response }: { tab: string; d: Draft; response: ResponseDraft }) {
  const updateDraft = useStore((s) => s.updateDraft);
  return (
    <div className="doc-panel">
      <label>
        <span className="section-label">Ruta</span>
        <textarea value={d.draft.description ?? ""} onChange={(e) => updateDraft(tab, (x) => ({ ...x, description: e.target.value || undefined }))} placeholder="Para qué sirve esta ruta" rows={3} />
      </label>
      <label>
        <span className="section-label">Respuesta {response.id}</span>
        <textarea
          value={response.description ?? ""}
          onChange={(e) => updateDraft(tab, (x) => ({ ...x, responses: (x.responses ?? []).map((r, i) => (i === d.response ? { ...r, description: e.target.value || undefined } : r)) }))}
          placeholder="Cuándo se usa"
          rows={3}
        />
      </label>
      <label className="field-inline">
        Id de la respuesta
        <input
          className="mini-select mono wide"
          value={response.id}
          onChange={(e) => updateDraft(tab, (x) => ({ ...x, responses: (x.responses ?? []).map((r, i) => (i === d.response ? { ...r, id: e.target.value } : r)) }))}
          aria-label="Id de la respuesta"
        />
      </label>
    </div>
  );
}

function OrderTable({ mock, tab, d }: { mock: MockStatus; tab: string; d: Draft }) {
  const updateDraft = useStore((s) => s.updateDraft);
  const selectResponse = useStore((s) => s.selectResponse);
  const log = useStore((s) => s.log);
  const responses = d.draft.responses ?? [];
  const mode = d.draft.mode ?? "rules";
  const routeId = d.doc.draft.id;
  const hits = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of log) if (r.mockId === mock.id && r.routeId === routeId && r.responseId) out[r.responseId] = (out[r.responseId] ?? 0) + 1;
    return out;
  }, [log, mock.id, routeId]);
  // Rules mode tries responses with rules in order, then the default.
  const ordered = mode === "rules" || mode === "fallback" ? [...responses.map((r, i) => ({ r, i })).filter((x) => x.r.rules), ...responses.map((r, i) => ({ r, i })).filter((x) => !x.r.rules)] : responses.map((r, i) => ({ r, i }));

  return (
    <>
      <div className="section-label">
        Orden de respuestas
        <span className="end">
          <span className="seg">
            {(["rules", "random", "sequential", "fallback"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => updateDraft(tab, (x) => ({ ...x, mode: m === "rules" ? undefined : m }))}>
                {MODE_LABEL[m]}
              </button>
            ))}
          </span>
        </span>
      </div>
      <table className="kv">
        <colgroup>
          <col style={{ width: 34 }} />
          <col style={{ width: "28%" }} />
          <col />
          <col style={{ width: 70 }} />
        </colgroup>
        <thead>
          <tr>
            <th />
            <th>Respuesta</th>
            <th>Condición</th>
            <th className="r">Aciertos</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map(({ r, i }, n) => (
            <tr key={i} className={i === d.response ? "sel" : undefined} onClick={() => selectResponse(tab, i)}>
              <td className="ord">{n + 1}</td>
              <td className="ui">
                <span className={`mono ${tone(r.status ?? 200)}-t`}>{r.status ?? 200}</span> {r.id}
              </td>
              <td className={conditionText(r) ? "cond" : "d"}>
                {mode === "random"
                  ? "al azar"
                  : mode === "sequential"
                    ? `turno ${n + 1} de ${responses.length}`
                    : (conditionText(r) ?? (r.default ? (mode === "fallback" ? "ninguna: pasa a la siguiente ruta" : "por defecto, si ninguna regla coincide") : "nunca (sin reglas)"))}
              </td>
              <td className="hits">{hits[r.id] ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function RouteContext({ mock, tab, d }: { mock: MockStatus; tab: string; d: Draft }) {
  const deleteRoute = useStore((s) => s.deleteRoute);
  const revert = useStore((s) => s.revert);
  const response = d.draft.responses?.[d.response];
  return (
    <>
      <div className="section-label">Qué más afecta a esta ruta</div>
      <table className="kv">
        <colgroup>
          <col style={{ width: "28%" }} />
          <col />
        </colgroup>
        <tbody>
          <tr>
            <td className="d">Latencia</td>
            <td>
              <span className="mono">{mock.latencyMs + (d.draft.latency ?? 0) + (response?.latency ?? 0)} ms</span> <span className="d">(mock + ruta + respuesta)</span>
            </td>
          </tr>
          <tr>
            <td className="d">Si no coincide</td>
            <td>{mock.proxyTarget ? <span className="mono">proxy → {mock.proxyTarget}</span> : <span className="d">404 del mock (sin proxy)</span>}</td>
          </tr>
          {(response?.callbacks?.length ?? 0) > 0 && (
            <tr>
              <td className="d">Callbacks</td>
              <td>{response!.callbacks!.length} tras responder (se editan en el archivo)</td>
            </tr>
          )}
          <tr>
            <td className="d">Archivo</td>
            <td className="mono">
              mocks/{mock.name}/{d.doc.file}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="section-label">
        El archivo en disco <span>{d.dirty ? "versión guardada; tus cambios aún no están aquí" : "lo que verá git"}</span>
      </div>
      <div className="code-block viewer">
        <CodeEditor key={d.doc.source} value={d.doc.source} language="text" readOnly label="Archivo YAML de la ruta" testId="route-source" />
      </div>
      <div className="danger-row">
        {d.dirty && (
          <button type="button" className="link-btn" onClick={() => revert(tab)}>
            Descartar cambios
          </button>
        )}
        <button type="button" className="link-btn" onClick={() => deleteRoute(tab)} data-testid="route-delete">
          <Icon name="trash" size={14} /> Mover la ruta a la papelera
        </button>
      </div>
    </>
  );
}

type Sub = "body" | "headers" | "rules" | "latency" | "doc";

export function RouteEditor({ mock, tab }: { mock: MockStatus; tab: string }) {
  const d = useStore((s) => s.drafts[tab]);
  const [sub, setSub] = useState<Sub>("body");
  if (!d) return <div className="pane-body loading">Abriendo la ruta…</div>;
  const response = d.draft.responses?.[d.response];

  return (
    <>
      <RouteLine mock={mock} tab={tab} d={d} />
      {d.error && (
        <pre className="notice err" role="alert" data-testid="save-error">
          No se guardó:
          {"\n"}
          {d.error}
        </pre>
      )}
      <div className="split">
        <div className="pane">
          {d.draft.crud ? (
            <div className="pane-body">
              <div className="section-label">
                Ruta CRUD <span>sobre data/{d.draft.crud.bucket}.json</span>
              </div>
              <table className="kv">
                <tbody>
                  {[
                    ["GET", d.draft.path, "lista con filtros, orden y paginación"],
                    ["GET", `${d.draft.path}/:${d.draft.crud.key ?? "id"}`, "un elemento"],
                    ["POST", d.draft.path, "crea (201, Location)"],
                    ["PUT", `${d.draft.path}/:${d.draft.crud.key ?? "id"}`, "reemplaza"],
                    ["PATCH", `${d.draft.path}/:${d.draft.crud.key ?? "id"}`, "modifica"],
                    ["DELETE", `${d.draft.path}/:${d.draft.crud.key ?? "id"}`, "borra (204)"],
                  ].map(([m, p, what]) => (
                    <tr key={`${m}${p}`}>
                      <td className={`meth ${METHOD_CLASS[m!] ?? ""}`}>{shortMethod(m!)}</td>
                      <td className="mono">{p}</td>
                      <td className="d">{what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <RouteContext mock={mock} tab={tab} d={d} />
            </div>
          ) : (
            <>
              <Chips tab={tab} d={d} />
              <div className="subtabs" role="tablist">
                {(
                  [
                    ["body", "Cuerpo", null],
                    ["headers", "Cabeceras", Object.keys(response?.headers ?? {}).length],
                    ["rules", "Reglas", response?.rules?.when.length ?? 0],
                    ["latency", "Latencia", null],
                    ["doc", "Documentación", null],
                  ] as Array<[Sub, string, number | null]>
                ).map(([key, label, n]) => (
                  <button key={key} type="button" className="subtab" role="tab" aria-selected={sub === key} onClick={() => setSub(key)} data-testid={`sub-${key}`}>
                    {label} {n !== null && <span className="n mono">{n}</span>}
                  </button>
                ))}
              </div>
              <div className="pane-body">
                {response && sub === "body" && <BodyPanel mock={mock} tab={tab} d={d} response={response} />}
                {response && sub === "headers" && <HeadersPanel tab={tab} d={d} response={response} />}
                {response && sub === "rules" && <RulesPanel tab={tab} d={d} response={response} />}
                {response && sub === "latency" && <LatencyPanel mock={mock} tab={tab} d={d} response={response} />}
                {response && sub === "doc" && <DocPanel tab={tab} d={d} response={response} />}
                <OrderTable mock={mock} tab={tab} d={d} />
                <RouteContext mock={mock} tab={tab} d={d} />
              </div>
            </>
          )}
        </div>
        <LogPane mock={mock} />
      </div>
    </>
  );
}
