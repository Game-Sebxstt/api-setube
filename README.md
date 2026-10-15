# Setube API

API de Setube, un convertidor de YouTube a mp3, m4a, wav y mp4. Convierte en streaming: yt-dlp descarga, ffmpeg convierte y el resultado sale directo en la respuesta HTTP, sin guardar archivos en disco. El progreso real de cada conversión se envía por SSE.

Redis se usa para la caché de metadata, el estado de los jobs, el pub/sub del progreso, la cola global de conversiones y el rate limit.

El cliente web está en `../setube` y ambos se levantan juntos con `../docker-compose.yml`.

Autor: Sebxstt.

## Stack y requisitos

- Node 24, Fastify 5 y TypeScript.
- Redis 7.
- yt-dlp y ffmpeg (estático) vienen incluidos en la imagen Docker; no hay que instalarlos aparte.
- Docker con Docker Compose v2.

El servidor solo corre en Linux: usa descriptores extra de stdio con ffmpeg, SIGKILL y tmpfs. En Windows usa Docker (perfil `dev`) o WSL2. `npm run dev` directamente en Windows no está soportado.

## Cómo funciona una conversión

1. `POST /api/resolve` reconoce los enlaces (videos y playlists) y trae título, autor y miniatura con oEmbed, que responde rápido y se cachea en Redis.
2. `GET /api/videos/:videoId` obtiene la metadata completa con yt-dlp (duración, formatos disponibles, tamaño estimado). Se cachea en Redis, así que la segunda vez es inmediata.
3. `POST /api/jobs` crea el job con los videos, el formato y la calidad. Valida duración, directos y videos privados antes de aceptar.
4. El cliente abre `GET /api/jobs/:id/events` (SSE) y pide la descarga de cada item (`/file`) o de todo junto (`/archive`).
5. Mientras la descarga sale por la respuesta HTTP, el progreso se publica por Redis y llega al SSE: de 0 a 85 % corresponde a la descarga de YouTube y de 85 a 100 % a la conversión.

Más detalles:

- ZIP en streaming: `/archive` arma el ZIP sobre la marcha mientras convierte cada item. En audio convierte varios en paralelo (`ZIP_PARALLEL_AUDIO`); en video, de uno en uno.
- Cancelación: `DELETE /api/jobs/:id` corta las descargas en curso, mata los procesos de yt-dlp y ffmpeg y libera el turno en la cola.
- Cola: un semáforo en Redis limita cuántas conversiones corren a la vez (`CONVERT_CONCURRENCY`). Como vive en Redis, funciona igual con una o varias instancias de la API. Las cabeceras de la respuesta se envían antes de esperar turno y el SSE informa la posición en la cola.

## Formatos y calidades

| Formato | Calidades | Notas |
|---|---|---|
| mp3 | 128, 192 (por defecto), 320 kbps | Se recodifica con libmp3lame. |
| m4a | — | Copia el AAC original sin recodificar; si el video no tiene AAC, recodifica a AAC 192 kbps. |
| wav | — | PCM 16 bits, 44,1 kHz, estéreo. |
| mp4 | 360, 480, 720 (por defecto), 1080, `best` | Une video y audio sin recodificar. |

El WAV sale con cabecera RIFF de tamaño indeterminado y el M4A/MP4 como MP4 fragmentado, porque se generan en streaming. Algunos reproductores pueden mostrar mal la duración.

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado de la API y de Redis. 200 `{status:"ok", redis:"ok", version, uptimeSec}` o 503 `{status:"degraded", redis:"down"}`. Sin rate limit. |
| GET | `/api/config` | Límites y formatos públicos (ver más abajo). |
| POST | `/api/resolve` | Recibe una lista de enlaces y devuelve qué es cada uno (video, playlist o inválido) con datos de oEmbed. |
| GET | `/api/videos/:videoId` | Metadata completa de un video con yt-dlp. |
| GET | `/api/videos/:videoId/audio` | Audio original del video para escucharlo en el navegador, con soporte de `Range` (ver «Escucha en streaming»). |
| POST | `/api/playlists/resolve` | Lista los videos de una playlist (hasta `MAX_PLAYLIST_ITEMS`). |
| POST | `/api/jobs` | Crea un job: `{ items: [{ videoId }], format, quality?, turnstileToken? }`. Responde 201. |
| GET | `/api/jobs/:id` | Estado actual del job y de sus items. |
| DELETE | `/api/jobs/:id` | Cancela el job. Responde 202. |
| GET | `/api/jobs/:id/events` | Progreso en tiempo real por SSE. |
| GET | `/api/jobs/:id/items/:itemId/file` | Descarga un item convertido, en streaming. |
| GET | `/api/jobs/:id/archive` | Descarga todos los items válidos en un ZIP, en streaming. |

Rate limits por IP (por minuto): 10 en `POST /api/jobs` y `POST /api/playlists/resolve`, 20 en las descargas, 30 en `/api/resolve`, SSE y `DELETE`, 120 en `/api/videos`, 60 en el audio (`PREVIEW_RATE_LIMIT_MAX`). El resto usa `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`.

Todos los errores tienen la misma forma:

```json
{
  "error": { "code": "LIMIT_DURATION", "message": "El video supera la duración máxima permitida.", "details": {} },
  "requestId": "..."
}
```

`details` es opcional. Los códigos y sus estados HTTP están en `src/lib/errors.ts` (por ejemplo `INVALID_URL` 400, `LIMIT_ITEMS` 413, `RATE_LIMITED` 429, `TOO_MANY_PREVIEWS` 429, `QUEUE_FULL` 503, `UPSTREAM_BLOCKED` 503).

## Escucha en streaming

`GET /api/videos/:videoId/audio?codec=aac|opus&sid=<32 hex>` deja escuchar el audio de un video antes de convertirlo. Es un proxy del audio original de YouTube: no usa ffmpeg, no escribe a disco y no ocupa turnos de la cola de conversión.

- Formato: por defecto m4a/AAC (itag 140, `audio/mp4`), que es el que más navegadores reproducen. Si el video no lo tiene, sirve webm/opus (`audio/webm`). Con `?codec=opus` el orden se invierte. El `Content-Type` siempre corresponde al formato servido.
- La URL firmada sale del info JSON que ya está en Redis; si falta o caducó, se vuelve a pedir a yt-dlp.
- Hacia YouTube se piden tramos de 10 MiB como máximo (`PREVIEW_CHUNK_BYTES`), igual que hace yt-dlp, aunque el navegador pida `bytes=0-`. Las peticiones abiertas o muy grandes YouTube las sirve a ~30 KiB/s.
- Respuestas: `206` con `Content-Range` si llega `Range`; `200` con el archivo completo si no; `416` con `Content-Range: bytes */T` si el rango queda fuera del archivo. Siempre con `Accept-Ranges: bytes`, `Content-Length`, `ETag` (para `If-Range`) y `Cache-Control: private, max-age=600`. Los errores llevan `Cache-Control: no-store` y la forma única de error.
- Si YouTube responde 403 o 410, la API reintenta la misma URL, después la original y, como último paso, vuelve a extraer la metadata, sin que el navegador lo note. Si el formato sigue rechazado, queda marcado 2 minutos y se responde `UPSTREAM_FORBIDDEN`.
- Si el navegador cierra la conexión, la petición a YouTube se cancela al momento. El envío respeta el ritmo de lectura del navegador, así que la memoria por oyente es pequeña.
- Límites: `PREVIEW_MAX_STREAMS_PER_IP` reproductores por IP (`TOO_MANY_PREVIEWS` 429), `PREVIEW_MAX_STREAMS_PER_INSTANCE` conexiones por instancia (`INSTANCE_BUSY` 503), `PREVIEW_RATE_LIMIT_MAX` peticiones por minuto, `MAX_DURATION_AUDIO_SEC` como duración máxima (`LIMIT_DURATION`) y sin directos (`LIVE_NOT_SUPPORTED`). El `sid` identifica al reproductor de cada pestaña: todas sus conexiones (los saltos en la barra abren varias) cuentan como uno.
- Si llegan `Origin` o `Referer` de un origen que no está en `CORS_ORIGINS`, responde 403. Sin ninguno de los dos, se acepta.
- `PREVIEW_ENABLED=false` apaga la ruta (`SERVICE_UNAVAILABLE` 503) y `/api/config` pasa a `preview: false`, así la web oculta el botón.
- Railway corta cualquier petición HTTP a los 15 minutos. En audios largos el navegador retoma solo con un `Range` desde donde iba, así que la escucha sigue.

Cada petición deja una línea `preview_finished` en el log con el formato, los bytes, el resultado (`ok`, `error`, `client_closed`, `idle`, `superseded` o `shutdown`) y los reintentos. Nunca registra URLs, cabeceras, IPs ni el `sid` en claro.

## Bloqueo de YouTube: PO token, proxy y cookies

Desde IPs de datacenter (Railway, VPS) YouTube responde a menudo «Sign in to confirm you're not a bot» (`UPSTREAM_BLOCKED`) o 403 al descargar. Hay tres herramientas, de menos a más esfuerzo, y se pueden combinar.

### PO token (servicio `pot`)

El PO token (Proof of Origin) es una prueba que genera BotGuard, el sistema anti-bots de YouTube, para demostrar que la petición viene de un cliente real. Algunos clientes de YouTube lo exigen para servir los formatos (las peticiones a googlevideo, «GVS») y sin él responden 403 o marcan la IP. Cada token está atado al video, así que hay que generar uno por video.

Setube usa [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider), que tiene dos partes:

- El servidor HTTP, que corre como servicio aparte (`pot`, imagen `brainicism/bgutil-ytdlp-pot-provider:2.0.2-node`, puerto 4416) y genera los tokens.
- El plugin de yt-dlp, que va dentro de la imagen de la API en `/opt/yt-dlp/yt-dlp-plugins/`. El binario standalone de yt-dlp carga los zip de esa carpeta junto al ejecutable, sin depender de `HOME`. Su versión está en `BGUTIL_POT_VERSION` y `BGUTIL_POT_SHA256` del `Dockerfile` y tiene que coincidir con la del servidor.

Con `POT_PROVIDER_URL` definido, cada llamada a yt-dlp (metadata, playlists y descargas) recibe `--extractor-args "youtubepot-bgutilhttp:base_url=<POT_PROVIDER_URL>"` y además `youtube:player_client=default,mweb`. El [PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) de yt-dlp recomienda el cliente `mweb` con PO token para GVS; se suma a los clientes por defecto (`visionos`), que no necesitan token, así que si uno falla queda el otro. Con `POT_PROVIDER_URL` vacío los plugins se desactivan (`--no-plugin-dirs`) y yt-dlp funciona como antes.

Al arrancar, la API registra `potProvider` en `setube_api_started` y hace un `GET /ping` al servidor: `pot_provider_ok` con la versión o `pot_provider_unreachable` como aviso. Si el servidor no responde la API arranca igual; yt-dlp sigue sin token.

Para comprobar a mano que el token se genera, dentro del contenedor de la API:

```sh
yt-dlp -v --extractor-args "youtubepot-bgutilhttp:base_url=http://pot:4416" --extractor-args "youtube:player_client=default,mweb" -s "https://www.youtube.com/watch?v=jNQXAC9IVRw"
```

Deben aparecer `PO Token Providers: bgutil:http-2.0.2 (external)` y `Generating a gvs PO Token for mweb client via bgutil HTTP server`.

Límites:

- El PO token no garantiza nada: ayuda a que el tráfico parezca legítimo, pero no salta los bloqueos por IP. Si con token sigue saliendo «Sign in to confirm», hacen falta cookies o un proxy.
- El servidor no tiene autenticación: nunca publiques su puerto ni le des dominio público.
- El servidor escribe en su propio log los tokens que genera. Son de corta duración y atados a un video, pero no compartas esos logs.
- Para actualizar, cambia a la vez la etiqueta de la imagen en compose/Railway y `BGUTIL_POT_VERSION` + `BGUTIL_POT_SHA256` (el `digest` del zip en el release de GitHub).

### Proxy (`YTDLP_PROXY`)

Con `YTDLP_PROXY` (`http://`, `https://` o `socks5://`, con `usuario:clave@` si el proveedor lo pide) yt-dlp sale por ese proxy en todas sus llamadas. Un proxy residencial es lo que más reduce los bloqueos, pero se paga por tráfico.

El proxy necesita una IP de salida estable. Muchos proxies residenciales rotan la IP en cada conexión por defecto, y eso no sirve aquí: las URLs de googlevideo llevan la IP que las pidió (`ip=`) y la info JSON se guarda en Redis durante `INFO_JSON_TTL_SEC` (3 h) para reutilizarla en la escucha y en las descargas (`--load-info-json`), que abren conexiones nuevas. Con rotación por petición la escucha entra en 403 → refresco → 403 y las descargas con info JSON en caché fallan. Usa una sesión fija (sticky) del proveedor que dure al menos `INFO_JSON_TTL_SEC`, o baja `INFO_JSON_TTL_SEC` por debajo de la duración de la sesión.

La escucha en streaming también sale por el mismo proxy, porque las URLs de googlevideo quedan atadas a la IP que las pidió. Usa `undici` (`ProxyAgent` para http/https y `Socks5ProxyAgent` para socks5). El soporte socks5 de undici es experimental: Node imprime un `ExperimentalWarning` al arrancar; si da problemas, usa un proxy http(s). El plugin del PO token le pasa el proxy al servidor `pot`, así que los retos de BotGuard también salen por él. La conexión entre la API y `pot` nunca pasa por el proxy.

El proxy nunca se registra completo: en los logs aparece como `http://[redacted]@host:puerto`, y las líneas de error de yt-dlp se limpian de `usuario:clave@` antes de guardarse. Eso sí, yt-dlp recibe el proxy completo en sus argumentos (`--proxy`), así que se puede leer en `/proc/<pid>/cmdline` desde dentro del contenedor mientras corre el proceso. Con un único usuario `node`, sistema de archivos de solo lectura y sin capabilities el riesgo es bajo, pero usa credenciales exclusivas para este proxy.

### Cookies de una cuenta secundaria

Las cookies de una sesión iniciada son lo más efectivo contra «Sign in to confirm», pero YouTube puede limitar o banear la cuenta. Usa siempre una cuenta secundaria, exporta las cookies de una sesión nueva (formato Netscape) y no abras esa sesión en el navegador mientras la usa la API. Se configuran con `YTDLP_COOKIES_FILE` o `YOUTUBE_COOKIES_JSON` (ver «Cookies con Docker secrets» y la sección de Railway). Con cookies de cuenta yt-dlp cambia sus clientes por defecto (`web_embedded`, `tv_downgraded`, `web`) y el PO token sigue ayudando con el cliente `web`.

## Desarrollo local

Todo se ejecuta desde la carpeta raíz (`convert`), donde está `docker-compose.yml`.

1. Crea el `.env` de la raíz a partir de `.env.example`. Son obligatorias `REDIS_PASSWORD` (hex, `openssl rand -hex 32`) e `IP_HASH_SALT`.
2. Opcional: copia `api-setube/.env.example` a `api-setube/.env.development` para ajustar variables de `api-dev`.
3. Levanta Redis y la API con recarga automática:

```powershell
docker compose --profile dev up redis api-dev
```

4. Comprueba que responde:

```powershell
Invoke-RestMethod http://localhost:4000/health
# o
curl http://localhost:4000/health
```

5. Para el cliente, en `setube` pon `NEXT_PUBLIC_API_URL=http://localhost:4000` en `.env.local` y corre `npm run dev`.

Notas:

- `api` y `api-dev` publican el puerto 4000: no los levantes a la vez.
- `api-dev` monta `api-setube/src`, `api-setube/test` y `api-setube/scripts` en solo lectura. Si cambias `package.json`, `tsconfig*.json`, `vitest.config.ts` o `eslint.config.js`, reconstruye con `docker compose --profile dev build api-dev`.
- En Windows, Docker Desktop a veces no detecta los cambios en archivos montados desde NTFS y `tsx watch` no recarga. Reinicia con `docker compose --profile dev restart api-dev` o trabaja desde el sistema de archivos de WSL2.
- `api-setube/.env` no se carga en ningún modo. Usa `api-setube/.env.development` para desarrollo y el `.env` de la raíz para compose.

### WSL2

Desde una copia del proyecto dentro del sistema de archivos de WSL2: `npm ci`, `cp .env.example .env.development` y `npm run dev`. Necesita `yt-dlp` y `ffmpeg` en el PATH, o `YTDLP_PATH` y `FFMPEG_PATH`.

### Scripts

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor con `tsx watch` y `.env.development`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint (incluye `scripts/`). |
| `npm test` | Tests unitarios (sin red, sin Redis, sin binarios). |
| `npm run test:integration` | Tests con Redis real y binarios falsos. |
| `npm run build` | Compila a `dist/`. |
| `npm start` | Corre `dist/server.js`. |

Los tests de integración se corren dentro del contenedor, desde la raíz:

```powershell
docker compose --profile dev run --rm api-dev npm run test:integration
```

Usan la DB 15 del Redis de compose (`TEST_REDIS_URL`) con un prefijo propio y limpian sus claves al terminar. Si no hay Redis, fallan en lugar de omitirse.

Con el stack de producción arriba, `node api-setube/scripts/e2e.mjs http://localhost:4000` prueba la API contra YouTube real: resolve, metadata, playlists, un job por formato, ZIP, cancelación, cola y una matriz de 10 videos (`scripts/e2e-matrix.json`). Tarda unos minutos y descarga varios cientos de MB.

## Variables de entorno

Los valores por defecto de esta tabla son los del código (`src/config/env.ts`); `api-setube/.env.example` tiene los mismos con comentarios.

### General

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `4000` | Puerto HTTP. |
| `HOST` | `0.0.0.0` | Interfaz donde escucha. |
| `NODE_ENV` | `production` | `production`, `development` o `test`. La imagen de desarrollo usa `development`. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` o `silent`. |
| `CORS_ORIGINS` | `http://localhost:3000` | Orígenes permitidos, separados por coma, coincidencia exacta. |
| `TRUST_PROXY` | `false` | `false`, `true`, número de saltos o lista de CIDR. Detrás de un proxy con un salto: `1`. |
| `CLIENT_IP_HEADER` | vacío | Cabecera de la que se toma la IP real del cliente (rate limit, topes por IP y Turnstile). Detrás de Cloudflare: `cf-connecting-ip`. Si falta o no trae una IP válida, se usa la que deduce `TRUST_PROXY`. |
| `IP_HASH_SALT` | vacío | Secreto para anonimizar IPs. Obligatorio en producción. Si falta en desarrollo, se genera uno al azar. |

### Redis

| Variable | Default | Descripción |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379/0` | URL de Redis (`redis://` o `rediss://`). Si lleva contraseña, debe ser hex de 32 caracteres o más. |

### Binarios y cookies

| Variable | Default | Descripción |
|---|---|---|
| `YTDLP_PATH` | `yt-dlp` | Ruta de yt-dlp. La imagen usa `/opt/yt-dlp/yt-dlp`. |
| `FFMPEG_PATH` | `ffmpeg` | Ruta de ffmpeg. La imagen usa `/usr/local/bin/ffmpeg`. |
| `YTDLP_ARGS_PREFIX` | `[]` | Array JSON que se antepone a los argumentos de yt-dlp. Solo para tests. |
| `FFMPEG_ARGS_PREFIX` | `[]` | Igual, para ffmpeg. Solo para tests. |
| `POT_PROVIDER_URL` | vacío | URL del servidor del PO token provider (`http://` o `https://`), p. ej. `http://pot:4416`. Vacío = desactivado. En compose vale `http://pot:4416` salvo que pongas otra cosa en el `.env` de la raíz. |
| `YTDLP_PROXY` | vacío | Proxy de salida para yt-dlp y para el audio de la escucha (`http://`, `https://` o `socks5://`). Vacío = sin proxy. |
| `YTDLP_COOKIES_FILE` | vacío | Ruta a un `cookies.txt` (formato Netscape). Recomendado en producción con Docker secrets. |
| `YOUTUBE_COOKIES_JSON` | vacío | Cookies como variable de entorno. En producción arranca igual, pero registra el aviso `cookies_via_env`. |
| `AUDIO_HLS_FALLBACK` | `true` | Si un video no tiene audio por https, usa el audio HLS. |
| `YTDLP_INFO_JSON` | `true` | Reutiliza el info JSON cacheado al descargar para no volver a pedir la metadata a YouTube. |

### Límites

| Variable | Default | Descripción |
|---|---|---|
| `MAX_ITEMS_PER_JOB` | `50` | Videos por job. Máximo 100. |
| `MAX_PLAYLIST_ITEMS` | `50` | Videos que se leen de una playlist. No puede superar `MAX_ITEMS_PER_JOB`. |
| `MAX_RESOLVE_URLS` | `50` | Enlaces por petición a `/api/resolve`. |
| `MAX_DURATION_AUDIO_SEC` | `3600` | Duración máxima en mp3, m4a y wav (60 min). |
| `MAX_DURATION_VIDEO_SEC` | `1200` | Duración máxima en mp4 (20 min). |

### Cola y concurrencia

| Variable | Default | Descripción |
|---|---|---|
| `CONVERT_CONCURRENCY` | `4` | Conversiones simultáneas en total (todas las instancias). Conviene igualarlo a los vCPU. |
| `QUEUE_MAX` | `200` | Peticiones esperando turno. Por encima responde `QUEUE_FULL`. |
| `MAX_STREAMS_PER_IP` | `3` | Descargas simultáneas por IP. |
| `MAX_STREAMS_PER_INSTANCE` | `40` | Descargas abiertas por instancia. |
| `META_CONCURRENCY` | `4` | Consultas de metadata a yt-dlp en paralelo. |

### Tiempos

| Variable | Default | Descripción |
|---|---|---|
| `QUEUE_WAIT_TIMEOUT_MS` | `300000` | Espera máxima en la cola (5 min). |
| `CONVERSION_TIMEOUT_MS` | `900000` | Tiempo máximo de conversión activa de un item, sin contar las pausas por un cliente lento (15 min). |
| `CONVERSION_WALL_TIMEOUT_MS` | `3600000` | Tiempo máximo real de un item desde que obtiene turno en la cola (60 min). |
| `STALL_TIMEOUT_MS` | `60000` | Corta si la conversión no avanza en este tiempo. |
| `SLOT_LEASE_MS` | `30000` | Vigencia del turno en el semáforo; se renueva mientras convierte. Mínimo 25000. |
| `WAIT_LEASE_MS` | `20000` | Vigencia de una espera en la cola. Mínimo 5000. |

### ZIP

| Variable | Default | Descripción |
|---|---|---|
| `ZIP_PARALLEL_AUDIO` | `3` | Items de audio que se convierten a la vez dentro de un ZIP. Entre 1 y `CONVERT_CONCURRENCY`. |
| `ZIP_PARALLEL_VIDEO` | `1` | Igual, para video. |
| `ZIP_ITEM_BUFFER_BYTES` | `33554432` | Buffer en memoria por item mientras espera su turno en el ZIP (32 MB). |

### Caché y TTL

| Variable | Default | Descripción |
|---|---|---|
| `META_TTL_SEC` | `21600` | Metadata de videos (6 h). |
| `INFO_JSON_TTL_SEC` | `10800` | Info JSON de yt-dlp (3 h). |
| `OEMBED_TTL_SEC` | `86400` | Datos de oEmbed (24 h). |
| `PLAYLIST_TTL_SEC` | `1800` | Contenido de playlists (30 min). |
| `JOB_TTL_SEC` | `7200` | Vida de un job (2 h). |

### Rate limit

| Variable | Default | Descripción |
|---|---|---|
| `RATE_LIMIT_MAX` | `120` | Peticiones por ventana para las rutas sin límite propio. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Ventana del rate limit (1 min). |

### SSE

| Variable | Default | Descripción |
|---|---|---|
| `SSE_HEARTBEAT_MS` | `15000` | Intervalo de heartbeat. |
| `SSE_MAX_LIFETIME_MS` | `1800000` | Vida máxima de una conexión SSE (30 min); el cliente reconecta. |
| `SSE_MAX_PER_JOB` | `5` | Conexiones SSE simultáneas por job. |

### Apagado

| Variable | Default | Descripción |
|---|---|---|
| `SHUTDOWN_GRACE_MS` | `30000` | Tiempo para cerrar SSE y procesos en curso al apagar. |

### Turnstile

| Variable | Default | Descripción |
|---|---|---|
| `TURNSTILE_SECRET` | vacío | Secreto de Cloudflare Turnstile. Vacío = desactivado. El cliente necesita `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. |

### Escucha en streaming

| Variable | Default | Descripción |
|---|---|---|
| `PREVIEW_ENABLED` | `true` | Activa la ruta de audio. Con `false` responde 503 y la web oculta el botón de escuchar. |
| `PREVIEW_MAX_STREAMS_PER_IP` | `4` | Reproductores simultáneos por IP. |
| `PREVIEW_MAX_STREAMS_PER_INSTANCE` | `100` | Conexiones de audio abiertas por instancia. |
| `PREVIEW_RATE_LIMIT_MAX` | `60` | Peticiones por minuto e IP a la ruta de audio. |
| `PREVIEW_CHUNK_BYTES` | `10485760` | Tamaño de cada tramo pedido a YouTube (10 MiB). Entre 1048576 y 10485760. |
| `PREVIEW_IDLE_TIMEOUT_MS` | `60000` | Corta la conexión si el navegador deja de leer durante este tiempo. Mínimo 5000. |

### Dónde se configuran

- Railway: en las variables del servicio de la API.
- Docker Compose (`api`): el servicio solo recibe las variables de su bloque `environment` en `../docker-compose.yml` (`REDIS_URL`, `IP_HASH_SALT`, `CORS_ORIGINS`, `TRUST_PROXY`, `TURNSTILE_SECRET`, `CONVERT_CONCURRENCY`, `POT_PROVIDER_URL`, `YTDLP_PROXY`, `YOUTUBE_COOKIES_JSON`); el resto usa los defaults. Para cambiar otra, agrégala a ese bloque y ponle el valor en el `.env` de la raíz:

  ```yaml
  environment:
    MAX_ITEMS_PER_JOB: "${MAX_ITEMS_PER_JOB:-50}"
  ```

- Desarrollo (`api-dev`): en `api-setube/.env.development`. `REDIS_URL`, `IP_HASH_SALT`, `CORS_ORIGINS`, `YTDLP_PATH` y `FFMPEG_PATH` vienen de compose y tienen prioridad.

### Validación al arrancar

La API valida la configuración al iniciar. Si algo no cuadra, registra un log `fatal` con el nombre de la variable (nunca su valor) y el proceso termina. Además de tipos y mínimos, comprueba:

- `MAX_ITEMS_PER_JOB` no mayor que 100.
- `MAX_PLAYLIST_ITEMS` no mayor que `MAX_ITEMS_PER_JOB`.
- `ZIP_PARALLEL_AUDIO` entre 1 y `CONVERT_CONCURRENCY` (con `CONVERT_CONCURRENCY=1` hay que poner `ZIP_PARALLEL_AUDIO=1`).
- `SLOT_LEASE_MS` de al menos 25000 y `WAIT_LEASE_MS` de al menos 5000.
- `YTDLP_ARGS_PREFIX` y `FFMPEG_ARGS_PREFIX` como arrays JSON de strings.
- `TRUST_PROXY` con un formato válido.
- `REDIS_URL` con protocolo `redis:`/`rediss:` y contraseña vacía o hex de 32+ caracteres.
- `IP_HASH_SALT` presente en producción.
- `CORS_ORIGINS` con al menos un origen.
- `PREVIEW_CHUNK_BYTES` entre 1048576 y 10485760, y `PREVIEW_IDLE_TIMEOUT_MS` de al menos 5000.
- `CLIENT_IP_HEADER` vacío o un nombre de cabecera válido (letras, números y guiones, hasta 64; se pasa a minúsculas).
- `POT_PROVIDER_URL` vacío o una URL `http:`/`https:` sin usuario, query, `,` ni `;` (yt-dlp usa esos dos como separadores en `--extractor-args`).
- `YTDLP_PROXY` vacío o una URL `http:`, `https:` o `socks5:` con host y sin ruta ni query.
- Si hay `YTDLP_COOKIES_FILE`, que el archivo se pueda leer.

### `/api/config`

El cliente lee los límites de `GET /api/config` (caché de 5 min), así que al cambiar las variables la web se ajusta sola. Expone `maxItemsPerJob`, `maxPlaylistItems`, `maxDurationAudioSec`, `maxDurationVideoSec`, las calidades por formato, las calidades por defecto (mp3 192, mp4 720), si Turnstile está activo y si la escucha en streaming está disponible (`preview`). Por esa caché, apagar `PREVIEW_ENABLED` puede tardar hasta 5 minutos en reflejarse en la web.

## Producción con Docker Compose

Desde la raíz:

```sh
cp .env.example .env          # rellena REDIS_PASSWORD, IP_HASH_SALT y NEXT_PUBLIC_API_URL
docker compose up -d --build --wait
```

- Servicios: `redis` (sin puertos publicados, red interna, sin persistencia y con comandos peligrosos deshabilitados), `pot` (PO token provider, sin puertos publicados, en la red interna y con salida a internet por la red `egress`; escucha en IPv4 e IPv6 con `--host 0.0.0.0,::`), `api` (puerto 4000, sistema de archivos de solo lectura, `/tmp` en tmpfs de 128 MB, sin capabilities; espera a que `pot` esté sano) y `web` (puerto 3000).
- Para levantar la API sin PO token, pon `POT_PROVIDER_URL=` (vacío) en el `.env` de la raíz.
- Ponlo detrás de un proxy con TLS y HTTP/2 (Cloudflare, Caddy). HTTP/2 importa porque el navegador abre un SSE y una descarga por job, y en HTTP/1.1 solo hay 6 conexiones por origen.
- Con proxy define `TRUST_PROXY` (normalmente `1`). Si no, todos los usuarios comparten la IP del proxy en el rate limit. Si se pone de más, cualquiera puede falsear `X-Forwarded-For`.
- Con Cloudflare (nube naranja) delante de Railway: `TRUST_PROXY=1` y `CLIENT_IP_HEADER=cf-connecting-ip`. Sin Cloudflare, solo `TRUST_PROXY=1`. Quien entre directo al dominio de Railway, saltándose Cloudflare, puede falsear esa cabecera; se acepta porque estos topes frenan abusos, no controlan el acceso.
- En la primera petición la API registra `proxy_hops_seen` (cuántas entradas trae `X-Forwarded-For` y si llega `CF-Connecting-IP`, sin IPs). Si `CLIENT_IP_HEADER` está puesto y una petición no la trae, avisa con `client_ip_header_missing`; en producción sin `TRUST_PROXY` ni `CLIENT_IP_HEADER` avisa con `trust_proxy_disabled`.
- `docker compose stop` da 40 s: la API deja de aceptar descargas, cierra los SSE con `server-restart` y termina los procesos en curso dentro de `SHUTDOWN_GRACE_MS`.
- Para actualizar yt-dlp cambia `YTDLP_VERSION` y los dos `YTDLP_SHA256_*` del `Dockerfile` (los valores están en `SHA2-256SUMS` del release) y reconstruye. El plugin del PO token pide yt-dlp 2025.05.22 o posterior.

### Cookies con Docker secrets

Las cookies son opcionales y ayudan con «Sign in to confirm you're not a bot».

1. Usa una cuenta secundaria y exporta un `cookies.txt` (formato Netscape) de una sesión nueva.
2. Guárdalo en `secrets/yt_cookies.txt` junto al `docker-compose.yml` de la raíz, fuera de cualquier repositorio.
3. En `docker-compose.yml` descomenta el bloque `secrets` del servicio `api`, el bloque `secrets` de nivel superior y la línea `YTDLP_COOKIES_FILE: /run/secrets/yt_cookies`.
4. En el host: `chmod 0444 secrets/yt_cookies.txt`, porque compose sin Swarm puede ignorar `uid`/`gid`/`mode`. Si la API no puede leer el archivo, no arranca.

Las cookies se escriben en un archivo temporal `0600` por cada proceso de yt-dlp y se borran al terminar. Nunca se loguean ni se guardan en Redis.

## Despliegue en Railway

### Servicios

Crea cuatro servicios en el mismo proyecto y la misma región:

1. Redis, desde la plantilla de Railway.
2. `pot`, el PO token provider (ver abajo).
3. API, desde este repositorio. Railway detecta el `Dockerfile` y lo usa.
4. Web, desde el repositorio `setube` (ver su README).

### Servicio `pot` (PO token)

1. New → Docker Image → `brainicism/bgutil-ytdlp-pot-provider:2.0.2-node`. Usa siempre una etiqueta fija, la misma versión que `BGUTIL_POT_VERSION` del `Dockerfile`, nunca `latest`.
2. Llama al servicio `pot` (la variable de la API depende de ese nombre).
3. En Settings → Networking no generes dominio público: solo se usa por la red privada y el servidor no tiene autenticación.
4. En Settings → Deploy → Custom Start Command pon:

   ```sh
   /usr/local/bin/node /app/build/main.js --host 0.0.0.0,::
   ```

   La imagen arranca con `--host 0.0.0.0`, que solo escucha en IPv4. La red privada de Railway usa IPv6 (en entornos creados antes del 16 de octubre de 2025, solo IPv6), así que sin ese comando la API no lo encuentra. El servidor no tiene ninguna variable para esto: se hace con `--host`, que acepta varias direcciones separadas por coma y abre un socket para cada una. Con un comando propio Railway reemplaza el `ENTRYPOINT` de la imagen, por eso va la ruta completa de node. En los logs debe aparecer `Started POT server (v2.0.2) on address 0.0.0.0:4416, [::]:4416`.
5. No necesita variables ni volumen. El puerto es 4416.

### Contraseña de Redis

La API exige que la contraseña de Redis sea hex de 32 caracteres o más, y la que genera la plantilla no lo es. Cambia la variable `REDIS_PASSWORD` del servicio Redis por un hex y vuelve a desplegar Redis:

```sh
openssl rand -hex 32
```

```powershell
-join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })
```

### Variables de la API

| Variable | Valor |
|---|---|
| `PORT` | `4000` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}?family=0` |
| `IP_HASH_SALT` | un hex generado igual que la contraseña |
| `CORS_ORIGINS` | `https://setube.sebxstt.dev,https://${{web.RAILWAY_PUBLIC_DOMAIN}}` |
| `TRUST_PROXY` | `1` |
| `CLIENT_IP_HEADER` | `cf-connecting-ip` (solo con Cloudflare delante) |
| `CONVERT_CONCURRENCY` | los vCPU de tu plan |
| `CONVERSION_WALL_TIMEOUT_MS` | `840000` |
| `MAX_ITEMS_PER_JOB` | `20` (recomendado) |
| `POT_PROVIDER_URL` | `http://${{pot.RAILWAY_PRIVATE_DOMAIN}}:4416` |
| `YTDLP_PROXY` | vacío, o la URL de tu proxy si lo usas (con IP de salida fija: sesión sticky de al menos `INFO_JSON_TTL_SEC`) |

- `POT_PROVIDER_URL` va con `http://`: el tráfico de la red privada ya va cifrado. Tras desplegar, el log de la API debe mostrar `pot_provider_ok`; si sale `pot_provider_unreachable`, revisa el nombre del servicio y el Custom Start Command de `pot`.
- `?family=0` es obligatorio: la red privada de Railway es IPv6 y ioredis por defecto solo resuelve IPv4. Sin eso la API no encuentra Redis.
- `CONVERSION_WALL_TIMEOUT_MS=840000` (14 min) porque Railway corta las peticiones HTTP a los 15 minutos. Así la API corta el item con un error claro antes de que lo haga el proxy.
- Si `CONVERT_CONCURRENCY` es menor que 3, baja también `ZIP_PARALLEL_AUDIO` a ese valor o la API no arranca.

Bloque para pegar en el editor «Raw» de variables de Railway (cambia los valores entre `<>`):

```env
PORT="4000"
NODE_ENV="production"
LOG_LEVEL="info"
REDIS_URL="${{Redis.REDIS_URL}}?family=0"
IP_HASH_SALT="<hex de 64 caracteres>"
CORS_ORIGINS="https://setube.sebxstt.dev"
TRUST_PROXY="1"
CLIENT_IP_HEADER="cf-connecting-ip"
CONVERT_CONCURRENCY="<vCPU de tu plan>"
CONVERSION_WALL_TIMEOUT_MS="840000"
MAX_ITEMS_PER_JOB="20"
POT_PROVIDER_URL="http://${{pot.RAILWAY_PRIVATE_DOMAIN}}:4416"
YTDLP_PROXY=""
PREVIEW_ENABLED="true"
PREVIEW_MAX_STREAMS_PER_IP="4"
PREVIEW_MAX_STREAMS_PER_INSTANCE="100"
PREVIEW_RATE_LIMIT_MAX="60"
PREVIEW_CHUNK_BYTES="10485760"
PREVIEW_IDLE_TIMEOUT_MS="60000"
```

### Prueba de la escucha tras desplegar

1. Un rango pequeño debe dar `206`:

   ```powershell
   curl.exe -sD - -r 0-1023 -o NUL "https://api-setube.sebxstt.dev/api/videos/jNQXAC9IVRw/audio" -H "Referer: https://setube.sebxstt.dev/"
   ```

   En macOS o Linux usa `curl` y `-o /dev/null`.
2. En los logs, `proxy_hops_seen` debe mostrar `cfConnectingIp: true`, sin avisos `client_ip_header_missing` ni `trust_proxy_disabled`.
3. Desde una misma red, cinco `curl --limit-rate 16k` en paralelo, cada uno con un `&sid=` distinto de 32 hex: el quinto debe dar `429 TOO_MANY_PREVIEWS`. Mientras siguen abiertos, uno desde otra red (por ejemplo, datos móviles) debe dar `206`.
4. Si el paso 1 da `502 UPSTREAM_FORBIDDEN` o `503 UPSTREAM_BLOCKED` de forma persistente, pon `PREVIEW_ENABLED=false` y revisa `retry403` y `urlIpFamily` en `preview_finished` y `preview_forbidden`. Si `urlIpFamily` es `6`, prueba con `YTDLP_ARGS_PREFIX='["--force-ipv4"]'` y `NODE_OPTIONS=--dns-result-order=ipv4first`.

### Healthcheck y dominio

- En Settings, pon `/health` como healthcheck path.
- En Networking, genera un dominio público apuntando al puerto 4000 y añade el dominio propio `api-setube.sebxstt.dev` con el CNAME que te indique Railway. `https://api-setube.sebxstt.dev` es el `NEXT_PUBLIC_API_URL` del servicio web.

### Cookies

Railway no tiene Docker secrets, así que usa `YOUTUBE_COOKIES_JSON` como variable del servicio, con cookies de una cuenta secundaria. Al arrancar en producción la API registra el aviso `cookies_via_env`; es esperado.

### Consideraciones

- Railway sale a internet con IPs de datacenter y YouTube puede responder «Sign in to confirm you're not a bot» (`UPSTREAM_BLOCKED`). El servicio `pot`, las cookies de una cuenta secundaria, un proxy (`YTDLP_PROXY`) y mantener yt-dlp al día lo mitigan, pero no lo eliminan (ver «Bloqueo de YouTube»).
- El límite de 15 minutos por petición afecta sobre todo a los ZIP grandes. Bajar `MAX_ITEMS_PER_JOB` ayuda a que entren en ese tiempo.
- Cada descarga sale completa por la red y Railway cobra el tráfico de salida. El audio que se escucha en la web también pasa por la API y cuenta como tráfico de salida.
- El corte de 15 minutos también afecta a la escucha, pero ahí no se nota: el navegador vuelve a pedir el audio con `Range` desde donde iba.
- Puedes subir réplicas de la API sin cambiar nada: la cola, los jobs y el rate limit viven en Redis.

## Seguridad y límites conocidos

- La API es pública y no tiene autenticación. La protegen el rate limit por IP, los topes de descargas por IP e instancia, la cola global y los límites de items y duración. Turnstile es opcional (`TURNSTILE_SECRET` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY`).
- Las IPs nunca se guardan en claro: se usa un hash con `IP_HASH_SALT`.
- El servidor `pot` no tiene autenticación y solo debe ser accesible desde la red privada (compose sin puertos publicados, Railway sin dominio público).
- No hay caché de archivos: cada descarga vuelve a convertir.
- Si la conexión se corta, la descarga de una conversión empieza de cero (las descargas de `/file` y `/archive` no admiten `Range`; la ruta de audio sí).
- Las cookies solo entran por archivo secreto o variable de entorno, nunca en el código ni en la imagen.
- Los cambios de YouTube (SABR, PO tokens) pueden romper descargas hasta actualizar yt-dlp.

## Aviso legal

Usa Setube solo con contenido sobre el que tengas derechos o permiso para descargar, y respeta los Términos de Servicio de YouTube.
