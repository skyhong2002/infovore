FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY assets ./assets
COPY src ./src
EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
