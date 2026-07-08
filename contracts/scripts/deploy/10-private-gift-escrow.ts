import fs from "node:fs/promises";
import path from "node:path";
import { ethers, network, run } from "hardhat";

const FUJI_CHAIN_ID = 43113n;
const DEPLOYMENTS_PATH = path.join(
	__dirname,
	"..",
	"..",
	"deployments",
	"fuji.json",
);

type DeploymentEntry = string | { address?: unknown };

type Deployments = {
	chainId?: number;
	contracts?: Record<string, unknown>;
	network?: string;
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

const snowtraceAddressUrl = (address: string) =>
	`https://testnet.snowtrace.io/address/${address}`;

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

	if (network.name !== "fuji" || chainId !== FUJI_CHAIN_ID) {
		throw new Error(
			`PrivateGiftEscrow deploy must target Fuji (43113); got ${network.name} (${chainId})`,
		);
	}

	const deployments = await readDeployments();
	const eercAddress = resolveEercAddress(deployments);
	const [deployer] = await ethers.getSigners();

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

	const eerc = await ethers.getContractAt("EncryptedERC", eercAddress);
	const authorizeTx = await eerc.setAuthorizedDepositor(address, true);
	await authorizeTx.wait();
	console.log(`Authorized PrivateGiftEscrow as eERC depositor: ${authorizeTx.hash}`);

	const constructorArguments = [eercAddress];
	const verification = await verifyPrivateGiftEscrow(address, constructorArguments);

	deployments.network = "fuji";
	deployments.chainId = Number(FUJI_CHAIN_ID);
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
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
