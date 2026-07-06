import type { ApiConfig } from "../config.js";
import type { MockKycPayload } from "../db/schema.js";

export type MockKycInput = {
	country?: string;
	name?: string;
};

export type KycProvider = {
	name: "mock";
	approve: (input: MockKycInput) => Promise<MockKycPayload>;
};

export function createKycProvider(config: ApiConfig): KycProvider {
	if (config.kycProvider !== "mock") {
		throw new Error(`unsupported_kyc_provider:${config.kycProvider}`);
	}

	return mockKycProvider;
}

export const mockKycProvider: KycProvider = {
	async approve(input) {
		return normalizeMockKycPayload(input);
	},
	name: "mock",
};

export function normalizeMockKycPayload(
	input: MockKycInput = {},
): MockKycPayload {
	return {
		country: normalizeCountry(input.country),
		label: "MOCK_KYC_NO_DOCUMENTS",
		name: normalizeName(input.name),
	};
}

function normalizeCountry(country: string | undefined): string {
	const normalized = country?.trim().toUpperCase();

	if (!normalized) {
		return "US";
	}

	return normalized.slice(0, 2);
}

function normalizeName(name: string | undefined): string {
	const normalized = name?.trim();

	if (!normalized) {
		return "Mock Benzo User";
	}

	return normalized.slice(0, 120);
}
