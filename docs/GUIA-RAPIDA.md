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

## Paso 6. Crea el mock de tu propia API

Si tienes la especificación de tu API en un archivo OpenAPI o Swagger (`.yaml` o `.json`):

1. Pulsa el icono **Importar** en la barra de la izquierda (la flecha hacia abajo) y elige tu archivo.
2. Mockix crea un mock con una ruta por cada operación, con los ejemplos de tu archivo o con datos inventados.
3. Selecciónalo y pulsa **Iniciar**.

También importa colecciones de Postman y de Sendix, archivos HAR y entornos de Mockoon.

¿Prefieres empezar de cero? Usa el icono **Nuevo mock** (el servidor) y luego **+** para añadir rutas.

## Paso 7. Úsalo en tu app

En tu app, cambia la dirección de la API real por la del mock (por ejemplo `http://127.0.0.1:3000/v1`). Cuando la API real esté lista, vuelves a poner la de siempre.

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

- **El [manual](MANUAL.md)** explica todo lo demás: respuestas que cambian según la petición, datos falsos, pedidos que avanzan de estado, red lenta a propósito, WebSocket y gRPC, grabar una API real y dejar que un agente de IA cree rutas por ti.
- **Explora el ejemplo:** tiene de todo. En el rail de la izquierda prueba **Escenarios** y **Perfiles de caos**.
