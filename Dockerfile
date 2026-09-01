# A container for the demo deployment. Works anywhere that runs one — Fly, Cloud Run,
# Railway, a VM — so the choice of host stays a decision rather than a commitment.
#
# Two stages. The first has the toolchain and dev dependencies and produces web/dist; the
# second carries only what is needed to RUN. That is not tidiness: a smaller image is a
# faster cold start, and on a host that sleeps when idle the cold start is the thing a
# visitor actually experiences.

# ---- build ----------------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# Copy the manifests ALONE first, install, and only then copy the source.
#
# Docker caches per layer and invalidates every layer after the first changed one. Copying
# source before installing would make every source edit re-run both installs. This way a
# code change reuses the dependency layers, and only a LOCKFILE change pays for them —
# which is the same "key on the lockfile" idea the CI cache uses, expressed as layers.
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
RUN npm ci && npm ci --prefix web

COPY . .
RUN npm run build --prefix web

# ---- run ------------------------------------------------------------------------------
FROM node:24-slim AS run
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only. The frontend is already built by now, so nothing in
# web/node_modules is needed at runtime — and it is the larger of the two trees.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The server runs TypeScript directly (Node >= 23.6 strips types), so `src` ships as
# source rather than as a build output. That is the same property that makes the Node
# version load-bearing here.
COPY src ./src
COPY db ./db
COPY scripts ./scripts
COPY --from=build /app/web/dist ./web/dist

# Never runs as root. If the process is ever compromised, the blast radius should not
# include the filesystem — and `node:*` images ship a non-root `node` user for this.
USER node

ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.ts"]
