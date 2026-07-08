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

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1

CMD ["npx", "tsx", "src/index.ts"]
