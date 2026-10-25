/**
 * Route path patterns:
 *   /productos/:id      a named parameter matches one non-empty segment
 *   /archivos/*         a trailing star matches the rest (params["*"], may be empty)
 *   ^/v\d+/salud$       a leading caret makes the path a regular expression;
 *                       named groups become params
 * Paths are matched after the mock prefix is removed. A trailing slash is ignored.
 */

export type Params = Record<string, string>;
export type PathMatcher = (path: string) => Params | null;

const trimSlash = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function compilePath(pattern: string): PathMatcher {
  if (pattern.startsWith("^")) {
    const re = new RegExp(pattern);
    return (path) => {
      const m = re.exec(path);
      if (!m) return null;
      const params: Params = {};
      for (const [k, v] of Object.entries(m.groups ?? {})) if (v !== undefined) params[k] = v;
      return params;
    };
  }

  const parts = trimSlash(pattern).split("/").slice(1);
  const rest = parts.at(-1) === "*";
  const fixed = rest ? parts.slice(0, -1) : parts;

  return (rawPath) => {
    const segments = trimSlash(rawPath).split("/").slice(1);
    if (segments.length === 1 && segments[0] === "") segments.length = 0;
    const want = fixed.length === 1 && fixed[0] === "" ? [] : fixed;
    if (rest ? segments.length < want.length : segments.length !== want.length) return null;

    const params: Params = {};
    for (let i = 0; i < want.length; i++) {
      const p = want[i]!;
      const s = segments[i]!;
      if (p.startsWith(":")) {
        const value = decode(s);
        if (value === null || value === "") return null;
        params[p.slice(1)] = value;
      } else if (p !== s) {
        return null;
      }
    }
    if (rest) params["*"] = segments.slice(want.length).join("/");
    return params;
  };
}

/** Strips the mock prefix; null when the path is outside it. */
export function stripPrefix(prefix: string, path: string): string | null {
  if (!prefix) return path;
  if (path === prefix) return "/";
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : null;
}
