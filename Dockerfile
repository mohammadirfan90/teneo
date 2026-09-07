# syntax=docker/dockerfile:1.7
# Housing Platform backend — multi-stage Dockerfile for Render.
#
# Stage 1 ("build") compiles TypeScript with `tsc`. The build context
# includes the Prisma schema + generated client (committed to repo)
# so we don't need network access at build time.
#
# Stage 2 ("runtime") runs as a non-root user on node:22-alpine. We
# copy only the compiled JS + production node_modules + prisma
# generated client — no dev deps, no source maps, no Biome.
#
# The HEALTHCHECK uses the same /health/ready endpoint that Render's
# platform probe hits; if the DB or Redis is unreachable, both fail
# (which keeps Render from sending traffic to a wedged container).

# ──────────────────────────────────────────────────────────────────────
# Stage 1: build
# ──────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Install deps with the lockfile. `npm ci` is faster + reproducible.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Build the TypeScript output.
COPY tsconfig.json ./
COPY src ./src
COPY prisma ./prisma
RUN npx prisma generate
RUN npm run build

# Prune dev deps so we can copy a slim node_modules into the runtime
# stage. The --omit=dev flag is the supported way.
RUN npm prune --omit=dev

# ──────────────────────────────────────────────────────────────────────
# Stage 2: runtime
# ──────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Non-root user. UID 1001 is the convention Render expects.
RUN addgroup -S app && adduser -S -u 1001 -G app app

# Copy the compiled JS + production node_modules + Prisma generated
# client. We deliberately omit source maps + devDependencies.
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

# /health/ready lives at the root of the express app — see src/server.ts.
# Render's platform probe hits this path; the container HEALTHCHECK is
# belt-and-braces for local docker runs.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health/ready || exit 1

ENV NODE_ENV=production \
    PORT=3000

USER app

EXPOSE 3000

# `node dist/server.js` is the production entrypoint.
CMD ["node", "dist/server.js"]
