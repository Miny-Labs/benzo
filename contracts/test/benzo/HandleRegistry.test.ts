import { expect } from "chai";
import { ethers } from "hardhat";

const hashHandle = (handle: string) =>
	ethers.keccak256(ethers.toUtf8Bytes(handle));

describe("HandleRegistry", () => {
	const deployFixture = async () => {
		const [alice, bob] = await ethers.getSigners();
		const registry = await ethers.deployContract("HandleRegistry");
		await registry.waitForDeployment();

		return { alice, bob, registry };
	};

	describe("validation", () => {
		it("accepts allowed lowercase, digit, and underscore handles at length boundaries", async () => {
			const { alice, bob, registry } = await deployFixture();
			const maxHandle = "a".repeat(32);

			await expect(registry.connect(alice).claim("ab0")).to.emit(
				registry,
				"HandleClaimed",
			);
			await expect(registry.connect(bob).claim(maxHandle)).to.emit(
				registry,
				"HandleClaimed",
			);

			expect(await registry.resolve("ab0")).to.equal(alice.address);
			expect(await registry.resolve(maxHandle)).to.equal(bob.address);
		});

		it("rejects invalid lengths", async () => {
			const { registry } = await deployFixture();

			await expect(registry.claim("")).to.be
				.revertedWithCustomError(registry, "InvalidHandleLength")
				.withArgs(0);
			await expect(registry.claim("ab")).to.be
				.revertedWithCustomError(registry, "InvalidHandleLength")
				.withArgs(2);
			await expect(registry.claim("a".repeat(33))).to.be
				.revertedWithCustomError(registry, "InvalidHandleLength")
				.withArgs(33);
		});

		it("rejects uppercase and unicode bytes without normalization", async () => {
			const { registry } = await deployFixture();

			await expect(registry.claim("Alice")).to.be
				.revertedWithCustomError(registry, "InvalidHandleCharacter")
				.withArgs("0x41");
			await expect(registry.claim("álf")).to.be
				.revertedWithCustomError(registry, "InvalidHandleCharacter")
				.withArgs("0xc3");
		});

		it("validates resolve inputs too", async () => {
			const { registry } = await deployFixture();

			await expect(registry.resolve("ALICE")).to.be
				.revertedWithCustomError(registry, "InvalidHandleCharacter")
				.withArgs("0x41");
		});
	});

	describe("claiming", () => {
		it("claims a free handle and exposes both lookup directions", async () => {
			const { alice, registry } = await deployFixture();
			const handle = "alice_1";
			const handleHash = hashHandle(handle);

			await expect(registry.connect(alice).claim(handle))
				.to.emit(registry, "HandleClaimed")
				.withArgs(handleHash, handle, alice.address);

			expect(await registry.ownerOf(handleHash)).to.equal(alice.address);
			expect(await registry.resolve(handle)).to.equal(alice.address);
			expect(await registry.handleOf(alice.address)).to.equal(handle);
		});

		it("rejects a second claimant for an existing handle", async () => {
			const { alice, bob, registry } = await deployFixture();
			const handle = "alice";
			const handleHash = hashHandle(handle);

			await registry.connect(alice).claim(handle);

			await expect(registry.connect(bob).claim(handle)).to.be
				.revertedWithCustomError(registry, "HandleTaken")
				.withArgs(handleHash);
		});

		it("rejects a second handle for the same caller", async () => {
			const { alice, registry } = await deployFixture();

			await registry.connect(alice).claim("alice");

			await expect(registry.connect(alice).claim("alice2")).to.be
				.revertedWithCustomError(registry, "CallerAlreadyHasHandle")
				.withArgs(alice.address);
		});
	});

	describe("release", () => {
		it("releases a handle and lets another account reclaim it", async () => {
			const { alice, bob, registry } = await deployFixture();
			const handle = "alice";
			const handleHash = hashHandle(handle);

			await registry.connect(alice).claim(handle);

			await expect(registry.connect(alice).release())
				.to.emit(registry, "HandleReleased")
				.withArgs(handleHash, handle, alice.address);

			expect(await registry.ownerOf(handleHash)).to.equal(ethers.ZeroAddress);
			expect(await registry.resolve(handle)).to.equal(ethers.ZeroAddress);
			expect(await registry.handleOf(alice.address)).to.equal("");

			await expect(registry.connect(bob).claim(handle))
				.to.emit(registry, "HandleClaimed")
				.withArgs(handleHash, handle, bob.address);
			expect(await registry.resolve(handle)).to.equal(bob.address);
			expect(await registry.handleOf(bob.address)).to.equal(handle);
		});
	});

	describe("transferHandle", () => {
		it("moves the caller's handle to a new address", async () => {
			const { alice, bob, registry } = await deployFixture();
			const handle = "alice";
			const handleHash = hashHandle(handle);

			await registry.connect(alice).claim(handle);

			await expect(registry.connect(alice).transferHandle(bob.address))
				.to.emit(registry, "HandleTransferred")
				.withArgs(handleHash, handle, alice.address, bob.address);

			expect(await registry.ownerOf(handleHash)).to.equal(bob.address);
			expect(await registry.resolve(handle)).to.equal(bob.address);
			expect(await registry.handleOf(alice.address)).to.equal("");
			expect(await registry.handleOf(bob.address)).to.equal(handle);
		});

		it("rejects transfer to an address that already holds a handle", async () => {
			const { alice, bob, registry } = await deployFixture();

			await registry.connect(alice).claim("alice");
			await registry.connect(bob).claim("bob");

			await expect(registry.connect(alice).transferHandle(bob.address)).to.be
				.revertedWithCustomError(registry, "RecipientAlreadyHasHandle")
				.withArgs(bob.address);
		});

		it("rejects transfer when the caller has no handle", async () => {
			const { alice, bob, registry } = await deployFixture();

			await expect(registry.connect(alice).transferHandle(bob.address)).to.be
				.revertedWithCustomError(registry, "CallerHasNoHandle")
				.withArgs(alice.address);
		});

		it("rejects transfer to the zero address", async () => {
			const { alice, registry } = await deployFixture();

			await registry.connect(alice).claim("alice");

			await expect(registry.connect(alice).transferHandle(ethers.ZeroAddress)).to.be
				.revertedWithCustomError(registry, "InvalidRecipient")
				.withArgs(ethers.ZeroAddress);
		});
	});
});
