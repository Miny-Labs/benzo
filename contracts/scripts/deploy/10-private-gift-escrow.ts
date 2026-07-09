import fs from "node:fs/promises";
import path from "node:path";
import { ethers, network, run } from "hardhat";

// Supported deploy targets. Fuji is the testnet target; avalanche is the mainnet
// C-Chain. Each entry pins the expected chainId and the explorer host so the
// gate fails fast on a mismatched --network and Snowtrace links resolve to the
// correct (testnet vs mainnet) explorer.
const SUPPORTED_NETWORKS = {
	fuji: { chainId: 43113n, explorerBase: "https://testnet.snowtrace.io" },
	avalanche: { chainId: 43114n, explorerBase: "https://snowtrace.io" },
} as const;

type SupportedNetwork = keyof typeof SUPPORTED_NETWORKS;

const isSupportedNetwork = (name: string): name is SupportedNetwork =>
	Object.prototype.hasOwnProperty.call(SUPPORTED_NETWORKS, name);

const DEPLOYMENTS_PATH = path.join(
	__dirname,
	"..",
	"..",
	"deployments",
	`${network.name}.json`,
);
// Mirror 09-cctp-router.ts: propagate the deployed address into the shared
// @benzo/config manifest as well, so app/service consumers resolve
// PrivateGiftEscrow without waiting for a manual config sync.
const CONFIG_MANIFEST_PATH = path.join(
	__dirname,
	"..",
	"..",
	"..",
	"packages",
	"config",
	"src",
	"deployments",
	`${network.name}.json`,
);

type DeploymentEntry = string | { address?: unknown };

type Deployments = {
	chainId?: number;
	contracts?: Record<string, unknown>;
	network?: string;
};

type ConfigManifest = {
	chainId?: number;
	contracts?: Record<string, unknown>;
	network?: string;
	tier?: string;
};

const EERC_ENV_KEYS = [
	"PRIVATE_GIFT_ESCROW_EERC_ADDRESS",
	"EERC_ENCRYPTED_ERC_ADDRESS",
	"EERC_CONVERTER_ADDRESS",
];

const readDeployments = async (): Promise<Deployments> => {
	try {
		const contents = await fs.readFile(DEPLOYMENTS_PATH, "utf8");
		return JSON.parse(contents) as Deployments;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		throw error;
	}
};

const writeDeployments = async (deployments: Deployments) => {
	await fs.mkdir(path.dirname(DEPLOYMENTS_PATH), { recursive: true });
	await fs.writeFile(
		DEPLOYMENTS_PATH,
		`${JSON.stringify(deployments, null, 2)}\n`,
	);
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
};

const asObject = (value: unknown, label: string): Record<string, unknown> => {
	const record = asRecord(value);
	if (record === undefined) {
		throw new Error(`${label} must be an object`);
	}
	return record;
};

// Dual-write mirror of 09-cctp-router.ts: project the deployed address into the
// shared @benzo/config manifest so config consumers stay in sync with the
// contracts-local deployment record.
const writeConfigManifest = async (address: string): Promise<void> => {
	const contents = await fs.readFile(CONFIG_MANIFEST_PATH, "utf8");
	const configManifest = JSON.parse(contents) as ConfigManifest;
	const configContracts = asObject(
		configManifest.contracts,
		"config.contracts",
	);
	configContracts.PrivateGiftEscrow = address;
	await fs.writeFile(
		CONFIG_MANIFEST_PATH,
		`${JSON.stringify(configManifest, null, 2)}\n`,
	);
	console.log(`Config manifest written: ${CONFIG_MANIFEST_PATH}`);
};

const deploymentAddress = (entry: DeploymentEntry | unknown): string | undefined => {
	if (typeof entry === "string") {
		return entry;
	}
	if (entry !== null && typeof entry === "object" && "address" in entry) {
		const address = (entry as { address?: unknown }).address;
		return typeof address === "string" ? address : undefined;
	}
	return undefined;
};

const resolveEercAddress = (deployments: Deployments): string => {
	for (const key of EERC_ENV_KEYS) {
		const value = process.env[key];
		if (value) {
			return ethers.getAddress(value);
		}
	}

	const contracts = asRecord(deployments.contracts);
	const eercConverter = asRecord(contracts?.eercConverter);
	const encryptedERC = deploymentAddress(eercConverter?.encryptedERC);
	if (encryptedERC) {
		return ethers.getAddress(encryptedERC);
	}

	throw new Error(
		`Missing eERC converter address. Set ${EERC_ENV_KEYS.join(
			" or ",
		)} or add contracts.eercConverter.encryptedERC.address to deployments/fuji.json before deploying PrivateGiftEscrow.`,
	);
};

const snowtraceAddressUrl = (address: string) => {
	const explorerBase = isSupportedNetwork(network.name)
		? SUPPORTED_NETWORKS[network.name].explorerBase
		: "https://testnet.snowtrace.io";
	return `${explorerBase}/address/${address}`;
};

const verifyPrivateGiftEscrow = async (
	address: string,
	constructorArguments: string[],
): Promise<{ verified: boolean; verifiedAt?: string }> => {
	if (process.env.SKIP_VERIFY === "1") {
		return { verified: false };
	}

	try {
		await run("verify:verify", {
			address,
			constructorArguments,
		});
		return { verified: true, verifiedAt: new Date().toISOString() };
	} catch (error) {
		console.warn("PrivateGiftEscrow verification failed; persisting deployment");
		console.warn(error);
		return { verified: false };
	}
};

const main = async () => {
	const chainId = await ethers.provider
		.getNetwork()
		.then((providerNetwork) => providerNetwork.chainId);

	if (!isSupportedNetwork(network.name)) {
		throw new Error(
			`PrivateGiftEscrow deploy must target one of: ${Object.keys(
				SUPPORTED_NETWORKS,
			).join(", ")}; got ${network.name}`,
		);
	}
	const target = SUPPORTED_NETWORKS[network.name];
	if (chainId !== target.chainId) {
		throw new Error(
			`PrivateGiftEscrow deploy expected chainId ${target.chainId} for ${network.name}; got ${chainId}`,
		);
	}

	const deployments = await readDeployments();
	const eercAddress = resolveEercAddress(deployments);
	const [deployer] = await ethers.getSigners();

	// Preflight: setAuthorizedDepositor is owner-gated. Verify the deployer owns
	// the eERC BEFORE deploying so a non-owner deployer fails fast instead of
	// leaving an orphan PrivateGiftEscrow deploy and no manifest write.
	const eerc = await ethers.getContractAt("EncryptedERC", eercAddress);
	const eercOwner = await eerc.owner();
	if (eercOwner.toLowerCase() !== deployer.address.toLowerCase()) {
		throw new Error(
			`Deployer ${deployer.address} is not the eERC owner (${eercOwner}); setAuthorizedDepositor would revert. Deploy PrivateGiftEscrow from the eERC owner account.`,
		);
	}

	const privateGiftEscrow = await ethers.deployContract("PrivateGiftEscrow", [
		eercAddress,
	]);
	await privateGiftEscrow.waitForDeployment();

	const deploymentTransaction = privateGiftEscrow.deploymentTransaction();
	const receipt = await deploymentTransaction?.wait();
	const address = await privateGiftEscrow.getAddress();

	console.log(`PrivateGiftEscrow deployed to ${address}`);
	console.log(`eERC converter: ${eercAddress}`);
	console.log(`Snowtrace: ${snowtraceAddressUrl(address)}`);

	const authorizeTx = await eerc.setAuthorizedDepositor(address, true);
	await authorizeTx.wait();
	console.log(`Authorized PrivateGiftEscrow as eERC depositor: ${authorizeTx.hash}`);

	const constructorArguments = [eercAddress];
	const verification = await verifyPrivateGiftEscrow(address, constructorArguments);

	deployments.network = network.name;
	deployments.chainId = Number(target.chainId);
	deployments.contracts = {
		...deployments.contracts,
		PrivateGiftEscrow: {
			address,
			authorizeDepositorTxHash: authorizeTx.hash,
			blockNumber: receipt?.blockNumber,
			constructorArguments,
			deployer: deployer.address,
			eercAddress,
			snowtraceUrl: snowtraceAddressUrl(address),
			transactionHash: deploymentTransaction?.hash,
			verified: verification.verified,
			...(verification.verifiedAt === undefined
				? {}
				: { verifiedAt: verification.verifiedAt }),
		},
	};

	await writeDeployments(deployments);
	console.log(`Deployment written to ${DEPLOYMENTS_PATH}`);

	await writeConfigManifest(address);
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
