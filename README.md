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
| POST | `/api/playlists/resolve` | Lista los videos de una playlist (hasta `MAX_PLAYLIST_ITEMS`). |
| POST | `/api/jobs` | Crea un job: `{ items: [{ videoId }], format, quality?, turnstileToken? }`. Responde 201. |
| GET | `/api/jobs/:id` | Estado actual del job y de sus items. |
| DELETE | `/api/jobs/:id` | Cancela el job. Responde 202. |
| GET | `/api/jobs/:id/events` | Progreso en tiempo real por SSE. |
| GET | `/api/jobs/:id/items/:itemId/file` | Descarga un item convertido, en streaming. |
| GET | `/api/jobs/:id/archive` | Descarga todos los items válidos en un ZIP, en streaming. |

Rate limits por IP (por minuto): 10 en `POST /api/jobs` y `POST /api/playlists/resolve`, 20 en las descargas, 30 en `/api/resolve`, SSE y `DELETE`, 120 en `/api/videos`. El resto usa `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`.

Todos los errores tienen la misma forma:

```json
{
  "error": { "code": "LIMIT_DURATION", "message": "El video supera la duración máxima permitida.", "details": {} },
  "requestId": "..."
}
```

`details` es opcional. Los códigos y sus estados HTTP están en `src/lib/errors.ts` (por ejemplo `INVALID_URL` 400, `LIMIT_ITEMS` 413, `RATE_LIMITED` 429, `QUEUE_FULL` 503, `UPSTREAM_BLOCKED` 503).

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

### Dónde se configuran

- Railway: en las variables del servicio de la API.
- Docker Compose (`api`): el servicio solo recibe las variables de su bloque `environment` en `../docker-compose.yml` (`REDIS_URL`, `IP_HASH_SALT`, `CORS_ORIGINS`, `TRUST_PROXY`, `TURNSTILE_SECRET`, `CONVERT_CONCURRENCY`, `YOUTUBE_COOKIES_JSON`); el resto usa los defaults. Para cambiar otra, agrégala a ese bloque y ponle el valor en el `.env` de la raíz:

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
- Si hay `YTDLP_COOKIES_FILE`, que el archivo se pueda leer.

### `/api/config`

El cliente lee los límites de `GET /api/config` (caché de 5 min), así que al cambiar las variables la web se ajusta sola. Expone `maxItemsPerJob`, `maxPlaylistItems`, `maxDurationAudioSec`, `maxDurationVideoSec`, las calidades por formato, las calidades por defecto (mp3 192, mp4 720) y si Turnstile está activo.

## Producción con Docker Compose

Desde la raíz:

```sh
cp .env.example .env          # rellena REDIS_PASSWORD, IP_HASH_SALT y NEXT_PUBLIC_API_URL
docker compose up -d --build --wait
```

- Servicios: `redis` (sin puertos publicados, red interna, sin persistencia y con comandos peligrosos deshabilitados), `api` (puerto 4000, sistema de archivos de solo lectura, `/tmp` en tmpfs de 128 MB, sin capabilities) y `web` (puerto 3000).
- Ponlo detrás de un proxy con TLS y HTTP/2 (Cloudflare, Caddy). HTTP/2 importa porque el navegador abre un SSE y una descarga por job, y en HTTP/1.1 solo hay 6 conexiones por origen.
- Con proxy define `TRUST_PROXY` (normalmente `1`). Si no, todos los usuarios comparten la IP del proxy en el rate limit. Si se pone de más, cualquiera puede falsear `X-Forwarded-For`.
- `docker compose stop` da 40 s: la API deja de aceptar descargas, cierra los SSE con `server-restart` y termina los procesos en curso dentro de `SHUTDOWN_GRACE_MS`.
- Para actualizar yt-dlp cambia `YTDLP_VERSION` y los dos `YTDLP_SHA256_*` del `Dockerfile` (los valores están en `SHA2-256SUMS` del release) y reconstruye.

### Cookies con Docker secrets

Las cookies son opcionales y ayudan con «Sign in to confirm you're not a bot».

1. Usa una cuenta secundaria y exporta un `cookies.txt` (formato Netscape) de una sesión nueva.
2. Guárdalo en `secrets/yt_cookies.txt` junto al `docker-compose.yml` de la raíz, fuera de cualquier repositorio.
3. En `docker-compose.yml` descomenta el bloque `secrets` del servicio `api`, el bloque `secrets` de nivel superior y la línea `YTDLP_COOKIES_FILE: /run/secrets/yt_cookies`.
4. En el host: `chmod 0444 secrets/yt_cookies.txt`, porque compose sin Swarm puede ignorar `uid`/`gid`/`mode`. Si la API no puede leer el archivo, no arranca.

Las cookies se escriben en un archivo temporal `0600` por cada proceso de yt-dlp y se borran al terminar. Nunca se loguean ni se guardan en Redis.

## Despliegue en Railway

### Servicios

Crea tres servicios en el mismo proyecto y la misma región:

1. Redis, desde la plantilla de Railway.
2. API, desde este repositorio. Railway detecta el `Dockerfile` y lo usa.
3. Web, desde el repositorio `setube` (ver su README).

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
| `CONVERT_CONCURRENCY` | los vCPU de tu plan |
| `CONVERSION_WALL_TIMEOUT_MS` | `840000` |
| `MAX_ITEMS_PER_JOB` | `20` (recomendado) |

- `?family=0` es obligatorio: la red privada de Railway es IPv6 y ioredis por defecto solo resuelve IPv4. Sin eso la API no encuentra Redis.
- `CONVERSION_WALL_TIMEOUT_MS=840000` (14 min) porque Railway corta las peticiones HTTP a los 15 minutos. Así la API corta el item con un error claro antes de que lo haga el proxy.
- Si `CONVERT_CONCURRENCY` es menor que 3, baja también `ZIP_PARALLEL_AUDIO` a ese valor o la API no arranca.

### Healthcheck y dominio

- En Settings, pon `/health` como healthcheck path.
- En Networking, genera un dominio público apuntando al puerto 4000 y añade el dominio propio `api-setube.sebxstt.dev` con el CNAME que te indique Railway. `https://api-setube.sebxstt.dev` es el `NEXT_PUBLIC_API_URL` del servicio web.

### Cookies

Railway no tiene Docker secrets, así que usa `YOUTUBE_COOKIES_JSON` como variable del servicio, con cookies de una cuenta secundaria. Al arrancar en producción la API registra el aviso `cookies_via_env`; es esperado.

### Consideraciones

- Railway sale a internet con IPs de datacenter y YouTube puede responder «Sign in to confirm you're not a bot» (`UPSTREAM_BLOCKED`). Las cookies y mantener yt-dlp al día lo mitigan, pero no lo eliminan.
- El límite de 15 minutos por petición afecta sobre todo a los ZIP grandes. Bajar `MAX_ITEMS_PER_JOB` ayuda a que entren en ese tiempo.
- Cada descarga sale completa por la red y Railway cobra el tráfico de salida.
- Puedes subir réplicas de la API sin cambiar nada: la cola, los jobs y el rate limit viven en Redis.

## Seguridad y límites conocidos

- La API es pública y no tiene autenticación. La protegen el rate limit por IP, los topes de descargas por IP e instancia, la cola global y los límites de items y duración. Turnstile es opcional (`TURNSTILE_SECRET` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY`).
- Las IPs nunca se guardan en claro: se usa un hash con `IP_HASH_SALT`.
- No hay caché de archivos: cada descarga vuelve a convertir.
- Si la conexión se corta, la descarga empieza de cero (no hay soporte de `Range`).
- Las cookies solo entran por archivo secreto o variable de entorno, nunca en el código ni en la imagen.
- Los cambios de YouTube (SABR, PO tokens) pueden romper descargas hasta actualizar yt-dlp.

## Aviso legal

Usa Setube solo con contenido sobre el que tengas derechos o permiso para descargar, y respeta los Términos de Servicio de YouTube.
