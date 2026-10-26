# Guía rápida de Mockix

Tu primer mock en 10 minutos, sin saber nada de mocks.

## ¿Qué es un mock?

Cuando una app muestra productos, le pide los datos a una **API**: un servidor que responde con información. A veces esa API todavía no existe, está caída o no quieres tocar la de verdad mientras pruebas.

Un **mock** es una API de mentiras que responde lo que tú decidas. Tu app le habla igual que a la real y no nota la diferencia. Mockix crea esos mocks en tu computadora.

## Paso 1. Instala Mockix

1. Descarga el instalador de [protohub.digital/mockix](https://protohub.digital/mockix/).
2. Ábrelo. Si Windows muestra un aviso azul, pulsa **Más información** y luego **Ejecutar de todas formas**. Aparece porque el instalador todavía no está firmado.
3. Sigue los pasos. No necesitas permisos de administrador.

## Paso 2. Crea el ejemplo

1. Abre Mockix.
2. Pulsa **Crear el ejemplo…** y elige una carpeta vacía, por ejemplo `Documentos\mi-primer-mock`.

Mockix crea ahí un mock llamado **tienda**: una API de una tienda de café con productos, pedidos e inventario. Lo verás en la barra de la izquierda.

## Paso 3. Enciéndelo

1. En la barra de la izquierda, haz clic en **tienda**.
2. Pulsa **Iniciar**.

El estado cambia a **En marcha** y aparece su dirección: `http://127.0.0.1:3000/v1`. Tu API de mentiras ya está funcionando.

## Paso 4. Pruébalo en el navegador

Abre esta dirección en Chrome o Edge:

```
http://127.0.0.1:3000/v1/productos/prd_7Qm2
```

Verás la respuesta del mock:

```json
{
  "id": "prd_7Qm2",
  "nombre": "Café de Veracruz 500 g",
  "precio": 189,
  "moneda": "MXN",
  "activo": true
}
```

Prueba también estas:

| Dirección | Qué responde |
|---|---|
| `http://127.0.0.1:3000/v1/productos` | La lista de productos |
| `http://127.0.0.1:3000/v1/productos/999` | Un error 404: «no existe» |

En Mockix, el **log** muestra cada petición que hiciste, qué respondió y cuánto tardó.

## Paso 5. Cambia una respuesta

1. En la barra de la izquierda, abre la carpeta **productos** y haz clic en la ruta **GET /productos/:id**.
2. En la respuesta **ok**, cambia `"activo": true` por `"activo": false`.
3. Pulsa **Guardar** (o `Ctrl S`).
4. Recarga la página del navegador.

Ahora dice `"activo": false`. Mockix aplica el cambio al momento, sin reiniciar nada.

## Paso 6. Crea el mock desde tu contrato

Si tienes la especificación de tu API en un archivo OpenAPI o Swagger (`.yaml` o `.json`), Mockix arma el mock completo por ti:

1. Pulsa el icono **Nuevo mock** (el servidor) en la barra de la izquierda. En un workspace sin mocks también tienes el botón **Crear mock desde un contrato**.
2. Deja elegida la opción **Desde un contrato OpenAPI** y pulsa **Elegir contrato…**.
3. Mockix lee el archivo y propone el nombre, el puerto y el prefijo (de `servers`). Cámbialos si quieres.
4. Pulsa **Crear mock**. Un informe te dice qué creó.
5. Selecciónalo y pulsa **Iniciar**.

**Qué crea a partir del contrato:**

| Qué | Cómo queda |
|---|---|
| **Rutas y respuestas** | Una ruta por operación y una respuesta por cada código documentado, con los ejemplos del contrato o con datos inventados según el esquema. |
| **Elegir la respuesta** | Cualquier respuesta documentada se pide por su código. Ver abajo. |
| **El contrato** | Copiado a `contracts/` y conectado en modo «avisar»: cada petición se revisa contra él. |
| **Datos y CRUD** | Si el contrato tiene un recurso que se lista, se lee por id y se crea, cambia o borra (`/clientes` y `/clientes/{id}`), Mockix crea un bucket con registros de ejemplo y una ruta CRUD: lo que creas con `POST` aparece después en `GET`. |
| **Escenarios** | Si un recurso tiene un campo de estado con valores fijos (`estado: [creado, pagado, enviado]`) y acciones como `POST /pedidos/{id}/pago`, Mockix deduce la máquina de estados y la ruta `GET` responde el estado actual. Revísalo en **Escenarios**. |
| **Perfiles de caos** | Tres perfiles con los errores de servidor del contrato (lenta, inestable y caída), **apagados**. Los activas en **Perfiles de caos** cuando quieras. |

**Pide cualquier respuesta del contrato.** Si el contrato documenta un 404 o un 500, el mock te lo da cuando lo pides. Así pruebas cómo reacciona tu app a cada error sin tocar nada:

- En el navegador, añade `?mockix_respuesta=404` a la dirección.
- Desde tu app o PowerShell, manda la cabecera `X-Mockix-Respuesta`:

  ```powershell
  Invoke-RestMethod -Method Post http://127.0.0.1:3001/v1/pedidos -Headers @{ "X-Mockix-Respuesta" = "500" }
  ```

Sin eso, el mock responde la respuesta normal (la primera correcta del contrato).

**Si tu contrato es diferente:**

- **Solo acciones** (todo es `POST` o `PUT`, sin `GET /recurso/{id}`): no hay datos ni estados que deducir, así que quedan las rutas con todas sus respuestas, que puedes elegir como arriba. El informe lo dice.
- **Swagger 2.0:** Mockix lo convierte a OpenAPI 3 y conecta esa conversión, en `contracts/`. Tu archivo no cambia, y el informe lo dice.

¿Tienes una colección de Postman o Sendix, un HAR o un entorno de Mockoon? Usa el icono **Importar** (la flecha hacia abajo). ¿Prefieres empezar de cero? En **Nuevo mock** elige **Vacío** y luego usa **+** para añadir rutas.

## Paso 7. Úsalo en tu app

En tu app, cambia la dirección de la API real por la del mock (por ejemplo `http://127.0.0.1:3000/v1`). Cuando la API real esté lista, vuelves a poner la de siempre.

## Más funciones, paso a paso

Con lo anterior ya tienes un mock funcionando. Estas cuatro funciones lo acercan a una API de verdad. Todas se prueban con el ejemplo **tienda** encendido, y se abren desde los iconos del **rail**, la columna de iconos a la izquierda de la ventana.

### Grabaciones: copia una API que ya existe

**Para qué sirve:** si la API real ya existe, Mockix la puede «copiar». Se pone en medio, deja pasar tus peticiones, guarda lo que responde la API y lo convierte en un mock. Así no escribes las respuestas a mano.

**Pruébalo grabando la propia tienda**, como si fuera la API real:

1. Abre **Grabaciones** en el rail.
2. Arriba verás `localhost:4100 → https://`. Ese `4100` es el puerto del intermediario (el *proxy*). A la derecha de la flecha escribe la API que quieres copiar: `http://127.0.0.1:3000/v1`.
3. Pulsa **Grabar**.
4. En el navegador abre `http://localhost:4100/productos/prd_7Qm2` y luego `http://localhost:4100/productos/prd_8Lx4`. Fíjate que usas el puerto **4100**, el del proxy, no el 3000.
5. Pulsa **Detener**. En **Tráfico** ves las dos peticiones. En **Rutas detectadas**, Mockix ya entendió que son la misma ruta, `GET /productos/:id`.
6. En **Destino** deja «mock nuevo», ponle un nombre y pulsa **Convertir en mocks**.

Con una API real haces lo mismo: en el paso 2 pones su dirección (por ejemplo `https://api.miempresa.com`), y en tu app la cambias por `http://localhost:4100` mientras grabas.

> Las contraseñas, tokens y cookies no pasan al mock: Mockix los quita o los cambia por datos inventados. La grabación original queda en la carpeta `.mockix`, que no se sube a git.

### Escenarios: respuestas que cambian con el tiempo

**Para qué sirve:** una API real recuerda cosas. Un pedido primero está «creado», cuando lo pagas pasa a «pagado» y luego a «enviado». Un escenario hace que tu mock se comporte así.

**Pruébalo con el pedido del ejemplo:**

1. Abre en el navegador `http://127.0.0.1:3000/v1/pedidos/ped_1`. Responde `{ "id": "ped_1", "estado": "creado" }`.
2. Paga el pedido. Esto no se puede hacer desde la barra del navegador, porque es un `POST`. Pégalo en PowerShell:

   ```powershell
   Invoke-RestMethod -Method Post http://127.0.0.1:3000/v1/pedidos/ped_1/pago
   ```

3. Vuelve a abrir `.../pedidos/ped_1`: ahora dice `"estado": "pagado"`.
4. Espera 10 segundos y ábrelo otra vez: `"estado": "enviado"`, con su número de guía.
5. Abre **Escenarios** en el rail. Verás el diagrama del pedido con el estado actual resaltado, la instancia `ped_1` y qué la hizo avanzar. Desde ahí puedes **Forzar estado** o **Reiniciar instancias** para volver a empezar.

Cada id lleva su propio estado: `ped_2` empieza otra vez en «creado».

**Cómo es por dentro:** el escenario es un archivo en `mocks/tienda/scenarios/pedido.yaml`:

```yaml
key: params.id                 # un estado distinto por cada id de pedido
initial: creado                # el estado con el que empieza
states: [creado, pagado, enviado, entregado, cancelado]
transitions:
  - { from: creado, to: pagado, on: { method: POST, path: /pedidos/:id/pago } }   # con una petición
  - { from: pagado, to: enviado, after: 10s }                                     # con el tiempo
```

La ruta `GET /pedidos/:id` tiene una respuesta para cada estado.

### Perfiles de caos: una red mala a propósito

**Para qué sirve:** en la vida real la red a veces va lenta o la API falla. Con un perfil de caos compruebas que tu app lo aguanta: que muestra un aviso en vez de quedarse en blanco, que reintenta, etc.

**Pruébalo:**

1. Abre **Perfiles de caos** en el rail. A la izquierda están los perfiles del ejemplo: `red-inestable`, `rampa`, `pico`, `red-3g` y `se-cae-a-los-30s`.
2. Elige **red-3g**, que simula un celular lento. La gráfica muestra la latencia (cuánto tarda en responder) y los errores a lo largo del tiempo.
3. A la derecha, en **Dónde se aplica**, busca el mock **tienda** y elige `red-3g` en su lista. Para quitarlo, elige «sin caos».
4. Abre de nuevo `http://127.0.0.1:3000/v1/productos`: ahora tarda un tercio de segundo o más. En la pestaña **Efectos aplicados** ves qué le hizo el caos a cada petición, por ejemplo `+391 ms`.

Prueba **red-inestable** para ver errores 500 y 503 a los 30 segundos. Para cambiar una curva, arrastra sus puntos sobre la gráfica y pulsa **Aplicar cambios**. **Pausar caos** lo detiene sin quitarlo.

### Contratos: que el mock no se invente nada

**Para qué sirve:** un contrato es la especificación oficial de tu API: qué rutas existen, qué datos recibe cada una y qué devuelve. Si el mock tiene contrato, Mockix revisa cada petición contra él y te avisa cuando tu app manda algo que la API real rechazaría. También revisa las respuestas del propio mock, para que no se quede desactualizado.

**Cómo debe ser un contrato:**

- **El formato:** un archivo **OpenAPI 3.0 o 3.1**, en YAML o JSON, el formato estándar para describir APIs. Si tu equipo ya tiene la documentación de la API en Swagger u OpenAPI, ese archivo sirve tal cual.
- **Dónde va:** en la carpeta `contracts/` del workspace, por ejemplo `contracts/tienda.openapi.yaml`.
- **Qué tiene:** cada ruta con sus parámetros, el cuerpo que espera (`requestBody`) y lo que responde (`responses`), cada uno con su esquema: qué campos hay, de qué tipo y cuáles son obligatorios. Mockix solo puede revisar lo que el contrato describe.
- **El prefijo:** va en `servers` (`url: http://localhost:3000/v1`) y las rutas van sin él (`/productos`, no `/v1/productos`).

Un trozo del contrato del ejemplo:

```yaml
openapi: 3.1.0
info: { title: Tienda demo, version: 1.0.0 }
servers:
  - url: http://localhost:3000/v1
paths:
  /productos:
    get:
      parameters:
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
                  data: { type: array }
                  total: { type: integer }
```

**Cómo se conecta al mock:** en `mocks/tienda/mock.yaml`:

```yaml
contract:
  file: contracts/tienda.openapi.yaml
  mode: warn        # off: apagado · warn: avisa y responde igual · strict: responde 400 si no cumple
```

**Pruébalo:** el ejemplo ya tiene su contrato en modo «avisar».

1. Manda un producto con el precio mal escrito (como texto en lugar de número). Pégalo en PowerShell:

   ```powershell
   Invoke-RestMethod -Method Post http://127.0.0.1:3000/v1/productos -ContentType application/json -Body '{"nombre":"Taza","precio":"caro"}'
   ```

   PowerShell lo muestra en rojo porque el mock respondió un error (422, «Datos no válidos»): es lo esperado.

2. Abre **Contratos** en el rail. Verás la regla que se rompió, explicada: `body.precio debe ser number (recibido "caro", un string)`. También ves qué cliente la rompió y qué operaciones del contrato todavía no tienen mock.
3. Cambia el modo a **Estricto** y repite el paso 1: ahora responde el propio contrato, con un error 400 «La petición no cumple el contrato» y la explicación del campo que falló.

## Borrar un mock

Selecciona el mock y, debajo de sus datos, pulsa **Mover el mock a la papelera**. Mockix lo detiene si está en marcha y manda su carpeta a la papelera de Windows, de donde lo puedes recuperar.

## Palabras que vas a ver

| Palabra | Qué significa |
|---|---|
| **Workspace** | La carpeta donde guardas tus mocks. Es la que abres en Mockix. |
| **Mock** | Una API de mentiras, con su dirección y su puerto. |
| **Ruta** | Una dirección del mock, como `GET /productos/:id`. El `:id` es la parte que cambia. |
| **Respuesta** | Lo que devuelve una ruta. Una ruta puede tener varias y elegir según la petición. |
| **Puerto** | El número al final de la dirección (`3000`). Cada mock usa el suyo. |

## Si algo sale mal

| Ves | Haz esto |
|---|---|
| «Esa carpeta es el mock «x», no un workspace» | Abriste una carpeta de más adentro. Abre la que indica el mensaje. |
| El mock queda «Con errores» y dice `PORT_IN_USE` | Otro programa usa el puerto 3000. Abre `mocks\tienda\mock.yaml` con el Bloc de notas, cambia `port: 3000` por otro número (como `3001`) o por `0` para que Mockix elija uno libre, guarda y pulsa **Iniciar** otra vez. |
| El navegador dice que no puede conectar | El mock está apagado. Selecciónalo y pulsa **Iniciar**. |
| Ves «No route in this mock» | La dirección no coincide con ninguna ruta. Revisa que lleve el prefijo `/v1`. |

## ¿Y después?

- **El [manual](MANUAL.md)** explica todo lo demás: respuestas que cambian según la petición, datos falsos y rutas CRUD, WebSocket, Socket.IO y gRPC, la terminal y Docker, y dejar que un agente de IA cree rutas por ti.
- **Explora el ejemplo:** tiene de todo. Cada ruta de `tienda` es un archivo que puedes abrir para ver cómo está hecha.
