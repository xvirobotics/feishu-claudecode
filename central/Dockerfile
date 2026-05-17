# --- Build stage ---
FROM node:20-slim AS build
WORKDIR /app

# better-sqlite3 needs build tools to compile its native binding.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
RUN npm run build

# --- Runtime stage ---
FROM node:20-slim AS runtime
WORKDIR /app

# Drop privileges — node:20-slim has a `node` user already.
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/package-lock.json* ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/bin ./bin
COPY --from=build --chown=node:node /app/node_modules ./node_modules

RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production \
    CENTRAL_PORT=8200 \
    CENTRAL_DATA_DIR=/app/data \
    LOG_FORMAT=json

USER node
EXPOSE 8200
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
