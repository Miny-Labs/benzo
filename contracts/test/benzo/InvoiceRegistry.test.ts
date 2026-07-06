import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import type { InvoiceRegistry } from "../../typechain-types/contracts/benzo/InvoiceRegistry";
import { InvoiceRegistry__factory } from "../../typechain-types/factories/contracts/benzo/InvoiceRegistry__factory";

const Status = {
	Created: 0n,
	Paid: 1n,
	Cancelled: 2n,
};

const abi = ethers.AbiCoder.defaultAbiCoder();

const invoiceCommitment = (
	amount: bigint,
	token: string,
	payee: string,
	invoiceSalt: string,
) =>
	ethers.keccak256(
		abi.encode(
			["uint256", "address", "address", "bytes32"],
			[amount, token, payee, invoiceSalt],
		),
	);

describe("InvoiceRegistry", () => {
	let registry: InvoiceRegistry;
	let payee: SignerWithAddress;
	let payer: SignerWithAddress;
	let stranger: SignerWithAddress;
	let token: SignerWithAddress;

	const deployFixture = async () => {
		[payee, payer, stranger, token] = await ethers.getSigners();

		const registryFactory = new InvoiceRegistry__factory(payee);
		registry = await registryFactory.deploy();
		await registry.waitForDeployment();
	};

	const createInvoice = async (payerAddress = payer.address, expiry = 0) => {
		const salt = ethers.id(`invoice-${await registry.invoiceCount()}`);
		const commitment = invoiceCommitment(
			1_000_000n,
			token.address,
			payee.address,
			salt,
		);

		const tx = await registry
			.connect(payee)
			.createInvoice(commitment, payerAddress, expiry);
		const receipt = await tx.wait();
		const id = await registry.invoiceCount();

		return { commitment, id, receipt, tx };
	};

	beforeEach(async () => {
		await deployFixture();
	});

	it("creates restricted invoices with immutable commitment metadata", async () => {
		const latest = await time.latest();
		const expiry = latest + 3600;
		const salt = ethers.id("restricted-invoice");
		const commitment = invoiceCommitment(
			42_000_000n,
			token.address,
			payee.address,
			salt,
		);

		const tx = await registry
			.connect(payee)
			.createInvoice(commitment, payer.address, expiry);
		const receipt = await tx.wait();
		const block = await ethers.provider.getBlock(receipt?.blockNumber ?? 0);

		await expect(tx)
			.to.emit(registry, "InvoiceCreated")
			.withArgs(1, payee.address, payer.address, commitment, expiry);

		const invoice = await registry.getInvoice(1);
		expect(invoice.payee).to.equal(payee.address);
		expect(invoice.payer).to.equal(payer.address);
		expect(invoice.commitment).to.equal(commitment);
		expect(invoice.createdAt).to.equal(BigInt(block?.timestamp ?? 0));
		expect(invoice.expiry).to.equal(BigInt(expiry));
		expect(invoice.status).to.equal(Status.Created);
		expect(invoice.paymentRef).to.equal(ethers.ZeroHash);
		expect(await registry.invoiceCount()).to.equal(1n);
		expect(await registry.isExpired(1)).to.equal(false);
	});

	it("stores open invoices with address(0) payer", async () => {
		const { commitment } = await createInvoice(ethers.ZeroAddress);

		const invoice = await registry.getInvoice(1);
		expect(invoice.payee).to.equal(payee.address);
		expect(invoice.payer).to.equal(ethers.ZeroAddress);
		expect(invoice.commitment).to.equal(commitment);
	});

	it("rejects non-zero expiries in the past", async () => {
		const nextTimestamp = (await time.latest()) + 60;
		const expiredAt = nextTimestamp - 1;
		const commitment = invoiceCommitment(
			1_000_000n,
			token.address,
			payee.address,
			ethers.id("expired-invoice"),
		);

		await time.setNextBlockTimestamp(nextTimestamp);

		await expect(
			registry.connect(payee).createInvoice(commitment, payer.address, expiredAt),
		).to.be.revertedWithCustomError(registry, "InvalidExpiry").withArgs(
			expiredAt,
			nextTimestamp,
		);
	});

	it("cancels created invoices by payee only", async () => {
		await createInvoice();

		await expect(registry.connect(payee).cancelInvoice(1))
			.to.emit(registry, "InvoiceCancelled")
			.withArgs(1);

		const invoice = await registry.getInvoice(1);
		expect(invoice.status).to.equal(Status.Cancelled);
	});

	it("reverts when a stranger cancels or the payer marks paid", async () => {
		const { id } = await createInvoice();
		const paymentRef = ethers.id("eerc-transfer-tx");

		await expect(
			registry.connect(stranger).cancelInvoice(id),
		).to.be.revertedWithCustomError(registry, "OnlyPayee").withArgs(
			id,
			stranger.address,
		);

		await expect(
			registry.connect(payer).markPaid(id, paymentRef),
		).to.be.revertedWithCustomError(registry, "OnlyPayee").withArgs(
			id,
			payer.address,
		);
	});

	it("marks created invoices paid by payee attestation", async () => {
		const { id } = await createInvoice();
		const paymentRef = ethers.id("fuji-eerc-transfer");

		await expect(registry.connect(payee).markPaid(id, paymentRef))
			.to.emit(registry, "InvoicePaid")
			.withArgs(id, paymentRef);

		const invoice = await registry.getInvoice(id);
		expect(invoice.status).to.equal(Status.Paid);
		expect(invoice.paymentRef).to.equal(paymentRef);
	});

	it("rejects empty payment references", async () => {
		const { id } = await createInvoice();

		await expect(
			registry.connect(payee).markPaid(id, ethers.ZeroHash),
		).to.be.revertedWithCustomError(registry, "InvalidPaymentRef");
	});

	it("does not allow paid invoices to be cancelled or marked paid again", async () => {
		const { id } = await createInvoice();
		await registry.connect(payee).markPaid(id, ethers.id("payment"));

		await expect(
			registry.connect(payee).cancelInvoice(id),
		).to.be.revertedWithCustomError(registry, "InvoiceNotCreated").withArgs(
			id,
			Status.Paid,
		);

		await expect(
			registry.connect(payee).markPaid(id, ethers.id("second-payment")),
		).to.be.revertedWithCustomError(registry, "InvoiceNotCreated").withArgs(
			id,
			Status.Paid,
		);
	});

	it("never marks a cancelled invoice paid", async () => {
		const { id } = await createInvoice();
		await registry.connect(payee).cancelInvoice(id);

		await expect(
			registry.connect(payee).markPaid(id, ethers.id("late-payment")),
		).to.be.revertedWithCustomError(registry, "InvoiceNotCreated").withArgs(
			id,
			Status.Cancelled,
		);
	});

	it("allows markPaid after expiry for late payment acknowledgement", async () => {
		const expiry = (await time.latest()) + 60;
		const { id } = await createInvoice(payer.address, expiry);
		const paymentRef = ethers.id("late-eerc-transfer");

		await time.increaseTo(expiry);

		expect(await registry.isExpired(id)).to.equal(true);
		await expect(registry.connect(payee).markPaid(id, paymentRef))
			.to.emit(registry, "InvoicePaid")
			.withArgs(id, paymentRef);

		const invoice = await registry.getInvoice(id);
		expect(invoice.status).to.equal(Status.Paid);
		expect(invoice.paymentRef).to.equal(paymentRef);
	});

	it("rejects empty commitments and unknown invoices", async () => {
		await expect(
			registry.connect(payee).createInvoice(ethers.ZeroHash, payer.address, 0),
		).to.be.revertedWithCustomError(registry, "EmptyCommitment");

		await expect(registry.getInvoice(1)).to.be.revertedWithCustomError(
			registry,
			"InvoiceNotFound",
		).withArgs(1);
	});
});
