FROM node:22-alpine
WORKDIR /app

# Install production deps first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code and static assets (fonts, logos).
COPY tsconfig.json ./
COPY assets ./assets
COPY src ./src

EXPOSE 3000

# Gateway liveness, not /healthz readiness: Traefik drops unhealthy and still
# starting containers, which would turn a warming or stalled backend into a 404
# for the whole host instead of the gateway's 503s and last-good homepage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --start-interval=2s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/livez || exit 1

CMD ["npx", "tsx", "src/server.ts"]
