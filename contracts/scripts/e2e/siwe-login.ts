/**
 * SIWE login against the live API (characterize flows 14/16/17 auth).
 * Performs the /auth/nonce -> sign -> /auth/verify handshake with alice's EOA,
 * then exercises authenticated endpoints and probes what is/isn't deployed.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

const API = process.env.E2E_API_BASE ?? "https://api.benzo.space";
const SESSION_PATH = path.join(
	"/private/tmp/claude-501/-Users-akshmnd-Dev-Projects-stellar-benzo",
	"e2e-fuji-session.json",
);

async function main() {
	const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
	const alice = new ethers.Wallet(session.alice.pk);
	const address = alice.address;

	const nonceResp = await fetch(`${API}/auth/nonce?address=${address}`);
	const { nonce } = (await nonceResp.json()) as { nonce: string };
	console.log(`nonce=${nonce.slice(0, 16)}...`);

	const issuedAt = new Date().toISOString();
	const message =
		`benzo.space wants you to sign in with your Ethereum account:\n` +
		`${address}\n\n` +
		`Benzo E2E validation login.\n\n` +
		`URI: https://benzo.space\n` +
		`Version: 1\n` +
		`Chain ID: 43113\n` +
		`Nonce: ${nonce}\n` +
		`Issued At: ${issuedAt}`;

	const signature = await alice.signMessage(message);
	const verifyResp = await fetch(`${API}/auth/verify`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message, signature }),
	});
	const setCookie = verifyResp.headers.get("set-cookie") ?? "";
	const verifyBody = await verifyResp.text();
	console.log(`/auth/verify -> HTTP ${verifyResp.status}`);
	console.log(`  body: ${verifyBody.slice(0, 200)}`);
	console.log(`  set-cookie: ${setCookie ? setCookie.split(";")[0] : "(none)"}`);

	if (verifyResp.status !== 200) {
		console.log("SIWE login FAILED — cannot exercise authenticated flows.");
		return;
	}
	const cookie = setCookie.split(";")[0];

	// Exercise authenticated + probe deployed surface for 14/16/17.
	const probes: [string, string][] = [
		["GET", "/orgs"],
		["GET", "/activity"],
		["GET", "/audit-log"],
		["GET", "/auditlog"],
		["GET", "/audit"],
		["GET", "/identity/me"],
		["GET", "/me"],
		["GET", "/disclosure/attestation-key"],
		["POST", "/disclosure/proof-of-payment"],
		["GET", "/payroll"],
		["POST", "/payroll/batches"],
	];
	for (const [method, p] of probes) {
		const r = await fetch(`${API}${p}`, {
			method,
			headers: { cookie, "content-type": "application/json" },
			body: method === "POST" ? "{}" : undefined,
		});
		const t = (await r.text()).slice(0, 160).replace(/\s+/g, " ");
		console.log(`${method} ${p} -> ${r.status} :: ${t}`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
