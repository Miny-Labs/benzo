import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ApiConfig } from "../src/config.js";
import {
	buildRegistrationProofInput,
	createManagedEercAccount,
} from "../src/payroll/eerc.js";
import { createSnarkjsPayrollProver } from "../src/payroll/prover.js";

const artifactDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../zk-artifacts",
);
const hasRegistrationArtifacts =
	existsSync(path.join(artifactDir, "registration.wasm")) &&
	existsSync(path.join(artifactDir, "registration.zkey"));

function config(): ApiConfig {
	return {
		appMasterKey:
			"0000000000000000000000000000000000000000000000000000000000000000",
		apiDomain: "localhost",
		benzonetChainId: 43_113,
		benzonetRpcUrl: "http://127.0.0.1:1",
		chainEnv: "fuji",
		databaseUrl: "postgres://benzo:benzo@127.0.0.1:5432/benzo",
		dripBalanceThresholdWei: 500_000_000_000_000_000n,
		dripWei: 500_000_000_000_000_000n,
		eercDeploymentManifest: undefined,
		eercEncryptedErcAddress: "0x46688f1704a69a6c276cccb823e36c80787b0fa2",
		eercRegistrarAddress: "0x9a63fea9851097dbaf3757b636217fdde50abaf0",
		host: "127.0.0.1",
		indexerConfirmations: 6,
		indexerEnabled: false,
		indexerMaxWindowBlocks: 2_000,
		indexerPollCron: "*/5 * * * * *",
		indexerStartBlock: 0n,
		kycProvider: "mock",
		logLevel: "silent",
		nodeEnv: "test",
		onboardingRegistrationPollSeconds: 1,
		opsPrivateKey:
			"0x0000000000000000000000000000000000000000000000000000000000000001",
		payrollEercDecimals: 6,
		payrollTokenId: 1n,
		payrollZkArtifactDir: artifactDir,
		port: 0,
		sessionCookieName: "benzo_test_session",
		sessionTtlDays: 7,
		siweNonceTtlMinutes: 10,
	};
}

describe("@benzo/api payroll prover", () => {
	it.runIf(hasRegistrationArtifacts)(
		"proves registration against local generated artifacts",
		async () => {
			const account = createManagedEercAccount(123_123n);
			const address = `0x${"12".repeat(20)}`;
			const proof = await createSnarkjsPayrollProver(config()).proveRegistration(
				buildRegistrationProofInput(account, address, 43_113n),
			);

			expect(proof.publicSignals).toHaveLength(5);
			expect(proof.publicSignals[0]).toBe(account.publicKey[0]);
			expect(proof.publicSignals[1]).toBe(account.publicKey[1]);
			expect(proof.publicSignals[2]).toBe(BigInt(address));
			expect(proof.publicSignals[3]).toBe(43_113n);
		},
		45_000,
	);
});
