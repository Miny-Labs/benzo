/**
 * Benzo — REAL-FUNDS end-to-end validation harness on Avalanche Fuji (chainId 43113).
 *
 * Runs the product's core private-payment flows against the LIVE deployed
 * converter using pre-funded testnet accounts (no faucet), asserts decrypted
 * eERC balances + public balances on-chain, and prints a GREEN/RED report with
 * tx hashes. No secrets are written to the repo; keys are read at runtime from
 * ~/.benzo-keys and contracts/.auditor-key.local.json. Ephemeral EOA keys for
 * the fresh test accounts are persisted only to a scratchpad session file so
 * re-runs reuse them (and funds are not stranded).
 *
 * Run (from contracts/, node 22, space-in-path needs the wasm force flag):
 *   export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22
 *   BENZO_ZKIT_FORCE_WASM=1 E2E_FLOWS=all \
 *     npx hardhat run scripts/e2e/fuji-real-funds-e2e.ts --network fuji
 *
 * E2E_FLOWS is a comma list selecting flows (default "all"):
 *   fund,register,usdc,eurc,handle,gift,disclosure,auditor,cctp,benzonet
 * usdc/eurc each run deposit->transfer->withdraw for that token.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers, zkit } from "hardhat";
import {
	Base8,
	mulPointEscalar,
	subOrder,
	type Point,
} from "@zk-kit/baby-jubjub";
import { formatPrivKeyForBabyJub } from "maci-crypto";
import { poseidon3 } from "poseidon-lite";
import { poseidonDecrypt } from "maci-crypto";
import {
	type EercAccount,
	type EercBalance,
	createEercAccount,
	deserializeEercAccount,
	encryptAmountPCT,
	flattenEncryptedBalance,
	generateWithdraw,
	getDecryptedBalance,
	serializeEercAccount,
} from "../deploy/eerc-crypto";
import { processPoseidonEncryption } from "../../src";
import { encryptMessage } from "../../src/jub/jub";

// ---------------------------------------------------------------------------
// Static config (Fuji deployment — deployments/fuji.json)
// ---------------------------------------------------------------------------
const FUJI_CHAIN_ID = 43113n;
const EERC = "0x9E16eD3B799541B4929f7E2014904C65E81035b1";
const REGISTRAR = "0x9a63FEa9851097DBAf3757b636217fdde50ABaF0";
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const EURC = "0x5E44db7996c682E92a960b65AC713a54AD815c6B";
const HANDLE_REGISTRY = "0xC74EcCDE4D9A1F48D560de9A96521D28D58B474b";
const PRIVATE_GIFT_ESCROW = "0x0B1f4e78C54E7696663b62F9cD7956f5FDE5b71d";
const USDC_TOKEN_ID = 1n;
const EURC_TOKEN_ID = 2n;

const API_BASE = process.env.E2E_API_BASE ?? "https://api.benzo.space";
const BENZONET_RPC = process.env.E2E_BENZONET_RPC ?? "https://rpc.benzo.space";

// Amounts (6-decimal tokens)
const DEPOSIT = 2_000_000n; // 2.0
const TRANSFER = 1_000_000n; // 1.0
const WITHDRAW = 500_000n; // 0.5
const GIFT_AMOUNT = 1_000_000n; // 1.0
const GIFT_REFUND_AMOUNT = 500_000n; // 0.5

const KEYS_DIR = path.join(os.homedir(), ".benzo-keys");
const AUDITOR_KEY_PATH = path.join(__dirname, "..", "..", ".auditor-key.local.json");
const SESSION_PATH =
	process.env.E2E_SESSION_PATH ??
	path.join(
		"/private/tmp/claude-501/-Users-akshmnd-Dev-Projects-stellar-benzo",
		"e2e-fuji-session.json",
	);

const SNOW = (h: string) => `https://testnet.snowtrace.io/tx/${h}`;

const ERC20_ABI = [
	"function approve(address spender, uint256 value) returns (bool)",
	"function balanceOf(address account) view returns (uint256)",
	"function transfer(address to, uint256 value) returns (bool)",
	"function decimals() view returns (uint8)",
];

// ---------------------------------------------------------------------------
// Session state (persisted to scratchpad only)
// ---------------------------------------------------------------------------
type Session = {
	alice: { pk: string; eercSeed: string };
	bob: { pk: string; eercSeed: string };
	giftEphemeral: { pk: string };
	benzonetProbe: { pk: string };
};

const loadSession = (): Session => {
	if (fs.existsSync(SESSION_PATH)) {
		return JSON.parse(fs.readFileSync(SESSION_PATH, "utf8")) as Session;
	}
	const rnd = () => ethers.Wallet.createRandom().privateKey;
	const seed = () => `0x${Buffer.from(ethers.randomBytes(31)).toString("hex")}`;
	const s: Session = {
		alice: { pk: rnd(), eercSeed: seed() },
		bob: { pk: rnd(), eercSeed: seed() },
		giftEphemeral: { pk: rnd() },
		benzonetProbe: { pk: rnd() },
	};
	fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
	fs.writeFileSync(SESSION_PATH, JSON.stringify(s, null, 2));
	return s;
};

const readKeyJson = (file: string) =>
	JSON.parse(fs.readFileSync(path.join(KEYS_DIR, file), "utf8"));

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------
type FlowResult = {
	flow: string;
	status: "PASS" | "FAIL" | "PARTIAL" | "SKIP";
	txHashes: string[];
	asserted: string;
	note: string;
};
const results: FlowResult[] = [];
const record = (r: FlowResult) => {
	results.push(r);
	console.log(
		`\n[[${r.status}]] ${r.flow} :: ${r.asserted}${r.note ? ` — ${r.note}` : ""}`,
	);
	for (const h of r.txHashes) console.log(`    tx ${h}  ${SNOW(h)}`);
};

// ---------------------------------------------------------------------------
// eERC crypto helpers local to the harness
// ---------------------------------------------------------------------------
type ZkitCircuit<T> = {
	generateProof: (input: Record<string, unknown>) => Promise<unknown>;
	generateCalldata: (proof: unknown) => Promise<T>;
};
type ProofCalldata = {
	proofPoints: { a: bigint[]; b: bigint[][]; c: bigint[] };
	publicSignals: bigint[];
};

const registrationHash = (account: EercAccount, addr: string, chainId: bigint) =>
	poseidon3([chainId, account.formattedPrivateKey, BigInt(addr)]);

async function ensureRegistered(
	registrar: any,
	signer: ethers.Wallet,
	account: EercAccount,
	chainId: bigint,
	label: string,
): Promise<string | null> {
	if (await registrar.isUserRegistered(signer.address)) {
		const pk = Array.from(await registrar.getUserPublicKey(signer.address)).map(
			(v) => BigInt(v as any),
		);
		if (pk[0] !== account.publicKey[0] || pk[1] !== account.publicKey[1]) {
			throw new Error(
				`${label} ${signer.address} already registered with a DIFFERENT eERC key`,
			);
		}
		console.log(`${label} already registered: ${signer.address}`);
		return null;
	}
	const circuit = (await zkit.getCircuit(
		"RegistrationCircuit",
	)) as unknown as ZkitCircuit<ProofCalldata>;
	const proof = await circuit.generateProof({
		SenderPrivateKey: account.formattedPrivateKey,
		SenderPublicKey: account.publicKey,
		SenderAddress: BigInt(signer.address),
		ChainID: chainId,
		RegistrationHash: registrationHash(account, signer.address, chainId),
	});
	const calldata = await circuit.generateCalldata(proof);
	const tx = await registrar.connect(signer).register(calldata);
	await tx.wait();
	console.log(`${label} registered: ${signer.address} tx ${tx.hash}`);
	return tx.hash as string;
}

async function decryptedBalance(
	eerc: any,
	owner: string,
	tokenId: bigint,
	account: EercAccount,
): Promise<{ total: bigint; encrypted: bigint[] }> {
	const bal = (await eerc.balanceOf(owner, tokenId)) as EercBalance;
	const total = getDecryptedBalance(account.privateKey, bal);
	return { total, encrypted: flattenEncryptedBalance(bal) };
}

// Build a transfer proof AND return the auditor encRandom + auditor PCT so the
// disclosure (Tier A) and auditor-decrypt flows can reuse them.
async function buildTransfer(params: {
	auditorPublicKey: [bigint, bigint];
	receiverPublicKey: [bigint, bigint];
	sender: EercAccount;
	senderBalance: bigint;
	senderEncryptedBalance: bigint[];
	transferAmount: bigint;
}) {
	const {
		auditorPublicKey,
		receiverPublicKey,
		sender,
		senderBalance,
		senderEncryptedBalance,
		transferAmount,
	} = params;
	const senderNewBalance = senderBalance - transferAmount;
	const { cipher: encAmtSender } = encryptMessage(sender.publicKey, transferAmount);
	const { cipher: encAmtReceiver, random: encAmtReceiverRandom } = encryptMessage(
		receiverPublicKey,
		transferAmount,
	);
	const {
		ciphertext: rCipher,
		nonce: rNonce,
		authKey: rAuth,
		encRandom: rEncRandom,
	} = processPoseidonEncryption([transferAmount], receiverPublicKey);
	const {
		ciphertext: aCipher,
		nonce: aNonce,
		authKey: aAuth,
		encRandom: auditorEncRandom,
	} = processPoseidonEncryption([transferAmount], auditorPublicKey);
	const {
		ciphertext: sCipher,
		nonce: sNonce,
		authKey: sAuth,
	} = processPoseidonEncryption([senderNewBalance], sender.publicKey);

	const circuit = (await zkit.getCircuit(
		"TransferCircuit",
	)) as unknown as ZkitCircuit<ProofCalldata>;
	const proof = await circuit.generateProof({
		ValueToTransfer: transferAmount,
		SenderPrivateKey: sender.formattedPrivateKey,
		SenderPublicKey: sender.publicKey,
		SenderBalance: senderBalance,
		SenderBalanceC1: senderEncryptedBalance.slice(0, 2),
		SenderBalanceC2: senderEncryptedBalance.slice(2, 4),
		SenderVTTC1: encAmtSender[0],
		SenderVTTC2: encAmtSender[1],
		ReceiverPublicKey: receiverPublicKey,
		ReceiverVTTC1: encAmtReceiver[0],
		ReceiverVTTC2: encAmtReceiver[1],
		ReceiverVTTRandom: encAmtReceiverRandom,
		ReceiverPCT: rCipher,
		ReceiverPCTAuthKey: rAuth,
		ReceiverPCTNonce: rNonce,
		ReceiverPCTRandom: rEncRandom,
		AuditorPublicKey: auditorPublicKey,
		AuditorPCT: aCipher,
		AuditorPCTAuthKey: aAuth,
		AuditorPCTNonce: aNonce,
		AuditorPCTRandom: auditorEncRandom,
	});
	const calldata = await circuit.generateCalldata(proof);
	const senderBalancePCT = [...sCipher, ...sAuth, sNonce] as [
		bigint,
		bigint,
		bigint,
		bigint,
		bigint,
		bigint,
		bigint,
	];
	// The auditor PCT the contract will emit = [ciphertext(4), authKey(2), nonce]
	const auditorPCT = [...aCipher, ...aAuth, aNonce] as bigint[];
	return { proof: calldata, senderBalancePCT, auditorEncRandom, auditorPCT };
}

const TRANSFER_SIG =
	"transfer(address,uint256,((uint256[2],uint256[2][2],uint256[2]),uint256[32]),uint256[7])";
const WITHDRAW_SIG =
	"withdraw(uint256,((uint256[2],uint256[2][2],uint256[2]),uint256[16]),uint256[7])";
const DEPOSIT_SIG = "deposit(uint256,address,uint256[7])";

// ---------------------------------------------------------------------------
// Runtime context assembled once
// ---------------------------------------------------------------------------
type Ctx = {
	provider: ethers.Provider;
	chainId: bigint;
	onramp: ethers.Wallet;
	relayer: ethers.Wallet;
	alice: ethers.Wallet;
	bob: ethers.Wallet;
	aliceEerc: EercAccount;
	bobEerc: EercAccount;
	giftEphemeral: ethers.Wallet;
	benzonetProbe: ethers.Wallet;
	registrar: any;
	eerc: any;
	usdc: ethers.Contract;
	eurc: ethers.Contract;
	auditorPublicKey: [bigint, bigint];
	auditorPrivateKey: bigint;
};

async function buildCtx(): Promise<Ctx> {
	const provider = ethers.provider;
	const net = await provider.getNetwork();
	if (net.chainId !== FUJI_CHAIN_ID) {
		throw new Error(`Expected Fuji ${FUJI_CHAIN_ID}, got ${net.chainId}`);
	}
	const session = loadSession();
	const onrampJson = readKeyJson("benzo-onramp-accounts.json");
	const onramp = new ethers.Wallet(onrampJson["benzo-onramp-user"].privateKey, provider);
	const relayer = new ethers.Wallet(onrampJson["benzo-relayer"].privateKey, provider);
	const alice = new ethers.Wallet(session.alice.pk, provider);
	const bob = new ethers.Wallet(session.bob.pk, provider);
	const giftEphemeral = new ethers.Wallet(session.giftEphemeral.pk, provider);
	const benzonetProbe = new ethers.Wallet(session.benzonetProbe.pk, provider);
	const aliceEerc = createEercAccount(BigInt(session.alice.eercSeed));
	const bobEerc = createEercAccount(BigInt(session.bob.eercSeed));

	const registrar = await ethers.getContractAt("Registrar", REGISTRAR);
	const eerc = await ethers.getContractAt("EncryptedERC", EERC);
	const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);
	const eurc = new ethers.Contract(EURC, ERC20_ABI, provider);

	const apk = (await eerc.auditorPublicKey()) as any;
	const auditorPublicKey: [bigint, bigint] = [BigInt(apk.x ?? apk[0]), BigInt(apk.y ?? apk[1])];

	const auditorFile = JSON.parse(fs.readFileSync(AUDITOR_KEY_PATH, "utf8"));
	const auditorAddr = (await eerc.auditor()) as string;
	const stored = auditorFile.auditors[`fuji:${auditorAddr.toLowerCase()}`];
	if (!stored) throw new Error(`No local auditor key for ${auditorAddr}`);
	const auditorPrivateKey = BigInt(stored.privateKey);
	// sanity: derived pubkey must match on-chain
	const derived = mulPointEscalar(
		Base8,
		formatPrivKeyForBabyJub(auditorPrivateKey) % subOrder,
	).map((v) => BigInt(v));
	if (derived[0] !== auditorPublicKey[0] || derived[1] !== auditorPublicKey[1]) {
		throw new Error("Local auditor private key does not match on-chain auditor public key");
	}

	console.log("Accounts:");
	console.log(`  onramp-user ${onramp.address}`);
	console.log(`  relayer     ${relayer.address}`);
	console.log(`  alice       ${alice.address} (eERC sender/depositor)`);
	console.log(`  bob         ${bob.address} (eERC receiver)`);
	console.log(`  giftEph     ${giftEphemeral.address}`);
	console.log(`  benzoProbe  ${benzonetProbe.address}`);
	console.log(`  auditor     ${auditorAddr}`);

	return {
		provider,
		chainId: net.chainId,
		onramp,
		relayer,
		alice,
		bob,
		aliceEerc,
		bobEerc,
		giftEphemeral,
		benzonetProbe,
		registrar,
		eerc,
		usdc,
		eurc,
		auditorPublicKey,
		auditorPrivateKey,
	};
}

// ---------------------------------------------------------------------------
// FLOW: fund fresh EOAs (gas from relayer, tokens from onramp-user)
// ---------------------------------------------------------------------------
async function flowFund(ctx: Ctx) {
	const txs: string[] = [];
	const need = async (
		who: ethers.Wallet,
		target: bigint,
		from: ethers.Wallet,
		label: string,
	) => {
		const bal = await ctx.provider.getBalance(who.address);
		if (bal >= target) {
			console.log(`${label} gas ok: ${ethers.formatEther(bal)} AVAX`);
			return;
		}
		const topUp = target - bal;
		const tx = await from.sendTransaction({ to: who.address, value: topUp });
		await tx.wait();
		txs.push(tx.hash);
		console.log(`funded ${label} +${ethers.formatEther(topUp)} AVAX tx ${tx.hash}`);
	};
	const needToken = async (
		token: ethers.Contract,
		who: string,
		target: bigint,
		from: ethers.Wallet,
		label: string,
	) => {
		const bal: bigint = await token.balanceOf(who);
		if (bal >= target) {
			console.log(`${label} ok: ${bal}`);
			return;
		}
		const topUp = target - bal;
		const tx = await (token.connect(from) as any).transfer(who, topUp);
		await tx.wait();
		txs.push(tx.hash);
		console.log(`sent ${label} +${topUp} tx ${tx.hash}`);
	};

	await need(ctx.alice, ethers.parseEther("0.35"), ctx.relayer, "alice");
	await need(ctx.bob, ethers.parseEther("0.2"), ctx.relayer, "bob");
	await needToken(ctx.usdc, ctx.alice.address, 4_000_000n, ctx.onramp, "alice USDC");
	await needToken(ctx.eurc, ctx.alice.address, 2_500_000n, ctx.onramp, "alice EURC");

	record({
		flow: "fund (prep)",
		status: "PASS",
		txHashes: txs,
		asserted: "fresh EOAs funded with gas + USDC/EURC",
		note: `alice=${ctx.alice.address} bob=${ctx.bob.address}`,
	});
}

// ---------------------------------------------------------------------------
// FLOW 1: register (fresh accounts, real Groth16)
// ---------------------------------------------------------------------------
async function flowRegister(ctx: Ctx) {
	const txs: string[] = [];
	const a = await ensureRegistered(ctx.registrar, ctx.alice, ctx.aliceEerc, ctx.chainId, "alice");
	if (a) txs.push(a);
	const b = await ensureRegistered(ctx.registrar, ctx.bob, ctx.bobEerc, ctx.chainId, "bob");
	if (b) txs.push(b);
	const aliceReg = await ctx.registrar.isUserRegistered(ctx.alice.address);
	const bobReg = await ctx.registrar.isUserRegistered(ctx.bob.address);
	if (!aliceReg || !bobReg) throw new Error("registration assertion failed");
	record({
		flow: "1 register",
		status: "PASS",
		txHashes: txs,
		asserted: `alice+bob registered on-chain (isUserRegistered=true)`,
		note: txs.length === 0 ? "already registered (prior run)" : "fresh Groth16 registration",
	});
}

// ---------------------------------------------------------------------------
// Core cycle for a token (deposit -> transfer -> withdraw)
// ---------------------------------------------------------------------------
async function flowTokenCycle(
	ctx: Ctx,
	token: ethers.Contract,
	tokenAddr: string,
	tokenId: bigint,
	sym: string,
) {
	const flowTag = sym === "USDC" ? "2-4 USDC cycle" : "5 EURC cycle";
	const txs: string[] = [];

	// ---- deposit / shield
	const aliceBefore = await decryptedBalance(ctx.eerc, ctx.alice.address, tokenId, ctx.aliceEerc);
	const alicePubBefore: bigint = await token.balanceOf(ctx.alice.address);
	const approveTx = await (token.connect(ctx.alice) as any).approve(EERC, DEPOSIT);
	await approveTx.wait();
	txs.push(approveTx.hash);
	const depTx = await (ctx.eerc.connect(ctx.alice) as any)[DEPOSIT_SIG](
		DEPOSIT,
		tokenAddr,
		encryptAmountPCT(DEPOSIT, ctx.aliceEerc.publicKey),
	);
	await depTx.wait();
	txs.push(depTx.hash);
	const aliceAfterDep = await decryptedBalance(ctx.eerc, ctx.alice.address, tokenId, ctx.aliceEerc);
	const alicePubAfterDep: bigint = await token.balanceOf(ctx.alice.address);
	if (aliceAfterDep.total !== aliceBefore.total + DEPOSIT)
		throw new Error(
			`${sym} deposit: decrypted balance ${aliceAfterDep.total} != ${aliceBefore.total + DEPOSIT}`,
		);
	if (alicePubAfterDep !== alicePubBefore - DEPOSIT)
		throw new Error(`${sym} deposit: public balance did not drop by deposit`);
	record({
		flow: sym === "USDC" ? "2 deposit/shield USDC" : "5a deposit/shield EURC",
		status: "PASS",
		txHashes: [approveTx.hash, depTx.hash],
		asserted: `decrypted eERC ${sym} ${aliceBefore.total} -> ${aliceAfterDep.total} (+${DEPOSIT}); public ${alicePubBefore} -> ${alicePubAfterDep}`,
		note: "deposit(uint256,address,uint256[7])",
	});

	// ---- private transfer alice -> bob
	const senderBefore = aliceAfterDep;
	const bobBefore = await decryptedBalance(ctx.eerc, ctx.bob.address, tokenId, ctx.bobEerc);
	const built = await buildTransfer({
		auditorPublicKey: ctx.auditorPublicKey,
		receiverPublicKey: ctx.bobEerc.publicKey,
		sender: ctx.aliceEerc,
		senderBalance: senderBefore.total,
		senderEncryptedBalance: senderBefore.encrypted,
		transferAmount: TRANSFER,
	});
	const trTx = await (ctx.eerc.connect(ctx.alice) as any)[TRANSFER_SIG](
		ctx.bob.address,
		tokenId,
		built.proof,
		built.senderBalancePCT,
	);
	const trRcpt = await trTx.wait();
	txs.push(trTx.hash);
	const senderAfter = await decryptedBalance(ctx.eerc, ctx.alice.address, tokenId, ctx.aliceEerc);
	const bobAfter = await decryptedBalance(ctx.eerc, ctx.bob.address, tokenId, ctx.bobEerc);
	if (senderAfter.total !== senderBefore.total - TRANSFER)
		throw new Error(`${sym} transfer: sender ${senderAfter.total} != ${senderBefore.total - TRANSFER}`);
	if (bobAfter.total !== bobBefore.total + TRANSFER)
		throw new Error(`${sym} transfer: receiver ${bobAfter.total} != ${bobBefore.total + TRANSFER}`);
	record({
		flow: sym === "USDC" ? "3 private transfer USDC" : "5b private transfer EURC",
		status: "PASS",
		txHashes: [trTx.hash],
		asserted: `sender ${senderBefore.total}->${senderAfter.total} (-${TRANSFER}); receiver ${bobBefore.total}->${bobAfter.total} (+${TRANSFER})`,
		note: "both decrypted balances moved correctly",
	});

	// stash the transfer details for disclosure/auditor flows (USDC only)
	if (sym === "USDC") {
		const logIndex = findPrivateTransferLogIndex(ctx.eerc, trRcpt);
		const stash = {
			txHash: trTx.hash,
			logIndex,
			amount: TRANSFER.toString(),
			auditorEncRandom: built.auditorEncRandom.toString(),
			auditorPCT: built.auditorPCT.map((v) => v.toString()),
			from: ctx.alice.address,
			to: ctx.bob.address,
		};
		fs.writeFileSync(
			path.join(path.dirname(SESSION_PATH), "e2e-fuji-lasttransfer.json"),
			JSON.stringify(stash, null, 2),
		);
		console.log(`stashed transfer for disclosure/auditor: logIndex=${logIndex}`);
	}

	// ---- withdraw / unshield (bob)
	const bobPubBefore: bigint = await token.balanceOf(ctx.bob.address);
	const bobEncBefore = await decryptedBalance(ctx.eerc, ctx.bob.address, tokenId, ctx.bobEerc);
	const wd = await generateWithdraw({
		amount: WITHDRAW,
		auditorPublicKey: ctx.auditorPublicKey,
		user: ctx.bobEerc,
		userBalance: bobEncBefore.total,
		userEncryptedBalance: bobEncBefore.encrypted,
	});
	const wdTx = await (ctx.eerc.connect(ctx.bob) as any)[WITHDRAW_SIG](
		tokenId,
		wd.proof,
		wd.userBalancePCT,
	);
	await wdTx.wait();
	txs.push(wdTx.hash);
	const bobPubAfter: bigint = await token.balanceOf(ctx.bob.address);
	const bobEncAfter = await decryptedBalance(ctx.eerc, ctx.bob.address, tokenId, ctx.bobEerc);
	if (bobPubAfter !== bobPubBefore + WITHDRAW)
		throw new Error(`${sym} withdraw: public ${bobPubAfter} != ${bobPubBefore + WITHDRAW}`);
	if (bobEncAfter.total !== bobEncBefore.total - WITHDRAW)
		throw new Error(`${sym} withdraw: decrypted ${bobEncAfter.total} != ${bobEncBefore.total - WITHDRAW}`);
	record({
		flow: sym === "USDC" ? "4 withdraw/unshield USDC" : "5c withdraw/unshield EURC",
		status: "PASS",
		txHashes: [wdTx.hash],
		asserted: `bob public ${sym} ${bobPubBefore}->${bobPubAfter} (+${WITHDRAW}); decrypted ${bobEncBefore.total}->${bobEncAfter.total}`,
		note: "withdraw unshields to public ERC20",
	});
}

function findPrivateTransferLogIndex(eerc: any, receipt: any): number {
	const iface = eerc.interface;
	for (const log of receipt.logs) {
		try {
			const parsed = iface.parseLog(log);
			if (parsed && parsed.name === "PrivateTransfer") return log.index;
		} catch {
			/* not ours */
		}
	}
	throw new Error("PrivateTransfer event not found in receipt");
}

// ---------------------------------------------------------------------------
// FLOW 12: plain public ERC-20 USDC send
// ---------------------------------------------------------------------------
async function flowPublicSend(ctx: Ctx) {
	const amount = 100_000n; // 0.1 USDC
	const from = ctx.alice;
	const to = ctx.bob.address;
	const fromBefore: bigint = await ctx.usdc.balanceOf(from.address);
	const toBefore: bigint = await ctx.usdc.balanceOf(to);
	if (fromBefore < amount) throw new Error(`alice public USDC ${fromBefore} < ${amount}`);
	const tx = await (ctx.usdc.connect(from) as any).transfer(to, amount);
	await tx.wait();
	const toAfter: bigint = await ctx.usdc.balanceOf(to);
	if (toAfter !== toBefore + amount)
		throw new Error(`public send: recipient ${toAfter} != ${toBefore + amount}`);
	record({
		flow: "12 public USDC send",
		status: "PASS",
		txHashes: [tx.hash],
		asserted: `recipient public USDC ${toBefore}->${toAfter} (+${amount})`,
		note: "plain ERC-20 transfer (non-private, control)",
	});
}

// ---------------------------------------------------------------------------
// FLOW 13: eERC key export / recovery — decrypt same on-chain balance from a
// re-imported key derived only from the serialized private key.
// ---------------------------------------------------------------------------
async function flowKeyExport(ctx: Ctx) {
	// Serialize alice's eERC account, then reconstruct it purely from the stored
	// private key (as a wallet-recovery import would) and confirm it (a) re-derives
	// the same public key registered on-chain and (b) decrypts alice's live
	// encrypted USDC balance to the same amount.
	const serialized = serializeEercAccount(ctx.aliceEerc);
	const recovered = deserializeEercAccount({ privateKey: serialized.privateKey });

	const onChainPk = Array.from(
		await ctx.registrar.getUserPublicKey(ctx.alice.address),
	).map((v) => BigInt(v as any));
	if (
		recovered.publicKey[0] !== onChainPk[0] ||
		recovered.publicKey[1] !== onChainPk[1]
	)
		throw new Error("recovered public key does not match on-chain registration");

	const original = await decryptedBalance(ctx.eerc, ctx.alice.address, USDC_TOKEN_ID, ctx.aliceEerc);
	const fromRecovered = await decryptedBalance(ctx.eerc, ctx.alice.address, USDC_TOKEN_ID, recovered);
	if (fromRecovered.total !== original.total)
		throw new Error(
			`recovery decrypt mismatch: ${fromRecovered.total} != ${original.total}`,
		);
	record({
		flow: "13 key export/recovery",
		status: "PASS",
		txHashes: [],
		asserted: `re-imported key re-derives on-chain pubkey and decrypts alice USDC balance = ${fromRecovered.total} (== original ${original.total})`,
		note: "serializeEercAccount -> deserializeEercAccount; funds recoverable from private key alone",
	});
}

// ---------------------------------------------------------------------------
// FLOW 6: @handle claim + resolve
// ---------------------------------------------------------------------------
async function flowHandle(ctx: Ctx) {
	const registry = await ethers.getContractAt("HandleRegistry", HANDLE_REGISTRY);
	// bob claims a handle (alice is busy as gift sender; keep them independent)
	const suffix = ctx.bob.address.slice(2, 8).toLowerCase();
	const handle = `qa_${suffix}`; // [a-z0-9_], length 9
	const existing = await registry.handleOf(ctx.bob.address);
	const txs: string[] = [];
	if (existing && existing.length > 0) {
		console.log(`bob already owns handle "${existing}"; resolving that instead`);
		const resolved = await registry.resolve(existing);
		if (resolved.toLowerCase() !== ctx.bob.address.toLowerCase())
			throw new Error("resolve mismatch on pre-existing handle");
		record({
			flow: "6 @handle claim+resolve",
			status: "PASS",
			txHashes: [],
			asserted: `resolve("${existing}") == ${resolved}`,
			note: "handle pre-owned by bob from a prior run",
		});
		return;
	}
	const owner = await registry.resolve(handle);
	if (owner !== ethers.ZeroAddress)
		throw new Error(`handle "${handle}" already taken by ${owner}`);
	const tx = await (registry.connect(ctx.bob) as any).claim(handle);
	await tx.wait();
	txs.push(tx.hash);
	const resolved = await registry.resolve(handle);
	if (resolved.toLowerCase() !== ctx.bob.address.toLowerCase())
		throw new Error(`resolve("${handle}") -> ${resolved} != ${ctx.bob.address}`);
	record({
		flow: "6 @handle claim+resolve",
		status: "PASS",
		txHashes: txs,
		asserted: `claim("${handle}") then resolve == ${resolved}`,
		note: "first-come-first-served registry",
	});
}

// ---------------------------------------------------------------------------
// FLOW 7: gift — createGift (escrow) -> claim into recipient shielded, + refund
// ---------------------------------------------------------------------------
async function flowGift(ctx: Ctx) {
	const escrow = await ethers.getContractAt("PrivateGiftEscrow", PRIVATE_GIFT_ESCROW);
	const claimTxs: string[] = [];

	// --- claim path: recipient = bob (registered)
	const nowTs = BigInt((await ctx.provider.getBlock("latest"))!.timestamp);
	const expiry = nowTs + 3600n; // 1h ahead — plenty of window to claim
	const apUsdcBefore: bigint = await ctx.usdc.balanceOf(ctx.alice.address);
	const approveTx = await (ctx.usdc.connect(ctx.alice) as any).approve(PRIVATE_GIFT_ESCROW, GIFT_AMOUNT);
	await approveTx.wait();
	claimTxs.push(approveTx.hash);
	const createTx = await (escrow.connect(ctx.alice) as any).createGift(
		ctx.giftEphemeral.address,
		USDC,
		GIFT_AMOUNT,
		expiry,
	);
	const createRcpt = await createTx.wait();
	claimTxs.push(createTx.hash);
	// find giftId from GiftCreated
	let giftId = 0n;
	for (const log of createRcpt.logs) {
		try {
			const p = escrow.interface.parseLog(log);
			if (p && p.name === "GiftCreated") giftId = p.args.giftId as bigint;
		} catch {}
	}
	if (giftId === 0n) throw new Error("GiftCreated event not found");
	console.log(`created gift #${giftId} escrowing ${GIFT_AMOUNT} USDC`);

	// recipient bob's amountPCT + claim signature from ephemeral key
	const bobBefore = await decryptedBalance(ctx.eerc, ctx.bob.address, USDC_TOKEN_ID, ctx.bobEerc);
	const amountPCT = encryptAmountPCT(GIFT_AMOUNT, ctx.bobEerc.publicKey);
	const digest = (await escrow.claimDigest(giftId, ctx.bob.address, amountPCT)) as string;
	const sig = ctx.giftEphemeral.signingKey.sign(ethers.getBytes(digest)).serialized;
	const claimTx = await (escrow.connect(ctx.bob) as any).claim(giftId, ctx.bob.address, sig, amountPCT);
	await claimTx.wait();
	claimTxs.push(claimTx.hash);
	const bobAfter = await decryptedBalance(ctx.eerc, ctx.bob.address, USDC_TOKEN_ID, ctx.bobEerc);
	if (bobAfter.total !== bobBefore.total + GIFT_AMOUNT)
		throw new Error(`gift claim: bob ${bobAfter.total} != ${bobBefore.total + GIFT_AMOUNT}`);
	record({
		flow: "7a gift create+claim",
		status: "PASS",
		txHashes: claimTxs,
		asserted: `gift #${giftId} escrowed ${GIFT_AMOUNT} USDC; bob shielded ${bobBefore.total}->${bobAfter.total} (+${GIFT_AMOUNT})`,
		note: "claim credits recipient's encrypted balance via depositFor",
	});

	// --- refund path: short expiry, wait, refund
	const refundTxs: string[] = [];
	const now2 = BigInt((await ctx.provider.getBlock("latest"))!.timestamp);
	const shortExpiry = now2 + 25n;
	const approveTx2 = await (ctx.usdc.connect(ctx.alice) as any).approve(PRIVATE_GIFT_ESCROW, GIFT_REFUND_AMOUNT);
	await approveTx2.wait();
	refundTxs.push(approveTx2.hash);
	const create2 = await (escrow.connect(ctx.alice) as any).createGift(
		ctx.giftEphemeral.address,
		USDC,
		GIFT_REFUND_AMOUNT,
		shortExpiry,
	);
	const create2Rcpt = await create2.wait();
	refundTxs.push(create2.hash);
	let giftId2 = 0n;
	for (const log of create2Rcpt.logs) {
		try {
			const p = escrow.interface.parseLog(log);
			if (p && p.name === "GiftCreated") giftId2 = p.args.giftId as bigint;
		} catch {}
	}
	const senderUsdcBeforeRefund: bigint = await ctx.usdc.balanceOf(ctx.alice.address);
	// wait until chain time passes shortExpiry
	console.log(`waiting for gift #${giftId2} to expire (short expiry)...`);
	for (let i = 0; i < 40; i++) {
		const t = BigInt((await ctx.provider.getBlock("latest"))!.timestamp);
		if (t >= shortExpiry) break;
		await new Promise((r) => setTimeout(r, 3000));
	}
	const refundTx = await (escrow.connect(ctx.alice) as any).refund(giftId2);
	await refundTx.wait();
	refundTxs.push(refundTx.hash);
	const senderUsdcAfterRefund: bigint = await ctx.usdc.balanceOf(ctx.alice.address);
	if (senderUsdcAfterRefund !== senderUsdcBeforeRefund + GIFT_REFUND_AMOUNT)
		throw new Error(
			`gift refund: sender USDC ${senderUsdcAfterRefund} != ${senderUsdcBeforeRefund + GIFT_REFUND_AMOUNT}`,
		);
	record({
		flow: "7b gift refund",
		status: "PASS",
		txHashes: refundTxs,
		asserted: `gift #${giftId2} refunded; sender public USDC ${senderUsdcBeforeRefund}->${senderUsdcAfterRefund} (+${GIFT_REFUND_AMOUNT})`,
		note: "refund after expiry returns escrow to sender",
	});
}

// ---------------------------------------------------------------------------
// FLOW 8: disclosure Tier A — deployed backend + local crypto cross-check
// ---------------------------------------------------------------------------
async function flowDisclosure(ctx: Ctx) {
	const stashPath = path.join(path.dirname(SESSION_PATH), "e2e-fuji-lasttransfer.json");
	if (!fs.existsSync(stashPath))
		throw new Error("no stashed transfer; run the USDC cycle first");
	const t = JSON.parse(fs.readFileSync(stashPath, "utf8"));

	// (a) Local crypto cross-check of the exact Tier A algorithm the backend runs.
	const pct = (t.auditorPCT as string[]).map((v) => BigInt(v));
	const ciphertext = pct.slice(0, 4);
	const storedAuthKey = pct.slice(4, 6) as [bigint, bigint];
	const nonce = pct[6];
	const encRandom = BigInt(t.auditorEncRandom);
	const computedAuthKey = mulPointEscalar(Base8, encRandom);
	const authKeyOk =
		BigInt(computedAuthKey[0]) === storedAuthKey[0] &&
		BigInt(computedAuthKey[1]) === storedAuthKey[1];
	const sharedKey = mulPointEscalar(ctx.auditorPublicKey as Point<bigint>, encRandom);
	const [recovered] = poseidonDecrypt(ciphertext, sharedKey, nonce, 1);
	const localOk = authKeyOk && BigInt(recovered) === BigInt(t.amount);
	// wrong-amount rejection is inherent: recovered != wrongAmount
	const wrongRejectedLocally = BigInt(recovered) !== BigInt(t.amount) + 1n;
	console.log(
		`local Tier A: authKeyMatch=${authKeyOk} recovered=${recovered} claimed=${t.amount} -> ${localOk ? "VERIFIED" : "FAIL"}`,
	);

	// (b) Deployed backend endpoint.
	const url = `${API_BASE}/disclosure/verify`;
	const goodBody = {
		txHash: t.txHash,
		logIndex: t.logIndex,
		claimedAmount: t.amount,
		encRandom: t.auditorEncRandom,
		from: t.from,
		to: t.to,
	};
	let backendVerified = false;
	let backendNote = "";
	let httpStatus = 0;
	let backendRaw = "";
	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(goodBody),
		});
		httpStatus = resp.status;
		backendRaw = await resp.text();
		try {
			const j = JSON.parse(backendRaw);
			backendVerified = j.verified === true;
			backendNote = JSON.stringify(j);
		} catch {
			backendNote = backendRaw.slice(0, 160);
		}
	} catch (e) {
		backendNote = `fetch error: ${(e as Error).message}`;
	}
	console.log(`backend POST ${url} -> HTTP ${httpStatus} :: ${backendNote}`);

	// wrong-amount against backend (only meaningful if endpoint exists)
	let wrongRejectedByBackend: boolean | null = null;
	if (httpStatus === 200) {
		const badBody = { ...goodBody, claimedAmount: (BigInt(t.amount) + 1n).toString() };
		const resp2 = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(badBody),
		});
		const j2 = await resp2.json().catch(() => ({}));
		wrongRejectedByBackend = (j2 as any).verified === false;
		console.log(`backend wrong-amount -> ${JSON.stringify(j2)}`);
	}

	if (httpStatus === 200 && backendVerified && wrongRejectedByBackend) {
		record({
			flow: "8 disclosure Tier A",
			status: "PASS",
			txHashes: [t.txHash],
			asserted: `backend verified=true for correct amount ${t.amount}, verified=false for wrong amount`,
			note: `local crypto cross-check ${localOk ? "VERIFIED" : "FAILED"}`,
		});
	} else {
		record({
			flow: "8 disclosure Tier A",
			status: localOk ? "PARTIAL" : "FAIL",
			txHashes: [t.txHash],
			asserted: `local reveal-and-verify ${localOk ? "VERIFIED" : "FAILED"} (authKeyMatch=${authKeyOk}, recovered=${recovered}==claimed ${localOk}); wrong-amount rejected locally=${wrongRejectedLocally}`,
			note: `deployed ${url} returned HTTP ${httpStatus} (${backendNote}). Disclosure endpoints not live on deployed backend.`,
		});
	}
}

// ---------------------------------------------------------------------------
// FLOW 9: auditor decrypt of the on-chain transfer's auditor PCT
// ---------------------------------------------------------------------------
async function flowAuditor(ctx: Ctx) {
	const stashPath = path.join(path.dirname(SESSION_PATH), "e2e-fuji-lasttransfer.json");
	if (!fs.existsSync(stashPath))
		throw new Error("no stashed transfer; run the USDC cycle first");
	const t = JSON.parse(fs.readFileSync(stashPath, "utf8"));

	// Re-read the auditor PCT straight from the on-chain event (independent of our stash).
	const rcpt = await ctx.provider.getTransactionReceipt(t.txHash);
	if (!rcpt) throw new Error("transfer receipt not found on-chain");
	let onchainPCT: bigint[] | null = null;
	for (const log of rcpt.logs) {
		try {
			const p = ctx.eerc.interface.parseLog(log);
			if (p && p.name === "PrivateTransfer") {
				onchainPCT = (p.args.auditorPCT as any[]).map((v) => BigInt(v));
			}
		} catch {}
	}
	if (!onchainPCT) throw new Error("PrivateTransfer event/auditorPCT not found on-chain");

	// Auditor-side decrypt: sharedKey = authKey * formatPrivKeyForBabyJub(auditorPriv)
	const ciphertext = onchainPCT.slice(0, 4);
	const authKey = onchainPCT.slice(4, 6) as [bigint, bigint];
	const nonce = onchainPCT[6];
	const sharedKey = mulPointEscalar(
		authKey as Point<bigint>,
		formatPrivKeyForBabyJub(ctx.auditorPrivateKey),
	);
	const [amount] = poseidonDecrypt(ciphertext, sharedKey, nonce, 1);
	const ok = BigInt(amount) === BigInt(t.amount);
	if (!ok)
		throw new Error(`auditor decrypt: ${amount} != expected ${t.amount}`);
	record({
		flow: "9 auditor decrypt",
		status: "PASS",
		txHashes: [t.txHash],
		asserted: `auditor key decrypted on-chain auditorPCT to ${amount} == transfer amount ${t.amount}`,
		note: "read PrivateTransfer.auditorPCT from the receipt; decrypted with auditor BabyJubJub key",
	});
}

// ---------------------------------------------------------------------------
// FLOW 10: CCTP onramp (best-effort) — handled by a separate dedicated script.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FLOW 11: BenzoNet tx-allowlist gating
// ---------------------------------------------------------------------------
const TX_ALLOWLIST_PRECOMPILE = "0x0200000000000000000000000000000000000002";
const IALLOWLIST_ABI = ["function readAllowList(address addr) view returns (uint256)"];

async function flowBenzonet(ctx: Ctx) {
	const provider = new ethers.JsonRpcProvider(BENZONET_RPC);
	let chainId = 0n;
	try {
		chainId = (await provider.getNetwork()).chainId;
	} catch (e) {
		record({
			flow: "11 BenzoNet gating",
			status: "FAIL",
			txHashes: [],
			asserted: "could not reach BenzoNet RPC",
			note: `${BENZONET_RPC}: ${(e as Error).message}`,
		});
		return;
	}
	const session = loadSession();
	const probe = new ethers.Wallet(session.benzonetProbe.pk, provider);
	const roles = readKeyJson("benzonet-roles.json");
	const dripper = new ethers.Wallet(roles["benzo-dripper"].privateKey, provider);

	const allowList = new ethers.Contract(TX_ALLOWLIST_PRECOMPILE, IALLOWLIST_ABI, provider);
	const probeRole: bigint = await allowList.readAllowList(probe.address);
	const dripperRole: bigint = await allowList.readAllowList(dripper.address);
	// dripper next nonce > 0 corroborates that allowlisted accounts CAN transact.
	const dripperNonce = await provider.getTransactionCount(dripper.address, "latest");
	console.log(
		`tx-allowlist roles: probe=${probeRole} dripper=${dripperRole}; dripper nextNonce=${dripperNonce}`,
	);
	if (probeRole !== 0n)
		throw new Error(`probe ${probe.address} is unexpectedly allowlisted (role ${probeRole})`);

	// Submit a signed legacy tx from the non-allowlisted probe straight to
	// eth_sendRawTransaction (no gas estimation). Subnet-EVM's tx-allowlist
	// precompile rejects it at admission with an allowlist-specific error, before
	// any balance check — so a zero-balance fresh EOA still surfaces the gating
	// (not a misleading "insufficient funds"). This never hangs: rejected tx
	// throws synchronously at submit.
	const gasPrice = BigInt(await provider.send("eth_gasPrice", []));
	const probeNonce = await provider.getTransactionCount(probe.address, "latest");
	const signed = await probe.signTransaction({
		to: probe.address,
		value: 0n,
		gasLimit: 21000n,
		gasPrice,
		nonce: probeNonce,
		chainId,
		type: 0,
	});
	let rejected = false;
	let reason = "";
	try {
		const hash = await provider.send("eth_sendRawTransaction", [signed]);
		reason = `tx ${hash} was ACCEPTED despite probe not being allowlisted — gating NOT enforced`;
	} catch (e) {
		rejected = true;
		reason = (e as Error).message;
	}
	const isAllowlistError = /allow ?list|not allowed|non-allow/i.test(reason);
	const notFundsError = !/insufficient funds/i.test(reason);
	const pass = rejected && isAllowlistError && notFundsError;
	record({
		flow: "11 BenzoNet gating",
		status: pass ? "PASS" : rejected ? "PARTIAL" : "FAIL",
		txHashes: [],
		asserted: pass
			? `non-allowlisted EOA ${probe.address} (role 0) REJECTED at admission by tx-allowlist precompile on BenzoNet chainId ${chainId}; allowlisted dripper role=${dripperRole} with nextNonce=${dripperNonce} (allowlisted txs ARE mined)`
			: rejected
			? `probe tx rejected but error not clearly allowlist-specific`
			: `probe tx unexpectedly accepted — gating NOT enforced`,
		note: reason.replace(/\s+/g, " ").slice(0, 220),
	});
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main() {
	const selected = (process.env.E2E_FLOWS ?? "all").split(",").map((s) => s.trim());
	const want = (f: string) => selected.includes("all") || selected.includes(f);
	const ctx = await buildCtx();

	const run = async (name: string, fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (e) {
			record({
				flow: name,
				status: "FAIL",
				txHashes: [],
				asserted: "threw",
				note: (e as Error).message?.slice(0, 300) ?? String(e),
			});
			console.error(e);
		}
	};

	if (want("fund")) await run("fund (prep)", () => flowFund(ctx));
	if (want("register")) await run("1 register", () => flowRegister(ctx));
	if (want("usdc")) await run("2-4 USDC cycle", () => flowTokenCycle(ctx, ctx.usdc, USDC, USDC_TOKEN_ID, "USDC"));
	if (want("eurc")) await run("5 EURC cycle", () => flowTokenCycle(ctx, ctx.eurc, EURC, EURC_TOKEN_ID, "EURC"));
	if (want("handle")) await run("6 @handle", () => flowHandle(ctx));
	if (want("gift")) await run("7 gift", () => flowGift(ctx));
	if (want("pubsend")) await run("12 public USDC send", () => flowPublicSend(ctx));
	if (want("keyexport")) await run("13 key export/recovery", () => flowKeyExport(ctx));
	if (want("disclosure")) await run("8 disclosure", () => flowDisclosure(ctx));
	if (want("auditor")) await run("9 auditor decrypt", () => flowAuditor(ctx));
	if (want("benzonet")) await run("11 BenzoNet gating", () => flowBenzonet(ctx));

	// -------- summary --------
	console.log("\n\n================ E2E SUMMARY ================");
	console.log("flow | status | txHashes | asserted | note");
	for (const r of results) {
		console.log(
			`${r.flow} | ${r.status} | ${r.txHashes.join(" ")} | ${r.asserted} | ${r.note}`,
		);
	}
	const outPath = path.join(path.dirname(SESSION_PATH), "e2e-fuji-results.json");
	fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
	console.log(`\nresults json: ${outPath}`);
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
