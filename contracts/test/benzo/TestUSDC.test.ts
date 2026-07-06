import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("TestUSDC", () => {
	const deployFixture = async () => {
		const [owner, alice, bob] = await ethers.getSigners();
		const token = await ethers.deployContract("TestUSDC", [owner.address]);
		await token.waitForDeployment();

		return { alice, bob, owner, token };
	};

	it("uses tUSDC metadata with 6 decimals", async () => {
		const { token } = await deployFixture();

		expect(await token.name()).to.equal("Test USD Coin");
		expect(await token.symbol()).to.equal("tUSDC");
		expect(await token.decimals()).to.equal(6);
	});

	it("lets each address mint 1,000 tUSDC through the public faucet once per 24 hours", async () => {
		const { alice, bob, token } = await deployFixture();
		const faucetAmount = 1_000_000_000n;

		await expect(token.connect(alice).faucet())
			.to.emit(token, "Transfer")
			.withArgs(ethers.ZeroAddress, alice.address, faucetAmount);

		expect(await token.balanceOf(alice.address)).to.equal(faucetAmount);

		const lastFaucetAt = await token.lastFaucetAt(alice.address);
		const nextAvailableAt = lastFaucetAt + 24n * 60n * 60n;

		await expect(token.connect(alice).faucet()).to.be
			.revertedWithCustomError(token, "FaucetCooldownActive")
			.withArgs(alice.address, nextAvailableAt);

		await token.connect(bob).faucet();
		expect(await token.balanceOf(bob.address)).to.equal(faucetAmount);

		await time.increaseTo(nextAvailableAt);
		await token.connect(alice).faucet();

		expect(await token.balanceOf(alice.address)).to.equal(faucetAmount * 2n);
	});

	it("gates arbitrary minting to the owner", async () => {
		const { alice, owner, token } = await deployFixture();
		const amount = 42_000_000n;

		await expect(token.connect(alice).mint(alice.address, amount)).to.be
			.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
			.withArgs(alice.address);

		await token.connect(owner).mint(alice.address, amount);
		expect(await token.balanceOf(alice.address)).to.equal(amount);
	});
});
