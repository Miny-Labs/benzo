#!/usr/bin/env node

const base = (process.env.BENZO_WALLET_URL || "https://wallet.benzo.space").replace(/\/+$/, "");
const token = process.env.BENZO_GOOGLE_ID_TOKEN || process.argv.find((a) => a.startsWith("--token="))?.slice("--token=".length);
const handle = process.env.BENZO_DIAG_HANDLE || process.argv.find((a) => a.startsWith("--handle="))?.slice("--handle=".length) || `diag${Date.now().toString(36).slice(-6)}`;

if (!token) {
  console.error("Missing BENZO_GOOGLE_ID_TOKEN. In the wallet page console, run:");
  console.error("copy(localStorage.getItem('benzo.googleCredential'))");
  console.error("Then run: BENZO_GOOGLE_ID_TOKEN='<pasted-token>' pnpm node scripts/diagnose-wallet-live.mjs");
  process.exit(2);
}

const endpoints = [
  { label: "auth/config", path: "/auth/config" },
  { label: "session", path: "/session" },
  { label: "balance", path: "/balance" },
  { label: "public-balance", path: "/public-balance" },
  { label: "deposit-address", path: "/deposit-address" },
  { label: "history", path: "/history" },
  { label: "contacts", path: "/contacts" },
  { label: "handle/available", path: `/handle/available?h=${encodeURIComponent(handle)}` },
  {
    label: "handle/claim",
    path: "/handle/claim",
    init: { method: "POST", body: JSON.stringify({ handle }) },
  },
];

function rpcUrl(path) {
  return `${base}/api/rpc?path=${encodeURIComponent(path)}`;
}

async function hit(endpoint) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if ((endpoint.init?.method || "GET") !== "GET") headers["idempotency-key"] = `diag_${crypto.randomUUID()}`;
  const res = await fetch(rpcUrl(endpoint.path), { ...endpoint.init, headers });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return {
    label: endpoint.label,
    method: endpoint.init?.method || "GET",
    path: endpoint.path,
    status: res.status,
    ok: res.ok,
    body,
  };
}

console.log(`Wallet diagnostics: ${base}`);
console.log(`Handle candidate: @${handle.replace(/^@/, "")}`);
for (const endpoint of endpoints) {
  const result = await hit(endpoint).catch((error) => ({
    label: endpoint.label,
    method: endpoint.init?.method || "GET",
    path: endpoint.path,
    status: "network-error",
    ok: false,
    body: { error: error instanceof Error ? error.message : String(error) },
  }));
  console.log(JSON.stringify(result, null, 2));
}
