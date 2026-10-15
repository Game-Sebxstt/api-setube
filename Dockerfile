# syntax=docker/dockerfile:1.7
FROM mwader/static-ffmpeg:8.1.2 AS ffmpeg

FROM node:24.21.0-bookworm-slim AS ytdlp
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_SHA256_AMD64=32e72032766bef9199d99d15beb69fd52e46df8f8b06f0d8745db59e04d339e9
ARG YTDLP_SHA256_ARM64=4e27ad43f3a34bacffd078694eb3edbb4e3b378e7da44edab2be02e98555516e
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN set -eu; case "$TARGETARCH" in amd64) A=yt-dlp_linux.zip; S=$YTDLP_SHA256_AMD64;; arm64) A=yt-dlp_linux_aarch64.zip; S=$YTDLP_SHA256_ARM64;; *) exit 1;; esac; \
    curl -fsSL -o /tmp/y.zip "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${A}"; \
    echo "$S  /tmp/y.zip" | sha256sum -c -; mkdir -p /opt/yt-dlp && unzip -q /tmp/y.zip -d /opt/yt-dlp; \
    BIN=$(find /opt/yt-dlp -maxdepth 2 -type f -name 'yt-dlp_linux*' | head -1); chmod 0755 "$BIN"; ln -s "$BIN" /opt/yt-dlp/yt-dlp
# Plugin del PO token provider (cliente HTTP de bgutil). El binario standalone carga los zip de
# yt-dlp-plugins/ junto al ejecutable, sin depender de HOME. Debe coincidir con la versión del servicio pot.
ARG BGUTIL_POT_VERSION=2.0.2
ARG BGUTIL_POT_SHA256=a26b980bf6d8e8400d8f21445daa4d8381bf6183d20f0be309391f86b31e27ef
RUN set -eu; mkdir -p /opt/yt-dlp/yt-dlp-plugins; \
    curl -fsSL -o /opt/yt-dlp/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip \
      "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${BGUTIL_POT_VERSION}/bgutil-ytdlp-pot-provider.zip"; \
    echo "$BGUTIL_POT_SHA256  /opt/yt-dlp/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip" | sha256sum -c -; \
    chmod 0644 /opt/yt-dlp/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip

FROM node:24.21.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Imagen de desarrollo (perfil dev de compose)
FROM deps AS dev
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=ytdlp /opt/yt-dlp /opt/yt-dlp
COPY tsconfig.json tsconfig.build.json vitest.config.ts eslint.config.js ./
ENV NODE_ENV=development YTDLP_PATH=/opt/yt-dlp/yt-dlp FFMPEG_PATH=/usr/local/bin/ffmpeg
USER node
CMD ["npx", "tsx", "watch", "--env-file-if-exists=.env.development", "src/server.ts"]

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.21.0-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24.21.0-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=4000 YTDLP_PATH=/opt/yt-dlp/yt-dlp FFMPEG_PATH=/usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=ytdlp /opt/yt-dlp /opt/yt-dlp
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
