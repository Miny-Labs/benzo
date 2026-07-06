import { ethers } from "hardhat";
import {
	type EercBalance,
	createEercAccount,
	encryptAmountPCT,
	flattenEncryptedBalance,
	generatePrivateTransfer,
	generateWithdraw,
	getDecryptedBalance,
	registerEercAccount,
} from "./eerc-crypto";
import {
	deployEercConverterStack,
	getEercDeploymentRecord,
	loadStoredAuditorAccount,
	requireDeploymentRecord,
} from "./eerc-deployments";

const DEPOSIT_AMOUNT = 100_000_000n;
const TRANSFER_AMOUNT = 25_000_000n;
const WITHDRAW_AMOUNT = 5_000_000n;

const assertEqual = (label: string, actual: bigint, expected: bigint) => {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${expected}, got ${actual}`);
	}
};

const hasCode = async (address: string) =>
	(await ethers.provider.getCode(address)) !== "0x";

const loadDeployment = async (deployIfMissing: boolean) => {
	let record = await getEercDeploymentRecord();

	try {
		const encryptedERC = requireDeploymentRecord(record.eercDeployment, [
			"encryptedERC",
		]);
		const registrar = requireDeploymentRecord(record.eercDeployment, [
			"registrar",
		]);
		const testUSDC = requireDeploymentRecord(record.eercDeployment, ["testUSDC"]);
		requireDeploymentRecord(record.eercDeployment, ["auditor"]);

		if (
			(await hasCode(encryptedERC.address)) &&
			(await hasCode(registrar.address)) &&
			(await hasCode(testUSDC.address))
		) {
			return record;
		}

		throw new Error("Recorded eERC deployment has no code on this network");
	} catch (error) {
		if (!deployIfMissing) {
			throw error;
		}
	}

	await deployEercConverterStack({
		configureAuditor: true,
		printPrivateKey: false,
	});
	record = await getEercDeploymentRecord();
	requireDeploymentRecord(record.eercDeployment, ["encryptedERC"]);
	requireDeploymentRecord(record.eercDeployment, ["registrar"]);
	requireDeploymentRecord(record.eercDeployment, ["testUSDC"]);
	requireDeploymentRecord(record.eercDeployment, ["auditor"]);

	return record;
};

export const runEercSmoke = async (
	options: { deployIfMissing?: boolean } = {},
) => {
	const { eercDeployment } = await loadDeployment(
		options.deployIfMissing === true,
	);
	const encryptedERCRecord = requireDeploymentRecord(eercDeployment, [
		"encryptedERC",
	]);
	const registrarRecord = requireDeploymentRecord(eercDeployment, ["registrar"]);
	const testUSDCRecord = requireDeploymentRecord(eercDeployment, ["testUSDC"]);
	const auditorRecord = requireDeploymentRecord(eercDeployment, ["auditor"]);
	const [senderSigner, ...otherSigners] = await ethers.getSigners();
	const receiverSigner = otherSigners.find(
		(signer) => signer.address.toLowerCase() === auditorRecord.address.toLowerCase(),
	);

	if (receiverSigner === undefined) {
		throw new Error(
			"Smoke requires PRIVATE_KEY_2 to match the configured auditor address.",
		);
	}

	const registrar = await ethers.getContractAt(
		"Registrar",
		registrarRecord.address,
	);
	const encryptedERC = await ethers.getContractAt(
		"EncryptedERC",
		encryptedERCRecord.address,
	);
	const testUSDC = await ethers.getContractAt("TestUSDC", testUSDCRecord.address);
	const senderAccount = createEercAccount(
		process.env.SMOKE_SENDER_BABYJUB_PRIVATE_KEY === undefined
			? undefined
			: BigInt(process.env.SMOKE_SENDER_BABYJUB_PRIVATE_KEY),
	);
	const receiverAccount = await loadStoredAuditorAccount(receiverSigner.address);

	await registerEercAccount(registrar, senderSigner, senderAccount);
	await registerEercAccount(registrar, receiverSigner, receiverAccount);

	let senderPublicBalance = await testUSDC.balanceOf(senderSigner.address);
	if (senderPublicBalance < DEPOSIT_AMOUNT) {
		await (await testUSDC.connect(senderSigner).faucet()).wait();
		senderPublicBalance = await testUSDC.balanceOf(senderSigner.address);
	}

	await (
		await testUSDC
			.connect(senderSigner)
			.approve(encryptedERCRecord.address, DEPOSIT_AMOUNT)
	).wait();
	await (
		await encryptedERC
			.connect(senderSigner)
			["deposit(uint256,address,uint256[7])"](
				DEPOSIT_AMOUNT,
				testUSDCRecord.address,
				encryptAmountPCT(DEPOSIT_AMOUNT, senderAccount.publicKey),
			)
	).wait();

	const tokenId = await encryptedERC.tokenIds(testUSDCRecord.address);
	const senderAfterDeposit = await testUSDC.balanceOf(senderSigner.address);
	assertEqual(
		"sender public balance after deposit",
		senderAfterDeposit,
		senderPublicBalance - DEPOSIT_AMOUNT,
	);

	let senderEncryptedBalance = (await encryptedERC.balanceOf(
		senderSigner.address,
		tokenId,
	)) as EercBalance;
	let senderDecryptedBalance = getDecryptedBalance(
		senderAccount.privateKey,
		senderEncryptedBalance,
	);
	assertEqual(
		"sender decrypted balance after deposit",
		senderDecryptedBalance,
		DEPOSIT_AMOUNT,
	);

	const auditorPublicKey = receiverAccount.publicKey;
	const transfer = await generatePrivateTransfer({
		auditorPublicKey,
		receiverPublicKey: receiverAccount.publicKey,
		sender: senderAccount,
		senderBalance: senderDecryptedBalance,
		senderEncryptedBalance: flattenEncryptedBalance(senderEncryptedBalance),
		transferAmount: TRANSFER_AMOUNT,
	});
	await (
		await encryptedERC
			.connect(senderSigner)
			[
				"transfer(address,uint256,((uint256[2],uint256[2][2],uint256[2]),uint256[32]),uint256[7])"
			](
				receiverSigner.address,
				tokenId,
				transfer.proof,
				transfer.senderBalancePCT,
			)
	).wait();

	senderEncryptedBalance = (await encryptedERC.balanceOf(
		senderSigner.address,
		tokenId,
	)) as EercBalance;
	senderDecryptedBalance = getDecryptedBalance(
		senderAccount.privateKey,
		senderEncryptedBalance,
	);
	assertEqual(
		"sender decrypted balance after transfer",
		senderDecryptedBalance,
		DEPOSIT_AMOUNT - TRANSFER_AMOUNT,
	);

	let receiverEncryptedBalance = (await encryptedERC.balanceOf(
		receiverSigner.address,
		tokenId,
	)) as EercBalance;
	let receiverDecryptedBalance = getDecryptedBalance(
		receiverAccount.privateKey,
		receiverEncryptedBalance,
	);
	assertEqual(
		"receiver decrypted balance after transfer",
		receiverDecryptedBalance,
		TRANSFER_AMOUNT,
	);

	const receiverPublicBeforeWithdraw = await testUSDC.balanceOf(
		receiverSigner.address,
	);
	const withdraw = await generateWithdraw({
		amount: WITHDRAW_AMOUNT,
		auditorPublicKey,
		user: receiverAccount,
		userBalance: receiverDecryptedBalance,
		userEncryptedBalance: flattenEncryptedBalance(receiverEncryptedBalance),
	});
	await (
		await encryptedERC
			.connect(receiverSigner)
			[
				"withdraw(uint256,((uint256[2],uint256[2][2],uint256[2]),uint256[16]),uint256[7])"
			](tokenId, withdraw.proof, withdraw.userBalancePCT)
	).wait();

	const receiverPublicAfterWithdraw = await testUSDC.balanceOf(
		receiverSigner.address,
	);
	assertEqual(
		"receiver public balance after withdraw",
		receiverPublicAfterWithdraw,
		receiverPublicBeforeWithdraw + WITHDRAW_AMOUNT,
	);

	receiverEncryptedBalance = (await encryptedERC.balanceOf(
		receiverSigner.address,
		tokenId,
	)) as EercBalance;
	receiverDecryptedBalance = getDecryptedBalance(
		receiverAccount.privateKey,
		receiverEncryptedBalance,
	);
	assertEqual(
		"receiver decrypted balance after withdraw",
		receiverDecryptedBalance,
		TRANSFER_AMOUNT - WITHDRAW_AMOUNT,
	);

	const result = {
		tokenId: tokenId.toString(),
		depositAmount: DEPOSIT_AMOUNT.toString(),
		transferAmount: TRANSFER_AMOUNT.toString(),
		withdrawAmount: WITHDRAW_AMOUNT.toString(),
		sender: senderSigner.address,
		receiver: receiverSigner.address,
	};
	console.log(JSON.stringify(result, null, 2));

	return result;
};
