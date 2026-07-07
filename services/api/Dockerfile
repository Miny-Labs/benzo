# syntax=docker/dockerfile:1
# Build with context = services/api (self-contained — no workspace deps):
#   gcloud run deploy benzo-api --source services/api ...
# Uses npm (not pnpm) so the build doesn't trip pnpm's ignored-build-scripts gate.
# The container runs `node dist/index.js` and listens on $PORT (Cloud Run injects it).
# Migrations run out-of-band (`npm run db:migrate`) against the same DATABASE_URL.

FROM node:22-slim AS build
WORKDIR /app

# Install all deps (dev included) to compile TypeScript.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build
# Drop dev dependencies for the runtime image.
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Cloud Run sets PORT (default 8080); the app reads process.env.PORT and binds HOST=0.0.0.0.
ENV PORT=8080
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Drop root: the node:22-slim image ships an unprivileged `node` user (uid 1000).
USER node

EXPOSE 8080
CMD ["node", "dist/index.js"]
