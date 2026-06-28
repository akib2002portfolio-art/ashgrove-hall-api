# ── Stage 1: deps ────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: production image ─────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Non-root user for security
RUN addgroup -S hall && adduser -S hall -G hall

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/
COPY sql/ ./sql/

RUN chown -R hall:hall /app
USER hall

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
