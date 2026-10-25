import { app, session, type WebFrameMain } from "electron";
import { APP_ORIGIN, originOf } from "./app-path";

let devOrigin: string | null = null;

/** Origins allowed to load in a window and to talk to main. */
export function setDevelopmentOrigin(url: string | null): void {
  devOrigin = url ? new URL(url).origin : null;
}

function isTrustedOrigin(url: string): boolean {
  const origin = originOf(url);
  return origin !== null && (origin === APP_ORIGIN || origin === devOrigin);
}

/** Only the app's own top-level page may use the IPC bridge. */
export function isTrustedSender(frame: WebFrameMain | null): boolean {
  return frame !== null && frame.parent === null && isTrustedOrigin(frame.url);
}

/** App-wide hardening; call once before any window exists. */
export function hardenApp(): void {
  app.enableSandbox();

  app.on("web-contents-created", (_event, contents) => {
    // No new windows, no navigation away from the app, no <webview>.
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!isTrustedOrigin(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!isTrustedOrigin(url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

/** Deny every web permission (camera, notifications, geolocation…); the UI needs none. */
export function denyPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setDevicePermissionHandler(() => false);
}
