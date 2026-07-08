import {
	processPoseidonPCT,
	type PoseidonPCT,
} from "../payroll/eerc.js";

export function computeOnrampAmountPCT(
	amount: bigint,
	userPubKey: [bigint, bigint],
): PoseidonPCT {
	if (amount < 0n) {
		throw new Error("invalid_onramp_amount");
	}

	return processPoseidonPCT(
		[amount],
		userPubKey,
		"onramp_amount_pct",
	).pct;
}
