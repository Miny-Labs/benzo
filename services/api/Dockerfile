# syntax=docker/dockerfile:1
# Build from the monorepo root so pnpm can resolve workspace dependencies:
#   docker build -f services/api/Dockerfile -t benzo-api:test .
# For source deploys, use a root-context build path that includes packages/config.
# The container runs `node dist/index.js` and listens on $PORT (Cloud Run injects it).
# Migrations run out-of-band against the same DATABASE_URL.

FROM node:22-slim AS build
WORKDIR /repo
ARG PNPM_VERSION=10.28.0
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/tsconfig.json ./packages/config/
COPY services/api/package.json services/api/tsconfig.json ./services/api/

# Dependency lifecycle scripts are skipped; package builds run explicitly below.
RUN pnpm install --frozen-lockfile --filter @benzo/api... --ignore-scripts

COPY packages/config ./packages/config
COPY services/api ./services/api

RUN pnpm --filter @benzo/config build
RUN pnpm --filter @benzo/api build
# This workspace does not use injected dependencies, so deploy uses pnpm's legacy mode.
RUN pnpm --filter @benzo/api deploy --prod --legacy /out

FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Cloud Run sets PORT (default 8080); the app reads process.env.PORT and binds HOST=0.0.0.0.
ENV PORT=8080
WORKDIR /app

COPY --from=build /out ./

# Drop root: the node:22-slim image ships an unprivileged `node` user (uid 1000).
USER node

EXPOSE 8080
CMD ["node", "dist/index.js"]
