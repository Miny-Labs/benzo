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
	network?: string;
	contracts?: Record<string, DeploymentEntry | unknown>;
};

const TOKEN_ENV_KEYS = [
	"GIFT_ESCROW_TOKEN_ADDRESS",
	"TUSDC_ADDRESS",
	"TEST_USDC_ADDRESS",
	"USDC_ADDRESS",
];

const TOKEN_DEPLOYMENT_KEYS = [
	"tUSDC",
	"tusdc",
	"testUSDC",
	"TestUSDC",
	"testUsdc",
	"USDC",
	"usdc",
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

const resolveTokenAddress = (deployments: Deployments): string => {
	for (const key of TOKEN_ENV_KEYS) {
		const value = process.env[key];
		if (value) {
			return ethers.getAddress(value);
		}
	}

	for (const key of TOKEN_DEPLOYMENT_KEYS) {
		const value = deploymentAddress(deployments.contracts?.[key]);
		if (value) {
			return ethers.getAddress(value);
		}
	}

	throw new Error(
		`Missing tUSDC address. Set ${TOKEN_ENV_KEYS.join(
			" or ",
		)} or add one of ${TOKEN_DEPLOYMENT_KEYS.join(
			", ",
		)} to deployments/fuji.json before deploying GiftEscrow.`,
	);
};

const main = async () => {
	const chainId = await ethers.provider
		.getNetwork()
		.then((providerNetwork) => providerNetwork.chainId);

	if (network.name !== "fuji" || chainId !== FUJI_CHAIN_ID) {
		throw new Error(
			`GiftEscrow deploy must target Fuji (43113); got ${network.name} (${chainId})`,
		);
	}

	const deployments = await readDeployments();
	const tokenAddress = resolveTokenAddress(deployments);
	const [deployer] = await ethers.getSigners();

	const giftEscrow = await ethers.deployContract("GiftEscrow", [tokenAddress]);
	await giftEscrow.waitForDeployment();

	const deploymentTransaction = giftEscrow.deploymentTransaction();
	const receipt = await deploymentTransaction?.wait();
	const address = await giftEscrow.getAddress();

	console.log(`GiftEscrow deployed to ${address}`);
	console.log(`tUSDC token: ${tokenAddress}`);

	let verified = false;
	let verifiedAt: string | undefined;
	try {
		await run("verify:verify", {
			address,
			constructorArguments: [tokenAddress],
		});
		verified = true;
		verifiedAt = new Date().toISOString();
	} catch (error) {
		console.warn("GiftEscrow verification failed; persisting deployment");
		console.warn(error);
	}

	deployments.network = "fuji";
	deployments.chainId = Number(FUJI_CHAIN_ID);
	deployments.contracts = {
		...deployments.contracts,
		GiftEscrow: {
			address,
			deployer: deployer.address,
			tokenAddress,
			transactionHash: deploymentTransaction?.hash,
			blockNumber: receipt?.blockNumber,
			verified,
			...(verifiedAt === undefined ? {} : { verifiedAt }),
		},
	};

	await writeDeployments(deployments);
	console.log(`Deployment written to ${DEPLOYMENTS_PATH}`);
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
