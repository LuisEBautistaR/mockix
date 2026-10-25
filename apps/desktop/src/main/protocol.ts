import { net, protocol, session } from "electron";
import { pathToFileURL } from "node:url";
import { APP_SCHEME, resolveAppPath } from "./app-path";
import { PRODUCTION_CSP, developmentCsp } from "./csp";

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ]);
}

/** Serves the renderer build from app://mockix/… with the production CSP on every response. */
export function serveRenderer(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppPath(rendererDir, request.url);
    if (!file) return new Response("Not found", { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", PRODUCTION_CSP);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    return new Response(response.body, { status: response.status, headers });
  });
}

/** In development the renderer comes from Vite's dev server; give it a CSP too. */
export function applyDevelopmentCsp(devUrl: string): void {
  const origin = new URL(devUrl).origin;
  const policy = developmentCsp(origin);
  session.defaultSession.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] } });
  });
}
