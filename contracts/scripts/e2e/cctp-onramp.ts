/**
 * FLOW 10 — CCTP onramp (best-effort, cross-chain).
 * Burns USDC on OP Sepolia (domain 2) via CCTP V2 depositForBurnWithHook with
 * hookData binding a registered Fuji eERC user, polls Circle Iris for the
 * attestation, then the relayer calls BenzoCCTPRouter.settleDeposit on Fuji to
 * auto-deposit the minted USDC into the user's shielded balance. Asserts the
 * user's decrypted eERC balance increased by the minted amount.
 *
 * Run:
 *   BENZO_ZKIT_FORCE_WASM=1 npx hardhat run scripts/e2e/cctp-onramp.ts --network fuji
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "hardhat";
import {
	type EercAccount,
	type EercBalance,
	createEercAccount,
	encryptAmountPCT,
	getDecryptedBalance,
} from "../deploy/eerc-crypto";

const EERC = "0x9E16eD3B799541B4929f7E2014904C65E81035b1";
const REGISTRAR = "0x9a63FEa9851097DBAf3757b636217fdde50ABaF0";
const ROUTER = "0xbADeF08FE085928c36cF1301CfAa4d8061DA2469";
const FUJI_USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const USDC_TOKEN_ID = 1n;

const OP_RPC = process.env.E2E_OP_RPC ?? "https://sepolia.optimism.io";
const OP_USDC = "0x5fd84259d66Cd46123540766Be93DFE6D43130D7";
const CCTP_TOKEN_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"; // V2 testnet
const OP_SOURCE_DOMAIN = 2;
const FUJI_DEST_DOMAIN = 1;
const IRIS_BASE = "https://iris-api-sandbox.circle.com";

const AMOUNT = 2_000_000n; // 2.0 USDC
const MAX_FEE = 50_000n; // 0.05 USDC ceiling for fast transfer
const MIN_FINALITY_THRESHOLD = 1000; // fast

const SESSION_PATH = path.join(
	"/private/tmp/claude-501/-Users-akshmnd-Dev-Projects-stellar-benzo",
	"e2e-fuji-session.json",
);
const readKeyJson = (f: string) =>
	JSON.parse(fs.readFileSync(path.join(os.homedir(), ".benzo-keys", f), "utf8"));
const SNOW = (h: string) => `https://testnet.snowtrace.io/tx/${h}`;

const ERC20 = [
	"function approve(address,uint256) returns (bool)",
	"function allowance(address,address) view returns (uint256)",
	"function balanceOf(address) view returns (uint256)",
];
const TOKEN_MESSENGER = [
	"function depositForBurnWithHook(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,bytes hookData)",
];

const toBytes32 = (addr: string) => ethers.zeroPadValue(addr, 32);

async function main() {
	const fuji = ethers.provider;
	const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
	const onrampJson = readKeyJson("benzo-onramp-accounts.json");
	const roles = readKeyJson("benzonet-roles.json");

	const opProvider = new ethers.JsonRpcProvider(OP_RPC);
	const opBurner = new ethers.Wallet(onrampJson["benzo-onramp-user"].privateKey, opProvider);
	const relayer = new ethers.Wallet(onrampJson["benzo-relayer"].privateKey, fuji);
	const deployer = new ethers.Wallet(roles["benzo-deployer"].privateKey, fuji);
	const alice = new ethers.Wallet(session.alice.pk, fuji);
	const aliceEerc: EercAccount = createEercAccount(BigInt(session.alice.eercSeed));

	const registrar = await ethers.getContractAt("Registrar", REGISTRAR);
	const eerc = await ethers.getContractAt("EncryptedERC", EERC);
	const router = await ethers.getContractAt("BenzoCCTPRouter", ROUTER);

	console.log(`recipient (Fuji eERC user) = alice ${alice.address}`);
	console.log(`OP burner = onramp-user ${opBurner.address}`);
	console.log(`relayer ${relayer.address}`);

	// preconditions
	if (!(await registrar.isUserRegistered(alice.address)))
		throw new Error("alice must be registered on Fuji eERC first");
	const regPk = Array.from(await registrar.getUserPublicKey(alice.address)).map((v) => BigInt(v as any));
	if (regPk[0] !== aliceEerc.publicKey[0] || regPk[1] !== aliceEerc.publicKey[1])
		throw new Error("alice registered pubkey mismatch");

	// ensure relayer authorized on router (owner = deployer)
	const authorized: boolean = await router.relayers(relayer.address);
	if (!authorized) {
		console.log("relayer not authorized on router; authorizing via owner/deployer...");
		const owner = await router.owner();
		if (owner.toLowerCase() !== deployer.address.toLowerCase())
			throw new Error(`router owner ${owner} is not the deployer key; cannot authorize relayer`);
		const tx = await (router.connect(deployer) as any).setRelayer(relayer.address, true);
		await tx.wait();
		console.log(`setRelayer tx ${tx.hash} ${SNOW(tx.hash)}`);
	} else {
		console.log("relayer already authorized on router");
	}
	if (!(await router.allowedTokens(FUJI_USDC)))
		throw new Error("Fuji USDC not allowed on router");

	// hookData = abi.encode(user, pkX, pkY)
	const hookData = ethers.AbiCoder.defaultAbiCoder().encode(
		["address", "uint256", "uint256"],
		[alice.address, aliceEerc.publicKey[0], aliceEerc.publicKey[1]],
	);

	// ---- 1) burn on OP Sepolia
	const opUsdc = new ethers.Contract(OP_USDC, ERC20, opBurner);
	const opBal: bigint = await opUsdc.balanceOf(opBurner.address);
	console.log(`OP Sepolia USDC balance: ${opBal}`);
	if (opBal < AMOUNT) throw new Error(`OP burner has ${opBal} USDC < ${AMOUNT}`);
	const allowance: bigint = await opUsdc.allowance(opBurner.address, CCTP_TOKEN_MESSENGER);
	if (allowance < AMOUNT) {
		const atx = await opUsdc.approve(CCTP_TOKEN_MESSENGER, AMOUNT);
		await atx.wait();
		console.log(`OP approve tx ${atx.hash}`);
	}
	const tm = new ethers.Contract(CCTP_TOKEN_MESSENGER, TOKEN_MESSENGER, opBurner);
	const burnTx = await tm.depositForBurnWithHook(
		AMOUNT,
		FUJI_DEST_DOMAIN,
		toBytes32(ROUTER),
		OP_USDC,
		ethers.ZeroHash, // destinationCaller = anyone
		MAX_FEE,
		MIN_FINALITY_THRESHOLD,
		hookData,
	);
	const burnRcpt = await burnTx.wait();
	console.log(`BURN on OP Sepolia: ${burnTx.hash} (block ${burnRcpt.blockNumber})`);
	console.log(`  OP explorer: https://sepolia-optimism.etherscan.io/tx/${burnTx.hash}`);

	// ---- 2) poll Iris for attestation
	const irisUrl = `${IRIS_BASE}/v2/messages/${OP_SOURCE_DOMAIN}?transactionHash=${burnTx.hash}`;
	console.log(`polling Iris: ${irisUrl}`);
	let message: string | null = null;
	let attestation: string | null = null;
	const deadline = Date.now() + 15 * 60 * 1000; // 15 min bound
	let lastStatus = "";
	while (Date.now() < deadline) {
		try {
			const resp = await fetch(irisUrl, { headers: { accept: "application/json" } });
			if (resp.status === 404) {
				lastStatus = "404 (not indexed yet)";
			} else if (resp.ok) {
				const j: any = await resp.json();
				const m = j.messages?.[0];
				if (m) {
					lastStatus = m.status;
					if (m.status === "complete" && m.message && m.attestation && m.attestation !== "PENDING") {
						message = m.message;
						attestation = m.attestation;
						break;
					}
				}
			} else {
				lastStatus = `http ${resp.status}`;
			}
		} catch (e) {
			lastStatus = `fetch err ${(e as Error).message}`;
		}
		process.stdout.write(`  iris status=${lastStatus} (waited ${Math.round((Date.now() - (deadline - 15 * 60 * 1000)) / 1000)}s)\n`);
		await new Promise((r) => setTimeout(r, 15000));
	}
	if (!message || !attestation) {
		console.log(
			JSON.stringify({
				flow: "10 CCTP onramp",
				status: "PARTIAL",
				burnTx: burnTx.hash,
				stoppedAt: "iris_attestation_pending",
				lastStatus,
				note: "Burn confirmed on OP Sepolia; Circle Iris had not returned a complete attestation within the 15-min bound. Re-run settle later with the burn tx.",
			}),
		);
		return;
	}
	console.log(`Iris attestation received (message ${message.length} chars)`);

	// mintedAmount = amount - feeExecuted, decoded from the raw message.
	// message body starts at byte 148; within body amount@68, feeExecuted@164.
	const msgHex = message.startsWith("0x") ? message.slice(2) : message;
	const amountHex = msgHex.slice((148 + 68) * 2, (148 + 68 + 32) * 2);
	const feeHex = msgHex.slice((148 + 164) * 2, (148 + 164 + 32) * 2);
	const burnedAmount = BigInt("0x" + amountHex);
	const feeExecuted = BigInt("0x" + feeHex);
	const mintedAmount = burnedAmount - feeExecuted;
	console.log(`decoded: amount=${burnedAmount} feeExecuted=${feeExecuted} mintedAmount=${mintedAmount}`);

	// ---- 3) settle on Fuji
	const decOf = async (acct: EercAccount) => {
		const b = (await eerc.balanceOf(alice.address, USDC_TOKEN_ID)) as EercBalance;
		return getDecryptedBalance(acct.privateKey, b);
	};
	const before = await decOf(aliceEerc);
	const amountPCT = encryptAmountPCT(mintedAmount, aliceEerc.publicKey);
	const settleTx = await (router.connect(relayer) as any).settleDeposit(
		"0x" + msgHex,
		attestation,
		amountPCT,
	);
	const settleRcpt = await settleTx.wait();
	console.log(`SETTLE on Fuji: ${settleTx.hash} (block ${settleRcpt.blockNumber}) ${SNOW(settleTx.hash)}`);
	const after = await decOf(aliceEerc);

	const ok = after === before + mintedAmount;
	console.log(
		JSON.stringify({
			flow: "10 CCTP onramp",
			status: ok ? "PASS" : "FAIL",
			burnTx: burnTx.hash,
			settleTx: settleTx.hash,
			mintedAmount: mintedAmount.toString(),
			aliceShielded: `${before} -> ${after}`,
			asserted: ok
				? `alice shielded USDC increased by mintedAmount ${mintedAmount} (CCTP OP Sepolia -> Fuji auto-deposit)`
				: `MISMATCH: ${after} != ${before}+${mintedAmount}`,
		}),
	);
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
