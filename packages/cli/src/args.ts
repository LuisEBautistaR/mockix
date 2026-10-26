import { parseArgs } from "node:util";

export type Command =
  | {
      kind: "serve";
      dir: string;
      mocks: string[];
      port: number | null;
      host: string | null;
      watch: boolean;
      seed: number | null;
      adminToken: string | null;
      contract: "off" | "warn" | "strict" | null;
      chaos: string | null;
      report: string | null;
      failOnViolation: boolean;
    }
  | { kind: "validate"; dir: string; failOnViolation: boolean }
  | { kind: "import"; file: string; dir: string; format: "openapi" | "postman" | "har" | "mockoon" | null; name: string | null; port: number | null; prefix: string | null; contract: boolean; chaos: boolean }
  | { kind: "export"; dir: string; mock: string; out: string | null }
  | { kind: "record"; dir: string; target: string; port: number; host: string | null; prefix: string; convert: string | null }
  | { kind: "convert"; file: string; dir: string; name: string | null; into: string | null; prefix: string }
  | { kind: "replay"; file: string; dir: string; port: number; host: string | null; strict: boolean }
  | { kind: "mcp"; dir: string; readOnly: boolean }
  | { kind: "init"; dir: string }
  | { kind: "help" }
  | { kind: "version" };

export type ParseResult = { ok: true; command: Command } | { ok: false; message: string };

export const HELP = `Uso: mockix <comando> [carpeta] [opciones]

Comandos:
  init [carpeta]      Crea un workspace de ejemplo (por defecto, la carpeta actual)
  serve [carpeta]     Sirve los mocks del workspace y recarga al guardar cambios
  validate [carpeta]  Revisa todos los archivos del workspace sin servir nada
  import <archivo> [carpeta]   Crea un mock desde OpenAPI, Postman v2.x, HAR o Mockoon
  export openapi [carpeta] -m <mock>   Escribe el mock como OpenAPI 3.1 (YAML)
  record [carpeta] --target <url>      Proxy que graba el tráfico real en .mockix/recordings
  convert <grabación> [carpeta]        Convierte una grabación en un mock (o en rutas de uno)
  replay <grabación> [carpeta]         Modo casete: reproduce lo grabado y falla si llega otra cosa
  mcp [carpeta]       Servidor MCP por stdio para agentes de IA (--read-only: sin escrituras)

Opciones de serve:
  -m, --mock <nombre>  Sirve solo ese mock (se puede repetir)
  -p, --port <n>       Cambia el puerto (solo con un mock; 0 = uno libre)
      --host <ip>      Interfaz donde escuchar (por defecto, la de mock.yaml o 127.0.0.1)
      --no-watch       No recarga al cambiar los archivos
      --seed <n>       Misma semilla, mismos datos falsos y mismas elecciones al azar
      --admin-token <t>  Activa la API de control en /__mockix/ con ese token
                         (también con la variable MOCKIX_ADMIN_TOKEN)
      --chaos <perfil>   Aplica ese perfil de chaos/ a los mocks (off: sin caos); con --seed se repite
      --contract <modo>  off, warn o strict: cambia el modo del contrato de mock.yaml
      --report <archivo> Al detener, escribe las violaciones del contrato (.xml JUnit o .json)
      --fail-on-violation  Termina con código 2 si hubo violaciones (también en validate)

Opciones de import:
      --format <f>     openapi, postman, har o mockoon (por defecto, se detecta)
      --name <n>       Nombre del mock (por defecto, el título de la fuente)
  -p, --port <n>       Puerto del mock nuevo
      --prefix </x>    Prefijo del mock; en HAR, la parte de la ruta que se quita
      --no-contract    Con un OpenAPI: no lo copia a contracts/ ni lo conecta al mock
      --no-chaos       Con un OpenAPI: no prepara perfiles de caos con sus errores

Opciones de export:
  -o, --out <archivo>  Archivo de salida (por defecto, la salida estándar)

Opciones de record, convert y replay:
      --target <url>   API real a la que se reenvía todo (record)
  -p, --port <n>       Puerto del proxy o del casete (por defecto 3000)
      --prefix </x>    Parte de la ruta que se quita al convertir (por ejemplo /v1)
      --convert <n>    Al parar la grabación, crea el mock <n> con lo grabado
      --name <n>       Nombre del mock nuevo (convert)
      --into <mock>    Añade lo grabado a un mock existente (convert)
      --strict         El casete exige el orden grabado (replay)

Generales:
  -h, --help           Muestra esta ayuda
  -v, --version        Muestra la versión
`;

/** node:util reports parse errors in English; the CLI speaks Spanish. */
function describeParseError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown }).code;
  // Messages name options as "'-p, --port <value>'" or "'--watch'": prefer the long form.
  const option = /--[\w-]+/.exec(message)?.[0] ?? /-\w/.exec(message)?.[0] ?? "";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return `Opción desconocida: ${option}`;
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") return `Falta el valor de ${option}`;
  return message;
}

/** Parses argv (without node and script). Never throws. */
export function parseCli(argv: readonly string[]): ParseResult {
  // --contract and --chaos take a value (serve), so parseArgs cannot negate them: import's --no-contract and --no-chaos are read here.
  const noContract = argv.includes("--no-contract");
  const noChaos = argv.includes("--no-chaos");
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.filter((a) => a !== "--no-contract" && a !== "--no-chaos"),
      allowPositionals: true,
      allowNegative: true,
      strict: true,
      options: {
        mock: { type: "string", short: "m", multiple: true },
        port: { type: "string", short: "p" },
        host: { type: "string" },
        watch: { type: "boolean", default: true },
        seed: { type: "string" },
        "admin-token": { type: "string" },
        contract: { type: "string" },
        chaos: { type: "string" },
        report: { type: "string" },
        "fail-on-violation": { type: "boolean" },
        format: { type: "string" },
        name: { type: "string" },
        prefix: { type: "string" },
        out: { type: "string", short: "o" },
        target: { type: "string" },
        convert: { type: "string" },
        into: { type: "string" },
        strict: { type: "boolean" },
        "read-only": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    return { ok: false, message: describeParseError(err) };
  }
  const { values, positionals } = parsed;
  if (values.version) return { ok: true, command: { kind: "version" } };
  if (values.help || positionals.length === 0) return { ok: true, command: { kind: "help" } };

  const [name, dirArg, ...rest] = positionals;
  const importOnly = values.format !== undefined || values.name !== undefined || values.prefix !== undefined || noContract || noChaos;
  const portOf = (fallback: number): number | string => {
    if (values.port === undefined) return fallback;
    if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65535) return `Puerto no válido: ${values.port}`;
    return Number(values.port);
  };
  const prefixOk = values.prefix === undefined || /^(\/[^/\s?#]+)*$/.test(values.prefix);
  const nameOk = (n: string | undefined) => n === undefined || /^[a-z0-9][a-z0-9-]{0,63}$/.test(n);

  if (name === "mcp") {
    if (rest.length > 0) return { ok: false, message: `Argumento inesperado: ${rest[0]}` };
    return { ok: true, command: { kind: "mcp", dir: dirArg ?? ".", readOnly: values["read-only"] === true } };
  }
  if (values["read-only"] !== undefined) return { ok: false, message: "--read-only solo se usa con mcp" };

  if (name === "record") {
    if (!values.target || !/^https?:\/\/[^\s]+$/.test(values.target)) return { ok: false, message: "record necesita --target con la URL http(s) de la API real" };
    if (rest.length > 0) return { ok: false, message: `Argumento inesperado: ${rest[0]}` };
    const port = portOf(3000);
    if (typeof port === "string") return { ok: false, message: port };
    if (!prefixOk) return { ok: false, message: '--prefix: algo como "/v1"' };
    if (!nameOk(values.convert)) return { ok: false, message: "--convert: minúsculas, números y guiones" };
    return { ok: true, command: { kind: "record", dir: dirArg ?? ".", target: values.target.replace(/\/+$/, ""), port, host: values.host ?? null, prefix: values.prefix ?? "", convert: values.convert ?? null } };
  }
  if (name === "convert" || name === "replay") {
    if (!dirArg) return { ok: false, message: `Falta la grabación (un .jsonl de .mockix/recordings)` };
    if (rest.length > 1) return { ok: false, message: `Argumento inesperado: ${rest[1]}` };
    if (name === "convert") {
      if (!nameOk(values.name) || !nameOk(values.into)) return { ok: false, message: "--name y --into: minúsculas, números y guiones" };
      if (values.name && values.into) return { ok: false, message: "Usa --name (mock nuevo) o --into (mock existente), no los dos" };
      if (!prefixOk) return { ok: false, message: '--prefix: algo como "/v1"' };
      return { ok: true, command: { kind: "convert", file: dirArg, dir: rest[0] ?? ".", name: values.name ?? null, into: values.into ?? null, prefix: values.prefix ?? "" } };
    }
    const port = portOf(3000);
    if (typeof port === "string") return { ok: false, message: port };
    return { ok: true, command: { kind: "replay", file: dirArg, dir: rest[0] ?? ".", port, host: values.host ?? null, strict: values.strict === true } };
  }

  if (name === "import") {
    if (!dirArg) return { ok: false, message: "Falta el archivo a importar" };
    if (rest.length > 1) return { ok: false, message: `Argumento inesperado: ${rest[1]}` };
    const format = values.format ?? null;
    if (format !== null && !["openapi", "postman", "har", "mockoon"].includes(format)) return { ok: false, message: `Formato desconocido: ${format}` };
    let port: number | null = null;
    if (values.port !== undefined) {
      if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65535) return { ok: false, message: `Puerto no válido: ${values.port}` };
      port = Number(values.port);
    }
    if (values.name !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(values.name)) return { ok: false, message: "--name: minúsculas, números y guiones" };
    if (values.prefix !== undefined && !/^(\/[^/\s?#]+)*$/.test(values.prefix)) return { ok: false, message: '--prefix: algo como "/v1"' };
    return {
      ok: true,
      command: {
        kind: "import",
        file: dirArg,
        dir: rest[0] ?? ".",
        format: format as "openapi" | null,
        name: values.name ?? null,
        port,
        prefix: values.prefix ?? null,
        contract: !noContract,
        chaos: !noChaos,
      },
    };
  }
  if (name === "export") {
    if (dirArg !== "openapi") return { ok: false, message: "Solo se exporta a OpenAPI: mockix export openapi [carpeta] -m <mock>" };
    if (rest.length > 1) return { ok: false, message: `Argumento inesperado: ${rest[1]}` };
    if (values.mock?.length !== 1) return { ok: false, message: "export necesita exactamente un --mock" };
    return { ok: true, command: { kind: "export", dir: rest[0] ?? ".", mock: values.mock[0]!, out: values.out ?? null } };
  }
  if (importOnly || values.out !== undefined) return { ok: false, message: `Las opciones de import o export no se usan con ${name}` };
  if (rest.length > 0) return { ok: false, message: `Argumento inesperado: ${rest[0]}` };
  const dir = dirArg ?? ".";
  const serveOnly =
    values.mock !== undefined ||
    values.port !== undefined ||
    values.host !== undefined ||
    values.watch === false ||
    values.seed !== undefined ||
    values["admin-token"] !== undefined ||
    values.contract !== undefined ||
    values.chaos !== undefined ||
    values.report !== undefined;
  const failOnViolation = values["fail-on-violation"] === true;

  if (name === "validate" || name === "init") {
    if (serveOnly || (name === "init" && failOnViolation)) return { ok: false, message: `Las opciones de serve no se usan con ${name}` };
    return { ok: true, command: name === "init" ? { kind: "init", dir } : { kind: "validate", dir, failOnViolation } };
  }
  if (name !== "serve") return { ok: false, message: `Comando desconocido: ${name}` };

  let port: number | null = null;
  if (values.port !== undefined) {
    if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65535) return { ok: false, message: `Puerto no válido: ${values.port}` };
    port = Number(values.port);
  }
  if (values.host !== undefined && values.host.trim() === "") return { ok: false, message: "--host no puede estar vacío" };
  const mocks = values.mock ?? [];
  if (port !== null && mocks.length !== 1) return { ok: false, message: "--port necesita exactamente un --mock" };
  let seed: number | null = null;
  if (values.seed !== undefined) {
    if (!/^\d{1,9}$/.test(values.seed)) return { ok: false, message: `Semilla no válida: ${values.seed} (un entero positivo)` };
    seed = Number(values.seed);
  }
  const adminToken = values["admin-token"] ?? null;
  if (adminToken !== null && adminToken.length < 12) return { ok: false, message: "--admin-token necesita al menos 12 caracteres" };
  const contract = values.contract ?? null;
  if (contract !== null && !["off", "warn", "strict"].includes(contract)) return { ok: false, message: `Modo de contrato no válido: ${contract} (off, warn o strict)` };
  const chaos = values.chaos ?? null;
  if (chaos !== null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(chaos)) return { ok: false, message: `Perfil de caos no válido: ${chaos}` };
  const report = values.report ?? null;
  if (report !== null && !/\.(xml|json)$/i.test(report)) return { ok: false, message: "--report necesita un archivo .xml (JUnit) o .json" };
  return {
    ok: true,
    command: { kind: "serve", dir, mocks, port, host: values.host ?? null, watch: values.watch ?? true, seed, adminToken, contract: contract as "off" | null, chaos, report, failOnViolation },
  };
}
