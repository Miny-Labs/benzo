/**
 * BenzoNet diagnostic: does the L1 currently include a tx from an allowlisted
 * account, and is a non-allowlisted (but funded) account's tx rejected by the
 * tx-allowlist precompile? Bounded so it never hangs on a non-producing node.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "hardhat";

const RPC = process.env.E2E_BENZONET_RPC ?? "https://rpc.benzo.space";
const PRECOMPILE = "0x0200000000000000000000000000000000000002";
const SESSION_PATH = path.join(
	"/private/tmp/claude-501/-Users-akshmnd-Dev-Projects-stellar-benzo",
	"e2e-fuji-session.json",
);

const readKeyJson = (f: string) =>
	JSON.parse(fs.readFileSync(path.join(os.homedir(), ".benzo-keys", f), "utf8"));

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
	let to: NodeJS.Timeout;
	const timeout = new Promise<never>((_, rej) => {
		to = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	try {
		return (await Promise.race([p, timeout])) as T;
	} finally {
		clearTimeout(to!);
	}
};

const pollReceipt = async (
	provider: ethers.JsonRpcProvider,
	hash: string,
	ms: number,
) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const r = await provider.getTransactionReceipt(hash).catch(() => null);
		if (r) return r;
		await new Promise((res) => setTimeout(res, 3000));
	}
	return null;
};

async function main() {
	const provider = new ethers.JsonRpcProvider(RPC);
	const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
	const roles = readKeyJson("benzonet-roles.json");
	const dripper = new ethers.Wallet(roles["benzo-dripper"].privateKey, provider);
	const probe = new ethers.Wallet(session.benzonetProbe.pk, provider);

	const net = await withTimeout(provider.getNetwork(), 15000, "getNetwork");
	const block = await withTimeout(provider.getBlockNumber(), 15000, "blockNumber");
	console.log(`BenzoNet chainId=${net.chainId} block=${block}`);

	const allow = new ethers.Contract(
		PRECOMPILE,
		["function readAllowList(address) view returns (uint256)"],
		provider,
	);
	console.log(`role dripper=${await allow.readAllowList(dripper.address)} probe=${await allow.readAllowList(probe.address)}`);

	const gasPriceHex = await provider.send("eth_gasPrice", []);
	const gasPrice = BigInt(gasPriceHex);
	console.log(`gasPrice=${gasPrice}`);

	// 1) allowlisted dripper -> probe funding tx; does BenzoNet include it?
	const dripNonce = await provider.getTransactionCount(dripper.address, "latest");
	const fundValue = gasPrice * 21000n * 5n;
	const fundTx = {
		to: probe.address,
		value: fundValue,
		gasLimit: 21000n,
		gasPrice,
		nonce: dripNonce,
		chainId: net.chainId,
		type: 0 as const,
	};
	const signedFund = await dripper.signTransaction(fundTx);
	let fundHash = "";
	try {
		fundHash = await withTimeout(
			provider.send("eth_sendRawTransaction", [signedFund]),
			15000,
			"send fund",
		);
		console.log(`dripper->probe fund submitted: ${fundHash}`);
	} catch (e) {
		console.log(`dripper fund REJECTED at submit: ${(e as Error).message}`);
	}
	let fundMined = false;
	if (fundHash) {
		const r = await pollReceipt(provider, fundHash, 45000);
		fundMined = !!r;
		console.log(`dripper fund mined=${fundMined}${r ? ` block=${r.blockNumber}` : " (NOT included within 45s)"}`);
	}
	const probeBal = await provider.getBalance(probe.address);
	console.log(`probe BGAS balance now=${ethers.formatEther(probeBal)}`);

	// 2) non-allowlisted probe tx (only meaningful if funded)
	const probeNonce = await provider.getTransactionCount(probe.address, "latest");
	const probeTx = {
		to: probe.address,
		value: 0n,
		gasLimit: 21000n,
		gasPrice,
		nonce: probeNonce,
		chainId: net.chainId,
		type: 0 as const,
	};
	const signedProbe = await probe.signTransaction(probeTx);
	let probeErr = "";
	let probeHash = "";
	try {
		probeHash = await withTimeout(
			provider.send("eth_sendRawTransaction", [signedProbe]),
			15000,
			"send probe",
		);
		console.log(`probe tx submitted (NOT immediately rejected): ${probeHash}`);
	} catch (e) {
		probeErr = (e as Error).message;
		console.log(`probe tx REJECTED at submit: ${probeErr}`);
	}

	console.log(
		JSON.stringify({
			block,
			fundMined,
			probeFunded: probeBal > 0n,
			probeRejectedAtSubmit: !!probeErr,
			probeError: probeErr,
			isAllowlistError: /allow ?list|not allowed|non-allow/i.test(probeErr),
			isInsufficientFunds: /insufficient funds/i.test(probeErr),
		}),
	);
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
