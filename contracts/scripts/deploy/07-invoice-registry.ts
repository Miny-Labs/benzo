import fs from "node:fs/promises";
import path from "node:path";
import { ethers, network, run } from "hardhat";

const FUJI_CHAIN_ID = 43113n;
const DEPLOYMENTS_PATH = path.join(
	__dirname,
	"..",
	"..",
	"..",
	"deployments",
	"fuji.json",
);

type Deployments = {
	chainId?: number;
	network?: string;
	contracts?: Record<string, unknown>;
};

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

const main = async () => {
	const chainId = await ethers.provider
		.getNetwork()
		.then((providerNetwork) => providerNetwork.chainId);

	if (network.name !== "fuji" || chainId !== FUJI_CHAIN_ID) {
		throw new Error(
			`InvoiceRegistry deploy must target Fuji (43113); got ${network.name} (${chainId})`,
		);
	}

	const [deployer] = await ethers.getSigners();
	const invoiceRegistry = await ethers.deployContract("InvoiceRegistry");
	await invoiceRegistry.waitForDeployment();

	const deploymentTransaction = invoiceRegistry.deploymentTransaction();
	const receipt = await deploymentTransaction?.wait();
	const address = await invoiceRegistry.getAddress();

	console.log(`InvoiceRegistry deployed to ${address}`);

	let verified = false;
	let verifiedAt: string | undefined;
	try {
		await run("verify:verify", {
			address,
			constructorArguments: [],
		});
		verified = true;
		verifiedAt = new Date().toISOString();
	} catch (error) {
		console.warn("InvoiceRegistry verification failed; persisting deployment");
		console.warn(error);
	}

	const deployments = await readDeployments();
	deployments.network = "fuji";
	deployments.chainId = Number(FUJI_CHAIN_ID);
	deployments.contracts = {
		...deployments.contracts,
		InvoiceRegistry: {
			address,
			deployer: deployer.address,
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
