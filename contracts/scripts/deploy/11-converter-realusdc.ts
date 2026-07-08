import { network } from "hardhat";
import {
	deployEercConverterStack,
	getDeploymentContext,
	writeDeployments,
} from "./eerc-deployments";

// Deploy a FRESH token-agnostic eERC converter that wraps real Circle USDC/EURC.
//
// The existing verifiers + Registrar are REUSED (so existing registrations survive);
// only BabyJubJub + EncryptedERC are redeployed and the auditor is re-set, then a
// deterministic bootstrap pins USDC -> tokenId 1, EURC -> tokenId 2. Encrypted
// balances on the previous converter are abandoned (acceptable on testnet — no
// admin setter can reassign tokenIds, so a fresh converter is the only lever).
//
// Prerequisite: the bootstrap signer (deployer, signers[0]) must hold a little
// USDC + EURC + gas — run scripts/deploy/prefund-bootstrap.ts first.
// BabyJubJub is a stateless pure library — reusing a previously deployed one for
// the fresh EncryptedERC is correct and saves a redeploy, so `libraries` is NOT
// cleared. Only the converter-specific records are reset.
const STALE_EERC_KEYS = ["encryptedERC", "auditor", "wrappedToken", "tokens"];

const main = async () => {
	if (!["fuji", "hardhat", "localhost"].includes(network.name)) {
		throw new Error(
			`11-converter-realusdc targets fuji/local only; got "${network.name}"`,
		);
	}

	// Clear the previous converter's records so a fresh EncryptedERC (+ lib) deploys
	// and the auditor is re-set. Verifiers + registrar records are kept and reused.
	const context = await getDeploymentContext();
	const contracts = (context.deployments.contracts ?? {}) as Record<string, unknown>;
	const eerc = (contracts.eercConverter ?? {}) as Record<string, unknown>;
	for (const key of STALE_EERC_KEYS) {
		delete eerc[key];
	}
	await writeDeployments(context);

	await deployEercConverterStack();
	console.log("Fresh converter stack deployed and tokens bootstrapped.");
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
