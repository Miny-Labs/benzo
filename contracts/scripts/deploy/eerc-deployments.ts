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
const CONTRACTS_WORKSPACE = path.join(__dirname, "..", "..");
const DEPLOYMENTS_DIR = path.join(CONTRACTS_WORKSPACE, "deployments");
const AUDITOR_KEY_PATH = path.join(CONTRACTS_WORKSPACE, ".auditor-key.local.json");
const VERIFY_TIMEOUT_MS = 90_000;
const EERC_KEY = "eercConverter";

type DeploymentJsonValue =
	| null
	| boolean
	| number
	| string
	| DeploymentJsonValue[]
	| { [key: string]: DeploymentJsonValue };

type DeploymentRecord = {
	address: string;
	blockNumber?: number;
	constructorArguments?: DeploymentJsonValue[];
	deployer?: string;
	libraries?: Record<string, string>;
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

// isDeploymentRecord only confirms an address shape; it does not confirm the
// address actually has bytecode on the current network. A manifest carried
// over from another chain (or a fresh in-process Hardhat run) can point a
// prerequisite at an address with no code, which then reverts deep inside a
// later contract call with an opaque "unrecognized selector". Fail loud here.
const requireDeployedRecord = async (
	record: unknown,
	name: string,
): Promise<DeploymentRecord> => {
	if (!isDeploymentRecord(record)) {
		throw new Error(`${name} must be deployed first`);
	}

	if (!(await hasCode(record.address))) {
		throw new Error(
			`${name} record ${record.address} has no bytecode on this network — ` +
				"the deployment manifest is stale or points at a different chain. " +
				`Re-deploy ${name} or clear the manifest before continuing.`,
		);
	}

	return record;
};

class VerificationTimeoutError extends Error {
	constructor(address: string) {
		super(
			`Routescan verification timed out for ${address} after ${VERIFY_TIMEOUT_MS / 1000}s`,
		);
		this.name = "VerificationTimeoutError";
	}
}

const serializeVerificationValue = (value: unknown): DeploymentJsonValue => {
	if (value === undefined || value === null) {
		return null;
	}

	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}

	if (typeof value === "bigint") {
		return value.toString();
	}

	if (Array.isArray(value)) {
		return value.map(serializeVerificationValue);
	}

	if (typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
				key,
				serializeVerificationValue(nestedValue),
			]),
		) as Record<string, DeploymentJsonValue>;
	}

	return String(value);
};

const recordVerificationInputs = (
	record: DeploymentRecord,
	constructorArguments: unknown[],
	libraries?: Record<string, string>,
) => {
	record.constructorArguments = constructorArguments.map(serializeVerificationValue);
	if (libraries === undefined) {
		delete record.libraries;
	} else {
		record.libraries = libraries;
	}
};

const ensureContractsWorkspaceCwd = () => {
	const contractsWorkspace = path.resolve(CONTRACTS_WORKSPACE);
	if (process.cwd() !== contractsWorkspace) {
		process.chdir(contractsWorkspace);
	}
};

const runVerifyWithTimeout = async (
	address: string,
	verifyArgs: {
		address: string;
		constructorArguments: unknown[];
		libraries?: Record<string, string>;
	},
) => {
	ensureContractsWorkspaceCwd();

	let timeout: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			run("verify:verify", verifyArgs),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					reject(new VerificationTimeoutError(address));
				}, VERIFY_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	}
};

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
	recordVerificationInputs(record, constructorArguments, libraries);
	setPath(getEercDeployment(context.deployments), pathSegments, record);

	if (network.name !== "fuji") {
		await writeDeployments(context);
		return;
	}

	// SKIP_VERIFY defers Routescan source verification: hardhat-verify polls the
	// explorer for the freshly-deployed (not-yet-indexed) contract and can block
	// the whole deploy for minutes per contract. Contracts are still live and
	// visible on the explorer; verify separately later.
	if (process.env.SKIP_VERIFY === "1") {
		record.verified = record.verified ?? false;
		if (!record.verified) {
			delete record.verifiedAt;
		}
		await writeDeployments(context);
		return;
	}

	if (record.verified) {
		await writeDeployments(context);
		return;
	}

	try {
		await runVerifyWithTimeout(record.address, {
			address: record.address,
			constructorArguments,
			...(libraries === undefined ? {} : { libraries }),
		});
		record.verified = true;
		record.verifiedAt = new Date().toISOString();
	} catch (error) {
		record.verified = false;
		delete record.verifiedAt;
		if (error instanceof VerificationTimeoutError) {
			console.warn(error.message);
			console.warn("Continuing with the next contract; re-run verification later.");
		} else {
			console.warn(`Routescan verification failed for ${record.address}`);
		}
		console.warn(error);
	}

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
	recordVerificationInputs(record, constructorArguments, libraries);

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
	const registrationVerifier = await requireDeployedRecord(
		getPath(eercDeployment, ["verifiers", "registration"]),
		"Registration verifier",
	);

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
		await requireDeployedRecord(record, `${name} (required by EncryptedERC)`);
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
	await fs.mkdir(path.dirname(AUDITOR_KEY_PATH), { recursive: true });
	// 0600: this file holds the raw auditor private key. writeFile's `mode`
	// only applies when the file is created, so chmod afterwards to also tighten
	// an existing file that may have been written with looser permissions.
	await fs.writeFile(
		AUDITOR_KEY_PATH,
		`${JSON.stringify(keyFile, null, 2)}\n`,
		{ mode: 0o600 },
	);
	await fs.chmod(AUDITOR_KEY_PATH, 0o600);
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
	console.log("Auditor private key is stored only in the local key file.");

	return account;
};

export const configureAuditor = async (context: DeployContext) => {
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
	);

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
	options: { configureAuditor?: boolean } = {},
) => {
	const context = await getDeploymentContext();
	await deployVerifiers(context);
	await deployRegistrar(context);
	await deployTestUSDC(context);
	await deployEncryptedERC(context);

	if (options.configureAuditor !== false) {
		await configureAuditor(context);
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
