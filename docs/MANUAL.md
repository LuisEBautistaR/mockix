# Manual de uso de Mockix

Mockix simula APIs en tu equipo. Defines qué responde cada ruta (HTTP, WebSocket, Socket.IO o gRPC) y Mockix lo sirve en un puerto local, para que tu app o tus tests trabajen como si la API real existiera.

¿Es la primera vez? Empieza por la [guía rápida](GUIA-RAPIDA.md). Este manual explica cada función; el [README](../README.md) tiene la referencia completa del formato.

**Contenido**

1. [Instalar](#1-instalar)
2. [Conceptos](#2-conceptos)
3. [La app de escritorio](#3-la-app-de-escritorio)
4. [Crear mocks y rutas](#4-crear-mocks-y-rutas)
5. [Respuestas que cambian](#5-respuestas-que-cambian)
6. [Datos y rutas CRUD](#6-datos-y-rutas-crud)
7. [Importar y exportar](#7-importar-y-exportar)
8. [Grabar una API real](#8-grabar-una-api-real)
9. [Contrato OpenAPI](#9-contrato-openapi)
10. [Escenarios con estado](#10-escenarios-con-estado)
11. [Perfiles de caos](#11-perfiles-de-caos)
12. [WebSocket, Socket.IO y gRPC](#12-websocket-socketio-y-grpc)
13. [Agentes de IA (MCP)](#13-agentes-de-ia-mcp)
14. [Con Sendix](#14-con-sendix)
15. [La CLI](#15-la-cli)
16. [Docker](#16-docker)
17. [Problemas frecuentes](#17-problemas-frecuentes)

## 1. Instalar

| Dónde | Cómo |
|---|---|
| **Windows 10 u 11** | Descarga `Mockix-<versión>-setup.exe` de [protohub.digital/mockix](https://protohub.digital/mockix/) o de [GitHub Releases](https://github.com/LuisEBautistaR/mockix/releases/latest). Se instala solo para tu usuario, sin permisos de administrador. |
| **Terminal (CLI)** | `npm i -g @fulerbdev/mockix`, con Node 22 o superior. Instala el comando `mockix`. |
| **Docker** | `docker run --rm --read-only -v ./MiProyecto:/mocks -p 3000:3000 ghcr.io/luisebautistar/mockix` |

- **Aviso de Windows:** el instalador todavía no está firmado, así que SmartScreen puede avisar la primera vez. Pulsa «Más información» y luego «Ejecutar de todas formas». Si quieres asegurarte de que el archivo es el original, compara su huella SHA-256 con la de la página de descarga.
- **Actualizaciones:** la app busca versiones nuevas al arrancar y las descarga sola. En **Ajustes → Actualizaciones** ves el estado y puedes reiniciar para instalar.

## 2. Conceptos

| Palabra | Qué es |
|---|---|
| **Workspace** | La carpeta de tu proyecto de mocks. Tiene un archivo `mockix.workspace.yaml` y una carpeta `mocks/`. Todo son archivos de texto, así que puedes guardarlo en git. |
| **Mock** | Una API simulada, con su puerto y su prefijo (por ejemplo `http://127.0.0.1:3000/v1`). Cada mock es una subcarpeta de `mocks/`. |
| **Ruta** | Un método y una dirección, como `GET /productos/:id`. Cada ruta es un archivo `.yaml` en `routes/`. |
| **Respuesta** | Lo que devuelve una ruta: estado, cabeceras y cuerpo. Una ruta puede tener varias. |
| **Regla** | La condición que elige una respuesta: «si el id empieza con 9, responde 404». |

```
MiProyecto/                      ← el workspace (abre esta carpeta)
├─ mockix.workspace.yaml
└─ mocks/
   └─ tienda/                    ← un mock
      ├─ mock.yaml               puerto, prefijo, CORS, latencia…
      └─ routes/
         └─ productos/
            └─ get-producto.yaml ← una ruta
```

> Abre siempre la carpeta del **workspace**, no la de un mock. Si abres la carpeta de un mock, Mockix te avisa y te dice qué carpeta abrir.

## 3. La app de escritorio

La primera vez verás dos botones:

- **Abrir carpeta…:** abre un workspace que ya tienes. Si la carpeta no tiene `mockix.workspace.yaml`, Mockix lo crea y la convierte en workspace; los mocks que ya estén en su carpeta `mocks/` aparecen tal cual.
- **Crear el ejemplo…:** crea en la carpeta que elijas un workspace de muestra con el mock `tienda`. Es la mejor forma de ver todo funcionando.

**Partes de la ventana:**

- **Barra de título:** la carpeta abierta, la búsqueda de rutas (`Ctrl K`), iniciar o detener el mock seleccionado y el tema claro u oscuro.
- **Rail (iconos de la izquierda):** Mocks y rutas, Grabaciones, Escenarios, Perfiles de caos, Contratos, y abajo Agentes (MCP) y Ajustes.
- **Barra lateral:** el árbol de mocks y rutas. Arriba tiene los botones para abrir otra carpeta, importar, crear un mock y crear una ruta. Abajo, los datos (buckets) del mock.
- **Zona central:** el resumen del mock, el editor de la ruta abierta o la vista que elegiste en el rail.

**Iniciar un mock:** selecciónalo y pulsa **Iniciar**. El estado pasa a «En marcha» y aparece su URL. Cada mock corre en su propio proceso: si uno falla, los demás siguen.

**Log en vivo:** cada petición que recibe el mock aparece con su ruta, la respuesta elegida y el desglose de tiempos. Desde una petición del log puedes crear una ruta nueva o copiarla como cURL. Las credenciales (`Authorization`, `Cookie`…) se guardan como `[redactado]`.

## 4. Crear mocks y rutas

**Nuevo mock** (icono de servidor en la barra lateral):

- **Nombre:** minúsculas, números y guiones. Es el nombre de su carpeta en `mocks/`.
- **Puerto:** donde escucha. `0` elige uno libre.
- **Prefijo (opcional):** la parte de la ruta común a todo el mock, como `/v1`.

**Nueva ruta** (botón `+`):

- **Respuestas fijas:** eliges método y ruta (`/productos/:id`; los `:param` se resaltan mientras escribes) y la carpeta donde guardarla.
- **CRUD sobre un bucket:** una ruta que lista, crea, cambia y borra registros de un bucket de datos. Ver [Datos y rutas CRUD](#6-datos-y-rutas-crud).

**Editor de la ruta:**

- **Respuestas:** una ficha por respuesta. Puedes añadir, duplicar o quitar, y marcar cuál es la respuesta por defecto.
- **Cuerpo:** estado, Content-Type, latencia y el texto. **Vista previa** muestra cómo queda la plantilla con una petición de ejemplo.
- **Cabeceras, Reglas, Latencia y Documentación:** cada una en su pestaña.
- **Probar** (`Ctrl Enter`): envía la petición al mock en marcha y muestra la respuesta.
- **Guardar** (`Ctrl S`): escribe los archivos. Si algo no es válido, te dice qué campo y no toca el disco. El mock en marcha aplica el cambio al momento, sin reiniciar.
- **Mover a la papelera:** las rutas no se borran para siempre; van a la papelera de Windows.

**Borrar un mock:** selecciónalo y pulsa **Mover el mock a la papelera**, debajo de sus datos. Después de confirmar, Mockix lo detiene si está en marcha, manda su carpeta a la papelera de Windows (de donde se puede restaurar), lo quita de `mockix.workspace.yaml` y borra el entorno de Sendix que había escrito para él.

También puedes editar los `.yaml` con cualquier editor de texto: Mockix detecta el cambio y recarga.

## 5. Respuestas que cambian

**Reglas.** Cada respuesta puede tener reglas que deciden cuándo se usa. Una regla mira una parte de la petición y la compara:

- **Qué mira:** `params.id`, `query.x`, `header.x`, `cookie.x`, `body.campo`, `method`, `path` o el número de petición.
- **Cómo compara:** igual, expresión regular, existe, vacío, contiene, está en una lista, mayor o menor que… Se puede invertir.
- **Todas o alguna:** una respuesta puede pedir que se cumplan todas sus reglas o solo una.

Si ninguna regla coincide, responde la respuesta por defecto.

**Modo de la ruta:**

| Modo | Qué hace |
|---|---|
| Reglas | Elige por reglas (el normal). |
| Aleatorio | Una respuesta al azar en cada petición. |
| Secuencial | Una tras otra, en orden. |
| Fallback | Si ninguna regla coincide, la petición sigue a la siguiente ruta que coincida o, si hay proxy, a la API real. |

**Plantillas.** Los cuerpos y las cabeceras pueden usar `{{…}}` para leer la petición o generar datos:

```json
{
  "id": "{{urlParam 'id'}}",
  "nombre": "{{faker 'commerce.productName'}}",
  "precio": {{float 100 900 2}},
  "creado": "{{now 'iso'}}"
}
```

| Para | Ejemplos |
|---|---|
| Leer la petición | `urlParam 'id'`, `queryParam 'q'`, `header 'x'`, `body 'cliente.nombre'` |
| Datos falsos | `faker 'person.fullName'`, `uuid`, `int 1 10`, `float 1 99 2`, `boolean`, `now 'iso'` |
| Repetir | `{{#repeat 3}}…{{/repeat}}` |
| Variables | `getVar 'moneda'` (definidas en `mockix.workspace.yaml` o en `mock.yaml`) |

Los datos falsos salen en español de México. La lista completa de helpers está en el [README](../README.md#plantillas-datos-y-más-m2). Si una plantilla falla al responder, la respuesta es un `500` con la cabecera `X-Mockix: template-error` y el motivo.

**Latencia.** Se suma la del mock, la de la ruta y la de la respuesta. Sirve para ver cómo se comporta tu app con una API lenta.

**Proxy parcial.** En los ajustes del mock (`proxy: { target: https://api.real }`) puedes mandar a la API real todo lo que ninguna ruta atiende. Así simulas solo lo que te falta.

## 6. Datos y rutas CRUD

Un **bucket** es una lista de registros en JSON: `mocks/<mock>/data/<nombre>.json`. Vive en memoria mientras el mock corre y vuelve a su contenido original cuando el archivo cambia o reinicias el mock. Nunca se escribe en disco.

Una **ruta CRUD** sobre un bucket te da una API completa sin escribir respuestas:

| Petición | Qué hace |
|---|---|
| `GET /inventario` | Lista, con filtros (`?sucursal=cdmx`), orden (`?sort=stock&order=desc`) y páginas (`?limit=20&page=2`) |
| `GET /inventario/:id` | Un registro |
| `POST /inventario` | Crea (genera el id si falta) y responde `201` |
| `PUT` / `PATCH /inventario/:id` | Reemplaza o cambia |
| `DELETE /inventario/:id` | Borra |

Si tu API devuelve la lista dentro de un objeto, la ruta CRUD la envuelve igual: `crud: { bucket: clientes, key: clienteId, list: { items: data, total: total } }` responde `{ "data": [...], "total": 3 }`.

Las plantillas también leen los buckets: `dataFind 'productos' 'id' (urlParam 'id') 'nombre'`.

## 7. Importar y exportar

### Crear un mock desde un contrato

**Nuevo mock → Desde un contrato OpenAPI → Elegir contrato…** (o `mockix import contrato.yaml`) crea el mock completo a partir de un OpenAPI 3 o Swagger 2. El nombre, el puerto y el prefijo se proponen del contrato (`info.title` y `servers`) y se pueden cambiar antes de crear.

| Qué | De dónde sale | Cómo queda |
|---|---|---|
| Rutas y respuestas | Cada operación y cada código documentado | Una ruta por operación. El cuerpo sale del ejemplo o del esquema, como plantilla con datos falsos. Si la ruta tiene un `{id}` y el ejemplo trae ese campo, responde con el id pedido. |
| Elegir la respuesta | Cada código documentado | Las respuestas que no son la normal responden con la cabecera `X-Mockix-Respuesta: <código>` o con `?mockix_respuesta=<código>`. |
| Contrato | El mismo archivo | Copiado a `contracts/` (o reutilizado si ya está ahí) y conectado en `mock.yaml` en modo `warn`. Solo OpenAPI 3: un Swagger 2 no se conecta. |
| Datos y CRUD | Un recurso con `GET /x`, `GET /x/{id}` y al menos un `POST /x`, `PUT`, `PATCH` o `DELETE /x/{id}` | Un bucket `data/x.json` con los ejemplos o con 3 registros generados, y una ruta CRUD. Si la lista viene envuelta (`{ data: [...], total }`), la ruta CRUD la envuelve igual. Sus errores (404, 409) son los del CRUD, no los del contrato. |
| Escenarios | Un campo `estado`, `status`, `estatus`, `state`, `situacion` o `etapa` con `enum`, y acciones `POST/PUT/PATCH /x/{id}/<acción>` (o `DELETE /x/{id}` si hay un estado de cancelación) | `scenarios/x.yaml` con los estados en el orden del `enum`. Cada acción lleva al estado cuyo nombre se le parece (`pago` → `pagado`). `GET /x/{id}` responde el estado actual, con el valor tal como lo escribe el contrato. Un recurso con escenario no se convierte en CRUD. |
| Perfiles de caos | Los códigos 5xx documentados (500 y 503 si no hay) | `chaos/<mock>.yaml` con `<mock>-lenta`, `<mock>-inestable` y `<mock>-caida`, apagados. |

Lo deducido aparece en el informe, y también por qué algo no se dedujo. En la terminal, `--no-contract` no conecta el contrato y `--no-chaos` no prepara los perfiles de caos; en la app son dos casillas del diálogo.

### Importar otros formatos

**Importar** (icono de descarga en la barra lateral, o `mockix import <archivo>`) crea un mock nuevo y te muestra un informe de lo que se convirtió y lo que no.

| Desde | Qué obtienes |
|---|---|
| **OpenAPI 3 o Swagger 2** | Todo lo de [Crear un mock desde un contrato](#crear-un-mock-desde-un-contrato). |
| **Postman v2.x o Sendix** | Cada petición con ejemplos guardados es una ruta, y cada ejemplo una respuesta. |
| **HAR** (del navegador) | Rutas a partir del tráfico, sin credenciales. |
| **Mockoon** | Rutas, respuestas, reglas, buckets, CRUD y proxy. |

**Exportar:** el botón **OpenAPI** del mock (o `mockix export openapi -m <mock>`) guarda el mock como OpenAPI 3.1.

## 8. Grabar una API real

Mockix se pone entre tu app y la API real, deja pasar todo y lo guarda. Luego conviertes lo grabado en un mock.

1. Abre **Grabaciones** en el rail, escribe la URL de la API real y pulsa **Grabar**.
2. Apunta tu app al proxy (`localhost:<puerto>`) y úsala normalmente.
3. Pulsa **Detener**. Revisa **Rutas detectadas** y la **vista previa de redacción**.
4. **Convertir en mocks** crea un mock nuevo o añade lo nuevo a uno existente.

Antes de escribir el mock, Mockix quita credenciales y cambia tokens, correos y teléfonos por datos falsos. La grabación en crudo queda en `.mockix/recordings/` y nunca va a git.

## 9. Contrato OpenAPI

Asocia un mock a un OpenAPI de `contracts/` y Mockix revisa cada petición: ruta, parámetros, tipos y cuerpo. También revisa las respuestas del propio mock, para detectar un mock desactualizado.

**Cómo debe ser el contrato:**

- **Formato:** un archivo OpenAPI 3.0 o 3.1 (YAML o JSON) en `contracts/`. Si ya tienes la documentación de tu API en Swagger u OpenAPI, sirve tal cual.
- **Esquemas:** cada operación con sus `parameters`, su `requestBody` y sus `responses`, con tipos y campos obligatorios. Solo se valida lo que el contrato describe.
- **Prefijo:** el prefijo del mock va en `servers` (`url: http://localhost:3000/v1`) y las rutas de `paths` van sin él (`/productos`).
- **Conexión:** en el `mock.yaml`:

  ```yaml
  contract:
    file: contracts/tienda.openapi.yaml
    mode: warn          # off, warn o strict
    responses: true     # valida también las respuestas del mock
  ```

La [guía rápida](GUIA-RAPIDA.md#contratos-que-el-mock-no-se-invente-nada) lo prueba paso a paso con el contrato del ejemplo.

- **Modos:** apagado, **avisar** (registra el fallo y responde igual) o **estricto** (responde `400` explicando el error).
- **Vista Contratos:** las reglas que se rompen, qué cliente las rompe y qué operaciones del contrato tienen mock.
- **En CI:** `mockix serve --report contrato.xml --fail-on-violation` escribe un informe JUnit y falla si hubo violaciones.

## 10. Escenarios con estado

Un escenario simula algo que cambia con el tiempo, como un pedido que pasa de «creado» a «pagado» y luego a «enviado».

- **Estados y transiciones:** se definen en `mocks/<mock>/scenarios/<id>.yaml`. Una transición ocurre con una petición (`POST /pedidos/:id/pago`) o pasado un tiempo (`after: 10s`).
- **Una instancia por clave:** cada pedido lleva su propio estado.
- **En las rutas:** las reglas leen `state.pedido` y las plantillas `{{state.pedido}}`, así `GET /pedidos/:id` responde según el estado.
- **Vista Escenarios:** el diagrama con el estado actual, el historial, y botones para forzar un estado o reiniciar.

El workspace de ejemplo trae el escenario `pedido` listo para probar.

## 11. Perfiles de caos

Un perfil de caos simula una red mala: latencia, variación (jitter) y errores que cambian a lo largo del tiempo.

- **La curva:** en **Perfiles de caos** arrastras los puntos sobre la gráfica o los editas en la tabla, y **Aplicar cambios** los guarda.
- **Efectos extra:** conexiones cortadas, peticiones que nunca responden y cuerpos que llegan lento.
- **Dónde aplica:** a todo un mock, a una carpeta de rutas o a una ruta. Gana el más concreto.
- **Repetible:** con la misma semilla (`--seed`) obtienes los mismos fallos en cada ejecución, útil en CI.

El ejemplo trae `red-inestable`, `rampa`, `pico`, `red-3g` y `se-cae-a-los-30s`.

## 12. WebSocket, Socket.IO y gRPC

- **WebSocket y Socket.IO:** son rutas con `protocol: ws` o `protocol: socketio`. Pueden enviar mensajes al conectar o cada cierto tiempo, responder por reglas, difundir a todos y, en Socket.IO, usar salas y ack.
- **gRPC:** cada servicio va en `grpc/*.yaml` con su `.proto` en `protos/`. Admite los cuatro tipos de llamada, estados de error y trailers. La reflection está activa, así que Sendix o `grpcurl` descubren el servicio sin el `.proto`.
- **Probar desde la app:** en la barra lateral, las rutas `WS`, `SIO` y los servicios `gRPC` abren su panel. **Conectar** abre una conexión de prueba y **Llamar** hace una llamada gRPC de ejemplo.

## 13. Agentes de IA (MCP)

Un agente de IA (Claude Code, Claude Desktop u otro cliente MCP) puede crear rutas, probarlas y leer el log de tu workspace.

- **En la app:** abre **Agentes (MCP)** en el rail y enciéndelo. Está apagado por defecto y solo escucha en tu equipo. La vista te da la configuración lista para copiar en tu cliente.
- **Tú apruebas cada cambio:** cuando el agente quiere escribir algo, aparece un diálogo con lo que pide. Sin respuesta en 2 minutos, se rechaza.
- **Sin romper nada:** si un cambio dejaría el mock con errores, se descarta y el agente recibe el motivo. Los borrados van a `.mockix/trash/`.
- **Desde la terminal:** `mockix mcp ./MiProyecto` (con `--read-only`, el agente solo puede leer).

## 14. Con Sendix

[Sendix](https://protohub.digital/sendix/) es el cliente de APIs hermano de Mockix.

- **Entornos automáticos:** si la carpeta también es un workspace de Sendix, cada mock en marcha escribe un entorno `Mock <mock>` con su `baseUrl`. En Sendix eliges ese entorno y tus peticiones van al mock.
- **Importar colecciones:** una colección de Sendix se importa en Mockix como cualquier colección de Postman.
- **gRPC:** Sendix descubre los servicios del mock por reflection.

## 15. La CLI

```bash
mockix init mi-proyecto               # crea el workspace de ejemplo
mockix serve mi-proyecto              # sirve todos los mocks y recarga al guardar
mockix serve mi-proyecto -m tienda    # solo un mock
mockix validate mi-proyecto           # revisa todos los archivos sin servir nada
mockix import api.yaml mi-proyecto    # crea un mock desde un OpenAPI (o Postman, HAR, Mockoon)
mockix --help                         # todos los comandos y opciones
```

- **Por defecto** escucha solo en `127.0.0.1`. Con `--host 0.0.0.0` otros equipos de tu red pueden llegar al mock.
- **Códigos de salida:** `0` bien; `1` archivos con problemas o un mock que no arrancó; `2` violaciones del contrato (con `--fail-on-violation`) o un casete que recibió algo no grabado.
- **API de control:** con `--admin-token <token>` puedes leer el log, cambiar datos o reiniciar el mock por HTTP en `/__mockix/`.

## 16. Docker

```bash
docker run --rm --read-only -v ./MiProyecto:/mocks -p 3000:3000 ghcr.io/luisebautistar/mockix
```

- **La carpeta** `MiProyecto` es tu workspace; dentro del contenedor está en `/mocks`.
- **Puertos:** publica con `-p` el puerto de cada mock que quieras usar.
- **Sin workspace todavía:** `docker run --rm -v ./MiProyecto:/mocks ghcr.io/luisebautistar/mockix init /mocks` crea el ejemplo.
- **gRPC:** fija su puerto en `mock.yaml` (`grpc: { port: 50051 }`) y publícalo con `-p 50051:50051`.

## 17. Problemas frecuentes

| Ves | Qué pasa y qué hacer |
|---|---|
| «Esa carpeta es el mock «x», no un workspace» | Abriste la carpeta de un mock. Abre la carpeta que contiene `mocks/`, la que indica el mensaje. |
| «no es un workspace de Mockix: falta mockix.workspace.yaml» | La carpeta no es un workspace. Ábrela con **Abrir carpeta…**, que la convierte, o crea el archivo con la línea `format: 1`. |
| El mock queda «Con errores» y dice `PORT_IN_USE` | Otro programa usa ese puerto. Cambia `port:` en el `mock.yaml` del mock (o pon `0` para que elija uno libre), guarda e inícialo otra vez. |
| El mock aparece con «problemas» | Algún archivo no es válido. La lista dice el archivo, la línea y el campo. Un mock con problemas no arranca; si ya corría, sigue con la última versión buena. |
| Una respuesta `500` con `X-Mockix: template-error` | Una plantilla falló al responder. El motivo está en el log; prueba con **Vista previa**. |
| `404` «No route in this mock» | Ninguna ruta coincide con esa petición. Revisa el método, la ruta y el prefijo del mock. |
| Windows avisa al instalar | El instalador aún no está firmado. «Más información» → «Ejecutar de todas formas». |
