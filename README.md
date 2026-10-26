<img src="docs/logo.svg" width="72" alt="" align="right">

# Mockix

Simulador de APIs local primero: HTTP, WebSocket, Socket.IO y gRPC, con app de escritorio, CLI y Docker. Es la app hermana de Sendix. Sistema visual en [docs/DESIGN.md](docs/DESIGN.md).

**¿Primera vez?** Empieza por la [guía rápida](docs/GUIA-RAPIDA.md) (también en [protohub.digital/mockix/guia](https://protohub.digital/mockix/guia/)). Cada función se explica en el [manual de uso](docs/MANUAL.md).

Estado: **0.1.4 publicada**: instalador de Windows con auto-actualización en [GitHub Releases](https://github.com/LuisEBautistaR/mockix/releases/latest) y en [protohub.digital/mockix](https://protohub.digital/mockix/), la CLI en npm como `@fulerbdev/mockix` y la imagen Docker en `ghcr.io/luisebautistar/mockix`.
- **Formato y servidor (M1):** un archivo YAML por ruta, reglas, modos, CORS, TLS y recarga en caliente.
- **Plantillas y datos (M2):** datos falsos reproducibles, data buckets, CRUD, callbacks, proxy parcial, API de control y log en SQLite.
- **Escritorio (M3):** el editor del prototipo aprobado. Crea mocks y rutas, edita las respuestas, las prueba y muestra cada petición con su desglose de tiempos.
- **Importar (M4):** crea mocks desde OpenAPI 3/Swagger 2, colecciones de Postman v2.x (también las de Sendix), HAR y entornos de Mockoon, con informe. Los mocks también se exportan a OpenAPI 3.1.
- **Grabar y reproducir (M5):** un proxy graba el tráfico real, lo convierte en un mock sin credenciales (nuevo o añadido a uno existente) y lo reproduce como casete en los tests.
- **Contrato y escenarios (M6):**
  - **Contrato:** cada petición se valida contra un OpenAPI 3.0/3.1, y también las respuestas del propio mock. Hay modo avisar y modo estricto (400 `problem+json`), e informe JUnit para CI.
  - **Escenarios:** máquinas de estado por clave (un pedido, un pago) que avanzan con peticiones o con el tiempo, y que las rutas leen en sus reglas y plantillas.
- **Tiempo real y gRPC (M8):** rutas WebSocket y namespaces de Socket.IO con guiones al conectar, respuestas por reglas, difusión, salas y ack. Servidor gRPC con los cuatro tipos de llamada, estados y trailers, reflection y TLS.
- **Publicación (M10):** logo, instalador NSIS con auto-actualización desde GitHub Releases, paquete npm de la CLI, imagen Docker sin shell e integración con Sendix (`mockix://`, `running.json`, entornos y "Abrir en Sendix").
- **Agentes (M9):** servidor MCP para que un agente de IA cree rutas, las pruebe y lea el log. Funciona por stdio (`mockix mcp`) o en el escritorio por HTTP con token, y cada escritura espera tu aprobación.
- **Caos (M7):** perfiles de latencia, jitter y errores que cambian con el tiempo, más conexiones cortadas, peticiones sin respuesta y cuerpos lentos. Se aplican por mock, carpeta o ruta, y con semilla se repiten en CI.

## Instalación

| Dónde | Cómo |
|---|---|
| **Windows** | `Mockix-<versión>-setup.exe` de GitHub Releases. Instala por usuario (sin administrador), registra `mockix://` y se actualiza solo. Una actualización no quita `mockix://`, y si algo lo quita, Mockix lo vuelve a registrar al recibir el foco. |
| **CLI** | `npm i -g @fulerbdev/mockix`, con Node 22 o superior. Instala el comando `mockix`. El nombre lleva prefijo porque npm rechaza `mockix` por parecido a otro paquete. |
| **Docker** | `docker run --rm --read-only -v ./MiProyecto:/mocks -p 3000:3000 ghcr.io/luisebautistar/mockix:v0.1.4` |

**Docker:**
- **Etiquetas:** una por versión (`v0.1.4`) y `latest`, que apunta a la más reciente.
- **Empezar:** sin un workspace, `docker run --rm -v ./MiProyecto:/mocks ghcr.io/luisebautistar/mockix:v0.1.4 init /mocks` crea el de ejemplo (sin `--read-only`, porque escribe los archivos). Con `import` y `validate` pasa lo mismo: el último argumento es la carpeta, `/mocks`.
- **Imagen:** parte de `distroless/nodejs24` (sin shell ni gestor de paquetes) y corre como usuario sin privilegios.
- **Escritura:** con `--read-only` solo escribe en el volumen montado (`.mockix/` del workspace).
- **Mocks:** sirve los de `/mocks` escuchando en `0.0.0.0`; el aviso que lo dice al arrancar es normal dentro del contenedor, que solo es accesible por los puertos que publiques con `-p`. Publica el puerto de cada mock (`-p 3001:3001`).
- **Salud:** el `HEALTHCHECK` consulta `/__mockix/health` en el puerto `MOCKIX_HEALTH_PORT` (3000 por defecto).
- **gRPC:** pon un puerto fijo en `mock.yaml` (`grpc: { port: 50051 }`) y publícalo con `-p 50051:50051`.

**Actualizaciones:** la app instalada busca una versión nueva unos segundos después de arrancar y la descarga en segundo plano. En **Ajustes → Actualizaciones** se ve el estado, se puede buscar a mano y se reinicia para instalar. Si no se reinicia, se instala al cerrar. Las versiones de desarrollo no se actualizan.

## Integración con Sendix

| Desde | Qué pasa |
|---|---|
| Sendix: "crear mock desde esta colección" | Abre `mockix://import?collection=<archivo>&workspace=<carpeta>`. Mockix valida el enlace (rutas absolutas, `.json`/`.yaml`/`.har`, la carpeta debe ser un workspace) y **pide confirmación** antes de importar. `mockix://open?workspace=<carpeta>` abre una carpeta, también tras confirmar. |
| Mockix en marcha | Escribe `.mockix/running.json` con la URL de cada mock (y su gRPC), en la app y en `mockix serve`. Si la carpeta también es un workspace de Sendix (`sendix.workspace.json`), escribe `environments/Mock <mock>.postman_environment.json` con `baseUrl` (y `grpcTarget`). Solo toca los entornos que escribió él (marca `x-mockix`). |
| Mockix → Sendix | Si Sendix registró `sendix://`, cada ruta tiene un botón **Sendix** junto a **Probar**, que abre la petición allí. |
| Sendix → historial en HAR | Se importa como grabación ([M5](#grabar-y-reproducir-m5)). |
| gRPC | El mock activa reflection y Sendix descubre el servicio sin `.proto`. |

## Requisitos

- Node.js 22.12 o superior (probado con 24.22) y npm 11.
- Windows 10/11 x64 para empaquetar la app de escritorio.

```bash
npm install
```

npm 11 bloquea los scripts de instalación que no están aprobados. `package.json` → `allowScripts` aprueba el de `electron`, que descarga el binario, y deniega el de `electron-winstaller`, que no se usa porque el instalador es NSIS. Si `node_modules/electron/dist` queda vacío, ejecuta `node node_modules/electron/install.js`.

## Monorepo

```
packages/
├─ core/      @mockix/core: modelo de mock (zod) y servidor HTTP. Node puro, sin Electron
└─ cli/       @mockix/cli: binario `mockix`
apps/
└─ desktop/   @mockix/desktop: Electron (main, hosts de mocks, preload, renderer)
docs/         DESIGN.md (lo propio de Mockix) y DESIGN-base.md (sistema compartido con Sendix)
```

El mismo `core` sirve los mocks en los tres sitios: la CLI lo importa compilado (`dist/`) y el escritorio lo empaqueta desde el código fuente, así que el instalador no necesita `node_modules`.

## Scripts (desde la raíz)

| Script | Qué hace |
|---|---|
| `npm run typecheck` | TypeScript estricto: core y CLI (`tsc -b`), y los tres proyectos del escritorio (node, web y e2e) |
| `npm test` | Tests unitarios de los tres paquetes (Vitest), desde el código fuente |
| `npm run build` | Compila core y CLI a `dist/` y el escritorio a `apps/desktop/out/` |
| `npm run test:e2e` | Binario real de la CLI y app de Electron real con Playwright (necesita `build`) |
| `npm run check` | Todo lo anterior, en orden |
| `npm run dev -w @mockix/desktop` | App de escritorio con recarga en caliente |
| `npm run dist` | Instalador NSIS en `apps/desktop/release/<versión>/` (con `latest.yml` para la auto-actualización) |
| `npm run pack:cli` | Paquete npm de la CLI en `packages/cli/npm/` (el núcleo va dentro de `dist/bin.js`) y su `.tgz` en `release/` |
| `npm run docker` | Imagen `mockix:dev` desde ese paquete |

## Formato del workspace

```
MiProyecto/
├─ mockix.workspace.yaml          format: 1 y, opcional, el orden de los mocks
├─ .gitignore                     .mockix/ (estado local: certificados, grabaciones…)
├─ contracts/                     contratos OpenAPI que los mocks pueden usar (M6)
├─ chaos/                         perfiles de caos, varios por archivo (M7)
├─ protos/                        archivos .proto de los servicios gRPC (M8)
└─ mocks/
   └─ tienda/
      ├─ mock.yaml                port, host, prefix, cors, latency, tls, order, contract
      ├─ data/                    data buckets (JSON semilla)
      ├─ files/                   archivos que sirven las rutas (body: { file: /files/logo.svg })
      ├─ scenarios/               máquinas de estado, una por archivo (M6)
      ├─ grpc/                    servicios gRPC, uno por archivo (M8)
      └─ routes/                  un .yaml por ruta; las subcarpetas solo organizan
         └─ productos/
            ├─ get-producto.yaml
            └─ get-producto.200.json
```

```yaml
# mocks/tienda/routes/productos/get-producto.yaml
id: productos/obtener          # opcional; por defecto, la ruta del archivo
method: GET                    # GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS o ANY
path: /productos/:id           # :param, * al final, o una expresión regular que empiece por ^
mode: rules                    # rules | random | sequential | fallback
latency: 40ms                  # se suma a la del mock y a la de la respuesta
responses:
  - id: ok
    default: true              # si ninguna regla coincide (por defecto, la primera)
    body: { file: get-producto.200.json }   # o un texto, { inline: … } o { json: … }
  - id: no-existe
    status: 404
    headers: { X-Motivo: catalogo }
    body: { json: { error: no existe } }
    rules:
      mode: all                # all | any
      when:
        - { target: params.id, op: regex, value: '^9\d+$' }
```

- **Objetivos de las reglas:** `body`, `body.campo[0].sub`, `query.x`, `header.x`, `cookie.x`, `params.x`, `method`, `path` y `request.number`.
- **Operadores:** `equals`, `regex`, `exists`, `empty`, `null`, `contains`, `in`, `gt`, `gte`, `lt` y `lte`. Con `negate: true` se invierte el resultado. Las reglas sobre el estado de escenarios (`state.*`) llegan en M6.
- **Rutas de los archivos:** se resuelven desde el archivo de la ruta; si empiezan por `/`, desde la carpeta del mock. Nunca pueden salir de la carpeta del mock.
- **Content-Type:** si la respuesta no lo indica, se deduce de la extensión o del cuerpo.
- **`tls: true`:** usa un certificado para `localhost` generado una vez por workspace en `.mockix/tls/`, que no va a git. Con `tls: { cert, key }` se usa uno propio.
- **CORS:** activo por defecto. Responde a los preflight y añade `Access-Control-Allow-Origin` a cada respuesta.
- **Problemas:** cada problema se informa con archivo, línea y ruta del campo, en español. Un mock con problemas no arranca. Si ya estaba en marcha, sigue con la última versión buena hasta que se corrija.

## Plantillas, datos y más (M2)

Los cuerpos de texto, las cabeceras y los callbacks son plantillas Handlebars. Para servir una respuesta tal cual, sin plantilla, se pone `template: false`.

```json
{
  "id": "{{urlParam 'id'}}",
  "nombre": "{{default (dataFind 'productos' 'id' (urlParam 'id') 'nombre') (faker 'commerce.productName')}}",
  "moneda": "{{getVar 'moneda'}}",
  "pedidos": [{{#repeat 2}}{ "total": {{float 100 900 2}} }{{/repeat}}]
}
```

| Grupo | Helpers |
|---|---|
| Petición | `urlParam`, `queryParam`, `header`, `cookie`, `body 'a.b[0]'`, `bodyRaw`, `method`, `path`, `jwtPayload 'campo'` (sin verificar la firma) |
| Variables | `getVar`, `setVar` (por petición), `envVar` (solo las variables de entorno listadas en `env:` del workspace) |
| Datos | `data 'bucket' 'ruta'`, `dataRaw`, `dataFind 'bucket' 'campo' valor 'ruta'` |
| Generados | `faker 'modulo.metodo'` (locale es_MX), `uuid`, `objectId`, `int min max`, `float min max decimales`, `boolean`, `oneOf`, `array`, `now 'iso'\|'date'\|'time'\|'unix'\|'ms' add='1d'` |
| Lógica y texto | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`, `includes`, `default`, `lowercase`, `uppercase`, `concat`, `json`, `len`, `base64`, `base64Decode` |
| Bloques | `#repeat n` o `#repeat min max` (con `@index`, `@first`, `@last`; separa con comas salvo `comma=false`), además de `#if`, `#unless`, `#each` y `#with` |

- **Errores en plantillas:** solo existen esos helpers. Un nombre desconocido o una plantilla mal cerrada es un problema al cargar, con el archivo. Si algo falla al responder, la respuesta es un `500` con `X-Mockix: template-error` y el motivo, que también queda en el log.
- **`}}}` al final:** se puede escribir `"n": {{int 1 9}}}` aunque Handlebars normalmente lo leería como triple llave.
- **Límites:** 1000 repeticiones por bucle, 100 000 iteraciones y 10 MB por respuesta.
- **Semilla:** con `--seed` (CLI), Faker y el azar (modo aleatorio y helpers) dan la misma secuencia en cada ejecución.
- **Variables:** se definen en `mockix.workspace.yaml` (`variables:`) y en `mock.yaml` (`variables:`); las del mock ganan.
- **Data buckets:** cada `mocks/<nombre>/data/<bucket>.json` es un bucket. Viven en memoria y nunca se escriben en disco. Al recargar, un bucket vuelve a su semilla solo si su archivo cambió.
- **Rutas CRUD:**
  ```yaml
  path: /inventario
  crud: { bucket: inventario, key: id }
  ```
  - `GET` lista con filtros por campo (`?sucursal=cdmx`), orden (`?sort=stock&order=desc`), paginación (`?limit=20&page=2`) y `X-Total-Count`.
  - `GET /:id`, `POST` (genera el id si falta; responde `201` con `Location`; `409` si ya existe), `PUT`, `PATCH` y `DELETE`.
  - Responde `405` con `Allow` para los métodos que no aplican.
  - Con `list: { items: data, total: total }` la lista va envuelta en un objeto (`{ "data": [...], "total": 3 }`), como responden muchas APIs.
- **Callbacks:** van en cada respuesta: `callbacks: [{ url, method, headers, body, delay }]`. Se envían después de responder y solo a los hosts de `mock.yaml` → `callbacks.allow`, para que un mock no sirva de trampolín. El resultado (estado o error) aparece en el log.
- **Proxy parcial:** se activa en `mock.yaml` → `proxy: { target, keepPrefix, insecure, headers }`. Lo que ninguna ruta atiende (o lo que deja pasar una ruta `fallback`) va a la API real con su método, ruta, query, cabeceras y cuerpo. Si la API real no responde, contesta `502` con `X-Mockix: proxy-error`.
- **API de control:** con `--admin-token` (o `MOCKIX_ADMIN_TOKEN`, mínimo 12 caracteres) se activa bajo `/__mockix/` en el mismo puerto.
  - Endpoints: `GET /logs`, `DELETE /logs`, `GET /buckets`, `GET/PUT /buckets/:nombre`, `POST /buckets/:nombre/reset`, `GET /vars`, `PUT /vars/:nombre`, `POST /reset`.
  - `GET /__mockix/health` responde siempre, también para el `HEALTHCHECK` de Docker. Sin token, el resto no existe (`404`). Con un token incorrecto, responde `401`.
- **Log:** guarda cabeceras y cuerpos (hasta 64 KB) de cada petición y respuesta. `Authorization`, `Cookie`, `Set-Cookie` y las cabeceras de claves de API se guardan como `[redactado]`. En el escritorio se guarda en `mockix.db` (SQLite, dentro de los datos de usuario), con un máximo de 5000 peticiones por mock, y se puede vaciar.

## Importar y exportar (M4)

Cada importación crea un mock nuevo en `mocks/<nombre>/` con un informe de lo que se convirtió, lo que se generó, lo que se omitió y por qué. El formato se detecta por el contenido, en JSON o YAML.

| Fuente | Qué se obtiene |
|---|---|
| **OpenAPI 3.0/3.1 y Swagger 2** | Una ruta por operación (`{id}` pasa a `:id`), en la carpeta de su primera etiqueta. Una respuesta por código, con la primera 2xx por defecto; las demás responden con `X-Mockix-Respuesta: <código>` o `?mockix_respuesta=<código>`. El cuerpo sale del ejemplo; si no hay, del esquema, como plantilla con datos falsos según el tipo, el formato y el nombre del campo (`email`, `nombre`, `telefono`…). El prefijo sale de `servers[0]`. Además, ver abajo. |
| **Postman v2.0/v2.1 y Sendix** | Cada petición con ejemplos guardados es una ruta, y cada ejemplo una respuesta. Lo que distingue a las peticiones originales de los ejemplos (variable de ruta, query o cabecera `X-…`) se convierte en la regla. Las variables de la colección pasan a ser variables del mock (`{{moneda}}` se convierte en `{{getVar 'moneda'}}`) y las dinámicas conocidas (`{{$guid}}`, `{{$randomEmail}}`…) en helpers. La ruta de `{{baseUrl}}` se usa como prefijo. Las peticiones WebSocket o gRPC de Sendix se omiten hasta M8. |
| **HAR** | Infiere parámetros a partir de valores con forma de id (números, UUID, hashes, `prd_7Qm2`, `CAF-VER-500`), agrupa las respuestas distintas de una ruta y deduce sus reglas. Quita cabeceras y parámetros con credenciales, cambia tokens, correos y teléfonos por datos falsos y escapa los `{{` literales. Es el mismo conversor que usará la grabación (M5). |
| **Entorno de Mockoon** | Rutas, respuestas, reglas (y/o, negación), modos aleatorio, secuencial y fallback, latencias, cabeceras del entorno, data buckets, rutas CRUD, prefijo, CORS y proxy. Las respuestas con helpers sin equivalente se sirven como texto, con aviso. Las rutas WebSocket se omiten hasta M8. |

**Un mock completo desde un contrato.** Con un OpenAPI, la importación (y **Nuevo mock → Desde un contrato OpenAPI** en el escritorio) también:
- **Conecta el contrato:** lo copia a `contracts/` (o reutiliza el que ya está ahí con el mismo contenido) y lo pone en `mock.yaml` en modo `warn`. Solo OpenAPI 3; un Swagger 2 no se conecta y el informe lo dice. `--no-contract` lo evita.
- **Datos y CRUD:** un recurso con `GET /x`, `GET /x/{id}` y alguna escritura (`POST /x`, `PUT`, `PATCH` o `DELETE /x/{id}`) pasa a un bucket con los ejemplos (o 3 registros generados del esquema) y una ruta CRUD; una lista envuelta en `{ data, total }` usa `crud.list`.
- **Escenarios:** un campo `estado`, `status`, `estatus`, `state`, `situacion` o `etapa` con `enum`, más acciones `POST/PUT/PATCH /x/{id}/<acción>` (o `DELETE` hacia un estado de cancelación), da `scenarios/x.yaml`. Los estados siguen el orden del `enum` y cada acción va al estado que más se le parece (`pago` → `pagado`). `GET /x/{id}` responde el estado actual con el valor original del contrato.
- **Caos:** `chaos/<mock>.yaml` con `<mock>-lenta`, `<mock>-inestable` y `<mock>-caida`, que usan los 5xx documentados, sin aplicar. `--no-chaos` lo evita.
- **Ids:** un ejemplo con el campo del `{id}` de la ruta responde con el id pedido.

El informe dice qué se dedujo y por qué no se dedujo lo demás.

- Se respeta el orden de la fuente (`order` en `mock.yaml`), porque responde la primera ruta que coincide.
- Si el puerto de la fuente ya lo usa otro mock del workspace, el nuevo recibe el siguiente libre.
- **Exportar:** `mockix export openapi` o el botón **OpenAPI** del mock escriben un OpenAPI 3.1 con rutas, parámetros y respuestas (con su ejemplo cuando el cuerpo no es una plantilla). Exportar e importar de nuevo da las mismas operaciones y códigos.

## Grabar y reproducir (M5)

Mockix se pone delante de la API real como proxy. El cliente apunta al proxy, cada petición llega a la API y la respuesta vuelve sin cambios. Cada intercambio queda guardado.

- **Dónde:** `.mockix/recordings/<fecha>-<host>.jsonl`, una línea por intercambio, con los cuerpos binarios en base64. Es el material en crudo, con credenciales incluidas, así que nunca va a git (el `.gitignore` del workspace excluye `.mockix/`).
- **Convertir:** usa el mismo conversor que HAR.
  - Infiere los parámetros (`/cosas/7` y `/cosas/8` pasan a `/cosas/:id`) y agrupa las respuestas distintas de cada ruta con las reglas que las separan.
  - Si un cuerpo repite un parámetro de la ruta, se convierte en `{{urlParam 'id'}}`.
  - Puede crear un mock nuevo o **añadir a un mock existente**. En ese caso solo agrega las rutas nuevas (en `routes/grabadas/`) y las respuestas que aún no tenía, sin tocar lo demás.
- **Redacción:** antes de escribir nada al mock se quitan las cabeceras y parámetros con credenciales (`Authorization`, `Cookie`, `Set-Cookie`, `api_key`…). Los tokens, correos y teléfonos de los cuerpos se cambian por plantillas `{{faker …}}`. El perfil se puede cambiar en `mockix.workspace.yaml`:

```yaml
redaction:
  - where: json          # json, header o query
    match: "token|secret|password"   # nombres separados por |
    action: faker        # faker o remove
    faker: string.alphanumeric 24
```

- **Casete (`replay`):** sirve exactamente lo grabado, sin convertirlo. Lo que no está en la grabación recibe `599` con `X-Mockix: cassette-miss`, y el comando termina con código `2`, así un test de integración falla si el cliente pide algo nuevo. `--strict` exige además el orden grabado.

En el escritorio, el botón **Grabaciones** del rail abre la vista:
- Arriba, el proxy (`localhost:<puerto> → API real`) con **Grabar / Detener** y el contador en vivo.
- A la izquierda, **Tráfico** (cada intercambio) y **Rutas detectadas** (qué ruta sale de cada grupo y si es nueva, añade respuestas o ya existe), con el prefijo a quitar y el destino.
- A la derecha, la **vista previa de redacción**: el intercambio tal como se grabó y el cuerpo que irá al mock. También el perfil de redacción en uso.
- **Convertir en mocks** escribe los archivos y muestra el informe. Las grabaciones se pueden mover a la papelera.

```bash
mockix record . --target https://api.real.example -p 4100 --prefix /v1 --convert real
mockix convert 2026-10-25T09-00-00-api.real.example.jsonl . --into tienda --prefix /v1
mockix replay 2026-10-25T09-00-00-api.real.example.jsonl . -p 4100
```

## Contrato OpenAPI (M6)

Un mock se asocia a un contrato de `contracts/` en su `mock.yaml`:

```yaml
contract:
  file: contracts/tienda.openapi.yaml   # relativo al workspace
  mode: warn          # off, warn (registra y responde igual) o strict (400 problem+json)
  responses: true     # valida también las respuestas del mock (por defecto, sí)
```

**Qué se valida en cada petición**, con ajv y el esquema del contrato:
- La operación (ruta y método).
- Los parámetros de ruta, query, cabecera y cookie, con su tipo y si son obligatorios.
- El `Content-Type` y el cuerpo.

Cada fallo se explica en español y con el valor recibido: `body.lineas[0].cantidad debe ser integer (recibido "2", un string)`. OpenAPI 3.0 se adapta solo (`nullable`, `exclusiveMinimum` booleano).

**Nuestras respuestas:** cada respuesta del mock se valida contra la que documenta el contrato (estado exacto, `2XX` o `default`). Así se detecta un mock que se quedó viejo. Pasa en vivo y también en estático: `mockix validate` y la vista Contratos renderizan las plantillas con una petición de ejemplo.

**Informe:** las violaciones se cuentan por regla (todas las peticiones que rompen la misma regla van juntas) y por cliente, según el User-Agent o el Origin.
- **CLI:** `mockix serve --report contrato.xml --fail-on-violation` escribe un JUnit al detenerse, con un caso por operación, y termina con `2` si algo no cumplió. `--contract strict` cambia el modo sin tocar `mock.yaml`.
- **API de control:** `GET /__mockix/contract` (o `?format=junit`) y `DELETE /__mockix/contract`.
- **Escritorio:** la vista **Contratos** muestra:
  - las reglas rotas, con la última petición que rompió cada una y el esquema esperado;
  - los clientes, con sus peticiones y cuántas no cumplen;
  - las respuestas del mock que no cumplen y las rutas fuera del contrato;
  - la cobertura: qué operaciones tienen mock.

  El modo se cambia ahí mismo, y el informe se exporta en JUnit o JSON.

## Escenarios con estado (M6)

Una máquina de estados declarativa por archivo, en `mocks/<mock>/scenarios/<id>.yaml`:

```yaml
key: params.id            # una instancia por pedido (sin key: una sola, compartida)
initial: creado
states: [creado, pagado, enviado, entregado, cancelado]
transitions:
  - { from: creado, to: pagado, on: { method: POST, path: /pedidos/:id/pago } }
  - { from: pagado, to: enviado, after: 10s }
  - { from: enviado, to: entregado, after: 30s }
  - { from: [creado, pagado], to: cancelado, on: { method: DELETE, path: /pedidos/:id } }
```

- **Instancias:** la primera petición con una clave nueva crea su instancia en el estado inicial.
- **Transiciones por petición:** una petición que coincide con `on` (método, ruta con `:param` y reglas opcionales) mueve la instancia si está en un estado de `from`. Se aplica antes de elegir la respuesta, así que la ruta ya ve el estado nuevo.
- **Transiciones por tiempo:** `after` mueve la instancia cuando lleva ese tiempo en el estado. Se calcula con el reloj, no con temporizadores, así que el resultado no depende de cuándo se consulte.
- **Lectura desde las rutas:** con `state.pedido` en las reglas (`{ target: state.pedido, op: in, value: [enviado, entregado] }`) y con `{{state.pedido}}` en las plantillas. Si una regla nombra un escenario o un estado que no existe, `validate` lo señala con su archivo.
- **Control:**
  - API: `GET /__mockix/scenarios`, `PUT /__mockix/scenarios/<id>/instances/<clave>` con `{"state": "…"}` para forzar un estado, y `POST /__mockix/scenarios/<id>/reset`.
  - CLI: `serve` escribe cada transición en el log (`⇢ pedido[ped_7] creado → pagado`).
  - Escritorio: la vista **Escenarios** dibuja el diagrama con el estado actual resaltado y muestra:
    - las instancias, con el tiempo que les falta para la siguiente transición;
    - el historial de cada instancia: qué la hizo avanzar;
    - cómo responde cada ruta según el estado.

    Desde ahí se puede forzar un estado o reiniciar las instancias.

El workspace de ejemplo trae los dos: `contracts/tienda.openapi.yaml` (en modo avisar) y el escenario `pedido` con `GET /pedidos/:id`, `POST /pedidos/:id/pago` y `DELETE /pedidos/:id`.

## Perfiles de caos (M7)

Un perfil es una lista de **puntos en el tiempo**. Entre dos puntos, la latencia, el jitter y la tasa de errores se interpolan en línea recta. Los perfiles viven en `chaos/*.yaml` y cada archivo puede tener varios:

```yaml
# chaos/perfiles.yaml
red-inestable:
  duration: 60s            # largo del ciclo (por defecto, el tiempo del último punto)
  loop: true               # al terminar vuelve a empezar (por defecto, sí)
  points:
    - { t: 0s,  latency: 50ms,  jitter: 10ms,  errorRate: 0 }
    - { t: 30s, latency: 800ms, jitter: 300ms, errorRate: 0.15, errors: { 500: 1, 503: 2 } }
    - { t: 45s, latency: 50ms,  jitter: 10ms,  errorRate: 0 }
  extras: { dropRate: 0.02, timeoutRate: 0.01, trickleKBps: 64 }
```

- **Efectos:**
  - **Latencia:** la de la curva, más un jitter al azar de ± el valor del punto.
  - **Errores:** la tasa del momento, con códigos ponderados (`errors: [503]` o `{ 500: 1, 503: 2 }`). La respuesta lleva `X-Mockix: chaos`.
  - **Conexión cortada** (`dropRate`): se cierra la conexión sin responder.
  - **Sin respuesta** (`timeoutRate`): la petición queda abierta hasta que el cliente se rinde (como mucho 2 minutos).
  - **Cuerpo lento** (`trickleKBps`): el cuerpo sale a esa velocidad.
- **Dónde se aplica:** en `mock.yaml` va el perfil de todo el mock, y se puede cambiar o quitar (`off`) por carpeta de `routes/`. En una ruta, `chaos: <perfil>` u `off`. Gana lo más concreto: ruta, luego la carpeta más profunda, luego el mock.

```yaml
# mocks/tienda/mock.yaml
chaos:
  profile: red-inestable
  folders: { pedidos: off }
```

- **Reproducible:** cada petición saca siempre cinco números al azar, en el mismo orden, de una secuencia propia del caos. Con `--seed`, el mismo perfil da la misma secuencia de efectos en cada ejecución, sin cambiar los datos falsos.
- **En el log:** cada petición dice qué recibió (`⚡ caos: error 503, +627 ms`), y la barra *strata* separa el tiempo de caos de la latencia configurada.
- **Control:**
  - CLI: `mockix serve --chaos red-3g --seed 42` aplica un perfil a los mocks sin tocar `mock.yaml`; `--chaos off` lo quita.
  - API de control: `GET /__mockix/chaos`, `PUT /__mockix/chaos` con `{"profile": …}`, y `POST /__mockix/chaos/pause`, `/resume` y `/restart`.
  - Escritorio: la vista **Perfiles de caos** dibuja la curva con la marca de "ahora". Los puntos se arrastran sobre la gráfica o se editan en la tabla, igual que los efectos extra, y **Aplicar cambios** los escribe en el YAML. A la derecha se ve en vivo qué efecto recibió cada petición, el resumen por ruta del último minuto y dónde se aplica cada perfil, con un selector por mock. El caos se puede pausar.
- **Perfiles de ejemplo** (en el workspace de ejemplo): `red-inestable`, `rampa`, `pico`, `red-3g` y `se-cae-a-los-30s`.

## WebSocket, Socket.IO y gRPC (M8)

**WebSocket y Socket.IO** van en `routes/` como cualquier ruta, con `protocol`:

```yaml
# routes/ws-notificaciones.yaml
protocol: ws
path: /notificaciones            # bajo el prefijo del mock: ws://localhost:3000/v1/notificaciones
onConnect:                       # lo que el servidor envía solo
  - send: { json: { tipo: hola } }
  - every: 5s
    send: |-
      { "tipo": "latido", "hora": "{{now 'iso'}}" }
messages:                        # respuestas por reglas sobre el mensaje (body.*)
  - id: pong
    rules: { when: [{ target: body.tipo, op: equals, value: ping }] }
    reply: { json: { tipo: pong } }
  - id: aviso
    rules: { when: [{ target: body.tipo, op: equals, value: aviso }] }
    broadcast: |-                # a todas las conexiones de la ruta
      { "texto": "{{body 'texto'}}" }
echo: true                       # lo que no coincide vuelve tal cual
```

```yaml
# routes/socketio-pedidos.yaml
protocol: socketio
path: /pedidos                   # namespace (el path de Socket.IO es /socket.io)
onConnect:
  - emit: bienvenida
    data: { json: { ok: true } }
messages:
  - id: seguir
    event: seguir
    join: "pedido:{{body 'id'}}"  # salas
    ack: |-                       # respuesta al callback del cliente
      { "sala": "pedido:{{body 'id'}}" }
  - id: nota
    event: nota
    emit: { event: nota, data: '{"texto": "hola"}', to: "room:pedido:{{body 'id'}}" }
```

- **Pasos de `onConnect`:** `after` (una vez, pasado un tiempo) o `every` (cada cierto tiempo, con `times` opcional).
- **Destino:** `to` puede ser `self` (el cliente), `all`, `others` o, en Socket.IO, `room:<sala>`.
- **Reglas y plantillas:** leen el mensaje con `body.*` y la conexión con `query.*`, `header.*` y `params.*`.
- **Recarga:** las conexiones abiertas siguen vivas y usan la versión nueva. Si se borra una ruta, sus conexiones se cierran.

**gRPC:** el puerto va en `mock.yaml` (`grpc: { port: 50051, tls: false, reflection: true }`) y cada servicio en `grpc/*.yaml`, con su `.proto` en `protos/`:

```yaml
# grpc/catalogo.yaml
proto: protos/catalogo.proto
service: tienda.Catalogo
methods:
  ObtenerProducto:                     # unario
    responses:
      - id: ok
        default: true
        message: { id: "{{body 'id'}}", nombre: "{{faker 'commerce.productName'}}", precio: 189 }
      - id: no-existe
        status: NOT_FOUND
        details: no existe el producto
        trailers: { x-motivo: catalogo }
        rules: { when: [{ target: body.id, op: regex, value: '^9' }] }
  ListarProductos:                     # stream del servidor: una secuencia con tiempos
    responses:
      - id: catalogo
        stream:
          - message: { id: prd_1 }
          - { message: { id: prd_2 }, delay: 200ms }
```

- **Tipos de llamada:**
  - Unario.
  - Stream del servidor: `stream` con `delay` por mensaje y `repeat`.
  - Stream del cliente: las reglas leen `body.count` y `body.messages`.
  - Bidireccional: una respuesta por mensaje que llega.
- **Estados:** `status` acepta los códigos de gRPC; además hay `details`, `metadata` y `trailers`.
- **Sin respuestas:** los métodos que no tienen responden un ejemplo generado del esquema, con datos falsos.
- **Reflection:** activa por defecto, para que Sendix (o `grpcurl`) descubran el servicio sin el `.proto`.
- **TLS:** usa el certificado del mock.
- **Imports del `.proto`:** se buscan junto al archivo y en `protos/`, nunca fuera del workspace. Los tipos de Google (`google/protobuf/*`) ya vienen incluidos.

**Importar:** las conexiones WebSocket y Socket.IO de una colección de Sendix se convierten en rutas. Los ítems gRPC se convierten en servicios y su `.proto` se copia a `protos/`. Las rutas WebSocket de Mockoon se importan conversacionales o en *streaming*.

**En el log y en el escritorio:**
- `serve` anuncia las URL de WebSocket, Socket.IO y gRPC, y escribe cada mensaje y llamada (`⇄ WS notificaciones ws3 ← {"tipo":"ping"}  → pong`).
- En la barra lateral, las rutas `WS` y `SIO` y los servicios `gRPC` abren su panel. Ahí se ven las reglas, el YAML y los mensajes en vivo.
- **Conectar** abre una conexión de prueba desde la app para enviar mensajes o eventos, y en Socket.IO muestra el ack.
- En gRPC, **Llamar** usa un mensaje de ejemplo generado del esquema y muestra el estado, la respuesta y los trailers.

## Servidor MCP para agentes (M9)

Un agente de IA (Claude Code, Claude Desktop u otro cliente MCP) puede trabajar con el workspace.

**Herramientas:**

| Para | Herramientas |
|---|---|
| Mocks | `list_mocks`, `start_mock`, `stop_mock` |
| Rutas | `list_routes`, `get_route`, `upsert_route`, `upsert_response`, `delete_route` |
| Probar y leer | `send_request`, `query_logs`, `get_log` |
| Validar e importar | `validate_workspace`, `validate_contract`, `import_openapi` |
| Grabar | `list_recordings`, `record_start`, `record_stop`, `convert_recording` |
| Estado | `get_scenario_state`, `set_scenario_state`, `apply_chaos` |

**Recursos:**
- El JSON Schema de cada archivo del formato: `mockix://schema/route`, `mock`, `realtime`, `scenario`, `chaos`, `grpc` y `workspace`.
- Los archivos del workspace: `mockix://workspace/<ruta>`, sin `.mockix/`.

**Seguridad:**
- **Validación:** cada escritura pasa por los mismos esquemas que el editor. Si un archivo válido deja su mock con problemas (por ejemplo, un `body.file` que no existe), se deja como estaba y el agente recibe la lista de problemas. Un agente no puede dejar el workspace roto.
- **Borrados:** `delete_route` mueve el archivo a `.mockix/trash/`.
- **Auditoría:** cada llamada queda en `.mockix/mcp-audit.jsonl`, con el resultado: hecho, error o rechazado.

**Por stdio:**

```bash
mockix mcp ./MiProyecto              # --read-only rechaza todo lo que escribe
```

Los mocks corren en ese proceso y se recargan cuando el agente cambia un archivo. Por stdout solo va el protocolo; los avisos van a stderr. Ejemplo de `.mcp.json` para Claude Code:

```json
{ "mcpServers": { "mockix": { "command": "mockix", "args": ["mcp", "./MiProyecto"] } } }
```

**En el escritorio:**
- **Servidor:** el botón **Agentes (MCP)** del rail lo enciende. Es *Streamable HTTP* en `127.0.0.1` (puerto libre, recordado) y está **apagado por defecto**.
- **Acceso:** pide un token, guardado cifrado con el almacén del sistema (DPAPI en Windows). Solo admite páginas locales como origen.
- **Configuración:** la vista muestra la URL, el token y la configuración lista para copiar al cliente.
- **Aprobación:** toda herramienta que escribe muestra un diálogo ("Un agente quiere crear GET /envios/:id en tienda") con los argumentos, para aprobar o rechazar. Sin respuesta en 2 minutos, se rechaza. **Confiar en esta sesión** aprueba sin preguntar hasta cerrar la app.
- **Auditoría:** se ve en la vista y se guarda en `.mockix/mcp-audit.jsonl`.

## CLI

```bash
node packages/cli/dist/bin.js init mi-proyecto
node packages/cli/dist/bin.js serve mi-proyecto
```

```
Uso: mockix <comando> [carpeta] [opciones]

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

Opciones de record, convert y replay:
      --target <url>   API real a la que se reenvía todo (record)
  -p, --port <n>       Puerto del proxy o del casete (por defecto 3000)
      --prefix </x>    Parte de la ruta que se quita al convertir (por ejemplo /v1)
      --convert <n>    Al parar la grabación, crea el mock <n> con lo grabado
      --name <n>       Nombre del mock nuevo (convert)
      --into <mock>    Añade lo grabado a un mock existente (convert)
      --strict         El casete exige el orden grabado (replay)
```

- **Recarga:** `serve` aplica los cambios al guardar. Si cambian el puerto, el host o TLS, reinicia ese mock.
- **Registro:** cada petición sale en una línea con hora, método, ruta, estado, duración, latencia simulada y `ruta → respuesta`.
- **Red:** escucha en `127.0.0.1` por defecto. Si un mock escucha en otra interfaz, la CLI avisa.
- **Códigos de salida:** `0` bien; `1` problemas en los archivos, argumentos no válidos o un mock que no pudo arrancar (por ejemplo, `PORT_IN_USE`); `2` el casete recibió peticiones que no estaban grabadas, o hubo violaciones del contrato con `--fail-on-violation`.

## Escritorio: uso

- **Barra de título:** carpeta abierta, búsqueda de rutas (`Ctrl K`), estado del mock seleccionado con botón para iniciarlo o detenerlo, y tema claro u oscuro. En Ajustes también se puede elegir que siga al sistema.
- **Barra lateral:**
  - El árbol de mocks y rutas, agrupadas por las subcarpetas de `routes/`, con los parámetros resaltados.
  - Botones para abrir otra carpeta, crear un mock y crear una ruta (de respuestas fijas o CRUD sobre un bucket).
  - Abajo, los data buckets del mock.
- **Pestañas de rutas:** el punto indica cambios sin guardar. La línea de la ruta permite cambiar el método y la ruta (los `:param` se ven resaltados mientras se escribe) y muestra el archivo.
  - **Probar** (`Ctrl Enter`) envía la petición desde el proceso principal, con los parámetros con valor `1`.
  - **Guardar** (`Ctrl S`) escribe el YAML y los archivos de cuerpo. Si algo no valida, se muestra el motivo por campo y no se toca el disco.
- **Editor de respuestas:**
  - Una ficha por respuesta: añadir, duplicar, quitar, y la bandera de la respuesta por defecto.
  - **Cuerpo:** estado, Content-Type, latencia, editor con las plantillas `{{…}}` resaltadas y **Vista previa**, que renderiza la plantilla con una petición de ejemplo y semilla fija.
  - **Cabeceras, Reglas** (todas o alguna, negación), **Latencia** (mock + ruta + respuesta) y **Documentación**.
  - Debajo: el orden en que se evalúan las respuestas con sus aciertos, el modo de la ruta, qué más la afecta (latencia total, proxy, callbacks) y el YAML tal como está en disco.
  - **Mover a la papelera:** las rutas no se borran de forma permanente; van a la papelera del sistema.
- **Log en vivo:**
  - La cabecera muestra la petición seleccionada con la barra *strata*: recepción, proceso, latencia, caos (M7) y envío, con lo simulado y el total.
  - Las pestañas **Petición** y **Respuesta** enseñan cabeceras (con credenciales redactadas) y cuerpo.
  - Desde un registro se puede crear una ruta (en `routes/desde-log/`) o copiar la petición como cURL. El filtro **Errores** y **Vaciar** completan la vista.

## Escritorio: arquitectura

```
src/
├─ main/      ventana, protocolo app://, seguridad, MockManager, HostProcess, router IPC
├─ host/      utilityProcess (uno por mock en marcha): servidor RPC y handlers sobre @mockix/core
├─ preload/   puente mínimo window.mockix (sandbox + contextIsolation)
├─ renderer/  React 19, tokens del diseño aprobado, fuentes autoalojadas
└─ shared/    contratos: sobres RPC (rpc.ts), métodos del host (host-methods.ts), canales IPC (ipc.ts)
```

- **Edición.** El main edita el workspace con las funciones de edición del núcleo (`packages/core/src/edit.ts`), las mismas que usará el MCP en M9. Valida cada borrador con los mismos esquemas que el cargador y actualiza el YAML en su sitio, conservando comentarios y orden de claves. La recarga en caliente hace el resto.
- **Carpeta de trabajo.** El main es el único proceso que lee el disco. Carga el workspace, lo vigila y entrega a cada host la definición ya resuelta, con los cuerpos leídos. Al guardar un archivo, el host aplica la versión nueva sin reiniciar el proceso. La carpeta abierta se recuerda en `settings.json`, dentro de los datos de usuario.
- **Un proceso por mock.** Al iniciar un mock, `MockManager` lanza un `utilityProcess` y le pide `mock.start` por un MessagePort con RPC tipado (zod en los dos extremos). Si un mock falla, los demás y la ventana siguen vivos.
- **Recuperación.** Si el proceso de un mock muere, el main lo reinicia con espera creciente (250 ms → 5 s) y vuelve a servir el mock **en el mismo puerto**, para que los clientes no tengan que cambiar nada. Si cae más de 5 veces en 60 s, el mock queda "Con errores".
- **El renderer nunca habla con un host.** Solo tiene canales con nombre: listar, iniciar, detener y probar. El main comprueba el remitente y valida el id. "Probar" envía `GET /` desde el main, así que la CSP de la interfaz no tiene que permitir localhost.
- Los errores siempre llegan como `{ ok: false, error: { code, message } }`, nunca como excepciones. Ejemplos de código: `PORT_IN_USE`, `NOT_FOUND`, `HOST_EXITED`.

## Seguridad (verificada)

| Medida | Cómo se comprueba |
|---|---|
| `contextIsolation`, `sandbox`, sin `nodeIntegration`, sin `webviewTag` | E2E lee las preferencias aplicadas |
| UI servida desde `app://mockix` con CSP estricta (`default-src 'none'`, sin `unsafe-eval`) | E2E: `eval` bloqueado, origen correcto, `fetch` a localhost bloqueado |
| Sin ventanas emergentes ni navegación fuera de la app; todos los permisos web denegados | E2E: `window.open` y cambio de `location` |
| IPC solo desde el marco principal de la app; ids validados; ganchos de prueba solo con `MOCKIX_TEST=1` en builds sin empaquetar | E2E (también sobre el `.exe` empaquetado) + unitarios |
| Mocks en `127.0.0.1` por defecto; aviso explícito en la CLI si se escucha en la red | unitarios del core y de la CLI |
| Rutas de `app://` sin escapar de la carpeta del renderer | unitarios (incluye `..%5c`) |
| Fuses empaquetados: RunAsNode, NODE_OPTIONS e `--inspect` desactivados; integridad del asar y solo `app.asar` activados; cookies cifradas; sin privilegios extra de `file://` | Lectura de los bytes de fuses del `Mockix.exe` empaquetado |
| La app empaquetada se cierra si arranca con `--remote-debugging-port`, `--remote-debugging-pipe` o `--inspect` (ningún fuse cubre los switches de Chromium) | Prueba sobre el `.exe`: sale con código 1 y el puerto nunca se abre |
| Enlaces `mockix://` validados con zod y siempre confirmados por el usuario | unitarios + E2E con el enlace en la línea de comandos |
| MCP del escritorio solo en `127.0.0.1`, con token cifrado (safeStorage) y aprobación de cada escritura | E2E con un cliente MCP real |

## Problemas conocidos

- **Sin firma de código:** el instalador aún no está firmado (la firma con SignPath está pendiente), así que SmartScreen avisa al instalarlo. El workflow de release firma en cuanto existan sus secretos.
- **Icono y versión del `.exe`:** el paso propio de `electron-builder` falla en este equipo por un bloqueo transitorio del archivo. `build/after-pack.cjs` los escribe un paso antes y reintenta.

## Publicar una versión

1. Sube la versión en los `package.json` (raíz, `apps/desktop`, `packages/core`, `packages/cli` y su dependencia `@mockix/core`) y haz commit.
2. Prepara el release, de una de dos formas:
   - **En local** (como la 0.1.1): `npm run dist` y `npm run pack:cli`, y luego `gh release create v<v> --target main` con `Mockix-<v>-setup.exe`, su `.blockmap`, `latest.yml`, el `.sha256` y `mockix-<v>.tgz`. El release queda publicado al momento.
   - **En GitHub:** crea el tag (`git tag v<v> && git push origin v<v>`) y ejecuta a mano el workflow `release` sobre ese tag. Pasa `npm run check` en Windows, genera el instalador y deja un **borrador** de release con el instalador, su `.blockmap` y `latest.yml`. Revisa el borrador y publícalo.
3. Al publicarse el release, el workflow `release` (`.github/workflows/release.yml`) publica la CLI en npm y la imagen Docker en `ghcr.io` (`v<v>` y `latest`; una versión preliminar no mueve `latest`). Crear o subir un tag solo no publica nada.
4. Secretos opcionales; sin ellos, ese paso se salta:
   - `NPM_TOKEN` publica `@fulerbdev/mockix` en npm (el nombre `mockix` lo rechaza npm por parecido a `mockjs`);
   - `SIGNPATH_API_TOKEN` (y la variable `SIGNPATH_ORGANIZATION_ID`) firma el instalador del borrador.
5. Desde que el release está publicado, las apps instaladas lo reciben como actualización.

El workflow `ci` (check completo en Windows) corre en los pull requests y a mano, no en cada push.

## Cómo se desarrolla

Mockix lo diseña y dirige Luis E. Bautista. El código, los tests y la documentación se escriben con la ayuda de Claude (Anthropic) como asistente de programación. Cada cambio se revisa y se prueba antes de integrarlo.

## Licencia

MIT. Ver [LICENSE](LICENSE).
