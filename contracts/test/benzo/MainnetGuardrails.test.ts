import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
	assertCeremonyBuild,
	computeVerifierFingerprint,
	readCeremonyMarker,
	validateCeremonyMarker,
} from "../../scripts/ceremony/marker";
import { runMainnetDeploy } from "../../scripts/deploy/deploy-mainnet";
import {
	AVALANCHE_CHAIN_ID,
	AVALANCHE_EURC,
	AVALANCHE_USDC,
	type MainnetGuardrailCode,
	MainnetGuardrailError,
	type MainnetGuardrailInput,
	MIN_DEPLOYER_BALANCE_WEI,
	assertMainnetGuardrails,
} from "../../scripts/deploy/mainnet-guardrails";

// #120 — proves deploy:mainnet is gated. The guardrail function is PURE (no RPC,
// no tx), so it cannot broadcast; the end-to-end case additionally runs the real
// entrypoint and asserts no block was mined.
const makeInput = (
	overrides: Partial<MainnetGuardrailInput> = {},
): MainnetGuardrailInput => ({
	confirm: "1",
	networkName: "avalanche",
	chainId: AVALANCHE_CHAIN_ID,
	wrappedTokens: [
		{ mode: "existing", symbol: "USDC", address: AVALANCHE_USDC },
		{ mode: "existing", symbol: "EURC", address: AVALANCHE_EURC },
	],
	deployerPrivateKey: `0x${"11".repeat(32)}`,
	auditorPrivateKey: `0x${"22".repeat(32)}`,
	deployerBalanceWei: MIN_DEPLOYER_BALANCE_WEI,
	minDeployerBalanceWei: MIN_DEPLOYER_BALANCE_WEI,
	ceremony: { ok: true },
	auditorProvided: true,
	...overrides,
});

const expectAbort = (
	input: MainnetGuardrailInput,
	code: MainnetGuardrailCode,
): void => {
	let error: unknown;
	try {
		assertMainnetGuardrails(input);
	} catch (caught) {
		error = caught;
	}
	expect(error, `expected an abort with code ${code}`).to.be.instanceOf(
		MainnetGuardrailError,
	);
	expect((error as MainnetGuardrailError).code).to.equal(code);
};

describe("deploy:mainnet guardrails", () => {
	it("passes when every guardrail is satisfied (fork/mainnet happy path)", () => {
		expect(() => assertMainnetGuardrails(makeInput())).to.not.throw();
	});

	it("aborts on each failed guardrail with no transaction sent", () => {
		expectAbort(makeInput({ confirm: undefined }), "confirm_flag_missing");
		expectAbort(makeInput({ confirm: "yes" }), "confirm_flag_missing");
		expectAbort(makeInput({ networkName: "fuji" }), "wrong_network");
		expectAbort(makeInput({ chainId: 43113 }), "wrong_chain_id");
		expectAbort(
			makeInput({
				wrappedTokens: [{ mode: "deploy-test", symbol: "tUSDC" }],
			}),
			"wrapped_token_deploy_test",
		);
		expectAbort(
			makeInput({
				wrappedTokens: [
					{
						mode: "existing",
						symbol: "USDC",
						// Fuji USDC address on a mainnet deploy — rejected.
						address: "0x5425890298aed601595a70AB815c96711a31Bc65",
					},
				],
			}),
			"wrapped_token_not_existing",
		);
		expectAbort(
			makeInput({
				ceremony: { ok: false, reason: "dev trusted setup (contributions:0)" },
			}),
			"ceremony_build_required",
		);
		expectAbort(
			makeInput({ deployerPrivateKey: undefined }),
			"deployer_key_missing",
		);
		expectAbort(
			makeInput({ auditorPrivateKey: undefined }),
			"auditor_key_missing",
		);
		expectAbort(
			makeInput({
				deployerPrivateKey: `0x${"33".repeat(32)}`,
				auditorPrivateKey: `0x${"33".repeat(32)}`,
			}),
			"deployer_equals_auditor",
		);
		expectAbort(
			makeInput({ deployerBalanceWei: 0n }),
			"insufficient_deployer_balance",
		);
		expectAbort(
			makeInput({ auditorProvided: false }),
			"auditor_key_not_provided",
		);
	});

	it("accepts the committed ceremony build (marker build:ceremony, hashes match)", () => {
		const result = validateCeremonyMarker(
			readCeremonyMarker(),
			computeVerifierFingerprint(),
		);
		expect(result.ok, JSON.stringify(result)).to.equal(true);
		expect(() => assertCeremonyBuild()).to.not.throw();
	});

	it("still rejects a dev marker or a verifier that changed after the ceremony", () => {
		const marker = readCeremonyMarker();
		const hashes = computeVerifierFingerprint();

		// A dev build (contributions:0) is refused even with matching hashes.
		expect(
			validateCeremonyMarker({ ...marker, build: "dev" }, hashes).ok,
		).to.equal(false);

		// Swapping any verifier .sol after the ceremony breaks the sha256 gate.
		const tampered = validateCeremonyMarker(marker, {
			...hashes,
			transfer: `${hashes.transfer}00`,
		});
		expect(tampered.ok).to.equal(false);
		if (!tampered.ok) {
			expect(tampered.reason).to.match(/verifier sha256/);
		}
	});

	it("the real deploy-mainnet entrypoint aborts and mines no block", async () => {
		// network.name here is "hardhat" (chainId 31337) — the deploy must refuse
		// even with the confirm flag set, and must not broadcast anything.
		expect(network.name).to.not.equal("avalanche");
		const blockBefore = await ethers.provider.getBlockNumber();

		const previousConfirm = process.env.MAINNET_CONFIRM;
		process.env.MAINNET_CONFIRM = "1";
		let error: unknown;
		try {
			await runMainnetDeploy();
		} catch (caught) {
			error = caught;
		} finally {
			if (previousConfirm === undefined) {
				delete process.env.MAINNET_CONFIRM;
			} else {
				process.env.MAINNET_CONFIRM = previousConfirm;
			}
		}

		expect(error).to.be.instanceOf(MainnetGuardrailError);
		const blockAfter = await ethers.provider.getBlockNumber();
		expect(blockAfter, "no transaction should have been broadcast").to.equal(
			blockBefore,
		);
	});
});
