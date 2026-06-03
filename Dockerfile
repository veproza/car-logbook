# syntax=docker/dockerfile:1

# ---- builder: install production dependencies ----
# node:20-slim is glibc, so better-sqlite3 installs its prebuilt binary on amd64
# and no build toolchain is needed.
FROM node:20-slim AS builder
WORKDIR /app

# Name both files explicitly: if the lockfile is ever missing from the build
# context the COPY fails immediately, rather than `npm ci` failing later.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/logbook.db

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# The SQLite database lives on a volume so it survives container restarts.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
