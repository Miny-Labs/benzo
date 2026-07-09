import fs from "node:fs/promises";
import path from "node:path";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, network, run } from "hardhat";
import {
	type EercAccount,
	createEercAccount,
	deserializeEercAccount,
	encryptAmountPCT,
	registerEercAccount,
	serializeEercAccount,
} from "./eerc-crypto";
import {
	AVALANCHE_CHAIN_ID,
	AVALANCHE_EURC,
	AVALANCHE_USDC,
} from "./mainnet-guardrails";

const FUJI_CHAIN_ID = 43113;
// Fixed by the BenzoNet genesis; kept a hardcoded constant like FUJI_CHAIN_ID
// so the deploy guard can't be loosened by a stray env var.
const BENZONET_CHAIN_ID = 68420;
// Networks whose contracts are source-verified through Routescan's Etherscan-
// compatible API (Fuji testnet + Avalanche mainnet). BenzoNet is intentionally
// absent — it verifies via its own self-hosted Blockscout, an unchanged path.
const ROUTESCAN_VERIFIABLE = new Set(["fuji", "avalanche"]);
const CONTRACTS_WORKSPACE = path.join(__dirname, "..", "..");
const DEPLOYMENTS_DIR = path.join(CONTRACTS_WORKSPACE, "deployments");
const AUDITOR_KEY_PATH = path.join(CONTRACTS_WORKSPACE, ".auditor-key.local.json");
const VERIFY_TIMEOUT_MS = 90_000;
const EERC_KEY = "eercConverter";

// Converter mode assigns tokenIds by DEPOSIT ORDER (no constructor token, no admin
// setter), so the wrapped token is not a constructor arg. Each network declares
// which ERC20(s) its converter wraps and in what order; a deterministic bootstrap
// (registerConverterTokens) deposits them in that order to pin USDC -> tokenId 1,
// EURC -> tokenId 2, etc.
type WrappedTokenMode = "existing" | "deploy-test";
type WrappedTokenSpec = {
	mode: WrappedTokenMode;
	symbol: string;
	decimals: number;
	// Required when mode === "existing" (a real, already-deployed ERC20).
	address?: string;
};
type NetworkDeployConfig = {
	eercName: string;
	eercSymbol: string;
	eercDecimals: number;
	wrappedTokens: WrappedTokenSpec[];
};

// Canonical Circle stablecoin addresses mirror packages/config/src/tokens.ts (one
// logical registry, each verified on-chain). Defined here so the hardhat deploy
// stays self-contained — the contracts workspace does not import the ESM
// @benzo/config package. On fuji the converter wraps REAL Circle USDC + EURC; on
// benzonet/local it mints a TestUSDC. USDC MUST be first so it becomes tokenId 1.
const FUJI_USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const FUJI_EURC = "0x5E44db7996c682E92a960b65AC713a54AD815c6B";
const TEST_NETWORK_CONFIG: NetworkDeployConfig = {
	eercName: "Benzo Private tUSDC",
	eercSymbol: "btUSDC",
	eercDecimals: 6,
	wrappedTokens: [{ mode: "deploy-test", symbol: "tUSDC", decimals: 6 }],
};
const NETWORK_DEPLOY_CONFIG: Record<string, NetworkDeployConfig> = {
	fuji: {
		eercName: "Benzo Private USDC",
		eercSymbol: "bUSDC",
		eercDecimals: 6,
		wrappedTokens: [
			{ mode: "existing", symbol: "USDC", decimals: 6, address: FUJI_USDC },
			{ mode: "existing", symbol: "EURC", decimals: 6, address: FUJI_EURC },
		],
	},
	// Mainnet C-Chain wraps REAL Circle USDC + EURC (never a TestUSDC). USDC MUST
	// stay first so it becomes tokenId 1, matching the fuji ordering. The mainnet
	// deploy is gated by deploy-mainnet.ts / mainnet-guardrails.ts.
	avalanche: {
		eercName: "Benzo Private USDC",
		eercSymbol: "bUSDC",
		eercDecimals: 6,
		wrappedTokens: [
			{ mode: "existing", symbol: "USDC", decimals: 6, address: AVALANCHE_USDC },
			{ mode: "existing", symbol: "EURC", decimals: 6, address: AVALANCHE_EURC },
		],
	},
	benzonet: TEST_NETWORK_CONFIG,
	hardhat: TEST_NETWORK_CONFIG,
	localhost: TEST_NETWORK_CONFIG,
};

export const resolveNetworkConfig = (name: string): NetworkDeployConfig => {
	const config = NETWORK_DEPLOY_CONFIG[name];
	if (config === undefined) {
		throw new Error(`No NetworkDeployConfig for network "${name}"`);
	}
	return config;
};

// Fixed seed for the throwaway bootstrap eERC account, so re-running the deploy
// re-derives the SAME key and registration/deposit are idempotent. This account
// only exists to establish tokenId order; it is never a real user.
const BOOTSTRAP_EERC_SEED =
	0x62656e7a6f2d626f6f7473747261702d746f6b656e2d6f72646572n; // "benzo-bootstrap-token-order"
// Dust deposited per token to assign its tokenId (0.001 of a 6-decimal token).
const BOOTSTRAP_DEPOSIT_UNITS = 1_000n;

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

// Snowtrace host by chainId: mainnet C-Chain -> snowtrace.io, everything else
// (Fuji) -> testnet.snowtrace.io.
const snowtraceAddressUrl = (address: string, chainId: number) => {
	const host =
		chainId === AVALANCHE_CHAIN_ID ? "snowtrace.io" : "testnet.snowtrace.io";
	return `https://${host}/address/${address}`;
};

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

	const expectedChainId: Record<string, number> = {
		fuji: FUJI_CHAIN_ID,
		benzonet: BENZONET_CHAIN_ID,
		avalanche: AVALANCHE_CHAIN_ID,
	};
	const expected = expectedChainId[network.name];
	if (expected !== undefined && chainId !== expected) {
		throw new Error(
			`${network.name} deploy expected chainId ${expected}; got ${chainId}`,
		);
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

	// Fuji + Avalanche mainnet verify through Routescan's Etherscan-compatible
	// API; every other network (BenzoNet Blockscout) uses its own path.
	if (!ROUTESCAN_VERIFIABLE.has(network.name)) {
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
		...(context.chainId === FUJI_CHAIN_ID ||
		context.chainId === AVALANCHE_CHAIN_ID
			? { snowtraceUrl: snowtraceAddressUrl(address, context.chainId) }
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
	const netConfig = resolveNetworkConfig(network.name);
	const eercDeployment = getEercDeployment(context.deployments);
	const registrar = getPath(eercDeployment, ["registrar"]);
	const mintVerifier = getPath(eercDeployment, ["verifiers", "mint"]);
	const transferVerifier = getPath(eercDeployment, ["verifiers", "transfer"]);
	const withdrawVerifier = getPath(eercDeployment, ["verifiers", "withdraw"]);
	const burnVerifier = getPath(eercDeployment, ["verifiers", "burn"]);

	for (const [name, record] of Object.entries({
		registrar,
		mintVerifier,
		transferVerifier,
		withdrawVerifier,
		burnVerifier,
	})) {
		await requireDeployedRecord(record, `${name} (required by EncryptedERC)`);
	}

	// The wrapped token is not a constructor arg (converter mode registers tokens
	// on first deposit), but an 'existing' token must actually have bytecode on
	// this network — otherwise a deposit reverts deep inside with an opaque error.
	for (const token of netConfig.wrappedTokens) {
		if (token.mode !== "existing") {
			continue;
		}
		if (token.address === undefined) {
			throw new Error(`wrapped token ${token.symbol} is 'existing' but has no address`);
		}
		await requireDeployedRecord({ address: token.address }, `${token.symbol} wrapped token`);
	}

	const babyJubJub = await deployContract({
		context,
		contractName: "BabyJubJub",
		pathSegments: ["libraries", "babyJubJub"],
	});
	const params = {
		registrar: (registrar as DeploymentRecord).address,
		isConverter: true,
		name: netConfig.eercName,
		symbol: netConfig.eercSymbol,
		decimals: netConfig.eercDecimals,
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

	// The wrapped-token registry (tokens + their deposit-order tokenIds) is written
	// by registerConverterTokens() after the auditor is set and the deterministic
	// bootstrap deposits run.
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
	allowGenerate = true,
) => {
	const keyFile = await readAuditorKeyFile();
	keyFile.auditors = keyFile.auditors ?? {};
	const key = `${network.name}:${auditorAddress.toLowerCase()}`;
	const stored = keyFile.auditors[key];

	if (stored !== undefined) {
		return deserializeEercAccount(stored);
	}

	// Mainnet MUST NOT auto-generate the auditor key: it has to be operator-
	// provided and its private half sealed into the prod store (never left in
	// contracts/.auditor-key.local.json). Fail loudly instead.
	if (!allowGenerate) {
		throw new Error(
			`mainnet_auditor_key_not_provided:${key} — provide the operator-custodied auditor key; deploy will not auto-generate it`,
		);
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

export const configureAuditor = async (
	context: DeployContext,
	options: { autoGenerateAuditor?: boolean } = {},
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
		options.autoGenerateAuditor !== false,
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

const ERC20_MIN_ABI = [
	"function approve(address spender, uint256 value) returns (bool)",
	"function balanceOf(address account) view returns (uint256)",
];

// Deterministic converter-token bootstrap: deposits each configured wrapped token
// IN ORDER from a fixed-seed throwaway account so tokenIds bind predictably
// (USDC -> 1, EURC -> 2). tokenIds are assigned by deposit order with no admin
// setter, so this is the only lever. Idempotent: skips a token that already has a
// tokenId, and refuses to append if the converter already carries out-of-order
// tokens (protects against running against a stale converter).
export const registerConverterTokens = async (context: DeployContext) => {
	const netConfig = resolveNetworkConfig(network.name);
	const eercDeployment = getEercDeployment(context.deployments);
	const encRecord = await requireDeployedRecord(
		getPath(eercDeployment, ["encryptedERC"]),
		"EncryptedERC (required to register tokens)",
	);
	const registrarRecord = await requireDeployedRecord(
		getPath(eercDeployment, ["registrar"]),
		"Registrar (required to register tokens)",
	);
	const encryptedERC = await ethers.getContractAt("EncryptedERC", encRecord.address);
	const registrar = await ethers.getContractAt("Registrar", registrarRecord.address);

	if (!(await encryptedERC.isAuditorKeySet())) {
		throw new Error("Auditor must be set before bootstrapping converter tokens");
	}

	const resolveTokenAddress = (token: WrappedTokenSpec): string => {
		if (token.mode === "existing") {
			if (token.address === undefined) {
				throw new Error(`token ${token.symbol} is 'existing' but has no address`);
			}
			return token.address;
		}
		const testUSDC = getPath(eercDeployment, ["testUSDC"]);
		if (!isDeploymentRecord(testUSDC)) {
			throw new Error("deploy-test token requires a deployed testUSDC record");
		}
		return testUSDC.address;
	};

	const tokensInOrder = await encryptedERC.getTokens();
	// Any token already registered must already be at its expected position — never
	// append a configured token out of the intended order.
	for (let index = 0; index < tokensInOrder.length; index += 1) {
		const spec = netConfig.wrappedTokens[index];
		const expected = spec === undefined ? undefined : resolveTokenAddress(spec);
		if (
			expected === undefined ||
			tokensInOrder[index].toLowerCase() !== expected.toLowerCase()
		) {
			throw new Error(
				`converter already has token ${tokensInOrder[index]} at tokenId ${index + 1}, which does not match the expected bootstrap order — refusing to seed tokens out of order`,
			);
		}
	}

	const bootstrapSigner = (await ethers.getSigners())[0];
	const bootstrapAccount = createEercAccount(BOOTSTRAP_EERC_SEED);
	// The bootstrap signer only needs to be a registered account so deposits credit
	// a valid pubkey. If it is already registered (e.g. the deployer on a reused
	// Registrar), keep its existing key; only register with the fixed seed when it is
	// not registered yet.
	if (!(await registrar.isUserRegistered(bootstrapSigner.address))) {
		await registerEercAccount(registrar, bootstrapSigner, bootstrapAccount);
	}

	// Build amountPCT from the depositor's ON-CHAIN registered public key (not the
	// fixed-seed account's key) so the deposit's history entry decrypts consistently
	// with the balance _convertFrom credits — even when the deployer was already
	// registered with a different key. Only the public key is needed for amountPCT.
	const registeredPubKey = await registrar.getUserPublicKey(bootstrapSigner.address);
	const depositorPublicKey: [bigint, bigint] = [
		BigInt(registeredPubKey[0]),
		BigInt(registeredPubKey[1]),
	];

	const tokenIdOf = async (address: string): Promise<number> => {
		const tokens: string[] = await encryptedERC.getTokens();
		const idx = tokens.findIndex(
			(token) => token.toLowerCase() === address.toLowerCase(),
		);
		return idx === -1 ? 0 : idx + 1;
	};

	const tokensRecord: Record<
		string,
		{ address: string; decimals: number; tokenId: number; symbol: string }
	> = {};

	for (const token of netConfig.wrappedTokens) {
		const tokenAddress = resolveTokenAddress(token);
		let tokenId = await tokenIdOf(tokenAddress);

		if (tokenId === 0) {
			const erc20 = new ethers.Contract(
				tokenAddress,
				ERC20_MIN_ABI,
				bootstrapSigner,
			);
			let balance: bigint = await erc20.balanceOf(bootstrapSigner.address);
			// deploy-test tokens (benzonet/local) are self-funding via their public
			// faucet; 'existing' Circle tokens must be pre-funded (prefund-bootstrap.ts).
			if (token.mode === "deploy-test" && balance < BOOTSTRAP_DEPOSIT_UNITS) {
				const faucet = new ethers.Contract(
					tokenAddress,
					["function faucet()"],
					bootstrapSigner,
				);
				await (await faucet.faucet()).wait();
				balance = await erc20.balanceOf(bootstrapSigner.address);
			}
			if (balance < BOOTSTRAP_DEPOSIT_UNITS) {
				throw new Error(
					`Bootstrap signer ${bootstrapSigner.address} needs >= ${BOOTSTRAP_DEPOSIT_UNITS} units of ${token.symbol} (${tokenAddress}) to seed tokenId order; has ${balance}. Pre-fund it first (scripts/deploy/prefund-bootstrap.ts).`,
				);
			}

			await (await erc20.approve(encRecord.address, BOOTSTRAP_DEPOSIT_UNITS)).wait();

			// creditedValue = deposited units scaled to eERC decimals (floored).
			const scaleDown = token.decimals - netConfig.eercDecimals;
			const creditedValue =
				scaleDown > 0
					? BOOTSTRAP_DEPOSIT_UNITS / 10n ** BigInt(scaleDown)
					: BOOTSTRAP_DEPOSIT_UNITS * 10n ** BigInt(-scaleDown);
			const amountPCT = encryptAmountPCT(creditedValue, depositorPublicKey);

			const depositTx = await encryptedERC
				.connect(bootstrapSigner)
				["deposit(uint256,address,uint256[7])"](
					BOOTSTRAP_DEPOSIT_UNITS,
					tokenAddress,
					amountPCT,
				);
			await depositTx.wait();
			tokenId = await tokenIdOf(tokenAddress);
			console.log(`Bootstrapped ${token.symbol} -> tokenId ${tokenId} (${tokenAddress})`);
		} else {
			console.log(
				`${token.symbol} already registered as tokenId ${tokenId} (${tokenAddress})`,
			);
		}

		if (tokenId === 0) {
			throw new Error(`failed to assign a tokenId for ${token.symbol} (${tokenAddress})`);
		}

		tokensRecord[token.symbol] = {
			address: tokenAddress,
			decimals: token.decimals,
			tokenId,
			symbol: token.symbol,
		};
	}

	setPath(eercDeployment, ["tokens"], tokensRecord);
	await writeDeployments(context);
	console.log("Converter token registry:", JSON.stringify(tokensRecord));
	return tokensRecord;
};

export const deployEercConverterStack = async (
	options: {
		configureAuditor?: boolean;
		registerTokens?: boolean;
		autoGenerateAuditor?: boolean;
	} = {},
) => {
	const context = await getDeploymentContext();
	const netConfig = resolveNetworkConfig(network.name);
	await deployVerifiers(context);
	await deployRegistrar(context);

	// Only mint a TestUSDC where the network wraps one (benzonet/local); fuji +
	// avalanche wrap real Circle tokens that already exist on-chain.
	if (netConfig.wrappedTokens.some((token) => token.mode === "deploy-test")) {
		await deployTestUSDC(context);
	}

	await deployEncryptedERC(context);

	if (options.configureAuditor !== false) {
		await configureAuditor(context, {
			autoGenerateAuditor: options.autoGenerateAuditor,
		});
	}

	if (options.registerTokens !== false) {
		await registerConverterTokens(context);
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
