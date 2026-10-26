import { useMemo, useState } from "react";
import type { MockStatus, RouteSummary } from "@shared/ipc";
import { Icon } from "../Icon";
import { METHOD_CLASS, STATE_LABEL, pathPieces, shortMethod } from "../lib/format";
import { tabKey, useStore } from "../state/store";

interface Folder {
  name: string;
  routes: RouteSummary[];
}

/** Groups routes by the subfolder of routes/ their file lives in; the workspace order is kept inside each group. */
function groupRoutes(routes: RouteSummary[]): { loose: RouteSummary[]; folders: Folder[] } {
  const loose: RouteSummary[] = [];
  const folders = new Map<string, RouteSummary[]>();
  for (const r of routes) {
    const parts = r.file.replace(/^routes\//, "").split("/");
    if (parts.length === 1) loose.push(r);
    else {
      const name = parts.slice(0, -1).join("/");
      folders.set(name, [...(folders.get(name) ?? []), r]);
    }
  }
  return { loose, folders: [...folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => ({ name, routes: list })) };
}

function PathText({ path }: { path: string }) {
  return (
    <span className="path mono">
      {pathPieces(path).map((p, i) =>
        p.param ? (
          <span key={i} className="p">
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}

function RouteRow({ mock, route, level }: { mock: MockStatus; route: RouteSummary; level: 2 | 3 }) {
  const activeTab = useStore((s) => s.activeTab);
  const openRoute = useStore((s) => s.openRoute);
  const selected = activeTab === tabKey({ mockId: mock.id, routeId: route.id });
  return (
    <li>
      <button type="button" className={`row l${level}`} aria-selected={selected} onClick={() => openRoute(mock.id, route.id)} title={route.file} data-testid={`route-${route.id}`}>
        <span className={`meth ${route.mode === "crud" ? "m-crud" : (METHOD_CLASS[route.method] ?? "")}`}>{route.mode === "crud" ? "CRUD" : shortMethod(route.method)}</span>
        <PathText path={route.path} />
      </button>
    </li>
  );
}

function LiveRows({ mock }: { mock: MockStatus }) {
  const live = useStore((s) => s.live);
  const openLive = useStore((s) => s.openLive);
  return (
    <>
      {mock.realtime.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            className="row l2"
            aria-selected={live?.mockId === mock.id && live.kind === "realtime" && live.id === r.id}
            onClick={() => openLive({ mockId: mock.id, kind: "realtime", id: r.id })}
            title={r.file}
            data-testid={`live-${r.id}`}
          >
            <span className="meth m-live">{r.protocol === "ws" ? "WS" : "SIO"}</span>
            <PathText path={r.path} />
          </button>
        </li>
      ))}
      {mock.grpc?.services.map((s) => (
        <li key={s.service}>
          <button
            type="button"
            className="row l2"
            aria-selected={live?.mockId === mock.id && live.kind === "grpc" && live.id === s.service}
            onClick={() => openLive({ mockId: mock.id, kind: "grpc", id: s.service })}
            title={`${s.file} · ${s.proto}`}
            data-testid={`grpc-${s.service}`}
          >
            <span className="meth m-live">gRPC</span>
            <span className="path mono">{s.service.split(".").pop()}</span>
            <span className="count mono">{s.methods.length}</span>
          </button>
        </li>
      ))}
    </>
  );
}

function MockNode({ mock }: { mock: MockStatus }) {
  const selected = useStore((s) => s.selectedMock);
  const selectMock = useStore((s) => s.selectMock);
  const [open, setOpen] = useState(true);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const { loose, folders } = useMemo(() => groupRoutes(mock.routes), [mock.routes]);
  const live = mock.state === "running";

  return (
    <li>
      <button
        type="button"
        className="row l1"
        onClick={() => {
          if (mock.id === selected) setOpen(!open);
          else {
            selectMock(mock.id);
            setOpen(true);
          }
        }}
        data-testid={`mock-row-${mock.id}`}
      >
        <Icon name={open ? "down" : "right"} size={14} className="chev" />
        <span className={live ? "dot-on" : "dot-off"} title={STATE_LABEL[mock.state]} aria-hidden="true" />
        <span className="name">{mock.name}</span>
        <span className="port mono">:{mock.port}</span>
        {mock.problems.length > 0 ? (
          <span className="flag-err">{mock.problems.length === 1 ? "1 problema" : `${mock.problems.length} problemas`}</span>
        ) : live ? (
          <span className="count mono">{mock.routes.length}</span>
        ) : (
          <span className="stopped">{STATE_LABEL[mock.state].toLowerCase()}</span>
        )}
      </button>
      {open && (
        <ul>
          {folders.map((f) => (
            <li key={f.name}>
              <button type="button" className="row l2" onClick={() => setClosed({ ...closed, [f.name]: !closed[f.name] })}>
                <Icon name={closed[f.name] ? "right" : "down"} size={14} className="chev" />
                <Icon name="folder" size={14} className="fold" />
                <span className="name">{f.name}</span>
              </button>
              {!closed[f.name] && (
                <ul>
                  {f.routes.map((r) => (
                    <RouteRow key={r.id} mock={mock} route={r} level={3} />
                  ))}
                </ul>
              )}
            </li>
          ))}
          {loose.map((r) => (
            <RouteRow key={r.id} mock={mock} route={r} level={2} />
          ))}
          <LiveRows mock={mock} />
          {mock.routes.length === 0 && mock.realtime.length === 0 && !mock.grpc && mock.problems.length === 0 && <li className="side-note">Sin rutas: crea una con +.</li>}
        </ul>
      )}
    </li>
  );
}

export function Sidebar() {
  const workspace = useStore((s) => s.workspace);
  const mocks = useStore((s) => s.mocks);
  const selected = useStore((s) => s.selectedMock);
  const setDialog = useStore((s) => s.setDialog);
  const openWorkspace = useStore((s) => s.openWorkspace);
  const importFile = useStore((s) => s.importFile);
  const [filter, setFilter] = useState("");
  const mock = mocks.find((m) => m.id === selected) ?? null;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return mocks;
    return mocks.map((m) => ({ ...m, routes: m.routes.filter((r) => `${r.method} ${r.path} ${r.id}`.toLowerCase().includes(q)) }));
  }, [mocks, filter]);

  if (!workspace?.dir) {
    return (
      <aside className="sidebar" aria-label="Mocks">
        <div className="side-head">
          <h2>Mocks</h2>
        </div>
        <div className="empty">
          <p className="empty-title">Abre una carpeta de trabajo</p>
          <p>Un workspace es una carpeta con un mockix.workspace.yaml y un mock por subcarpeta de mocks/. Todo queda en tu equipo y en git.</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => openWorkspace("open")} data-testid="open-workspace">
            <Icon name="folder" size={14} /> Abrir carpeta…
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => openWorkspace("example")} data-testid="create-example">
            <Icon name="plus" size={14} /> Crear el ejemplo…
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar" aria-label="Mocks">
      <div className="side-head">
        <h2>Mocks</h2>
        <button type="button" className="icon-btn" title="Abrir otra carpeta de trabajo" aria-label="Abrir otra carpeta de trabajo" onClick={() => openWorkspace("open")} data-testid="open-workspace">
          <Icon name="folder" size={16} />
        </button>
        <button type="button" className="icon-btn" title="Importar OpenAPI, Postman, HAR o Mockoon" aria-label="Importar" onClick={() => importFile()} data-testid="import">
          <Icon name="download" size={16} />
        </button>
        <button type="button" className="icon-btn" title="Nuevo mock" aria-label="Nuevo mock" onClick={() => setDialog({ kind: "new-mock" })} data-testid="new-mock">
          <Icon name="server" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Nueva ruta"
          aria-label="Nueva ruta"
          disabled={!mock}
          onClick={() => mock && setDialog({ kind: "new-route", mockId: mock.id })}
          data-testid="new-route"
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
      <label className="filter">
        <Icon name="filter" size={14} />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar rutas" aria-label="Filtrar rutas" />
      </label>
      <ul className="tree" role="tree">
        {filtered.length === 0 && <li className="side-note">Este workspace no tiene mocks: crea uno desde un contrato o vacío con el botón de servidor.</li>}
        {filtered.map((m) => (
          <MockNode key={m.id} mock={m} />
        ))}
      </ul>
      {mock && (
        <div className="side-block">
          <div className="vars-head">
            <b>Data buckets</b>
            <span>{mock.name}</span>
          </div>
          {mock.buckets.length === 0 ? (
            <p className="side-note">Sin buckets: añade un JSON en mocks/{mock.name}/data/.</p>
          ) : (
            <table>
              <tbody>
                {mock.buckets.map((b) => (
                  <tr key={b.name}>
                    <td className="k">{b.name}</td>
                    <td className="d">data/{b.name}.json</td>
                    <td className="n">{b.size}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </aside>
  );
}

export { PathText };
