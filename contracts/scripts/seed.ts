import path from "node:path";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, network } from "hardhat";
import {
	buildGiftInvite,
	buildInvoiceLink,
	buildSeedConfig,
	deriveDemoAccounts,
	deriveGiftClaimPrivateKey,
	loadSeedState,
	mirrorPostgresFixtures,
	tokenText,
	transferPlans,
	writePayrollCsv,
	writeSeedState,
	accountOutput,
	type ChainAccountResult,
	type DemoAccount,
	type SeedConfig,
	type SeedGiftResult,
	type SeedInvoiceResult,
	type SeedState,
	type SeedTarget,
	type SeedTransferResult,
} from "./seed-fixtures";
import {
	configureAuditor,
	deployEercConverterStack,
	getEercDeploymentRecord,
	requireDeploymentRecord,
	writeDeployments,
} from "./deploy/eerc-deployments";
import {
	encryptAmountPCT,
	flattenEncryptedBalance,
	generatePrivateTransfer,
	getDecryptedBalance,
	registerEercAccount,
	type EercBalance,
} from "./deploy/eerc-crypto";

type DeploymentRecord = {
	address: string;
	blockNumber?: number;
	constructorArguments?: unknown[];
	deployer?: string;
	tokenAddress?: string;
	transactionHash?: string;
	verified?: boolean;
};

type RuntimeAccount = DemoAccount & {
	signer: ethers.Wallet;
};

type EercContracts = {
	auditorPublicKey: [bigint, bigint];
	encryptedERC: Awaited<ReturnType<typeof ethers.getContractAt>>;
	encryptedERCAddress: string;
	registrar: Parameters<typeof registerEercAccount>[0];
	testUSDC: Awaited<ReturnType<typeof ethers.getContractAt>>;
	testUSDCAddress: string;
};

type WorkflowContracts = {
	giftEscrowAddress: string | null;
	handleRegistryAddress: string | null;
	invoiceRegistryAddress: string | null;
};

type SeedSigners = {
	allowlist: SignerWithAddress | ethers.Wallet;
	deployer: SignerWithAddress;
	dripper: SignerWithAddress | ethers.Wallet;
};

const TX_ALLOWLIST_ADDRESS =
	"0x0200000000000000000000000000000000000002";
const NATIVE_MINTER_ADDRESS =
	"0x0200000000000000000000000000000000000001";
const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();
const INVOICE_AMOUNT_RAW = 375_000_000n;

const allowListAbi = [
	"function readAllowList(address user) view returns (uint256)",
	"function setEnabled(address user)",
];
const nativeMinterAbi = [
	"function mintNativeCoin(address recipient, uint256 amount)",
];

async function main() {
	const config = buildSeedConfig(process.env);
	const chain = await ethers.provider.getNetwork();
	const chainId = Number(chain.chainId);

	assertTargetMatchesNetwork(config.target, chainId);
	const state = await loadSeedState(config.outputPath, config, chainId);
	const accounts = deriveDemoAccounts(config).map((account) => ({
		...account,
		signer: new ethers.Wallet(account.privateKey, ethers.provider),
	}));

	console.log(
		`Seeding ${accounts.length} deterministic demo accounts for ${config.target} (${chainId})`,
	);

	const signers = await resolveSigners(config.target);
	await ensureEercStack(config.target);
	const contracts = await loadEercContracts();
	const workflowContracts = await ensureWorkflowContracts(
		config.target,
		contracts.testUSDCAddress,
	);

	const accountResults: ChainAccountResult[] = [];
	for (const account of accounts) {
		console.log(`Account ${account.index + 1}/${accounts.length}: @${account.handle}`);
		const allowlist = await ensureAllowlisted(config.target, signers, account);
		const gas = await ensureNativeGas(config.target, signers, account, config);
		const registration = await registerAccount(contracts, account);
		const balances = await ensureTokenAndPrivateDeposit(
			config,
			signers.deployer,
			contracts,
			account,
		);
		await claimHandleIfAvailable(workflowContracts, account);

		accountResults.push({
			address: account.address,
			allowlistResult: allowlist.result,
			allowlistTxHash: allowlist.txHash,
			depositAmountRaw: balances.depositAmountRaw.toString(),
			depositTxHash: balances.depositTxHash,
			gasResult: gas.result,
			gasTxHash: gas.txHash,
			handle: account.handle,
			name: account.name,
			privateBalanceRaw: balances.privateBalanceRaw.toString(),
			publicBalanceRaw: balances.publicBalanceRaw.toString(),
			registrationTxHash: registration.txHash,
			tusdcTopUpResult: balances.topUpResult,
			tusdcTopUpTxHash: balances.topUpTxHash,
		});
	}

	const transfers = await seedPrivateTransfers({
		accounts,
		contracts,
		state,
	});
	const invoice = await seedInvoiceFixture({
		accounts,
		contracts,
		state,
		workflowContracts,
	});
	const gift = await seedGiftFixture({
		accounts,
		config,
		contracts,
		signers,
		state,
		workflowContracts,
	});

	state.accounts = accounts.map(accountOutput);
	state.invoice = invoice;
	state.gift = gift;
	await writePayrollCsv(config.payrollCsvPath, accounts);
	await writeSeedState(config.outputPath, state);

	const postgres = await mirrorPostgresFixtures({
		accounts,
		accountResults,
		chainId,
		config,
		gift,
		invoice,
		transfers,
	});

	console.log(
		JSON.stringify(
			{
				accounts: accountResults.map((result) => ({
					address: result.address,
					depositTxHash: result.depositTxHash,
					handle: result.handle,
					name: result.name,
					privateBalance: tokenText(BigInt(result.privateBalanceRaw)),
					publicBalance: tokenText(BigInt(result.publicBalanceRaw)),
					registrationTxHash: result.registrationTxHash,
				})),
				fixtures: {
					giftLink: "written_to_seed_output",
					invoiceLink: invoice.link,
					outputPath: path.relative(process.cwd(), config.outputPath),
					payrollCsvPath: path.relative(process.cwd(), config.payrollCsvPath),
					transfers: transfers.length,
				},
				postgres,
				target: config.target,
			},
			null,
			2,
		),
	);
}

function assertTargetMatchesNetwork(target: SeedTarget, chainId: number): void {
	if (target === "fuji" && chainId !== 43_113) {
		throw new Error(`BENZO_SEED_TARGET=fuji requires chain id 43113; got ${chainId}`);
	}

	if (target === "benzonet" && chainId !== 68_420) {
		throw new Error(
			`BENZO_SEED_TARGET=benzonet requires chain id 68420; got ${chainId}`,
		);
	}

	if (target === "local" && (chainId === 43_113 || chainId === 68_420)) {
		throw new Error("BENZO_SEED_TARGET=local must not run against Fuji or BenzoNet");
	}
}

async function resolveSigners(target: SeedTarget): Promise<SeedSigners> {
	const [deployer] = await ethers.getSigners();
	if (!deployer) {
		throw new Error("seed requires at least one Hardhat signer");
	}

	return {
		allowlist:
			target === "benzonet" && process.env.BENZO_OPS_PRIVATE_KEY
				? new ethers.Wallet(process.env.BENZO_OPS_PRIVATE_KEY, ethers.provider)
				: deployer,
		deployer,
		dripper:
			target === "benzonet" && process.env.BENZO_DRIPPER_PRIVATE_KEY
				? new ethers.Wallet(
						process.env.BENZO_DRIPPER_PRIVATE_KEY,
						ethers.provider,
					)
				: deployer,
	};
}

async function ensureEercStack(target: SeedTarget): Promise<void> {
	if (target !== "local") {
		return;
	}

	await deployEercConverterStack({ configureAuditor: true });
	const { eercDeployment } = await getEercDeploymentRecord();
	const encryptedERC = requireDeploymentRecord(eercDeployment, ["encryptedERC"]);
	const registrar = requireDeploymentRecord(eercDeployment, ["registrar"]);
	const encryptedERCContract = await ethers.getContractAt(
		"EncryptedERC",
		encryptedERC.address,
	);

	if (!(await encryptedERCContract.isAuditorKeySet())) {
		const { context } = await getEercDeploymentRecord();
		await configureAuditor(context);
	}

	requireDeploymentRecord(eercDeployment, ["testUSDC"]);
	requireDeploymentRecord(eercDeployment, ["auditor"]);
	requireDeploymentRecord(eercDeployment, ["verifiers", "registration"]);
	requireDeploymentRecord(eercDeployment, ["verifiers", "transfer"]);
}

async function loadEercContracts(): Promise<EercContracts> {
	const { eercDeployment } = await getEercDeploymentRecord();
	const encryptedERCRecord = requireDeploymentRecord(eercDeployment, [
		"encryptedERC",
	]);
	const registrarRecord = requireDeploymentRecord(eercDeployment, ["registrar"]);
	const testUSDCRecord = requireDeploymentRecord(eercDeployment, ["testUSDC"]);
	const encryptedERC = await ethers.getContractAt(
		"EncryptedERC",
		encryptedERCRecord.address,
	);
	const registrar = await ethers.getContractAt(
		"Registrar",
		registrarRecord.address,
	);
	const testUSDC = await ethers.getContractAt("TestUSDC", testUSDCRecord.address);
	const auditorPublicKeyRaw = await encryptedERC.auditorPublicKey();
	const auditorPublicKey = [
		BigInt(readTupleValue(auditorPublicKeyRaw, "x", 0)),
		BigInt(readTupleValue(auditorPublicKeyRaw, "y", 1)),
	] as [bigint, bigint];

	return {
		auditorPublicKey,
		encryptedERC,
		encryptedERCAddress: encryptedERCRecord.address,
		registrar,
		testUSDC,
		testUSDCAddress: testUSDCRecord.address,
	};
}

async function ensureWorkflowContracts(
	target: SeedTarget,
	testUSDCAddress: string,
): Promise<WorkflowContracts> {
	if (target === "local") {
		return deployLocalWorkflowContracts(testUSDCAddress);
	}

	return readWorkflowContractsFromManifest();
}

async function deployLocalWorkflowContracts(
	testUSDCAddress: string,
): Promise<WorkflowContracts> {
	const { context } = await getEercDeploymentRecord();
	context.deployments.contracts = context.deployments.contracts ?? {};
	const contracts = context.deployments.contracts as Record<string, unknown>;

	const handleRegistryAddress = await deployOrReuseTopLevelContract({
		contracts,
		contractName: "HandleRegistry",
		key: "handleRegistry",
	});
	const invoiceRegistryAddress = await deployOrReuseTopLevelContract({
		contracts,
		contractName: "InvoiceRegistry",
		key: "InvoiceRegistry",
	});
	const giftEscrowAddress = await deployOrReuseTopLevelContract({
		contracts,
		constructorArguments: [testUSDCAddress],
		contractName: "GiftEscrow",
		extraRecord: { tokenAddress: testUSDCAddress },
		key: "GiftEscrow",
	});

	await writeDeployments(context);

	return {
		giftEscrowAddress,
		handleRegistryAddress,
		invoiceRegistryAddress,
	};
}

async function deployOrReuseTopLevelContract(input: {
	constructorArguments?: unknown[];
	contractName: string;
	contracts: Record<string, unknown>;
	extraRecord?: Record<string, unknown>;
	key: string;
}): Promise<string> {
	const existingAddress = deploymentAddress(input.contracts[input.key]);
	if (existingAddress && (await hasCode(existingAddress))) {
		return existingAddress;
	}

	const factory = await ethers.getContractFactory(input.contractName);
	const contract = await factory.deploy(...(input.constructorArguments ?? []));
	await contract.waitForDeployment();
	const tx = contract.deploymentTransaction();
	const receipt = await tx?.wait();
	const address = await contract.getAddress();
	const [deployer] = await ethers.getSigners();

	input.contracts[input.key] = {
		address,
		blockNumber: receipt?.blockNumber,
		constructorArguments: input.constructorArguments ?? [],
		deployer: deployer?.address,
		transactionHash: tx?.hash,
		verified: false,
		...(input.extraRecord ?? {}),
	} satisfies DeploymentRecord;
	console.log(`${input.contractName} deployed for local seed: ${address}`);

	return address;
}

async function readWorkflowContractsFromManifest(): Promise<WorkflowContracts> {
	const { context } = await getEercDeploymentRecord();
	const contracts = (context.deployments.contracts ?? {}) as Record<string, unknown>;

	return {
		giftEscrowAddress: await addressWithCode(
			deploymentAddress(contracts.GiftEscrow) ??
				deploymentAddress(contracts.giftEscrow),
		),
		handleRegistryAddress: await addressWithCode(
			deploymentAddress(contracts.handleRegistry),
		),
		invoiceRegistryAddress: await addressWithCode(
			deploymentAddress(contracts.InvoiceRegistry) ??
				deploymentAddress(contracts.invoiceRegistry),
		),
	};
}

async function ensureAllowlisted(
	target: SeedTarget,
	signers: SeedSigners,
	account: RuntimeAccount,
): Promise<{ result: string; txHash: string | null }> {
	if (target !== "benzonet") {
		return {
			result:
				target === "fuji"
					? "noop_fuji_no_tx_allowlist"
					: "noop_local_hardhat_no_tx_allowlist",
			txHash: null,
		};
	}

	const allowList = new ethers.Contract(
		TX_ALLOWLIST_ADDRESS,
		allowListAbi,
		signers.allowlist,
	);
	const level = await allowList.readAllowList(account.address);
	if (BigInt(level) >= 1n) {
		return { result: "already_enabled", txHash: null };
	}

	const tx = await allowList.setEnabled(account.address);
	await tx.wait();

	return { result: "enabled", txHash: tx.hash };
}

async function ensureNativeGas(
	target: SeedTarget,
	signers: SeedSigners,
	account: RuntimeAccount,
	config: SeedConfig,
): Promise<{ result: string; txHash: string | null }> {
	const balance = await ethers.provider.getBalance(account.address);
	if (balance >= config.nativeTargetWei) {
		return { result: "balance_sufficient", txHash: null };
	}

	const topUp = config.nativeTargetWei - balance;
	if (target === "local" && network.name === "hardhat") {
		await ethers.provider.send("hardhat_setBalance", [
			account.address,
			ethers.toBeHex(config.nativeTargetWei),
		]);
		return { result: "local_hardhat_set_balance", txHash: null };
	}

	if (target === "benzonet") {
		const nativeMinter = new ethers.Contract(
			NATIVE_MINTER_ADDRESS,
			nativeMinterAbi,
			signers.dripper,
		);
		const tx = await nativeMinter.mintNativeCoin(account.address, topUp);
		await tx.wait();

		return { result: "benzonet_native_minter_sent", txHash: tx.hash };
	}

	const tx = await signers.deployer.sendTransaction({
		to: account.address,
		value: topUp,
	});
	await tx.wait();

	return {
		result: target === "fuji" ? "fuji_plain_transfer_sent" : "native_transfer_sent",
		txHash: tx.hash,
	};
}

async function registerAccount(
	contracts: EercContracts,
	account: RuntimeAccount,
): Promise<{ txHash: string | null }> {
	const registration = await registerEercAccount(
		contracts.registrar,
		account.signer as unknown as SignerWithAddress,
		account.eercAccount,
	);

	return { txHash: registration?.transactionHash ?? null };
}

async function ensureTokenAndPrivateDeposit(
	config: SeedConfig,
	deployer: SignerWithAddress,
	contracts: EercContracts,
	account: RuntimeAccount,
): Promise<{
	depositAmountRaw: bigint;
	depositTxHash: string | null;
	privateBalanceRaw: bigint;
	publicBalanceRaw: bigint;
	topUpResult: string;
	topUpTxHash: string | null;
}> {
	let privateBalance = await readPrivateBalance(contracts, account);
	let publicBalance = await contracts.testUSDC.balanceOf(account.address);
	const totalBalance = BigInt(publicBalance) + privateBalance;
	let topUpResult = "balance_sufficient";
	let topUpTxHash: string | null = null;

	if (totalBalance < config.tusdcTargetRaw) {
		const faucetAmount = await contracts.testUSDC.FAUCET_AMOUNT();
		if (BigInt(publicBalance) === 0n && config.tusdcTargetRaw <= BigInt(faucetAmount)) {
			try {
				const faucetTx = await contracts.testUSDC.connect(account.signer).faucet();
				await faucetTx.wait();
				topUpResult = "faucet_minted";
				topUpTxHash = faucetTx.hash;
			} catch (error) {
				topUpResult = `faucet_skipped:${errorName(error)}`;
			}
		}

		privateBalance = await readPrivateBalance(contracts, account);
		publicBalance = await contracts.testUSDC.balanceOf(account.address);
		const refreshedTotal = BigInt(publicBalance) + privateBalance;
		if (refreshedTotal < config.tusdcTargetRaw) {
			const mintAmount = config.tusdcTargetRaw - refreshedTotal;
			const owner = await contracts.testUSDC.owner();
			if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
				throw new Error(
					`TestUSDC top-up requires owner ${owner}; deployer is ${deployer.address}`,
				);
			}

			const mintTx = await contracts.testUSDC
				.connect(deployer)
				.mint(account.address, mintAmount);
			await mintTx.wait();
			topUpResult =
				topUpResult === "balance_sufficient"
					? "owner_minted"
					: `${topUpResult}+owner_minted`;
			topUpTxHash = mintTx.hash;
		}
	}

	privateBalance = await readPrivateBalance(contracts, account);
	publicBalance = await contracts.testUSDC.balanceOf(account.address);
	const privateTarget = config.tusdcTargetRaw / 2n;
	const depositAmount =
		privateBalance >= privateTarget ? 0n : privateTarget - privateBalance;
	let depositTxHash: string | null = null;

	if (depositAmount > 0n) {
		if (BigInt(publicBalance) < depositAmount) {
			throw new Error(
				`${account.address} needs ${depositAmount} public tUSDC to seed private balance; has ${publicBalance}`,
			);
		}

		const approveTx = await contracts.testUSDC
			.connect(account.signer)
			.approve(contracts.encryptedERCAddress, depositAmount);
		await approveTx.wait();
		const depositTx = await contracts.encryptedERC
			.connect(account.signer)
			["deposit(uint256,address,uint256[7])"](
				depositAmount,
				contracts.testUSDCAddress,
				encryptAmountPCT(depositAmount, account.eercAccount.publicKey),
			);
		await depositTx.wait();
		depositTxHash = depositTx.hash;
	}

	return {
		depositAmountRaw: depositAmount,
		depositTxHash,
		privateBalanceRaw: await readPrivateBalance(contracts, account),
		publicBalanceRaw: BigInt(await contracts.testUSDC.balanceOf(account.address)),
		topUpResult,
		topUpTxHash,
	};
}

async function claimHandleIfAvailable(
	workflow: WorkflowContracts,
	account: RuntimeAccount,
): Promise<void> {
	if (!workflow.handleRegistryAddress) {
		return;
	}

	const registry = await ethers.getContractAt(
		"HandleRegistry",
		workflow.handleRegistryAddress,
	);
	const existingForOwner = await registry.handleOf(account.address);
	if (existingForOwner === account.handle) {
		return;
	}
	if (existingForOwner !== "") {
		throw new Error(
			`${account.address} already owns @${existingForOwner}; cannot claim @${account.handle}`,
		);
	}

	const currentOwner = (await registry.resolve(account.handle)).toLowerCase();
	if (currentOwner === account.address) {
		return;
	}
	if (currentOwner !== ZERO_ADDRESS) {
		throw new Error(`@${account.handle} is already owned by ${currentOwner}`);
	}

	const tx = await registry.connect(account.signer).claim(account.handle);
	await tx.wait();
}

async function seedPrivateTransfers(input: {
	accounts: RuntimeAccount[];
	contracts: EercContracts;
	state: SeedState;
}): Promise<SeedTransferResult[]> {
	const seeded: SeedTransferResult[] = [];

	for (const plan of transferPlans(input.accounts)) {
		const existing = input.state.transfers[plan.id];
		if (existing) {
			seeded.push(existing);
			continue;
		}

		const senderBalance = await readPrivateBalance(input.contracts, plan.from);
		if (senderBalance < plan.amountRaw) {
			throw new Error(
				`${plan.from.address} has ${senderBalance} private tUSDC; ${plan.amountRaw} required for ${plan.id}`,
			);
		}

		const tokenId = await tokenIdForTUSDC(input.contracts);
		const encryptedBalance = (await input.contracts.encryptedERC.balanceOf(
			plan.from.address,
			tokenId,
		)) as EercBalance;
		const transfer = await generatePrivateTransfer({
			auditorPublicKey: input.contracts.auditorPublicKey,
			receiverPublicKey: plan.to.eercAccount.publicKey,
			sender: plan.from.eercAccount,
			senderBalance,
			senderEncryptedBalance: flattenEncryptedBalance(encryptedBalance),
			transferAmount: plan.amountRaw,
		});
		const tx = await input.contracts.encryptedERC
			.connect(plan.from.signer)
			[
				"transfer(address,uint256,((uint256[2],uint256[2][2],uint256[2]),uint256[32]),uint256[7])"
			](
				plan.to.address,
				tokenId,
				transfer.proof,
				transfer.senderBalancePCT,
			);
		const receipt = await tx.wait();
		if (!receipt) {
			throw new Error(`missing_transfer_receipt:${plan.id}`);
		}

		const eventLog = findContractLog(
			receipt,
			input.contracts.encryptedERCAddress,
			input.contracts.encryptedERC.interface.getEvent("PrivateTransfer")?.topicHash,
		);
		const block = await ethers.provider.getBlock(receipt.blockNumber);
		if (!block) {
			throw new Error(`missing_transfer_block:${receipt.blockNumber}`);
		}

		const result: SeedTransferResult = {
			amountRaw: plan.amountRaw.toString(),
			blockHash: receipt.blockHash,
			blockNumber: receipt.blockNumber.toString(),
			blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
			from: plan.from.address,
			id: plan.id,
			label: plan.label,
			log: {
				address: eventLog.address,
				data: eventLog.data,
				logIndex: eventLog.index,
				topics: [...eventLog.topics],
			},
			to: plan.to.address,
			txHash: tx.hash,
		};
		input.state.transfers[plan.id] = result;
		seeded.push(result);
	}

	return seeded;
}

async function seedInvoiceFixture(input: {
	accounts: RuntimeAccount[];
	contracts: EercContracts;
	state: SeedState;
	workflowContracts: WorkflowContracts;
}): Promise<SeedInvoiceResult> {
	const payee = input.accounts[1] ?? input.accounts[0];
	if (!payee) {
		throw new Error("seed_invoice_requires_account");
	}

	const salt = ethers.id("benzo-demo-open-invoice-v1");
	const commitment = ethers.keccak256(
		ethers.AbiCoder.defaultAbiCoder().encode(
			["uint256", "address", "address", "bytes32"],
			[INVOICE_AMOUNT_RAW, input.contracts.testUSDCAddress, payee.address, salt],
		),
	);
	const link = buildInvoiceLink({
		amountRaw: INVOICE_AMOUNT_RAW,
		commitment,
		payee: payee.address,
		salt,
		token: input.contracts.testUSDCAddress,
	});
	const existing = input.state.invoice;
	if (existing?.txHash || existing?.status === "already_created") {
		return { ...existing, link };
	}
	if (!input.workflowContracts.invoiceRegistryAddress) {
		return {
			amountRaw: INVOICE_AMOUNT_RAW.toString(),
			commitment,
			expiresAt: expiryIso(14),
			id: null,
			link,
			payee: payee.address,
			payer: ethers.ZeroAddress,
			salt,
			status: "skipped_no_registry",
			txHash: null,
		};
	}

	const registry = await ethers.getContractAt(
		"InvoiceRegistry",
		input.workflowContracts.invoiceRegistryAddress,
	);
	const expiry = expiryUnix(14);
	const tx = await registry
		.connect(payee.signer)
		.createInvoice(commitment, ethers.ZeroAddress, expiry);
	await tx.wait();
	const invoiceId = await registry.invoiceCount();

	return {
		amountRaw: INVOICE_AMOUNT_RAW.toString(),
		commitment,
		expiresAt: new Date(Number(expiry) * 1000).toISOString(),
		id: invoiceId.toString(),
		link,
		payee: payee.address,
		payer: ethers.ZeroAddress,
		salt,
		status: "created",
		txHash: tx.hash,
	};
}

async function seedGiftFixture(input: {
	accounts: RuntimeAccount[];
	config: SeedConfig;
	contracts: EercContracts;
	signers: SeedSigners;
	state: SeedState;
	workflowContracts: WorkflowContracts;
}): Promise<SeedGiftResult> {
	const invite = buildGiftInvite(input.config);
	const base: SeedGiftResult = {
		...invite,
		escrowGiftId: null,
		escrowStatus: "skipped_no_escrow",
		escrowTxHash: null,
		expiresAt: expiryIso(7),
	};
	const existing = input.state.gift;
	if (existing?.escrowTxHash || existing?.escrowStatus === "already_created") {
		return { ...existing, link: invite.link, token: invite.token };
	}
	if (!input.workflowContracts.giftEscrowAddress) {
		return base;
	}

	const sender = input.accounts[0];
	if (!sender) {
		throw new Error("seed_gift_requires_sender");
	}

	await ensurePublicTokenBalance(
		input.contracts,
		input.signers.deployer,
		sender,
		input.config.giftAmountRaw,
	);
	const claimPrivateKey = deriveGiftClaimPrivateKey(input.config);
	const claimAddress = ethers.computeAddress(claimPrivateKey);
	const escrow = await ethers.getContractAt(
		"GiftEscrow",
		input.workflowContracts.giftEscrowAddress,
	);
	const approveTx = await input.contracts.testUSDC
		.connect(sender.signer)
		.approve(input.workflowContracts.giftEscrowAddress, input.config.giftAmountRaw);
	await approveTx.wait();
	const expiry = expiryUnix(7);
	const tx = await escrow
		.connect(sender.signer)
		.createGift(claimAddress, input.config.giftAmountRaw, expiry);
	await tx.wait();
	const giftId = await escrow.giftCount();

	return {
		...base,
		escrowGiftId: giftId.toString(),
		escrowStatus: "created",
		escrowTxHash: tx.hash,
		expiresAt: new Date(Number(expiry) * 1000).toISOString(),
		link: `${invite.link}?escrowGiftId=${giftId.toString()}`,
	};
}

async function ensurePublicTokenBalance(
	contracts: EercContracts,
	deployer: SignerWithAddress,
	account: RuntimeAccount,
	minBalance: bigint,
): Promise<void> {
	const balance = BigInt(await contracts.testUSDC.balanceOf(account.address));
	if (balance >= minBalance) {
		return;
	}

	const owner = await contracts.testUSDC.owner();
	if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
		throw new Error(
			`TestUSDC public top-up requires owner ${owner}; deployer is ${deployer.address}`,
		);
	}

	const tx = await contracts.testUSDC
		.connect(deployer)
		.mint(account.address, minBalance - balance);
	await tx.wait();
}

async function readPrivateBalance(
	contracts: EercContracts,
	account: RuntimeAccount,
): Promise<bigint> {
	const tokenId = await tokenIdForTUSDC(contracts);
	if (tokenId === 0n) {
		return 0n;
	}

	const encryptedBalance = (await contracts.encryptedERC.balanceOf(
		account.address,
		tokenId,
	)) as EercBalance;

	return getDecryptedBalance(account.eercAccount.privateKey, encryptedBalance);
}

async function tokenIdForTUSDC(contracts: EercContracts): Promise<bigint> {
	return BigInt(await contracts.encryptedERC.tokenIds(contracts.testUSDCAddress));
}

function readTupleValue(value: unknown, name: string, index: number): unknown {
	const record = value as Record<string, unknown> & ArrayLike<unknown>;
	return record[name] ?? record[index];
}

function deploymentAddress(entry: unknown): string | null {
	if (typeof entry === "string" && ethers.isAddress(entry)) {
		return ethers.getAddress(entry);
	}

	if (entry && typeof entry === "object" && "address" in entry) {
		const address = (entry as { address?: unknown }).address;
		if (typeof address === "string" && ethers.isAddress(address)) {
			return ethers.getAddress(address);
		}
	}

	return null;
}

async function addressWithCode(address: string | null): Promise<string | null> {
	if (!address) {
		return null;
	}

	return (await hasCode(address)) ? address : null;
}

async function hasCode(address: string): Promise<boolean> {
	return (await ethers.provider.getCode(address)) !== "0x";
}

function findContractLog(
	receipt: ethers.TransactionReceipt,
	contractAddress: string,
	topicHash: string | undefined,
) {
	const normalized = contractAddress.toLowerCase();
	const log =
		receipt.logs.find(
			(candidate) =>
				candidate.address.toLowerCase() === normalized &&
				(topicHash === undefined || candidate.topics[0] === topicHash),
		) ??
		receipt.logs.find((candidate) => candidate.address.toLowerCase() === normalized);

	if (!log) {
		throw new Error(`missing_contract_log:${contractAddress}:${receipt.hash}`);
	}

	return log;
}

function expiryUnix(days: number): bigint {
	return BigInt(Math.floor(Date.now() / 1000) + days * 86_400);
}

function expiryIso(days: number): string {
	return new Date(Number(expiryUnix(days)) * 1000).toISOString();
}

function errorName(error: unknown): string {
	if (error instanceof Error) {
		return error.message.split(/[(:\n]/)[0] ?? error.name;
	}

	return "unknown_error";
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
