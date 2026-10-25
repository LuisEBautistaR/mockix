import { X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generate } from "selfsigned";

export interface TlsPair {
  cert: string;
  key: string;
}

/** Where `tls: true` keeps its certificate: local to the workspace and git-ignored. */
export const GENERATED_TLS_DIR = join(".mockix", "tls");
const VALID_DAYS = 825;
/** Regenerate when less than this is left, so a running mock never expires mid-session. */
const RENEW_BEFORE_MS = 7 * 24 * 3600 * 1000;

async function readPair(dir: string): Promise<TlsPair | null> {
  try {
    const [cert, key] = await Promise.all([readFile(join(dir, "cert.pem"), "utf8"), readFile(join(dir, "key.pem"), "utf8")]);
    const x509 = new X509Certificate(cert);
    if (new Date(x509.validTo).getTime() - Date.now() < RENEW_BEFORE_MS) return null;
    return { cert, key };
  } catch {
    return null;
  }
}

/**
 * Returns the workspace's self-signed certificate for localhost, creating it on
 * first use. Each workspace gets its own key; nothing ships inside the app.
 */
export async function ensureSelfSigned(workspaceDir: string): Promise<TlsPair> {
  const dir = join(workspaceDir, GENERATED_TLS_DIR);
  const existing = await readPair(dir);
  if (existing) return existing;

  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + VALID_DAYS * 24 * 3600 * 1000);
  const pems = await generate([{ name: "commonName", value: "localhost" }, { name: "organizationName", value: "Mockix (local)" }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
          { type: 7, ip: "::1" },
        ],
      },
    ],
  });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "cert.pem"), pems.cert);
  await writeFile(join(dir, "key.pem"), pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private };
}
