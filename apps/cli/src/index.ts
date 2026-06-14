#!/usr/bin/env node
/**
 * @benzo/cli — the fully-built operator/developer surface over @benzo/core.
 *
 * Every protocol operation is a scriptable command; this also serves as the
 * reproducible e2e harness. Headless NodeProver. Reads deployments/testnet.json
 * and circuit artifacts from BENZO_ROOT (default: cwd). Env is loaded from .env
 * by the caller (`set -a; . ./.env; set +a`).
 */
import { readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BenzoClient, StellarCli, configFromEnv, stroopsToUsdc } from "@benzo/core";
import { encodeBenzoLink, parseBenzoLink } from "@benzo/links";
import { AnchorClient, anchorConfigFromEnv } from "@benzo/anchor";
import { onrampFromEnv } from "@benzo/integrations";

const ROOT = process.env.BENZO_ROOT || process.cwd();
const WALLET = process.env.BENZO_WALLET || join(homedir(), ".benzo", "account.json");
const toStroops = (n: string) => BigInt(Math.round(Number(n) * 1e7));
const jstr = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

function circuitSet() {
  const art = (c: string) => ({
    wasmPath: `${ROOT}/circuits/build/${c}/${c}_js/${c}.wasm`,
    zkeyPath: `${ROOT}/circuits/build/${c}/${c}.zkey`,
  });
  return {
    shield: art("shield"),
    joinsplit: art("joinsplit"),
    unshield: art("unshield"),
    proofOfBalance: art("proof_of_balance"),
  };
}

function makeClient(opts: { relayer?: boolean } = {}): BenzoClient {
  const dep = JSON.parse(readFileSync(`${ROOT}/deployments/testnet.json`, "utf8"));
  const cli = new StellarCli(configFromEnv());
  let anchor: AnchorClient | undefined;
  try { anchor = new AnchorClient(anchorConfigFromEnv()); } catch { anchor = undefined; }
  return new BenzoClient({
    cli,
    anchor,
    deployment: {
      pool: dep.pool, verifier: dep.verifier, merkle: dep.merkle,
      nullifierSet: dep.nullifierSet, aspMembership: dep.aspMembership,
      aspNonMembership: dep.aspNonMembership, viewkeyAnchor: dep.viewkeyAnchor,
      token: dep.token, treeLevels: dep.treeLevels, aspLevels: dep.aspLevels, smtLevels: dep.smtLevels,
    },
    circuits: circuitSet(),
    rpcUrl: process.env.SOROBAN_RPC_URL!,
    txSource: "benzo-deployer",
    relayer: opts.relayer ? { source: "benzo-relayer", address: process.env.RELAYER_PUBLIC! } : undefined,
    handleRegistry: dep.handleRegistry,
  });
}

/** Minimal --flag value parser. */
function flags(rest: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) continue;
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const HELP = `benzo — private USDC on Stellar (testnet)

  benzo address                         show your shareable payment address
  benzo balance                         sync + print spendable USDC
  benzo history                         print transaction history
  benzo shield   --amount N [--from G..] [--source S..]
  benzo send     --to @handle --amount N [--relayer]
  benzo unshield --amount N --to G..
  benzo handle-register --handle NAME
  benzo handle-resolve  --handle NAME
  benzo claim-create   --amount N       mint a claim link (pay someone with no account)
  benzo claim-redeem   --link <url>     claim a benzo:// link into a fresh account
  benzo disclose                        print an auditor view-key + reconstructed flows
  benzo payroll  --payouts "@a:10,@b:25" [--scope L]  confidential batch payouts
  benzo disclose-total [--scope L]      prove payroll/invoice TOTAL to an auditor
  benzo prove-balance --min N           prove you hold >= N USDC (hides exact balance)
  benzo cashin   --amount N             anchor deposit -> shield   (needs running anchor)
  benzo cashout  --amount N             unshield -> anchor withdraw (needs running anchor)
  benzo onramp   [--to G..] [--amount N]  fiat->USDC onramp session (Stripe sandbox / Mock)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") { console.log(HELP); return; }
  const f = flags(rest);
  const c = makeClient({ relayer: !!f.relayer });
  mkdirSync(dirname(WALLET), { recursive: true });

  // claim-redeem derives its account from the link; everything else loads the wallet.
  if (cmd !== "claim-redeem") {
    c.createOrLoadAccount(WALLET, { label: "cli", stellarSecret: process.env.DEPLOYER_SECRET });
  }

  switch (cmd) {
    case "address":
      console.log(jstr(c.address())); break;

    case "balance": {
      await c.sync();
      console.log(`${stroopsToUsdc(await c.getBalance())} USDC`); break;
    }
    case "history": {
      await c.sync();
      for (const h of c.getHistory())
        console.log(`${h.type}\t${h.amount}\t${h.counterparty ?? "-"}\t${h.status}\t${h.txHash ?? ""}`);
      break;
    }
    case "shield": {
      const r = await c.shield({
        amount: toStroops(String(f.amount)),
        fromAddress: String(f.from ?? process.env.DEPLOYER_PUBLIC),
        fromSource: String(f.source ?? "benzo-deployer"),
      });
      console.log(`shielded leaf=${r.leafIndex} tx=${r.txHash}`); break;
    }
    case "send": {
      const handle = String(f.to).replace(/^@/, "");
      const r = await c.sendToHandle({ handle, amount: toStroops(String(f.amount)), useRelayer: !!f.relayer } as any);
      console.log(`sent to @${handle} tx=${(r as any).txHash ?? JSON.stringify(r)}`); break;
    }
    case "unshield": {
      const r = await c.unshield({ amount: toStroops(String(f.amount)), toAddress: String(f.to) } as any);
      console.log(`unshield tx=${r.txHash} nullifier=${r.nullifier}`); break;
    }
    case "handle-register": {
      const r = await c.registerHandle({ handle: String(f.handle) } as any);
      console.log(`registered @${f.handle} tx=${(r as any).txHash ?? JSON.stringify(r)}`); break;
    }
    case "handle-resolve": {
      console.log(jstr(await c.resolveHandle(String(f.handle)))); break;
    }
    case "claim-create": {
      const r = await c.createClaimLink({ amount: toStroops(String(f.amount)) } as any);
      const link = (r as any).link ?? encodeBenzoLink({ type: "claim", secret: (r as any).secret, amount: String(f.amount), asset: "USDC" });
      console.log(`claim link: ${link}`);
      console.log(`tx=${(r as any).txHash ?? ""}`); break;
    }
    case "claim-redeem": {
      const parsed = parseBenzoLink(String(f.link));
      if (!parsed || parsed.type !== "claim") throw new Error("not a valid benzo claim link");
      const r = await c.claim({ secret: parsed.secret } as any);
      console.log(`claimed tx=${(r as any).txHash ?? JSON.stringify(r)}`); break;
    }
    case "disclose": {
      await c.sync();
      const d = c.disclose();
      console.log(`view-key (TVK) scope=${d.scope}`);
      console.log(JSON.stringify(d.reconstruct(), null, 2)); break;
    }
    case "payroll": {
      // --payouts "@alice:10,@bob:25" [--scope LABEL]: pay a team privately.
      const scope = f.scope ? String(f.scope) : undefined;
      const payouts = [] as Array<{ to: Awaited<ReturnType<typeof c.resolveHandle>>; amount: bigint }>;
      for (const part of String(f.payouts).split(",")) {
        const [h, amt] = part.split(":");
        payouts.push({ to: await c.resolveHandle(h.replace(/^@/, "")), amount: toStroops(amt) });
      }
      const res = await c.payroll({ payouts, scope });
      for (const r of res) console.log(`paid ${stroopsToUsdc(r.amount)} -> @${r.to.label} tx=${r.txHash ?? ""}`);
      break;
    }
    case "disclose-total": {
      await c.sync();
      const d = c.disclosedTotal(f.scope ? String(f.scope) : undefined);
      console.log(`disclosed total: ${stroopsToUsdc(d.total)} USDC across ${d.count} notes`); break;
    }
    case "prove-balance": {
      // Prove you hold >= --min USDC without revealing your exact balance.
      const r = await c.proveBalance({
        minAmount: toStroops(String(f.min)),
        context: f.context ? BigInt(String(f.context)) : undefined,
      });
      console.log(`proof-of-balance: holds >= ${stroopsToUsdc(r.threshold)} USDC  (root=${r.root})`);
      console.log(`  publicSignals: ${jstr(r.publicSignals)}`);
      console.log(`  sorobanProof:  ${jstr(r.sorobanProof)}`);
      break;
    }
    case "cashin": {
      const r = await c.cashIn({ amount: toStroops(String(f.amount)), fromSource: "benzo-deployer" });
      console.log(`cashin fiatIn=${r.fiatInTx} shield=${r.shieldTx}`); break;
    }
    case "cashout": {
      const r = await c.cashOut({ amount: toStroops(String(f.amount)) });
      console.log(`cashout unshield=${r.unshieldTx} fiatOut=${r.fiatOutTx}`); break;
    }
    case "onramp": {
      // Stripe (test mode) when STRIPE_SECRET_KEY is set, else Mock. Delivers
      // USDC to a PUBLIC Stellar address (G..), which the user then shields.
      const onramp = onrampFromEnv();
      const to = String(f.to ?? process.env.DEPLOYER_PUBLIC);
      const session = await onramp.createSession({ amount: f.amount ? String(f.amount) : undefined, address: to });
      console.log(`onramp(${onramp.name}) -> ${session.url}`);
      console.log(`  buy USDC on Stellar to ${to}  (session=${session.id})`);
      if (onramp.name === "mock")
        console.log("  note: Mock. After Stripe onramp-application approval, set STRIPE_SECRET_KEY=sk_test_… for the sandbox flow.");
      break;
    }
    default:
      console.error(`unknown command: ${cmd}\n`); console.log(HELP); process.exit(1);
  }
}

main()
  .then(() => process.exit(0)) // open RPC/anchor keep-alive handles would otherwise hang the process
  .catch((e) => { console.error("error:", e?.message ?? e); process.exit(1); });
