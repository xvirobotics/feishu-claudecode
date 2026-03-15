# ---- Build stage ----
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install backend dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Install web dependencies
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --include=dev

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY web/ ./web/

RUN npm run build

# ---- Runtime stage ----
FROM node:20-slim

WORKDIR /app

# Install runtime deps for better-sqlite3 and Claude CLI
RUN apt-get update && apt-get install -y python3 make g++ git curl && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install production dependencies (rebuilds native modules for this stage)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built output from builder
COPY --from=builder /app/dist ./dist

# Copy supporting files
COPY bin/ ./bin/
COPY .env.example ./

# Default environment
ENV NODE_ENV=production
ENV API_PORT=9100

EXPOSE 9100

CMD ["node", "dist/index.js"]
