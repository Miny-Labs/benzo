# Benzo confidential prover — runs INSIDE a Phala dstack (Intel TDX) CVM.
# Bundles the circuit artifacts so witnesses never need a zkey shipped per proof,
# and serves TDX attestation quotes (via the mounted dstack guest-agent socket)
# so a client can attest the enclave BEFORE sending a witness.
FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Service code.
COPY src ./src

# Circuit artifacts (wasm witness-generators + proving zkeys), staged by
# scripts/stage-artifacts.sh into ./artifacts before `docker build`.
COPY artifacts ./artifacts

ENV NODE_ENV=production
ENV BENZO_PROVER_PORT=8080
ENV BENZO_ARTIFACT_ROOT=/app/artifacts
EXPOSE 8080

# Fail fast at boot if any artifact is missing.
CMD ["node", "src/server.mjs"]
