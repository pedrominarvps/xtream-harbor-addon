# Xtream → Harbor

Addon personal que convierte una cuenta Xtream en tres catálogos compatibles con el protocolo Stremio: películas, series y TV en vivo. Funciona como un servicio independiente y se instala en Harbor por URL.

Requiere Node.js 22.14 o posterior, hasta la versión 25, y una cuenta Xtream activa. Render utiliza Node 24 según el archivo `.node-version`; la copia local está probada con Node 25. No tiene dependencias de ejecución ni necesita una base de datos. El archivo `.env` local contiene tus credenciales: está excluido de Git. El enlace privado del addon permite consultar streams de esa cuenta; consérvalo como una contraseña.

## Probar en tu equipo

Esta copia puede tener un `.env` local ya configurado. En ese caso, ejecuta desde esta carpeta:

```powershell
npm ci
npm run check
npm test
npm start
```

Abre [la página de instalación local](http://localhost:7000). Introduce el valor `ADDON_ACCESS_KEY` de tu `.env` y copia la URL que aparece. En Harbor abre **Addons**, selecciona la opción de añadir mediante URL y pega el enlace del manifest. Los contenidos estarán en los catálogos del addon.

También puedes ejecutar `npm run install-link`: guarda el enlace privado en `.install-local.md`, excluido de Git. Esta copia ya incluye ese archivo para facilitar la prueba local. Cópialo desde allí y evita publicarlo junto con el proyecto.

Para configurar otra copia:

```powershell
Copy-Item .env.example .env
npm run key
notepad .env
```

Completa las cuatro variables obligatorias y pega la clave generada en `ADDON_ACCESS_KEY`. Después ejecuta `npm start`. No reutilices la contraseña Xtream como clave del addon.

Para comprobar tu proveedor con peticiones reales, ejecuta `npm run smoke`. Valida la autenticación, los tres catálogos, los episodios de la primera serie y los encabezados de un enlace de cada tipo. No descarga videos ni imprime enlaces o credenciales. Un HTTP 200 confirma la respuesta a HEAD; la reproducción completa se comprueba desde Harbor.

## Subir a Render Free

1. Crea un repositorio para **esta carpeta independiente** y sube sus archivos, incluyendo `package-lock.json` y `render.yaml`. Excluye `.env`, `.install-local.md` y `node_modules`; están indicados en `.gitignore`.
2. En Render elige **New → Blueprint**, conecta ese repositorio y utiliza el `render.yaml` incluido. Crea un Web Service de Node con plan **Free**.
3. Completa `XTREAM_SERVER`, `XTREAM_USERNAME`, `XTREAM_PASSWORD` y `ADDON_ACCESS_KEY` en los campos secretos del despliegue. Puedes copiar esos valores desde tu `.env` local. No los añadas al YAML ni al repositorio.
4. Al terminar el despliegue, abre la URL HTTPS del servicio. Introduce la clave de instalación, copia el enlace e instálalo en Harbor.

El addon detecta automáticamente `RENDER_EXTERNAL_URL`. Si utilizas un dominio propio, configura `PUBLIC_URL` con su origen HTTPS, sin rutas ni parámetros.

Si creas el servicio manualmente, usa:

| Campo | Valor |
| --- | --- |
| Runtime | Node |
| Instance type | Free |
| Build command | `npm ci && npm run check && npm test` |
| Start command | `npm start` |
| Health check | `/health` |

Render Free suspende el servicio tras 15 minutos sin tráfico y puede tardar aproximadamente un minuto en reactivarlo. Harbor tiene un tiempo de espera menor: **abre primero la página del addon y espera a que cargue cuando el servicio esté dormido**, luego vuelve a intentar en Harbor. El plan también tiene cuotas de horas, tráfico y compilación; revisa los límites vigentes en [la documentación oficial de Render](https://render.com/docs/free). La configuración del servicio está descrita en [Render Blueprints](https://render.com/docs/blueprint-spec).

## Metadatos de TMDB

El addon aprovecha títulos, imágenes, sinopsis, fechas y puntuaciones que ya entrega Xtream. Si el proveedor ha integrado TMDB, esos datos llegan sin que tengas que proporcionar otra clave.

Para enriquecer adicionalmente las fichas, configura una de estas variables opcionales:

| Variable | Uso |
| --- | --- |
| `TMDB_READ_TOKEN` | Token de lectura de TMDB, enviado como Bearer |
| `TMDB_API_KEY` | Clave v3 de TMDB, alternativa al token |
| `TMDB_LANGUAGE` | Idioma de las fichas; por defecto `es-ES` |

Puedes añadirlas en **Environment** en Render o en `.env` local. El token tiene prioridad si existen ambos. El addon consulta TMDB solamente cuando la fila Xtream contiene un `tmdb_id`; conserva siempre los identificadores y episodios de tu proveedor. Si TMDB falla, utiliza los metadatos Xtream disponibles. Los catálogos no hacen una petición TMDB por cada elemento.

This product uses the TMDB API but is not endorsed or certified by TMDB. [TMDB](https://www.themoviedb.org/) y su [documentación de autenticación](https://developer.themoviedb.org/docs/authentication-application) describen el servicio externo opcional.

## Qué verás en Harbor

| Contenido | Comportamiento |
| --- | --- |
| Películas | Catálogo paginado, búsqueda, ficha y enlace de reproducción |
| Series | Catálogo, ficha, temporadas, especiales y episodios ordenados |
| TV | Catálogo de canales y enlace de reproducción en vivo |

Los canales se muestran como un catálogo del addon. No se agregan automáticamente a la sección IPTV nativa **En vivo**, ni se genera una guía EPG a partir de una API sin programación. Este addon tampoco corrige endpoints XMLTV ausentes en el proveedor.

Los identificadores propios, como `xtream:series:123:1:2`, permiten a Harbor pedir exactamente el episodio de tu cuenta. Cuando Xtream no proporciona fecha del episodio se usa `1970-01-01` como fecha desconocida para cumplir el campo requerido por el protocolo; no es su fecha de emisión.

## Cómo funciona

Harbor consulta el manifest y los recursos `catalog`, `meta` y `stream`. El addon consulta `player_api.php`, guarda catálogos y detalles en memoria durante cinco minutos y devuelve JSON. Las peticiones simultáneas al mismo recurso comparten la consulta. La caché es limitada y se reconstruye tras reiniciar el servicio.

El recurso stream conserva `stream_url` o `direct_source` cuando el proveedor los entrega. Si faltan, genera el enlace Xtream estándar con las credenciales codificadas, el identificador y la extensión. Para TV sin enlace explícito utiliza HLS (`m3u8`). Harbor descarga el video directamente del proveedor, así que el tráfico de video no atraviesa Render. Siguen aplicándose los límites de conexiones de la cuenta Xtream.

Los endpoints del addon usan una clave aleatoria en la ruta. La página pública y `/health` no exponen la biblioteca ni las credenciales. Los errores no incluyen las URLs autenticadas. El addon no almacena claves en el navegador, no retransmite videos y no ofrece un registro público de cuentas. El enlace instalado y los streams recibidos sí deben ser accesibles para tu reproductor.

Referencias del formato: [protocolo Stremio](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md), [manifest](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md), [metadatos](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/meta.md) y [streams](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md).

## Resolver problemas

- **No aparece el addon:** instala la URL que termina en `/manifest.json`, verifica la clave y espera a que Render reactive el servicio.
- **Los catálogos dan un error del proveedor:** verifica las tres variables Xtream y que la cuenta esté activa. La raíz HTTP del servidor puede devolver 404 aunque `player_api.php` funcione.
- **Hay fichas pero el video no reproduce:** ejecuta `npm run smoke`, verifica la disponibilidad del enlace y cierra reproducciones simultáneas si superan el límite de tu cuenta.
- **Cambiaste `ADDON_ACCESS_KEY`:** elimina el addon antiguo en Harbor y vuelve a instalarlo con el nuevo enlace. Cambiar la clave revoca los enlaces anteriores del addon, pero no los enlaces de video que ya haya recibido un cliente; para revocarlos debes cambiar las credenciales Xtream.
- **Faltan cambios recientes del catálogo:** la caché se actualiza en cinco minutos o al reiniciar el servicio.

## Validación del proyecto

`npm run check` comprueba la sintaxis de todo el JavaScript. `npm test` verifica el protocolo HTTP contra un servidor de prueba, autenticación, búsqueda con caracteres especiales, paginación, mapeo de episodios, selección de enlaces, caché y ausencia de credenciales en páginas públicas. Las pruebas automáticas no usan la cuenta real ni necesitan conexión a Internet.
