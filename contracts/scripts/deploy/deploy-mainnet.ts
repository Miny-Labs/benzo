import { ethers, network } from "hardhat";
import {
	computeVerifierFingerprint,
	readCeremonyMarker,
	validateCeremonyMarker,
} from "../ceremony/marker";
import {
	deployEercConverterStack,
	getDeploymentContext,
	resolveNetworkConfig,
} from "./eerc-deployments";
import {
	MIN_DEPLOYER_BALANCE_WEI,
	MainnetGuardrailError,
	assertMainnetGuardrails,
} from "./mainnet-guardrails";

// #120 — the single guard-railed Avalanche mainnet deploy command.
//
// Everything here is "built + fork-dry-run only". It sends NO transaction until
// EVERY guardrail passes, and today the #121 ceremony guardrail can't pass (the
// committed verifiers are a dev build), so a real run aborts non-zero. The happy
// path is reachable only on a C-Chain fork with a real ceremony build in place —
// which is the whole point: prove the guardrails, not broadcast to mainnet.

export const runMainnetDeploy = async (): Promise<void> => {
	// Confirm gate FIRST, before touching the RPC, so an accidental invocation
	// aborts without opening a mainnet connection.
	const confirm = process.env.MAINNET_CONFIRM;
	if (confirm !== "1") {
		throw new MainnetGuardrailError(
			"confirm_flag_missing",
			"MAINNET_CONFIRM=1 is required to deploy to Avalanche mainnet; refusing.",
		);
	}

	// getDeploymentContext also enforces network.name→chainId (avalanche⇒43114).
	const context = await getDeploymentContext();
	const netConfig = resolveNetworkConfig(network.name);

	const deployerBalanceWei = await ethers.provider.getBalance(
		context.deployer.address,
	);

	// #121 ceremony marker vs the on-disk verifiers.
	const ceremony = validateCeremonyMarker(
		readCeremonyMarker(),
		computeVerifierFingerprint(),
	);

	// The mainnet auditor is operator-provided: the operator seals the private
	// half into the prod store and passes ONLY the public key here. Absence ⇒
	// abort (deploy never auto-generates a mainnet auditor key).
	const auditorProvided = Boolean(process.env.MAINNET_AUDITOR_PUBKEY);

	assertMainnetGuardrails({
		confirm,
		networkName: network.name,
		chainId: context.chainId,
		wrappedTokens: netConfig.wrappedTokens,
		deployerPrivateKey: process.env.PRIVATE_KEY,
		auditorPrivateKey: process.env.PRIVATE_KEY_2,
		deployerBalanceWei,
		minDeployerBalanceWei: MIN_DEPLOYER_BALANCE_WEI,
		ceremony,
		auditorProvided,
	});

	// Only reached once every guardrail passes (real ceremony build + C-Chain
	// fork/mainnet + operator-provided auditor). Never auto-generates the auditor.
	console.log(
		`All mainnet guardrails passed on ${network.name} (${context.chainId}). Deploying converter stack.`,
	);
	await deployEercConverterStack({ autoGenerateAuditor: false });
	console.log("Mainnet converter stack deployed (fork dry-run unless on 43114).");
};

// Never auto-run on import (the guardrail test imports this module).
if (require.main === module) {
	runMainnetDeploy().catch((error) => {
		if (error instanceof MainnetGuardrailError) {
			console.error(`deploy:mainnet aborted [${error.code}]: ${error.message}`);
		} else {
			console.error(error);
		}
		process.exitCode = 1;
	});
}
