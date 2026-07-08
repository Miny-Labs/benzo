import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { DEFAULT_CORS_ORIGINS, type ApiConfig } from "../src/config.js";
import { createViemPayrollSubmitter } from "../src/payroll/chain.js";

const config: ApiConfig = {
	appMasterKey:
		"0000000000000000000000000000000000000000000000000000000000000000",
	apiDomain: "localhost",
	benzonetChainId: 43_113,
	benzonetRpcUrl: "http://127.0.0.1:1",
	chainEnv: "fuji",
	autoDepositRouterAddress: null,
	cctpAttestationApiBase: "https://iris-api-sandbox.circle.com",
	cctpDestDomain: 1,
	cctpDomain: null,
	cctpMessageTransmitter: null,
	cctpTokenMessenger: null,
	tier: "staging",
	corsOrigins: [...DEFAULT_CORS_ORIGINS],
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
	payrollZkArtifactDir: "/tmp/benzo-test-zk-artifacts",
	port: 0,
	relayerPrivateKey:
		"0x0000000000000000000000000000000000000000000000000000000000000002",
	sessionCookieName: "benzo_test_session",
	sessionTtlDays: 7,
	siweNonceTtlMinutes: 10,
};

describe("@benzo/api payroll chain", () => {
	it("throws when viem returns a reverted transfer receipt", async () => {
		const submitter = createViemPayrollSubmitter(config, {
			async waitForTransactionReceipt() {
				return { status: "reverted" };
			},
		} as unknown as PublicClient);

		await expect(
			submitter.waitForConfirmations(`0x${"11".repeat(32)}`, 2),
		).rejects.toThrow("transfer_reverted");
	});
});
