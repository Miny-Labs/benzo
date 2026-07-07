/**
 * BenzoNet gated-access proof (tx-allowlist precompile).
 *
 * Demonstrates the "hide the whole chain behind a wall" primitive: a wallet that
 * is NOT on the tx-allowlist cannot get a transaction included — it is rejected
 * at the precompile (0x02..02) before it ever reaches a block. Pairs with
 * benzonet-confidential-demo.ts, where an Admin enables a wallet and it can then
 * move encrypted eERC value.
 *
 * Run: BENZONET_RPC_URL=https://rpc.benzo.space \
 *      npx hardhat run scripts/deploy/benzonet-gated-access-demo.ts --network benzonet
 */
import { ethers } from "hardhat";

const TX_ALLOWLIST = "0x0200000000000000000000000000000000000002";
const ROLE_NAMES = ["None", "Enabled", "Manager", "Admin"];

async function main() {
	const net = await ethers.provider.getNetwork();
	if (net.chainId !== 68420n) throw new Error(`run on BenzoNet (68420); got ${net.chainId}`);

	const allowList = await ethers.getContractAt("IAllowList", TX_ALLOWLIST);
	const [funder] = await ethers.getSigners();
	if (funder === undefined) throw new Error("Set PRIVATE_KEY to an allow-listed funder (e.g. benzo-deployer).");
	const outsider = ethers.Wallet.createRandom().connect(ethers.provider);
	const role = await allowList.readAllowList(outsider.address);
	console.log(`outsider ${outsider.address}`);
	console.log(`tx-allowlist role: ${ROLE_NAMES[Number(role)]} (${role})`);

	// Give the outsider gas money so the rejection can only be the ALLOWLIST,
	// not an empty balance. Receiving is fine; only SENDING is gated.
	await (await funder.sendTransaction({ to: outsider.address, value: ethers.parseEther("1") })).wait();
	console.log("funded outsider with 1 BGAS (so gas is not the blocker)");

	let rejected = false;
	let message = "";
	try {
		// A zero-value self-send: the cheapest possible tx. It still can't be
		// issued because the FROM address is not on the allowlist.
		await outsider.sendTransaction({ to: outsider.address, value: 0n });
	} catch (error) {
		rejected = true;
		const e = error as { info?: { error?: { message?: string } }; shortMessage?: string; message?: string };
		message = e.info?.error?.message ?? e.shortMessage ?? e.message ?? "unknown";
	}

	console.log("");
	if (rejected && /allow ?list/i.test(message)) {
		console.log("✅ GATED ACCESS ENFORCED ON-CHAIN");
		console.log(`   a non-allow-listed wallet is rejected at the precompile:`);
		console.log(`   "${message}"`);
	} else if (rejected) {
		console.log(`rejected, but not by the allowlist: ${message}`);
	} else {
		throw new Error("outsider tx was accepted — allowlist NOT enforcing!");
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
