#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const projects = [
  {
    name: "wallet",
    cwd: "apps/wallet",
    required: [
      ["DATABASE_URL"],
      ["BENZO_DATA_ENCRYPTION_SECRET"],
      ["BENZO_ACCOUNT_SALT", "BENZO_AUTH_SALT"],
      ["GOOGLE_CLIENT_ID"],
      ["RELAYER_SECRET"],
      ["SOROBAN_RPC_URL"],
      ["BENZO_PROVER_ENDPOINT"],
      ["BENZO_PROVER_MEASUREMENT"],
      ["VITE_GOOGLE_CLIENT_ID"],
      ["VITE_BENZO_PROVER_ENDPOINT"],
      ["VITE_BENZO_PROVER_MEASUREMENT"],
    ],
  },
  {
    name: "console",
    cwd: "apps/console",
    required: [
      ["DATABASE_URL"],
      ["BENZO_DATA_ENCRYPTION_SECRET"],
      ["BENZO_PRIVATE_EVENT_SECRET"],
      ["BENZO_ACCOUNT_SALT", "BENZO_AUTH_SALT"],
      ["GOOGLE_CLIENT_ID"],
      ["RELAYER_SECRET"],
      ["SOROBAN_RPC_URL"],
      ["BENZO_PROVER_ENDPOINT"],
      ["BENZO_PROVER_MEASUREMENT"],
      ["VITE_BENZO_PROVER_ENDPOINT"],
      ["VITE_BENZO_PROVER_MEASUREMENT"],
    ],
  },
];

const forbiddenProductionNames = [
  "DEPLOYER_SECRET",
  "BENZO_DEV_EXPORT",
  "BENZO_INSECURE_INDEXER",
  "BENZO_TENANT_STORE_MEMORY",
  "BENZO_ALLOW_LOCAL_MEMORY_TENANT_STORE",
  "RELAYER_STORE_MEMORY",
];

const invariantFiles = [
  {
    file: "apps/wallet-api/src/tenantData.ts",
    contains: [
      "BENZO_DATA_ENCRYPTION_SECRET is required for hosted tenant storage",
      "DATABASE_URL is required for hosted tenant storage",
      "BENZO_TENANT_STORE_MEMORY is not allowed for hosted tenant storage",
      "BENZO_ALLOW_LOCAL_MEMORY_TENANT_STORE is not allowed for hosted tenant storage",
      "benzo:tenant-doc:v1:",
      "benzo_request_limits",
    ],
  },
  {
    file: "apps/console-api/src/tenantData.ts",
    contains: [
      "BENZO_DATA_ENCRYPTION_SECRET is required for hosted tenant storage",
      "DATABASE_URL is required for hosted tenant storage",
      "BENZO_TENANT_STORE_MEMORY is not allowed for hosted tenant storage",
      "BENZO_ALLOW_LOCAL_MEMORY_TENANT_STORE is not allowed for hosted tenant storage",
      "benzo:tenant-doc:v1:",
      "benzo_tenant_routes",
      "benzo:tenant-route:v1:",
      "benzo_request_limits",
    ],
  },
  {
    file: "apps/wallet-api/src/auth.ts",
    contains: ["BENZO_ACCOUNT_SALT is required for hosted account derivation"],
  },
  {
    file: "apps/console-api/src/auth.ts",
    contains: ["BENZO_ACCOUNT_SALT is required for hosted account derivation"],
  },
  {
    file: "apps/console-api/src/server.ts",
    contains: [
      "BENZO_PRIVATE_EVENT_SECRET is required for hosted private-event encryption",
      "Idempotency-Key header is required for hosted console writes.",
      "x-benzo-org-invite-token",
      "lookupTenantRoute(\"console\", \"invite\"",
    ],
  },
  {
    file: "apps/wallet-api/src/server.ts",
    contains: ["Idempotency-Key header is required for hosted wallet writes."],
  },
  {
    file: "packages/relayer/src/abuse-store.ts",
    contains: ["DATABASE_URL is required for durable relayer rate limits and idempotency"],
  },
  {
    file: "apps/wallet-api/src/chain.ts",
    contains: [
      "if (hostedRuntime()) return null; // never export wallet material from hosted deployments",
    ],
  },
];

function fail(message) {
  console.error(`::error::${message}`);
  process.exitCode = 1;
}

function checkSourceInvariants() {
  for (const item of invariantFiles) {
    const abs = join(root, item.file);
    if (!existsSync(abs)) {
      fail(`missing invariant file: ${item.file}`);
      continue;
    }
    const src = readFileSync(abs, "utf8");
    for (const needle of item.contains) {
      if (!src.includes(needle)) fail(`${item.file} is missing fail-closed invariant: ${needle}`);
    }
  }
}

function parseVercelEnvList(output) {
  const names = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]+)\s+Encrypted\s+/);
    if (match) names.add(match[1]);
  }
  return names;
}

function listVercelProductionEnv(project) {
  return execFileSync("vercel", ["env", "ls", "production", "--cwd", project.cwd], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function checkVercelProject(project) {
  const linked = existsSync(join(root, project.cwd, ".vercel", "project.json"));
  if (!linked) {
    console.log(`[prod-env] ${project.name}: skipped, no linked Vercel project`);
    return;
  }

  let output;
  try {
    output = listVercelProductionEnv(project);
  } catch (error) {
    const required = process.env.BENZO_REQUIRE_VERCEL_ENV_AUDIT === "1";
    const reason = error.stderr?.toString?.().trim() || error.message;
    if (required) fail(`${project.name}: could not inspect Vercel production env: ${reason}`);
    else console.log(`[prod-env] ${project.name}: skipped Vercel env inspection: ${reason}`);
    return;
  }

  const names = parseVercelEnvList(output);
  if (names.size === 0) {
    const required = process.env.BENZO_REQUIRE_VERCEL_ENV_AUDIT === "1";
    const message = `${project.name}: Vercel env inspection returned no encrypted production env names`;
    if (required) fail(message);
    else console.log(`[prod-env] ${project.name}: skipped Vercel env inspection: ${message}`);
    return;
  }
  for (const group of project.required) {
    if (!group.some((name) => names.has(name))) {
      fail(`${project.name}: production env missing ${group.join(" or ")}`);
    }
  }
  for (const name of forbiddenProductionNames) {
    if (names.has(name)) fail(`${project.name}: forbidden production env is present: ${name}`);
  }
  console.log(`[prod-env] ${project.name}: ${names.size} production env names audited`);
}

checkSourceInvariants();
for (const project of projects) checkVercelProject(project);

if (process.exitCode) process.exit(process.exitCode);
console.log("[prod-env] source invariants and available production envs passed");
