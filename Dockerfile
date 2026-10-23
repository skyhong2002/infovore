FROM node:22-alpine
WORKDIR /app

# Install production deps first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code and static assets (fonts, logos).
COPY tsconfig.json ./
COPY assets ./assets
COPY src ./src
COPY scripts/container-health.sh ./scripts/

EXPOSE 3000

# Ready once, then live: see scripts/container-health.sh. The long start period
# keeps 2-second probes until the first full readiness (cold starts take ~80 s);
# the 10-second interval lets a drained container leave Traefik in ~30 s. The
# ingest service overrides this in docker-compose.yml.
HEALTHCHECK --interval=10s --timeout=15s --start-period=600s --start-interval=2s --retries=3 \
  CMD sh scripts/container-health.sh

CMD ["npx", "tsx", "src/server.ts"]
