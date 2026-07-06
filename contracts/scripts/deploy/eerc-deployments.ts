import fs from "node:fs/promises";
import path from "node:path";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, network, run } from "hardhat";
import {
	type EercAccount,
	createEercAccount,
	deserializeEercAccount,
	registerEercAccount,
	serializeEercAccount,
} from "./eerc-crypto";

const FUJI_CHAIN_ID = 43113;
const DEPLOYMENTS_DIR = path.join(__dirname, "..", "..", "deployments");
const AUDITOR_KEY_PATH = path.join(
	__dirname,
	"..",
	"..",
	".auditor-key.local.json",
);
const EERC_KEY = "eercConverter";

type DeploymentRecord = {
	address: string;
	blockNumber?: number;
	deployer?: string;
	snowtraceUrl?: string;
	transactionHash?: string;
	verified?: boolean;
	verifiedAt?: string;
};

type DeploymentJson = {
	chainId?: number;
	contracts?: Record<string, unknown>;
	network?: string;
};

type DeployContext = {
	chainId: number;
	deployer: SignerWithAddress;
	deploymentPath: string;
	deployments: DeploymentJson;
};

type AuditorKeyFile = {
	auditors?: Record<
		string,
		{
			address: string;
			formattedPrivateKey: string;
			privateKey: string;
			publicKey: string[];
		}
	>;
	custodyNote: string;
	warning: string;
};

const snowtraceAddressUrl = (address: string) =>
	`https://testnet.snowtrace.io/address/${address}`;

const deploymentPathForNetwork = () =>
	path.join(DEPLOYMENTS_DIR, `${network.name}.json`);

const readJson = async <T>(filePath: string, fallback: T): Promise<T> => {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return fallback;
		}
		throw error;
	}
};

const writeJson = async (filePath: string, data: unknown) => {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
};

const getEercDeployment = (deployments: DeploymentJson) => {
	deployments.contracts = deployments.contracts ?? {};
	const contracts = deployments.contracts as Record<string, unknown>;
	contracts[EERC_KEY] = contracts[EERC_KEY] ?? {};
	return contracts[EERC_KEY] as Record<string, unknown>;
};

const getPath = (
	target: Record<string, unknown>,
	pathSegments: string[],
): unknown =>
	pathSegments.reduce<unknown>((current, segment) => {
		if (typeof current !== "object" || current === null) {
			return undefined;
		}

		return (current as Record<string, unknown>)[segment];
	}, target);

const setPath = (
	target: Record<string, unknown>,
	pathSegments: string[],
	value: unknown,
) => {
	let current = target;
	for (const segment of pathSegments.slice(0, -1)) {
		current[segment] = current[segment] ?? {};
		current = current[segment] as Record<string, unknown>;
	}

	current[pathSegments[pathSegments.length - 1]] = value;
};

const isDeploymentRecord = (value: unknown): value is DeploymentRecord =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as DeploymentRecord).address === "string";

const hasCode = async (address: string) =>
	(await ethers.provider.getCode(address)) !== "0x";

export const getDeploymentContext = async (): Promise<DeployContext> => {
	const [deployer] = await ethers.getSigners();
	const chainId = Number((await ethers.provider.getNetwork()).chainId);

	if (network.name === "fuji" && chainId !== FUJI_CHAIN_ID) {
		throw new Error(`Fuji deploy expected chainId ${FUJI_CHAIN_ID}; got ${chainId}`);
	}

	const deploymentPath = deploymentPathForNetwork();
	const deployments = await readJson<DeploymentJson>(deploymentPath, {});
	deployments.network = network.name;
	deployments.chainId = chainId;
	deployments.contracts = deployments.contracts ?? {};

	return { chainId, deployer, deploymentPath, deployments };
};

export const writeDeployments = async (context: DeployContext) => {
	await writeJson(context.deploymentPath, context.deployments);
	console.log(`Deployment record written: ${context.deploymentPath}`);
};

const verifyRecord = async ({
	constructorArguments,
	context,
	libraries,
	pathSegments,
	record,
}: {
	constructorArguments: unknown[];
	context: DeployContext;
	libraries?: Record<string, string>;
	pathSegments: string[];
	record: DeploymentRecord;
}) => {
	if (network.name !== "fuji") {
		return;
	}

	if (record.verified) {
		return;
	}

	try {
		await run("verify:verify", {
			address: record.address,
			constructorArguments,
			...(libraries === undefined ? {} : { libraries }),
		});
		record.verified = true;
		record.verifiedAt = new Date().toISOString();
	} catch (error) {
		record.verified = false;
		console.warn(`Routescan verification failed for ${record.address}`);
		console.warn(error);
	}

	setPath(getEercDeployment(context.deployments), pathSegments, record);
	await writeDeployments(context);
};

const deployContract = async ({
	constructorArguments = [],
	context,
	contractName,
	libraries,
	pathSegments,
}: {
	constructorArguments?: unknown[];
	context: DeployContext;
	contractName: string;
	libraries?: Record<string, string>;
	pathSegments: string[];
}): Promise<DeploymentRecord> => {
	const eercDeployment = getEercDeployment(context.deployments);
	const existing = getPath(eercDeployment, pathSegments);

	if (isDeploymentRecord(existing) && (await hasCode(existing.address))) {
		console.log(`${contractName} already deployed: ${existing.address}`);
		await verifyRecord({
			constructorArguments,
			context,
			libraries,
			pathSegments,
			record: existing,
		});
		return existing;
	}

	const factory =
		libraries === undefined
			? await ethers.getContractFactory(contractName)
			: await ethers.getContractFactory(contractName, { libraries });
	const contract = await factory
		.connect(context.deployer)
		.deploy(...constructorArguments);
	await contract.waitForDeployment();

	const deploymentTransaction = contract.deploymentTransaction();
	const receipt = await deploymentTransaction?.wait();
	const address = await contract.getAddress();
	const record: DeploymentRecord = {
		address,
		deployer: context.deployer.address,
		transactionHash: deploymentTransaction?.hash,
		blockNumber: receipt?.blockNumber,
		verified: false,
		...(context.chainId === FUJI_CHAIN_ID
			? { snowtraceUrl: snowtraceAddressUrl(address) }
			: {}),
	};

	console.log(`${contractName} deployed: ${address}`);
	setPath(eercDeployment, pathSegments, record);
	await writeDeployments(context);
	await verifyRecord({
		constructorArguments,
		context,
		libraries,
		pathSegments,
		record,
	});

	return record;
};

export const deployVerifiers = async (context: DeployContext) => ({
	registration: await deployContract({
		context,
		contractName: "RegistrationCircuitGroth16Verifier",
		pathSegments: ["verifiers", "registration"],
	}),
	mint: await deployContract({
		context,
		contractName: "MintCircuitGroth16Verifier",
		pathSegments: ["verifiers", "mint"],
	}),
	transfer: await deployContract({
		context,
		contractName: "TransferCircuitGroth16Verifier",
		pathSegments: ["verifiers", "transfer"],
	}),
	withdraw: await deployContract({
		context,
		contractName: "WithdrawCircuitGroth16Verifier",
		pathSegments: ["verifiers", "withdraw"],
	}),
	burn: await deployContract({
		context,
		contractName: "BurnCircuitGroth16Verifier",
		pathSegments: ["verifiers", "burn"],
	}),
});

export const deployRegistrar = async (context: DeployContext) => {
	const eercDeployment = getEercDeployment(context.deployments);
	const registrationVerifier = getPath(eercDeployment, [
		"verifiers",
		"registration",
	]);

	if (!isDeploymentRecord(registrationVerifier)) {
		throw new Error("Registration verifier must be deployed before Registrar");
	}

	return deployContract({
		context,
		contractName: "Registrar",
		constructorArguments: [registrationVerifier.address],
		pathSegments: ["registrar"],
	});
};

export const deployTestUSDC = async (context: DeployContext) =>
	deployContract({
		context,
		contractName: "TestUSDC",
		constructorArguments: [context.deployer.address],
		pathSegments: ["testUSDC"],
	});

export const deployEncryptedERC = async (context: DeployContext) => {
	const eercDeployment = getEercDeployment(context.deployments);
	const registrar = getPath(eercDeployment, ["registrar"]);
	const mintVerifier = getPath(eercDeployment, ["verifiers", "mint"]);
	const transferVerifier = getPath(eercDeployment, ["verifiers", "transfer"]);
	const withdrawVerifier = getPath(eercDeployment, ["verifiers", "withdraw"]);
	const burnVerifier = getPath(eercDeployment, ["verifiers", "burn"]);
	const testUSDC = getPath(eercDeployment, ["testUSDC"]);

	for (const [name, record] of Object.entries({
		registrar,
		mintVerifier,
		transferVerifier,
		withdrawVerifier,
		burnVerifier,
		testUSDC,
	})) {
		if (!isDeploymentRecord(record)) {
			throw new Error(`${name} must be deployed before EncryptedERC`);
		}
	}

	const babyJubJub = await deployContract({
		context,
		contractName: "BabyJubJub",
		pathSegments: ["libraries", "babyJubJub"],
	});
	const params = {
		registrar: (registrar as DeploymentRecord).address,
		isConverter: true,
		name: "Benzo Private tUSDC",
		symbol: "btUSDC",
		decimals: 6,
		mintVerifier: (mintVerifier as DeploymentRecord).address,
		withdrawVerifier: (withdrawVerifier as DeploymentRecord).address,
		transferVerifier: (transferVerifier as DeploymentRecord).address,
		burnVerifier: (burnVerifier as DeploymentRecord).address,
	};
	const libraries = {
		"contracts/eerc/libraries/BabyJubJub.sol:BabyJubJub": babyJubJub.address,
	};
	const encryptedERC = await deployContract({
		context,
		contractName: "EncryptedERC",
		constructorArguments: [params],
		libraries,
		pathSegments: ["encryptedERC"],
	});

	setPath(eercDeployment, ["wrappedToken"], {
		address: (testUSDC as DeploymentRecord).address,
		decimals: 6,
		symbol: "tUSDC",
	});
	await writeDeployments(context);

	return encryptedERC;
};

const readAuditorKeyFile = async () =>
	readJson<AuditorKeyFile>(AUDITOR_KEY_PATH, {
		warning: "Local auditor BabyJubJub secret material. Never commit.",
		custodyNote:
			"Operator must custody the privateKey until M3 sealed storage imports it.",
		auditors: {},
	});

const writeAuditorKeyFile = async (keyFile: AuditorKeyFile) => {
	await writeJson(AUDITOR_KEY_PATH, keyFile);
};

export const loadStoredAuditorAccount = async (auditorAddress: string) => {
	const keyFile = await readAuditorKeyFile();
	const stored =
		keyFile.auditors?.[`${network.name}:${auditorAddress.toLowerCase()}`];

	if (stored === undefined) {
		throw new Error(
			`Missing local auditor key for ${auditorAddress}. Expected ${AUDITOR_KEY_PATH}`,
		);
	}

	return deserializeEercAccount(stored);
};

const getAuditorSigner = async () => {
	const signers = await ethers.getSigners();

	if (signers.length < 2) {
		throw new Error(
			"Dedicated auditor signer missing. Provide PRIVATE_KEY_2 as a funded auditor account for non-local deploys.",
		);
	}

	return signers[1];
};

const getOrCreateAuditorAccount = async (
	context: DeployContext,
	auditorAddress: string,
	options: { printPrivateKey?: boolean },
) => {
	const keyFile = await readAuditorKeyFile();
	keyFile.auditors = keyFile.auditors ?? {};
	const key = `${network.name}:${auditorAddress.toLowerCase()}`;
	const stored = keyFile.auditors[key];

	if (stored !== undefined) {
		return deserializeEercAccount(stored);
	}

	const account = createEercAccount();
	keyFile.auditors[key] = {
		address: auditorAddress,
		...serializeEercAccount(account),
	};

	await writeAuditorKeyFile(keyFile);
	console.log(`Auditor BabyJubJub key written: ${AUDITOR_KEY_PATH}`);
	console.log(`Network: ${network.name} (${context.chainId})`);
	console.log(`Auditor address: ${auditorAddress}`);
	if (options.printPrivateKey !== false) {
		console.log(`Auditor private key: ${account.privateKey.toString()}`);
		console.log(
			"Operator must custody this value until M3 sealed storage imports it.",
		);
	}

	return account;
};

export const configureAuditor = async (
	context: DeployContext,
	options: { printPrivateKey?: boolean } = {},
) => {
	const eercDeployment = getEercDeployment(context.deployments);
	const encryptedERCRecord = getPath(eercDeployment, ["encryptedERC"]);
	const registrarRecord = getPath(eercDeployment, ["registrar"]);

	if (!isDeploymentRecord(encryptedERCRecord) || !isDeploymentRecord(registrarRecord)) {
		throw new Error("Registrar and EncryptedERC must be deployed before auditor setup");
	}

	const encryptedERC = await ethers.getContractAt(
		"EncryptedERC",
		encryptedERCRecord.address,
	);
	const registrar = await ethers.getContractAt("Registrar", registrarRecord.address);
	const auditorIsSet = await encryptedERC.isAuditorKeySet();

	if (auditorIsSet) {
		const auditorAddress = await encryptedERC.auditor();
		const auditorPublicKey = await encryptedERC.auditorPublicKey();
		setPath(eercDeployment, ["auditor"], {
			address: auditorAddress,
			publicKey: [auditorPublicKey.x.toString(), auditorPublicKey.y.toString()],
			keyFile: path.relative(path.join(__dirname, "..", ".."), AUDITOR_KEY_PATH),
			custodyNote:
				"Auditor key already set on-chain; keep the matching private half out of git.",
		});
		await writeDeployments(context);
		console.log(`Auditor already set: ${auditorAddress}`);
		return;
	}

	const auditorSigner = await getAuditorSigner();
	const auditorAccount: EercAccount = await getOrCreateAuditorAccount(
		context,
		auditorSigner.address,
		options,
	);

	if (options.printPrivateKey === false) {
		console.log("Auditor private key printing suppressed by caller.");
	}

	const registration = await registerEercAccount(
		registrar,
		auditorSigner,
		auditorAccount,
	);
	if (registration?.transactionHash !== undefined) {
		console.log(`Auditor registered: ${registration.transactionHash}`);
	}

	const tx = await encryptedERC
		.connect(context.deployer)
		.setAuditorPublicKey(auditorSigner.address);
	const receipt = await tx.wait();

	setPath(eercDeployment, ["auditor"], {
		address: auditorSigner.address,
		publicKey: auditorAccount.publicKey.map((value) => value.toString()),
		registrationTxHash: registration?.transactionHash,
		setAuditorPublicKeyTxHash: tx.hash,
		setAuditorPublicKeyBlockNumber: receipt?.blockNumber,
		keyFile: path.relative(path.join(__dirname, "..", ".."), AUDITOR_KEY_PATH),
		custodyNote:
			"Operator must custody the BabyJubJub privateKey in contracts/.auditor-key.local.json until M3 sealed storage imports it.",
	});
	await writeDeployments(context);
	console.log(`Auditor key set: ${auditorSigner.address}`);
};

export const deployEercConverterStack = async (
	options: { configureAuditor?: boolean; printPrivateKey?: boolean } = {},
) => {
	const context = await getDeploymentContext();
	await deployVerifiers(context);
	await deployRegistrar(context);
	await deployTestUSDC(context);
	await deployEncryptedERC(context);

	if (options.configureAuditor !== false) {
		await configureAuditor(context, {
			printPrivateKey: options.printPrivateKey,
		});
	}

	return context;
};

export const getEercDeploymentRecord = async () => {
	const context = await getDeploymentContext();
	return {
		context,
		eercDeployment: getEercDeployment(context.deployments),
	};
};

export const requireDeploymentRecord = (
	eercDeployment: Record<string, unknown>,
	pathSegments: string[],
) => {
	const record = getPath(eercDeployment, pathSegments);
	if (!isDeploymentRecord(record)) {
		throw new Error(`Missing eERC deployment record: ${pathSegments.join(".")}`);
	}

	return record;
};
