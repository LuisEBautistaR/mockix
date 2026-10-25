import { resolve, sep } from "node:path";

export const APP_SCHEME = "app";
export const APP_HOST = "mockix";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/**
 * Maps an app:// request to a file inside the renderer build folder.
 * Returns null for other hosts or for any path that would escape the folder.
 */
export function resolveAppPath(rootDir: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  if (pathname === "" || pathname === "/") pathname = "/index.html";

  const root = resolve(rootDir);
  const file = resolve(root, `.${pathname}`);
  return file.startsWith(root + sep) ? file : null;
}

/**
 * Origin of a URL, including app:// — Node's URL reports "null" as the origin of
 * non-special schemes, so it cannot be compared directly.
 */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === `${APP_SCHEME}:`) return `${parsed.protocol}//${parsed.host}`;
    return parsed.origin === "null" ? null : parsed.origin;
  } catch {
    return null;
  }
}

export function isAppUrl(url: string): boolean {
  return originOf(url) === APP_ORIGIN;
}
