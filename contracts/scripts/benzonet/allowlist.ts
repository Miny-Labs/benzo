// Read or change a wallet's role on a BenzoNet AllowList precompile.
//
// This is the hook the M3 backend uses to Enable a new user wallet before its
// first tx (txAllowList) and the general admin surface for every AllowList
// precompile. Role changes run from a Manager/Admin key; `read` needs no key.
//
//   # Enable a wallet on the tx allowlist (run from benzo-ops, the tx manager)
//   ALLOWLIST_ACTION=setEnabled TARGET_ADDRESS=0x... MANAGER_PRIVATE_KEY=0x... \
//     pnpm --filter @benzo/contracts hardhat run scripts/benzonet/allowlist.ts --network benzonet
//
//   # Read a wallet's current role (no key needed)
//   ALLOWLIST_ACTION=read TARGET_ADDRESS=0x... \
//     pnpm --filter @benzo/contracts hardhat run scripts/benzonet/allowlist.ts --network benzonet
//
// ALLOWLIST selects the precompile: tx (default) | deployer | minter | fee.
import { ethers, network } from "hardhat";

const PRECOMPILES: Record<string, string> = {
	deployer: "0x0200000000000000000000000000000000000000",
	minter: "0x0200000000000000000000000000000000000001",
	tx: "0x0200000000000000000000000000000000000002",
	fee: "0x0200000000000000000000000000000000000003",
};
const ROLE_NAMES = ["None", "Enabled", "Manager", "Admin"];
const WRITE_ACTIONS = new Set(["setEnabled", "setManager", "setNone"]);
const BENZONET_CHAIN_ID = 68_420n;

const roleName = (role: bigint) => ROLE_NAMES[Number(role)] ?? `Unknown(${role})`;

const main = async () => {
	const net = await ethers.provider.getNetwork();
	if (net.chainId !== BENZONET_CHAIN_ID) {
		throw new Error(
			`allowlist.ts must run on BenzoNet (chainId ${BENZONET_CHAIN_ID}); got ${net.chainId} on network "${network.name}". Pass --network benzonet.`,
		);
	}

	const action = process.env.ALLOWLIST_ACTION;
	if (!action || (action !== "read" && !WRITE_ACTIONS.has(action))) {
		throw new Error(
			"Set ALLOWLIST_ACTION to read | setEnabled | setManager | setNone.",
		);
	}

	const listKey = process.env.ALLOWLIST ?? "tx";
	const precompile = PRECOMPILES[listKey];
	if (!precompile) {
		throw new Error(`Unknown ALLOWLIST "${listKey}"; use tx|deployer|minter|fee.`);
	}

	const target = process.env.TARGET_ADDRESS;
	if (!target || !ethers.isAddress(target)) {
		throw new Error("Set TARGET_ADDRESS to the wallet whose role to read/change.");
	}

	if (action === "read") {
		const allowList = await ethers.getContractAt("IAllowList", precompile);
		const role = await allowList.readAllowList(target);
		console.log(`${target} role on the ${listKey} allowlist: ${roleName(role)}.`);
		return;
	}

	const managerKey = process.env.MANAGER_PRIVATE_KEY;
	if (!managerKey) {
		throw new Error(
			"Set MANAGER_PRIVATE_KEY to a Manager/Admin key for this allowlist (benzo-ops manages tx).",
		);
	}
	const manager = new ethers.Wallet(managerKey, ethers.provider);
	const allowList = await ethers.getContractAt("IAllowList", precompile, manager);

	console.log(
		`${action}(${target}) on the ${listKey} allowlist from ${manager.address}...`,
	);
	const tx =
		action === "setEnabled"
			? await allowList.setEnabled(target)
			: action === "setManager"
				? await allowList.setManager(target)
				: await allowList.setNone(target);
	const receipt = await tx.wait();
	const role = await allowList.readAllowList(target);
	console.log(
		`${action} landed in ${tx.hash} (block ${receipt?.blockNumber}). ${target} role is now ${roleName(role)}.`,
	);
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
