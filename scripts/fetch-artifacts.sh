#!/usr/bin/env bash
# Fetch the EXACT published ZK proving artifacts and verify them against the
# committed manifest (circuits/build/artifacts-manifest.json). Use this to run a
# self-hosted instance that INTEROPERATES with the already-deployed Benzo testnet:
# Groth16 verification keys are setup-specific, so only these exact zkeys produce
# proofs the deployed verifier accepts. (To deploy your OWN contracts from fresh
# keys instead, use scripts/build-artifacts.sh.)
#
# Hosting: set BENZO_ARTIFACTS_BASE_URL to where the artifacts are published. The
# default points at this repo's GitHub Releases 'artifacts' tag; override it for a
# mirror/bucket. Each file is verified by sha256 against the manifest, so a wrong
# or tampered download fails loudly.
#
#   BENZO_ARTIFACTS_BASE_URL=https://.../benzo-artifacts bash scripts/fetch-artifacts.sh
set -euo pipefail
cd "$(dirname "$0")/.."

MANIFEST="circuits/build/artifacts-manifest.json"
[ -f "$MANIFEST" ] || { echo "ERROR: $MANIFEST not found (it is committed; are you at the repo root?)"; exit 1; }

BASE="${BENZO_ARTIFACTS_BASE_URL:-https://github.com/akash-mondal/benzo/releases/download/artifacts}"
ARTIFACT_TOKEN="${BENZO_ARTIFACTS_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"
echo "Fetching artifacts from: $BASE"
echo "(override with BENZO_ARTIFACTS_BASE_URL=... if you host them elsewhere)"
echo ""

sha256_of() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}' || sha256sum "$1" | awk '{print $1}'; }

# Circuits whose proofs are generated in the browser also get staged flat under
# apps/wallet/public/circuits.
is_browser() { case "$1" in joinsplit|proof_of_balance) return 0;; *) return 1;; esac; }

# Enumerate circuits from the manifest (node is always available in this repo).
CIRCUITS=$(node -e "const m=require('./$MANIFEST');console.log(Object.keys(m.circuits).join(' '))")

github_asset_download() { # github release download url, dest
  local url=$1 dest=$2
  [ -n "$ARTIFACT_TOKEN" ] || return 1
  node - "$url" "$dest" "$ARTIFACT_TOKEN" <<'NODE'
const fs = require("node:fs");
const { dirname } = require("node:path");

const [url, dest, token] = process.argv.slice(2);
const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url);
if (!m) process.exit(2);
const [, owner, repo, tag, assetNameRaw] = m;
const assetName = decodeURIComponent(assetNameRaw);
const headers = {
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
  "user-agent": "benzo-artifact-fetch",
};

(async () => {
  const release = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, { headers });
  if (!release.ok) throw new Error(`release lookup failed: HTTP ${release.status}`);
  const body = await release.json();
  const asset = body.assets?.find((a) => a.name === assetName);
  if (!asset?.url) throw new Error(`asset not found: ${assetName}`);
  const assetRes = await fetch(asset.url, {
    headers: {
      ...headers,
      accept: "application/octet-stream",
    },
  });
  if (!assetRes.ok) throw new Error(`asset download failed: HTTP ${assetRes.status}`);
  fs.mkdirSync(dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await assetRes.arrayBuffer()));
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
}

fetch_verify() { # url, dest, expected_sha
  local url=$1 dest=$2 want=$3
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "$want" ]; then echo "  ok (cached) $dest"; return; fi
  echo "  downloading $url"
  if ! curl -fL --retry 3 -o "$dest" "$url"; then
    echo "  direct download failed; trying GitHub API asset fetch"
    github_asset_download "$url" "$dest"
  fi
  local got; got=$(sha256_of "$dest")
  [ "$got" = "$want" ] || { echo "  HASH MISMATCH for $dest: got $got want $want"; exit 1; }
  echo "  verified $dest"
}

for C in $CIRCUITS; do
  echo "== $C =="
  zkeyHash=$(node -e "console.log(require('./$MANIFEST').circuits['$C'].zkeyHash||'')")
  wasmHash=$(node -e "console.log(require('./$MANIFEST').circuits['$C'].wasmHash||'')")
  # The witness wasm MUST land at the snarkjs `${C}_js/` path that every consumer
  # reads (circuits/build/$C/${C}_js/$C.wasm — see tests/e2e/flow.mjs and the SDK
  # circuit map). Writing it flat made cold clones ENOENT before the first proof;
  # it only worked locally because the author already had the _js dir populated.
  [ -n "$zkeyHash" ] && fetch_verify "$BASE/$C/$C.zkey" "circuits/build/$C/$C.zkey" "$zkeyHash"
  [ -n "$wasmHash" ] && fetch_verify "$BASE/$C/$C.wasm" "circuits/build/$C/${C}_js/$C.wasm" "$wasmHash"
  if is_browser "$C"; then
    mkdir -p apps/wallet/public/circuits
    cp "circuits/build/$C/$C.zkey" "apps/wallet/public/circuits/$C.zkey"
    cp "circuits/build/$C/${C}_js/$C.wasm" "apps/wallet/public/circuits/$C.wasm"
    echo "  staged browser artifacts -> apps/wallet/public/circuits/"
  fi
done

echo ""
echo "Done. Verified all artifacts against $MANIFEST."
echo "These match the deployed Benzo testnet VKs — a self-hosted client now interoperates with the deployed instance."
