import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "hardhat";
import { createEercAccount, encryptAmountPCT } from "../deploy/eerc-crypto";

const ROUTER = "0xbADeF08FE085928c36cF1301CfAa4d8061DA2469";
const IRIS_BASE = "https://iris-api-sandbox.circle.com";
const BURN_TX = process.env.BURN_TX ?? "0xbe6b584f2c19218fef3acd9425c42280930fbe17e61a81ea35af65b1e65bab5a";
const SESSION_PATH = "/private/tmp/claude-501/-Users-akshmnd-Dev-Projects-stellar-benzo/e2e-fuji-session.json";
const readKeyJson = (f: string) => JSON.parse(fs.readFileSync(path.join(os.homedir(), ".benzo-keys", f), "utf8"));
const addrFrom32 = (hex: string) => ethers.getAddress("0x" + hex.slice(24));

async function main() {
	const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
	const aliceEerc = createEercAccount(BigInt(session.alice.eercSeed));
	const alice = new ethers.Wallet(session.alice.pk);
	const relayer = new ethers.Wallet(readKeyJson("benzo-onramp-accounts.json")["benzo-relayer"].privateKey, ethers.provider);
	const router = await ethers.getContractAt("BenzoCCTPRouter", ROUTER);

	const r = await fetch(`${IRIS_BASE}/v2/messages/2?transactionHash=${BURN_TX}`);
	const j: any = await r.json();
	const m = j.messages?.[0];
	const message: string = m.message;
	const attestation: string = m.attestation;
	const hex = message.slice(2);
	const at = (off: number, len = 32) => hex.slice(off * 2, (off + len) * 2);
	// header
	const sourceDomain = parseInt(at(4, 4), 16);
	const destDomain = parseInt(at(8, 4), 16);
	// body @148
	const B = 148;
	const burnToken = addrFrom32(at(B + 4));
	const mintRecipient = addrFrom32(at(B + 36));
	const amount = BigInt("0x" + at(B + 68));
	const feeExecuted = BigInt("0x" + at(B + 164));
	const hookStart = B + 228;
	const hookUser = addrFrom32(hex.slice(hookStart * 2, (hookStart + 32) * 2));
	console.log(JSON.stringify({ sourceDomain, destDomain, burnToken, mintRecipient, amount: amount.toString(), feeExecuted: feeExecuted.toString(), mintedAmount: (amount - feeExecuted).toString(), hookUser }, null, 2));
	console.log(`router allowedTokens(burnToken=${burnToken}) = ${await router.allowedTokens(burnToken)}`);
	console.log(`router allowedTokens(FujiUSDC) = ${await router.allowedTokens("0x5425890298aed601595a70AB815c96711a31Bc65")}`);

	const amountPCT = encryptAmountPCT(amount - feeExecuted, aliceEerc.publicKey);
	try {
		await (router.connect(relayer) as any).settleDeposit.staticCall(message, attestation, amountPCT);
		console.log("staticCall SUCCEEDED (would settle)");
	} catch (e: any) {
		const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
		console.log(`staticCall revert raw data: ${data}`);
		if (data && data !== "0x") {
			try {
				const parsed = router.interface.parseError(data);
				console.log(`parsed custom error: ${parsed?.name}(${parsed?.args?.map((a: any) => a.toString()).join(", ")})`);
			} catch {
				console.log("could not parse against router ABI");
			}
		} else {
			console.log(`no data; message: ${e?.shortMessage ?? e?.message}`);
		}
	}
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
