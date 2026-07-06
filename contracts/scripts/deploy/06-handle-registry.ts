import fs from "node:fs";
import path from "node:path";
import { ethers, network, run } from "hardhat";

type FujiDeployments = {
	chainId: number;
	contracts: {
		handleRegistry: string | null;
	};
	network: "fuji";
};

const DEPLOYMENTS_PATH = path.join(
	__dirname,
	"..",
	"..",
	"deployments",
	"fuji.json",
);

const readFujiDeployments = (): FujiDeployments => {
	if (!fs.existsSync(DEPLOYMENTS_PATH)) {
		return {
			chainId: 43113,
			contracts: { handleRegistry: null },
			network: "fuji",
		};
	}

	return JSON.parse(
		fs.readFileSync(DEPLOYMENTS_PATH, "utf8"),
	) as FujiDeployments;
};

const writeFujiDeployments = (deployments: FujiDeployments) => {
	fs.mkdirSync(path.dirname(DEPLOYMENTS_PATH), { recursive: true });
	fs.writeFileSync(
		DEPLOYMENTS_PATH,
		`${JSON.stringify(deployments, null, 2)}\n`,
	);
};

async function main() {
	const [deployer] = await ethers.getSigners();
	const chainId = Number((await ethers.provider.getNetwork()).chainId);

	console.log(`Deploying HandleRegistry to ${network.name} (${chainId})`);
	console.log(`Deployer: ${deployer.address}`);

	const registry = await ethers.deployContract("HandleRegistry");
	await registry.waitForDeployment();

	const address = await registry.getAddress();
	console.log(`HandleRegistry deployed: ${address}`);

	if (network.name === "fuji") {
		const deployments = readFujiDeployments();
		deployments.chainId = chainId;
		deployments.contracts.handleRegistry = address;
		writeFujiDeployments(deployments);

		console.log(`Updated ${path.relative(process.cwd(), DEPLOYMENTS_PATH)}`);

		try {
			await run("verify:verify", {
				address,
				constructorArguments: [],
			});
			console.log("Routescan verification submitted");
		} catch (error) {
			console.error("Routescan verification failed");
			throw error;
		}
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
