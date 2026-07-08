import { ethers, network } from "hardhat";

// Position bootstrap funds on the deployer for the fresh-converter tokenId bootstrap:
// the deployer (signers[0]) must hold a little USDC + EURC + gas. onramp-user holds
// the Circle tokens but no gas, so relayer -> onramp-user (gas), then onramp-user ->
// deployer (token dust). Keys come from env and are NEVER committed:
//   RELAYER_PRIVATE_KEY, ONRAMP_USER_PRIVATE_KEY   (deployer = PRIVATE_KEY / signers[0])
// Idempotent — every hop checks balances first.

const ERC20_ABI = [
	"function transfer(address to, uint256 value) returns (bool)",
	"function balanceOf(address account) view returns (uint256)",
];

// Fuji Circle tokens (mirror packages/config/src/tokens.ts).
const FUJI_TOKENS: Record<string, string> = {
	USDC: "0x5425890298aed601595a70AB815c96711a31Bc65",
	EURC: "0x5E44db7996c682E92a960b65AC713a54AD815c6B",
};

const GAS_TOPUP = ethers.parseEther("0.1"); // AVAX for onramp-user to make the transfers
const TOKEN_DUST = 50_000n; // 0.05 of a 6-decimal token moved to the deployer, per token
const MIN_DEPLOYER_TOKEN = 2_000n; // deployer needs >= this per token to seed the bootstrap

const main = async () => {
	if (network.name !== "fuji") {
		throw new Error(`prefund-bootstrap targets fuji; got "${network.name}"`);
	}
	const relayerKey = process.env.RELAYER_PRIVATE_KEY;
	const onrampKey = process.env.ONRAMP_USER_PRIVATE_KEY;
	if (!relayerKey || !onrampKey) {
		throw new Error("Set RELAYER_PRIVATE_KEY and ONRAMP_USER_PRIVATE_KEY in the environment");
	}

	const provider = ethers.provider;
	const [deployer] = await ethers.getSigners();
	const relayer = new ethers.Wallet(relayerKey, provider);
	const onramp = new ethers.Wallet(onrampKey, provider);
	console.log(
		`deployer ${deployer.address} | onramp-user ${onramp.address} | relayer ${relayer.address}`,
	);

	// 1. Ensure onramp-user has gas to move its tokens.
	const onrampGas = await provider.getBalance(onramp.address);
	if (onrampGas < GAS_TOPUP / 2n) {
		console.log(`Funding onramp-user with ${ethers.formatEther(GAS_TOPUP)} AVAX from relayer...`);
		await (await relayer.sendTransaction({ to: onramp.address, value: GAS_TOPUP })).wait();
	} else {
		console.log(`onramp-user already has gas (${ethers.formatEther(onrampGas)} AVAX)`);
	}

	// 1b. Ensure the auditor signer (PRIVATE_KEY_2 / signers[1]) has gas to register
	// itself on-chain during configureAuditor.
	const signers = await ethers.getSigners();
	if (signers.length >= 2) {
		const auditor = signers[1];
		const auditorGas = await provider.getBalance(auditor.address);
		if (auditorGas < GAS_TOPUP / 2n) {
			console.log(
				`Funding auditor ${auditor.address} with ${ethers.formatEther(GAS_TOPUP)} AVAX from relayer...`,
			);
			await (await relayer.sendTransaction({ to: auditor.address, value: GAS_TOPUP })).wait();
		} else {
			console.log(`auditor already has gas (${ethers.formatEther(auditorGas)} AVAX)`);
		}
	}

	// 2. Move token dust to the deployer for any token it is short on.
	for (const [symbol, address] of Object.entries(FUJI_TOKENS)) {
		const asOnramp = new ethers.Contract(address, ERC20_ABI, onramp);
		const deployerBalance: bigint = await asOnramp.balanceOf(deployer.address);
		if (deployerBalance >= MIN_DEPLOYER_TOKEN) {
			console.log(`deployer already holds ${deployerBalance} ${symbol}`);
			continue;
		}
		const onrampBalance: bigint = await asOnramp.balanceOf(onramp.address);
		if (onrampBalance < TOKEN_DUST) {
			throw new Error(`onramp-user has only ${onrampBalance} ${symbol}; need >= ${TOKEN_DUST}`);
		}
		console.log(`Transferring ${TOKEN_DUST} ${symbol} onramp-user -> deployer...`);
		await (await asOnramp.transfer(deployer.address, TOKEN_DUST)).wait();
	}

	console.log("Bootstrap prefund complete.");
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
