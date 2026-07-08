import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_CORS_ORIGINS, type ApiConfig } from "../src/config.js";
import { createOnChainIdentityChainClient } from "../src/identity/chain.js";

const testOpsPrivateKey =
	"0x0000000000000000000000000000000000000000000000000000000000000001";

const config: ApiConfig = {
	appMasterKey:
		"0000000000000000000000000000000000000000000000000000000000000000",
	apiDomain: "localhost",
	benzonetChainId: 43_113,
	benzonetRpcUrl: "http://127.0.0.1:1",
	chainEnv: "fuji",
	autoDepositRouterAddress: null,
	cctpAttestationApiBase: "https://iris-api-sandbox.circle.com",
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
	handleRegistryAddress: undefined,
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
	opsPrivateKey: testOpsPrivateKey,
	payrollEercDecimals: 6,
	payrollTokenId: 1n,
	payrollZkArtifactDir: "/tmp/benzo-test-zk-artifacts",
	port: 0,
	sessionCookieName: "benzo_test_session",
	sessionTtlDays: 7,
	siweNonceTtlMinutes: 10,
};

describe("OnChainIdentityChainClient", () => {
	it("degrades handle methods gracefully when HandleRegistry is not configured", async () => {
		const account = privateKeyToAccount(testOpsPrivateKey);
		const client = createOnChainIdentityChainClient(config);

		await expect(client.resolveHandle("alice")).resolves.toEqual({
			address: null,
			registeredOnEerc: false,
			source: "chain",
		});
		await expect(
			client.claimHandle({
				handle: "alice",
				ownerAddress: account.address,
			}),
		).rejects.toThrow("handle registry not configured");
	});
});
