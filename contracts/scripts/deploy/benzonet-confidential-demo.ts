/**
 * BenzoNet confidential-transfer demo / proof.
 *
 * Runs a REAL end-to-end eERC flow on BenzoNet (Benzo's permissioned Avalanche
 * L1, chain id 68420) using two fresh EOAs this script controls:
 *   register (both) -> sender faucets + deposits tUSDC -> PRIVATE TRANSFER with a
 *   Groth16 proof (amount encrypted on-chain) -> decrypt + assert both balances.
 *
 * The auditor public key is read from the deployed contract (already set on
 * BenzoNet), so the transfer is auditor-compliant without needing the auditor's
 * private key. Prints explorer links to the on-chain deposit + transfer txs —
 * the demonstrable "encrypted amounts on a gated L1" (the Speedrun bonus combo).
 *
 * Run: PRIVATE_KEY=<deployer> PRIVATE_KEY_2=<tx-allowlist Admin, e.g. benzo-ops> \
 *      BENZONET_RPC_URL=https://rpc.benzo.space \
 *      npx hardhat run scripts/deploy/benzonet-confidential-demo.ts --network benzonet
 */
import { ethers } from "hardhat";
import {
	type EercBalance,
	createEercAccount,
	encryptAmountPCT,
	flattenEncryptedBalance,
	generatePrivateTransfer,
	getDecryptedBalance,
	registerEercAccount,
} from "./eerc-crypto";
import { getEercDeploymentRecord, requireDeploymentRecord } from "./eerc-deployments";

const DEPOSIT_AMOUNT = 100_000_000n; // 100 tUSDC (6 dp)
const TRANSFER_AMOUNT = 30_000_000n; // 30 tUSDC
const EXPLORER = "https://explorer.benzo.space";

const assertEq = (label: string, actual: bigint, expected: bigint) => {
	if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
};

async function main() {
	const record = await getEercDeploymentRecord();
	const eercRec = requireDeploymentRecord(record.eercDeployment, ["encryptedERC"]);
	const registrarRec = requireDeploymentRecord(record.eercDeployment, ["registrar"]);
	const usdcRec = requireDeploymentRecord(record.eercDeployment, ["testUSDC"]);

	const provider = ethers.provider;
	const net = await provider.getNetwork();
	const [funder, manager] = await ethers.getSigners();
	console.log(`chainId ${net.chainId} | funder ${funder.address}`);
	if (net.chainId !== 68420n) throw new Error(`expected BenzoNet (68420), got ${net.chainId}`);
	if (manager === undefined) throw new Error("Set PRIVATE_KEY_2 to a tx-allowlist Admin/Manager (e.g. benzo-ops).");

	// Two fresh EOAs so there is never a registration-key clash.
	const senderWallet = ethers.Wallet.createRandom().connect(provider);
	const receiverWallet = ethers.Wallet.createRandom().connect(provider);
	console.log(`sender   EOA ${senderWallet.address}`);
	console.log(`receiver EOA ${receiverWallet.address}`);

	// GATED ACCESS: BenzoNet rejects any tx from a non-allow-listed wallet at the
	// precompile. Enable the two demo wallets from the Admin signer first — the
	// same onboarding step a real permissioned deployment runs before a member's
	// first tx. (A wallet skipped here is rejected on-chain; that is the gate.)
	const txAllowList = await ethers.getContractAt(
		"IAllowList",
		"0x0200000000000000000000000000000000000002",
	);
	for (const w of [senderWallet, receiverWallet]) {
		await (await txAllowList.connect(manager).setEnabled(w.address)).wait();
	}
	console.log("enabled sender + receiver on the tx-allowlist (gated access)");

	for (const w of [senderWallet, receiverWallet]) {
		await (await funder.sendTransaction({ to: w.address, value: ethers.parseEther("2") })).wait();
	}

	const registrar = await ethers.getContractAt("Registrar", registrarRec.address);
	const eerc = await ethers.getContractAt("EncryptedERC", eercRec.address);
	const usdc = await ethers.getContractAt("TestUSDC", usdcRec.address);

	const senderAcct = createEercAccount();
	const receiverAcct = createEercAccount();

	await registerEercAccount(registrar, senderWallet as never, senderAcct);
	await registerEercAccount(registrar, receiverWallet as never, receiverAcct);
	console.log("registered sender + receiver eERC accounts");

	// Sender acquires public tUSDC and shields (deposits) it into the eERC.
	await (await usdc.connect(senderWallet).faucet()).wait();
	await (await usdc.connect(senderWallet).approve(eercRec.address, DEPOSIT_AMOUNT)).wait();
	const depositRcpt = await (
		await eerc
			.connect(senderWallet)
			["deposit(uint256,address,uint256[7])"](
				DEPOSIT_AMOUNT,
				usdcRec.address,
				encryptAmountPCT(DEPOSIT_AMOUNT, senderAcct.publicKey),
			)
	).wait();
	const tokenId = await eerc.tokenIds(usdcRec.address);
	console.log(`deposit ${DEPOSIT_AMOUNT} (tokenId ${tokenId}) tx ${depositRcpt?.hash}`);

	let senderBal = (await eerc.balanceOf(senderWallet.address, tokenId)) as unknown as EercBalance;
	let senderDec = getDecryptedBalance(senderAcct.privateKey, senderBal);
	assertEq("sender balance after deposit", senderDec, DEPOSIT_AMOUNT);

	// Auditor public key is already configured on-chain — read it for the proof.
	const ap = await eerc.auditorPublicKey();
	const auditorPublicKey: [bigint, bigint] = [BigInt(ap[0]), BigInt(ap[1])];

	const transfer = await generatePrivateTransfer({
		auditorPublicKey,
		receiverPublicKey: receiverAcct.publicKey,
		sender: senderAcct,
		senderBalance: senderDec,
		senderEncryptedBalance: flattenEncryptedBalance(senderBal),
		transferAmount: TRANSFER_AMOUNT,
	});
	const xferRcpt = await (
		await eerc
			.connect(senderWallet)
			[
				"transfer(address,uint256,((uint256[2],uint256[2][2],uint256[2]),uint256[32]),uint256[7])"
			](receiverWallet.address, tokenId, transfer.proof, transfer.senderBalancePCT)
	).wait();
	console.log(`PRIVATE TRANSFER ${TRANSFER_AMOUNT} tx ${xferRcpt?.hash}`);

	senderBal = (await eerc.balanceOf(senderWallet.address, tokenId)) as unknown as EercBalance;
	senderDec = getDecryptedBalance(senderAcct.privateKey, senderBal);
	const recvBal = (await eerc.balanceOf(receiverWallet.address, tokenId)) as unknown as EercBalance;
	const recvDec = getDecryptedBalance(receiverAcct.privateKey, recvBal);
	assertEq("sender balance after transfer", senderDec, DEPOSIT_AMOUNT - TRANSFER_AMOUNT);
	assertEq("receiver balance after transfer", recvDec, TRANSFER_AMOUNT);

	console.log("\n✅ CONFIDENTIAL eERC TRANSFER VERIFIED ON BENZONET (L1 68420)");
	console.log(`   sender  now ${senderDec}  |  receiver now ${recvDec}  (amounts encrypted on-chain)`);
	console.log(`   deposit  ${EXPLORER}/tx/${depositRcpt?.hash}`);
	console.log(`   transfer ${EXPLORER}/tx/${xferRcpt?.hash}`);
	console.log(JSON.stringify({
		network: "benzonet", chainId: 68420,
		encryptedERC: eercRec.address, tokenId: tokenId.toString(),
		depositTx: depositRcpt?.hash, transferTx: xferRcpt?.hash,
		sender: senderWallet.address, receiver: receiverWallet.address,
	}, null, 2));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
