import { getAddress, isAddress } from "viem";

// Shared address normalizer for the disclosure module. Returns the lowercased
// checksummed address, or null when the input is not a syntactically valid EVM
// address so callers can distinguish "no assertion" from "malformed assertion".
export function normalizeAddress(address: string): string | null {
	if (!isAddress(address, { strict: false })) {
		return null;
	}

	return getAddress(address).toLowerCase();
}
