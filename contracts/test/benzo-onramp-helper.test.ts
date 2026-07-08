import { expect } from "chai";
import { ethers } from "hardhat";
import type { MockPermitToken } from "../typechain-types/contracts/mocks";
import type { MockTokenMessengerV2 } from "../typechain-types/contracts/mocks/MockTokenMessengerV2";
import type { BenzoOnrampHelper } from "../typechain-types/contracts/onramp/BenzoOnrampHelper.sol";
import {
	DEFAULT_CCTP_FAST_FINALITY_THRESHOLD,
	buildDepositForBurnWithHookArgs,
} from "../src/cctp";

const TOKEN_DECIMALS = 6;
type HardhatSigner = Awaited<ReturnType<typeof ethers.getSigners>>[number];

describe("BenzoOnrampHelper", () => {
	let owner: HardhatSigner;
	let relayer: HardhatSigner;
	let router: HardhatSigner;
	let other: HardhatSigner;

	async function deployFixture() {
		const messenger = (await ethers.deployContract(
			"MockTokenMessengerV2",
		)) as unknown as MockTokenMessengerV2;
		const token = (await ethers.deployContract("MockPermitToken", [
			"USD Coin",
			"USDC",
			TOKEN_DECIMALS,
		])) as unknown as MockPermitToken;
		const helper = (await ethers.deployContract("BenzoOnrampHelper", [
			await messenger.getAddress(),
			1,
			router.address,
		])) as unknown as BenzoOnrampHelper;

		return { helper, messenger, token };
	}

	before(async () => {
		[owner, relayer, router, other] = await ethers.getSigners();
	});

	it("consumes an EIP-2612 permit and burns through TokenMessengerV2 in one submitted tx", async () => {
		const { helper, messenger, token } = await deployFixture();
		const amount = 25_000_000n;
		const maxFee = 100n;
		const cctpArgs = buildDepositForBurnWithHookArgs({
			sourceChain: "ethereum",
			token: "USDC",
			amount,
			userAvalancheAddress: owner.address,
			userEercPubKey: { x: 123n, y: 456n },
			routerAddress: router.address,
			maxFee,
		});

		await token.mint(owner.address, amount);
		const permit = await signPermit({
			token,
			owner,
			spender: await helper.getAddress(),
			value: amount,
		});

		await expect(
			helper
				.connect(relayer)
				.onrampWithPermit(
					owner.address,
					await token.getAddress(),
					amount,
					maxFee,
					DEFAULT_CCTP_FAST_FINALITY_THRESHOLD,
					cctpArgs.hookData,
					permit,
				),
		)
			.to.emit(messenger, "DepositForBurnWithHook")
			.withArgs(
				await helper.getAddress(),
				1n,
				amount,
				cctpArgs.destinationDomain,
				cctpArgs.mintRecipient,
				await token.getAddress(),
				cctpArgs.destinationCaller,
				maxFee,
				DEFAULT_CCTP_FAST_FINALITY_THRESHOLD,
				cctpArgs.hookData,
			);

		const lastDeposit = await messenger.lastDeposit();
		expect(lastDeposit.caller).to.equal(await helper.getAddress());
		expect(lastDeposit.amount).to.equal(amount);
		expect(lastDeposit.destinationDomain).to.equal(cctpArgs.destinationDomain);
		expect(lastDeposit.mintRecipient).to.equal(cctpArgs.mintRecipient);
		expect(lastDeposit.burnToken).to.equal(await token.getAddress());
		expect(lastDeposit.destinationCaller).to.equal(cctpArgs.destinationCaller);
		expect(lastDeposit.maxFee).to.equal(maxFee);
		expect(lastDeposit.minFinalityThreshold).to.equal(
			DEFAULT_CCTP_FAST_FINALITY_THRESHOLD,
		);
		expect(lastDeposit.hookData).to.equal(cctpArgs.hookData);
		expect(await token.balanceOf(owner.address)).to.equal(0n);
		expect(await token.balanceOf(await helper.getAddress())).to.equal(0n);
		expect(await token.balanceOf(await messenger.getAddress())).to.equal(amount);
		expect(await token.allowance(await helper.getAddress(), await messenger.getAddress()))
			.to.equal(0n);
	});

	it("rejects hookData that would credit a different Avalanche user", async () => {
		const { helper, token } = await deployFixture();
		const amount = 1_000_000n;
		const mismatchedArgs = buildDepositForBurnWithHookArgs({
			sourceChain: "ethereum",
			token: "USDC",
			amount,
			userAvalancheAddress: other.address,
			userEercPubKey: { x: 1n, y: 2n },
			routerAddress: router.address,
		});

		await token.mint(owner.address, amount);
		const permit = await signPermit({
			token,
			owner,
			spender: await helper.getAddress(),
			value: amount,
		});

		await expect(
			helper
				.connect(relayer)
				.onrampWithPermit(
					owner.address,
					await token.getAddress(),
					amount,
					0n,
					DEFAULT_CCTP_FAST_FINALITY_THRESHOLD,
					mismatchedArgs.hookData,
					permit,
				),
		)
			.to.be.revertedWithCustomError(helper, "HookUserMismatch")
			.withArgs(owner.address, other.address);
		expect(await token.nonces(owner.address)).to.equal(0n);
	});

	it("rejects invalid constructor and call inputs", async () => {
		const messenger = await ethers.deployContract("MockTokenMessengerV2");

		await expect(
			ethers.deployContract("BenzoOnrampHelper", [
				ethers.ZeroAddress,
				1,
				router.address,
			]),
		)
			.to.be.revertedWithCustomError(
				await ethers.getContractFactory("BenzoOnrampHelper"),
				"InvalidTokenMessenger",
			)
			.withArgs(ethers.ZeroAddress);
		await expect(
			ethers.deployContract("BenzoOnrampHelper", [
				await messenger.getAddress(),
				1,
				ethers.ZeroAddress,
			]),
		)
			.to.be.revertedWithCustomError(
				await ethers.getContractFactory("BenzoOnrampHelper"),
				"InvalidDestinationRouter",
			)
			.withArgs(ethers.ZeroAddress);

		const token = await ethers.deployContract("MockPermitToken", [
			"USD Coin",
			"USDC",
			TOKEN_DECIMALS,
		]);
		const helper = await ethers.deployContract("BenzoOnrampHelper", [
			await messenger.getAddress(),
			1,
			router.address,
		]);
		const permit = await signPermit({
			token,
			owner,
			spender: await helper.getAddress(),
			value: 1n,
		});

		await expect(
			helper.onrampWithPermit(
				ethers.ZeroAddress,
				await token.getAddress(),
				1n,
				0n,
				DEFAULT_CCTP_FAST_FINALITY_THRESHOLD,
				"0x",
				permit,
			),
		)
			.to.be.revertedWithCustomError(helper, "InvalidOwner")
			.withArgs(ethers.ZeroAddress);
		await expect(
			helper.onrampWithPermit(
				owner.address,
				ethers.ZeroAddress,
				1n,
				0n,
				DEFAULT_CCTP_FAST_FINALITY_THRESHOLD,
				"0x",
				permit,
			),
		)
			.to.be.revertedWithCustomError(helper, "InvalidBurnToken")
			.withArgs(ethers.ZeroAddress);
		await expect(
			helper.onrampWithPermit(
				owner.address,
				await token.getAddress(),
				0n,
				0n,
				DEFAULT_CCTP_FAST_FINALITY_THRESHOLD,
				"0x",
				permit,
			),
		).to.be.revertedWithCustomError(helper, "InvalidAmount");
		await expect(
			helper.onrampWithPermit(
				owner.address,
				await token.getAddress(),
				1n,
				0n,
				DEFAULT_CCTP_FAST_FINALITY_THRESHOLD,
				"0x",
				permit,
			),
		).to.be.revertedWithCustomError(helper, "InvalidHookData");
	});
});

async function signPermit({
	token,
	owner,
	spender,
	value,
}: {
	token: MockPermitToken;
	owner: HardhatSigner;
	spender: string;
	value: bigint;
}) {
	const deadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);
	const nonce = await token.nonces(owner.address);
	const network = await ethers.provider.getNetwork();
	const signature = await owner.signTypedData(
		{
			name: await token.name(),
			version: "1",
			chainId: network.chainId,
			verifyingContract: await token.getAddress(),
		},
		{
			Permit: [
				{ name: "owner", type: "address" },
				{ name: "spender", type: "address" },
				{ name: "value", type: "uint256" },
				{ name: "nonce", type: "uint256" },
				{ name: "deadline", type: "uint256" },
			],
		},
		{
			owner: owner.address,
			spender,
			value,
			nonce,
			deadline,
		},
	);
	const { v, r, s } = ethers.Signature.from(signature);

	return { deadline, v, r, s };
}
