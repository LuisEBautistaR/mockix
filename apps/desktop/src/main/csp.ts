/** Content-Security-Policy for the renderer. Nothing is loaded from outside the app. */
export const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

/** Development only: Vite's dev server needs inline scripts/styles and its HMR websocket. */
export function developmentCsp(devOrigin: string): string {
  const ws = devOrigin.replace(/^http/, "ws");
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'`,
    `style-src 'self' 'unsafe-inline'`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${ws}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}
