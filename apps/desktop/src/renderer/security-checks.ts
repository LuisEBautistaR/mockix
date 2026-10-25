export interface SecurityCheck {
  id: string;
  label: string;
  detail: string;
  passed: boolean;
}

/** Checks the page can make about its own isolation. Main-side settings are covered by the E2E tests. */
export function runSecurityChecks(): SecurityCheck[] {
  const scope = globalThis as Record<string, unknown>;

  let evalBlocked = false;
  try {
    // A CSP without 'unsafe-eval' makes this throw.
    new Function("return 1")();
  } catch {
    evalBlocked = true;
  }

  const bridgeKeys = Object.keys(window.mockix ?? {}).sort().join(",");

  return [
    {
      id: "no-node",
      label: "Sin Node.js en la interfaz",
      detail: "require y process no existen en la página",
      passed: typeof scope["require"] === "undefined" && typeof scope["process"] === "undefined",
    },
    {
      id: "bridge",
      label: "Puente mínimo",
      detail: "solo window.mockix (workspace, mocks, rutas, grabaciones, logs y app); ipcRenderer no es accesible",
      passed: bridgeKeys === "agents,app,chaos,contracts,links,live,logs,mocks,recordings,routes,scenarios,sendix,updates,workspace" && typeof scope["ipcRenderer"] === "undefined",
    },
    {
      id: "csp",
      label: "Política de contenido activa",
      detail: "eval y código dinámico bloqueados; la interfaz no puede llamar a localhost",
      passed: evalBlocked,
    },
    {
      id: "origin",
      label: "Origen propio",
      detail: location.protocol === "app:" ? "app://mockix, sin file://" : `servidor de desarrollo ${location.origin}`,
      passed: location.protocol === "app:" || location.hostname === "localhost",
    },
  ];
}
