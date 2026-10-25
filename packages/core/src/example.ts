import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WORKSPACE_FILE } from "./format.js";

/** Synthetic store API (api.tienda-demo.test style data) that shows routes, rules, modes and file bodies. */
const FILES: Record<string, string> = {
  [WORKSPACE_FILE]: `# Workspace de Mockix. Cada carpeta de mocks/ es un mock con su propio puerto.
format: 1
mocks: [tienda]
# Variables que cualquier mock lee con {{getVar 'nombre'}}.
variables:
  moneda: MXN
`,
  ".gitignore": `# Estado local de Mockix: grabaciones crudas, certificados generados.
.mockix/
`,
  "mocks/tienda/mock.yaml": `# Ajustes del mock "tienda".
port: 3000
prefix: /v1
cors: true
latency: 0
variables:
  tienda: cdmx-centro
# Hosts a los que pueden ir los callbacks (webhooks) de las respuestas.
callbacks:
  allow: [localhost:4000]
# Mock parcial: lo que ninguna ruta atiende iría a la API real.
# proxy:
#   target: https://api.tienda-demo.test
# gRPC (servicios en grpc/): 0 toma un puerto libre; pon 50051 para fijarlo.
grpc:
  port: 0
# Caos (perfiles de chaos/perfiles.yaml): descomenta para probar la red inestable.
# chaos:
#   profile: red-inestable
#   folders: { pedidos: off }
# Contrato OpenAPI: warn registra lo que no cumple; strict responde 400.
contract:
  file: contracts/tienda.openapi.yaml
  mode: warn
`,
  "protos/catalogo.proto": `syntax = "proto3";

package tienda;

// Catálogo de ejemplo para el mock gRPC de "tienda".
service Catalogo {
  rpc ObtenerProducto (ProductoId) returns (Producto);
  rpc ListarProductos (Filtro) returns (stream Producto);
  rpc SubirPrecios (stream Precio) returns (Resumen);
  rpc Chat (stream Mensaje) returns (stream Mensaje);
}

message ProductoId { string id = 1; }

message Producto {
  string id = 1;
  string nombre = 2;
  double precio = 3;
  int32 stock = 4;
  Categoria categoria = 5;
}

enum Categoria {
  CATEGORIA_DESCONOCIDA = 0;
  CAFE = 1;
  TE = 2;
}

message Filtro { Categoria categoria = 1; int32 limite = 2; }

message Precio { string id = 1; double precio = 2; }

message Resumen { int32 actualizados = 1; string mensaje = 2; }

message Mensaje { string de = 1; string texto = 2; }
`,
  "mocks/tienda/grpc/catalogo.yaml": `proto: protos/catalogo.proto
service: tienda.Catalogo
description: Los métodos que no aparecen aquí responden un ejemplo generado del esquema.
methods:
  ObtenerProducto:
    responses:
      - id: ok
        default: true
        message:
          id: "{{body 'id'}}"
          nombre: "{{default (dataFind 'productos' 'id' (body 'id') 'nombre') (faker 'commerce.productName')}}"
          precio: "{{default (dataFind 'productos' 'id' (body 'id') 'precio') 99}}"
          stock: 12
          categoria: CAFE
      - id: no-existe
        status: NOT_FOUND
        details: no existe el producto
        trailers: { x-motivo: catalogo }
        rules:
          when:
            - { target: body.id, op: regex, value: '^9' }
  ListarProductos:
    responses:
      - id: catalogo
        stream:
          - message: { id: prd_7Qm2, nombre: Café de Veracruz 500 g, precio: 189, stock: 42, categoria: CAFE }
          - message: { id: prd_8Lx4, nombre: Café de Chiapas 250 g, precio: 112.5, stock: 0, categoria: CAFE }
            delay: 200ms
          - message: { id: prd_9Kc1, nombre: Café de Oaxaca molido 1 kg, precio: 349, stock: 17, categoria: CAFE }
            delay: 200ms
  SubirPrecios:
    responses:
      - id: resumen
        message: { actualizados: "{{body 'count'}}", mensaje: precios recibidos }
  Chat:
    responses:
      - id: eco
        message: { de: mockix, texto: "recibido: {{body 'texto'}}" }
`,
  "mocks/tienda/routes/ws-notificaciones.yaml": `id: notificaciones
protocol: ws
path: /notificaciones
description: WebSocket con guion al conectar, respuestas por reglas y difusión a todos.
onConnect:
  - send: { json: { tipo: hola, tienda: "{{getVar 'tienda'}}" } }
  - every: 5s
    send: |-
      { "tipo": "latido", "hora": "{{now 'iso'}}" }
messages:
  - id: pong
    rules:
      when:
        - { target: body.tipo, op: equals, value: ping }
    reply: |-
      { "tipo": "pong", "recibido": "{{now 'iso'}}" }
  - id: aviso
    description: Lo que manda un cliente con tipo aviso les llega a todos.
    rules:
      when:
        - { target: body.tipo, op: equals, value: aviso }
    broadcast: |-
      { "tipo": "aviso", "texto": "{{body 'texto'}}" }
  - id: adios
    rules:
      when:
        - { target: body.tipo, op: equals, value: salir }
    reply: { json: { tipo: adios } }
    close: { code: 1000, reason: hasta luego }
echo: true
`,
  "mocks/tienda/routes/socketio-pedidos.yaml": `id: pedidos-en-vivo
protocol: socketio
path: /pedidos
description: Namespace de Socket.IO con salas por pedido, ack y emisiones.
onConnect:
  - emit: bienvenida
    data: { json: { namespace: /pedidos } }
messages:
  - id: seguir
    event: seguir
    description: El cliente se une a la sala de su pedido.
    join: "pedido:{{body 'id'}}"
    ack: |-
      { "ok": true, "sala": "pedido:{{body 'id'}}" }
  - id: estado
    event: estado
    ack: |-
      { "id": "{{body 'id'}}", "estado": "en camino", "consultado": "{{now 'iso'}}" }
  - id: nota
    event: nota
    emit:
      event: nota
      data: |-
        { "id": "{{body 'id'}}", "texto": "{{body 'texto'}}" }
      to: "room:pedido:{{body 'id'}}"
`,
  "chaos/perfiles.yaml": `# Perfiles de caos: puntos en el tiempo con interpolación lineal entre ellos.
# Se aplican en mock.yaml (chaos: <perfil>), por carpeta o por ruta, o con «mockix serve --chaos <perfil>».
red-inestable:
  description: Va bien, se degrada a los 30 s con errores y se recupera.
  duration: 60s
  points:
    - { t: 0s, latency: 50ms, jitter: 10ms, errorRate: 0 }
    - { t: 20s, latency: 120ms, jitter: 40ms, errorRate: 0.02, errors: [503] }
    - { t: 30s, latency: 800ms, jitter: 300ms, errorRate: 0.15, errors: { 500: 1, 503: 2 } }
    - { t: 45s, latency: 50ms, jitter: 10ms, errorRate: 0 }
  extras: { dropRate: 0.02, timeoutRate: 0.01 }

rampa:
  description: La latencia sube poco a poco durante dos minutos y vuelve a empezar.
  duration: 2m
  points:
    - { t: 0s, latency: 20ms }
    - { t: 2m, latency: 2s, jitter: 200ms }

pico:
  description: Un pico corto de latencia y errores cada minuto.
  duration: 60s
  points:
    - { t: 0s, latency: 30ms }
    - { t: 25s, latency: 30ms }
    - { t: 30s, latency: 1500ms, jitter: 300ms, errorRate: 0.3, errors: [502, 503, 504] }
    - { t: 35s, latency: 30ms }

red-3g:
  description: Móvil lento, constante.
  points:
    - { t: 0s, latency: 300ms, jitter: 120ms }
  extras: { trickleKBps: 50, dropRate: 0.01 }

se-cae-a-los-30s:
  description: Responde bien 30 s y luego todo falla con 503 (sin bucle).
  loop: false
  points:
    - { t: 0s, latency: 40ms }
    - { t: 30s, latency: 40ms }
    - { t: 30.1s, errorRate: 1, errors: [503] }
`,
  "contracts/tienda.openapi.yaml": `openapi: 3.1.0
info:
  title: Tienda demo
  version: 1.0.0
  description: Contrato de ejemplo. El mock "tienda" se valida contra él (mock.yaml → contract).
servers:
  - url: http://localhost:3000/v1
paths:
  /salud:
    get:
      operationId: salud
      responses:
        "200":
          description: Servicio en marcha
          content:
            application/json:
              schema:
                type: object
                required: [ok]
                properties:
                  ok: { type: boolean }
                  servicio: { type: string }
  /productos:
    get:
      operationId: listarProductos
      parameters:
        - { name: categoria, in: query, schema: { type: string } }
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100 } }
      responses:
        "200":
          description: Productos
          content:
            application/json:
              schema:
                type: object
                required: [data, total]
                properties:
                  data: { type: array, items: { $ref: "#/components/schemas/Producto" } }
                  total: { type: integer }
    post:
      operationId: crearProducto
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/ProductoNuevo" }
      responses:
        "201":
          description: Creado
          content:
            application/json:
              schema: { type: object, required: [id], properties: { id: { type: string } } }
        "422":
          description: Datos no válidos
          content:
            application/json:
              schema: { type: object, required: [title], properties: { title: { type: string }, errores: { type: array } } }
  /productos/{id}:
    get:
      operationId: obtenerProducto
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200":
          description: Producto
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Producto" }
        "404":
          description: No existe
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
  /clientes/{id}:
    get:
      operationId: obtenerCliente
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200":
          description: Cliente
          content:
            application/json:
              schema:
                type: object
                required: [id, nombre, email]
                properties:
                  id: { type: string }
                  nombre: { type: string }
                  email: { type: string, format: email }
  /pedidos:
    post:
      operationId: crearPedido
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/PedidoNuevo" }
      responses:
        "201":
          description: Pedido creado
          content:
            application/json:
              schema:
                type: object
                required: [id, estado]
                properties:
                  id: { type: string }
                  estado: { $ref: "#/components/schemas/EstadoPedido" }
                  articulos: { type: integer }
  /pedidos/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      operationId: obtenerPedido
      responses:
        "200":
          description: El pedido en su estado actual
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Pedido" }
        "410":
          description: Cancelado
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
    delete:
      operationId: cancelarPedido
      responses:
        "200":
          description: Cancelado
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Pedido" }
        "409":
          description: Ya salió
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
    patch:
      operationId: modificarPedido
      requestBody:
        content:
          application/json:
            schema: { type: object, properties: { notas: { type: string } } }
      responses:
        "200":
          description: Modificado
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Pedido" }
              example: { id: ped_1043, estado: creado }
  /pedidos/{id}/pago:
    post:
      operationId: pagarPedido
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200":
          description: Pagado
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Pedido" }
        "409":
          description: No se puede pagar
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
  /facturas:
    get:
      operationId: listarFacturas
      responses:
        "200":
          description: Facturas
          content:
            application/json:
              schema: { type: array, items: { type: object, properties: { folio: { type: string }, total: { type: number } } } }
components:
  schemas:
    Producto:
      type: object
      required: [id, nombre, precio]
      properties:
        id: { type: string }
        nombre: { type: string }
        categoria: { type: string }
        precio: { type: number, minimum: 0 }
        stock: { type: integer }
        moneda: { type: string }
        activo: { type: boolean }
    ProductoNuevo:
      type: object
      required: [nombre, precio]
      properties:
        nombre: { type: string, minLength: 1 }
        precio: { type: number, exclusiveMinimum: 0 }
        categoria: { type: string }
    PedidoNuevo:
      type: object
      required: [lineas]
      additionalProperties: false
      properties:
        cliente: { type: string }
        lineas:
          type: array
          minItems: 1
          items: { $ref: "#/components/schemas/LineaPedido" }
    LineaPedido:
      type: object
      required: [sku, cantidad]
      properties:
        sku: { type: string }
        cantidad: { type: integer, minimum: 1 }
    EstadoPedido:
      type: string
      enum: [creado, pagado, enviado, entregado, cancelado]
    Pedido:
      type: object
      required: [id, estado]
      properties:
        id: { type: string }
        estado: { $ref: "#/components/schemas/EstadoPedido" }
        guia: { type: string }
    Error:
      type: object
      required: [error, codigo]
      properties:
        error: { type: string }
        codigo: { type: string }
`,
  "mocks/tienda/scenarios/pedido.yaml": `# Máquina de estados del pedido: una instancia por id (params.id).
# Las rutas leen el estado con state.pedido (reglas) y {{state.pedido}} (plantillas).
key: params.id
initial: creado
states: [creado, pagado, enviado, entregado, cancelado]
transitions:
  - { from: creado, to: pagado, on: { method: POST, path: /pedidos/:id/pago } }
  - { from: pagado, to: enviado, after: 10s }
  - { from: enviado, to: entregado, after: 30s }
  - { from: [creado, pagado], to: cancelado, on: { method: DELETE, path: /pedidos/:id } }
`,
  "mocks/tienda/routes/pedidos/get-pedido.yaml": `id: pedidos/obtener
method: GET
path: /pedidos/:id
description: Responde según el estado del escenario "pedido" de ese id.
responses:
  - id: en-curso
    default: true
    body: |
      { "id": "{{urlParam 'id'}}", "estado": "{{state.pedido}}" }
  - id: enviado
    body: |
      { "id": "{{urlParam 'id'}}", "estado": "enviado", "guia": "MX-{{int 10000 99999}}" }
    rules:
      when:
        - { target: state.pedido, op: in, value: [enviado, entregado] }
  - id: cancelado
    status: 410
    body:
      json: { error: pedido cancelado, codigo: PEDIDO_CANCELADO }
    rules:
      when:
        - { target: state.pedido, op: equals, value: cancelado }
`,
  "mocks/tienda/routes/pedidos/post-pedido-pago.yaml": `id: pedidos/pagar
method: POST
path: /pedidos/:id/pago
description: Mueve el pedido de creado a pagado (escenario "pedido"); a los 10 s pasa solo a enviado.
responses:
  - id: pagado
    default: true
    body: |
      { "id": "{{urlParam 'id'}}", "estado": "{{state.pedido}}" }
  - id: no-se-puede
    status: 409
    body:
      json: { error: el pedido no se puede pagar, codigo: PEDIDO_NO_PAGABLE }
    rules:
      when:
        - { target: state.pedido, op: equals, value: cancelado }
`,
  "mocks/tienda/routes/pedidos/delete-pedido.yaml": `id: pedidos/cancelar
method: DELETE
path: /pedidos/:id
responses:
  - id: cancelado
    default: true
    body: |
      { "id": "{{urlParam 'id'}}", "estado": "{{state.pedido}}" }
  - id: ya-salio
    status: 409
    body:
      json: { error: el pedido ya salió, codigo: PEDIDO_EN_CAMINO }
    rules:
      when:
        - { target: state.pedido, op: in, value: [enviado, entregado] }
`,
  "mocks/tienda/data/productos.json": `[
  { "id": "prd_7Qm2", "nombre": "Café de Veracruz 500 g", "categoria": "cafe", "precio": 189, "stock": 42 },
  { "id": "prd_8Lx4", "nombre": "Café de Chiapas 250 g", "categoria": "cafe", "precio": 112.5, "stock": 0 },
  { "id": "prd_9Kc1", "nombre": "Café de Oaxaca molido 1 kg", "categoria": "cafe", "precio": 349, "stock": 17 }
]
`,
  "mocks/tienda/data/inventario.json": `[
  { "id": "CAF-VER-500", "sucursal": "cdmx-centro", "stock": 42 },
  { "id": "CAF-CHI-250", "sucursal": "cdmx-centro", "stock": 0 },
  { "id": "CAF-OAX-1K", "sucursal": "gdl-chapultepec", "stock": 17 }
]
`,
  "mocks/tienda/routes/inventario.yaml": `id: inventario
path: /inventario
description: CRUD completo sobre data/inventario.json (listar, filtrar, ordenar, paginar, crear, reemplazar, modificar y borrar).
crud:
  bucket: inventario
  key: id
`,
  "mocks/tienda/routes/clientes/get-cliente.yaml": `id: clientes/obtener
method: GET
path: /clientes/:id
description: Datos falsos con faker; con --seed salen siempre iguales.
responses:
  - id: ok
    body: |
      {
        "id": "{{urlParam 'id'}}",
        "nombre": "{{faker 'person.fullName'}}",
        "email": "{{faker 'internet.email'}}",
        "tienda": "{{getVar 'tienda'}}",
        "pedidos": [
          {{#repeat 2}}
          { "id": "ped_{{int 1000 9999}}", "total": {{float 100 900 2}}, "moneda": "{{getVar 'moneda'}}" }
          {{/repeat}}
        ],
        "consultado": "{{now 'iso'}}"
      }
`,
  "mocks/tienda/routes/pedidos/post-pedido.yaml": `id: pedidos/crear
method: POST
path: /pedidos
responses:
  - id: creado
    status: 201
    body: |
      { "id": "ped_{{int 1000 9999}}", "estado": "creado", "articulos": {{len (body 'lineas')}} }
    callbacks:
      - url: http://localhost:4000/webhooks/pedidos
        method: POST
        delay: 500ms
        body: |
          { "evento": "pedido.creado", "cliente": {{body 'cliente' 'null'}} }
`,
  "mocks/tienda/routes/salud.yaml": `id: salud
method: GET
path: /salud
responses:
  - id: ok
    body:
      json: { ok: true, servicio: tienda }
`,
  "mocks/tienda/routes/productos/get-productos.yaml": `id: productos/listar
method: GET
path: /productos
responses:
  - id: ok
    default: true
    body: { file: get-productos.200.json }
  - id: vacio
    description: Una categoría sin productos
    body:
      json: { data: [], total: 0 }
    rules:
      when:
        - { target: query.categoria, op: equals, value: ninguna }
`,
  "mocks/tienda/routes/productos/get-productos.200.json": `{
  "data": [
    { "id": "prd_7Qm2", "nombre": "Café de Veracruz 500 g", "categoria": "cafe", "precio": 189, "stock": 42 },
    { "id": "prd_8Lx4", "nombre": "Café de Chiapas 250 g", "categoria": "cafe", "precio": 112.5, "stock": 0 },
    { "id": "prd_9Kc1", "nombre": "Café de Oaxaca molido 1 kg", "categoria": "cafe", "precio": 349, "stock": 17 }
  ],
  "total": 3
}
`,
  "mocks/tienda/routes/productos/get-producto.yaml": `id: productos/obtener
method: GET
path: /productos/:id
responses:
  - id: ok
    default: true
    body: { file: get-producto.200.json }
  - id: no-existe
    status: 404
    body:
      json: { error: no existe, codigo: PRODUCTO_NO_ENCONTRADO }
    rules:
      when:
        - { target: params.id, op: regex, value: '^9\\d+$' }
`,
  "mocks/tienda/routes/productos/get-producto.200.json": `{
  "id": "{{urlParam 'id'}}",
  "nombre": "{{default (dataFind 'productos' 'id' (urlParam 'id') 'nombre') (faker 'commerce.productName')}}",
  "precio": {{default (dataFind 'productos' 'id' (urlParam 'id') 'precio') (int 50 500)}},
  "moneda": "{{getVar 'moneda'}}",
  "activo": true
}
`,
  "mocks/tienda/routes/productos/post-productos.yaml": `id: productos/crear
method: POST
path: /productos
responses:
  - id: creado
    status: 201
    headers: { Location: /v1/productos/prd_nuevo }
    body:
      json: { id: prd_nuevo }
    rules:
      mode: all
      when:
        - { target: body.nombre, op: exists }
        - { target: body.precio, op: gt, value: 0 }
  - id: no-valido
    default: true
    status: 422
    body:
      json:
        title: Datos no válidos
        errores: [{ campo: precio, mensaje: debe ser mayor que 0 }]
`,
  "mocks/tienda/routes/pedidos/get-pedido-estado.yaml": `id: pedidos/estado
method: GET
path: /pedidos/:id/estado
description: Cada llamada avanza el estado (modo secuencial).
mode: sequential
responses:
  - id: creado
    body: { json: { estado: creado } }
  - id: pagado
    body: { json: { estado: pagado } }
  - id: enviado
    body: { json: { estado: enviado, guia: MX-88213 } }
`,
  "mocks/tienda/routes/inestable.yaml": `id: inestable
method: GET
path: /inestable
description: Responde al azar con éxito o con un 503.
mode: random
latency: 120ms
responses:
  - id: ok
    body: { json: { ok: true } }
  - id: caido
    status: 503
    headers: { Retry-After: 5 }
    body: { json: { error: servicio no disponible } }
`,
  "mocks/tienda/routes/logo.yaml": `id: logo
method: GET
path: /logo.svg
responses:
  - id: ok
    body: { file: /files/logo.svg }
`,
  "mocks/tienda/files/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96"><rect x="4" y="4.5" width="16" height="6" rx="1.5" fill="none" stroke="#5c6b54" stroke-width="1.6"/><rect x="4" y="13.5" width="16" height="6" rx="1.5" fill="none" stroke="#5c6b54" stroke-width="1.6"/></svg>
`,
};

export class WorkspaceExistsError extends Error {
  constructor(dir: string) {
    super(`${dir} already contains a Mockix workspace`);
    this.name = "WorkspaceExistsError";
  }
}

/** Writes the example workspace into `dir` (created if needed). Refuses to overwrite an existing workspace. */
export async function writeExampleWorkspace(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).includes(WORKSPACE_FILE)) throw new WorkspaceExistsError(dir);
  const written: string[] = [];
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, { flag: "wx" });
    written.push(rel);
  }
  return written;
}
