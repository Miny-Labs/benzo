import fs from "node:fs/promises";
import path from "node:path";
import { ethers, network, run } from "hardhat";

const FUJI_CHAIN_ID = 43113n;
const CONTRACTS_MANIFEST_PATH = path.join(
	__dirname,
	"..",
	"..",
	"deployments",
	"fuji.json",
);
const CONFIG_MANIFEST_PATH = path.join(
	__dirname,
	"..",
	"..",
	"..",
	"packages",
	"config",
	"src",
	"deployments",
	"fuji.json",
);

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

type DeploymentRecord = {
	address: string;
	blockNumber?: number;
	constructorArguments?: JsonValue[];
	deployer?: string;
	snowtraceUrl?: string;
	transactionHash?: string;
	verified?: boolean;
	verifiedAt?: string;
};

type ContractsManifest = {
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

const snowtraceAddressUrl = (address: string) =>
	`https://testnet.snowtrace.io/address/${address}`;

const readJson = async <T>(filePath: string): Promise<T> =>
	JSON.parse(await fs.readFile(filePath, "utf8")) as T;

const writeJson = async (filePath: string, data: unknown) => {
	await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
};

const asObject = (value: unknown, label: string): Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
};

const deploymentAddress = (value: unknown, label: string): string => {
	if (typeof value === "string") {
		return ethers.getAddress(value);
	}

	if (typeof value === "object" && value !== null) {
		const address = (value as { address?: unknown }).address;
		if (typeof address === "string") {
			return ethers.getAddress(address);
		}
	}

	throw new Error(`${label} must be an address or deployment record`);
};

const tokenAddress = (
	tokens: Record<string, unknown>,
	symbol: "USDC" | "EURC",
): string => {
	const token = asObject(tokens[symbol], `eercConverter.tokens.${symbol}`);
	const address = token.address;
	if (typeof address !== "string") {
		throw new Error(`eercConverter.tokens.${symbol}.address must be set`);
	}
	return ethers.getAddress(address);
};

const verifyRouter = async (
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
		console.warn("BenzoCCTPRouter verification failed; persisting deployment");
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
			`CCTP router deploy must target Fuji (43113); got ${network.name} (${chainId})`,
		);
	}

	const contractsManifest =
		await readJson<ContractsManifest>(CONTRACTS_MANIFEST_PATH);
	const configManifest = await readJson<ConfigManifest>(CONFIG_MANIFEST_PATH);

	const contracts = asObject(contractsManifest.contracts, "contracts");
	const eercConverter = asObject(
		contracts.eercConverter,
		"contracts.eercConverter",
	);
	const cctp = asObject(contracts.cctp, "contracts.cctp");
	const tokens = asObject(eercConverter.tokens, "contracts.eercConverter.tokens");

	const messageTransmitter = deploymentAddress(
		cctp.messageTransmitter,
		"contracts.cctp.messageTransmitter",
	);
	const encryptedERC = deploymentAddress(
		eercConverter.encryptedERC,
		"contracts.eercConverter.encryptedERC",
	);
	const registrar = deploymentAddress(
		eercConverter.registrar,
		"contracts.eercConverter.registrar",
	);
	const usdc = tokenAddress(tokens, "USDC");
	const eurc = tokenAddress(tokens, "EURC");

	const [deployer] = await ethers.getSigners();
	// The gas-sponsoring settlement relayer (benzo-relayer). Default to the known
	// relayer rather than the deployer, so a deploy without CCTP_RELAYER_ADDRESS
	// doesn't grant the deployer key a settlement role or leave the intended relayer
	// unable to settle. Override with CCTP_RELAYER_ADDRESS.
	const BENZO_RELAYER = "0x984E075152391C018Df97161D51C6BfE52631508";
	const relayer = ethers.getAddress(
		process.env.CCTP_RELAYER_ADDRESS ?? BENZO_RELAYER,
	);
	const router = await ethers.deployContract("BenzoCCTPRouter", [
		messageTransmitter,
		encryptedERC,
		registrar,
	]);
	await router.waitForDeployment();

	const deploymentTransaction = router.deploymentTransaction();
	const receipt = await deploymentTransaction?.wait();
	const routerAddress = await router.getAddress();

	console.log(`BenzoCCTPRouter deployed to ${routerAddress}`);
	console.log(`Snowtrace: ${snowtraceAddressUrl(routerAddress)}`);

	const allowUsdcTx = await router.setAllowedToken(usdc, true);
	await allowUsdcTx.wait();
	const allowEurcTx = await router.setAllowedToken(eurc, true);
	await allowEurcTx.wait();
	const relayerTx = await router.setRelayer(relayer, true);
	await relayerTx.wait();

	const eerc = await ethers.getContractAt("EncryptedERC", encryptedERC);
	const authorizeTx = await eerc.setAuthorizedDepositor(routerAddress, true);
	await authorizeTx.wait();

	console.log(`Allowed USDC: ${usdc}`);
	console.log(`Allowed EURC: ${eurc}`);
	console.log(`Authorized CCTP relayer: ${relayer}`);
	console.log(`Authorized router as eERC depositor: ${authorizeTx.hash}`);

	const constructorArguments = [messageTransmitter, encryptedERC, registrar];
	const verification = await verifyRouter(routerAddress, constructorArguments);
	const record: DeploymentRecord = {
		address: routerAddress,
		deployer: deployer.address,
		transactionHash: deploymentTransaction?.hash,
		blockNumber: receipt?.blockNumber,
		snowtraceUrl: snowtraceAddressUrl(routerAddress),
		constructorArguments,
		verified: verification.verified,
		...(verification.verifiedAt === undefined
			? {}
			: { verifiedAt: verification.verifiedAt }),
	};

	contractsManifest.network = "fuji";
	contractsManifest.chainId = Number(FUJI_CHAIN_ID);
	contracts.benzoCctpRouter = record;
	cctp.autoDepositRouter = routerAddress;
	await writeJson(CONTRACTS_MANIFEST_PATH, contractsManifest);

	const configContracts = asObject(configManifest.contracts, "config.contracts");
	const configCctp = asObject(configContracts.cctp, "config.contracts.cctp");
	configContracts.benzoCctpRouter = routerAddress;
	configCctp.autoDepositRouter = routerAddress;
	await writeJson(CONFIG_MANIFEST_PATH, configManifest);

	console.log(`Contracts manifest written: ${CONTRACTS_MANIFEST_PATH}`);
	console.log(`Config manifest written: ${CONFIG_MANIFEST_PATH}`);
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
