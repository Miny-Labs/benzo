// Mint a small BGAS gas drip to an allowlisted wallet via the Contract Native
// Minter precompile (0x0200000000000000000000000000000000000001).
//
// BGAS is a valueless gas token: users never buy it, the system mints tiny
// drips so allowlisted wallets can pay gas. Minting is callable only by the
// enabled `benzo-dripper` key. This is the CLI plumbing the always-on M3 drip
// service consumes.
//
//   TARGET_ADDRESS=0x... DRIPPER_PRIVATE_KEY=0x... \
//     pnpm --filter @benzo/contracts hardhat run scripts/benzonet/drip.ts --network benzonet
//
// Optional: DRIP_AMOUNT_BGAS (default 1). Idempotent — refuses to drip if the
// target already holds >= MIN_TOPUP_BGAS, so it is safe to re-run as a top-up.
import { ethers, network } from "hardhat";

const NATIVE_MINTER = "0x0200000000000000000000000000000000000001";
const BENZONET_CHAIN_ID = 68_420n;
const DEFAULT_DRIP_BGAS = "1";
const MIN_TOPUP_BGAS = "0.5";

const main = async () => {
	const net = await ethers.provider.getNetwork();
	if (net.chainId !== BENZONET_CHAIN_ID) {
		throw new Error(
			`drip.ts must run on BenzoNet (chainId ${BENZONET_CHAIN_ID}); got ${net.chainId} on network "${network.name}". Pass --network benzonet.`,
		);
	}

	const target = process.env.TARGET_ADDRESS;
	if (!target || !ethers.isAddress(target)) {
		throw new Error("Set TARGET_ADDRESS to the wallet that needs BGAS gas.");
	}

	const dripperKey = process.env.DRIPPER_PRIVATE_KEY;
	if (!dripperKey) {
		throw new Error(
			"Set DRIPPER_PRIVATE_KEY (benzo-dripper — the Enabled NativeMinter key).",
		);
	}
	const dripper = new ethers.Wallet(dripperKey, ethers.provider);

	const amount = ethers.parseEther(
		process.env.DRIP_AMOUNT_BGAS ?? DEFAULT_DRIP_BGAS,
	);
	const threshold = ethers.parseEther(MIN_TOPUP_BGAS);

	const balance = await ethers.provider.getBalance(target);
	if (balance >= threshold) {
		console.log(
			`${target} already holds ${ethers.formatEther(balance)} BGAS (>= ${MIN_TOPUP_BGAS}); skipping drip.`,
		);
		return;
	}

	const minter = await ethers.getContractAt(
		"INativeMinter",
		NATIVE_MINTER,
		dripper,
	);
	console.log(
		`Dripping ${ethers.formatEther(amount)} BGAS to ${target} from ${dripper.address} (benzo-dripper)...`,
	);
	const tx = await minter.mintNativeCoin(target, amount);
	const receipt = await tx.wait();
	const newBalance = await ethers.provider.getBalance(target);
	console.log(
		`Minted in ${tx.hash} (block ${receipt?.blockNumber}). ${target} now holds ${ethers.formatEther(newBalance)} BGAS.`,
	);
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
