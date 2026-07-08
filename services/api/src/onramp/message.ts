import { getAddress, keccak256, type Address, type Hex } from "viem";
import {
	decodeOnrampHookData,
	type OnrampHookData,
} from "./hookdata.js";

const MESSAGE_BODY_INDEX = 148;
const BURN_MESSAGE_HOOK_DATA_INDEX = 228;
const HOOK_DATA_LENGTH = 96;
const MAX_UINT160 = (1n << 160n) - 1n;

const SOURCE_DOMAIN_INDEX = 4;
const DESTINATION_DOMAIN_INDEX = 8;
const NONCE_INDEX = 12;

const BURN_TOKEN_INDEX = 4;
const MINT_RECIPIENT_INDEX = 36;
const AMOUNT_INDEX = 68;
const FEE_EXECUTED_INDEX = 164;

export type DecodedCctpOnrampMessage = {
	amount: bigint;
	burnToken: Address;
	destinationDomain: number;
	feeExecuted: bigint;
	hookData: OnrampHookData;
	messageHash: Hex;
	mintedAmount: bigint;
	mintRecipient: Address;
	nonce: Hex;
	sourceDomain: number;
};

export function decodeCctpOnrampMessage(
	message: Hex,
): DecodedCctpOnrampMessage {
	assertHexBytes(message, "cctp_message");
	const length = hexByteLength(message);

	if (length < MESSAGE_BODY_INDEX) {
		throw new Error("cctp_message_too_short");
	}

	const hookDataStart = MESSAGE_BODY_INDEX + BURN_MESSAGE_HOOK_DATA_INDEX;

	if (length < hookDataStart) {
		throw new Error("cctp_burn_message_too_short");
	}

	const hookDataLength = length - hookDataStart;

	if (hookDataLength !== HOOK_DATA_LENGTH) {
		throw new Error("cctp_invalid_hook_data_length");
	}

	const amount = readUint256(message, MESSAGE_BODY_INDEX + AMOUNT_INDEX);
	const feeExecuted = readUint256(
		message,
		MESSAGE_BODY_INDEX + FEE_EXECUTED_INDEX,
	);

	if (feeExecuted >= amount) {
		throw new Error("cctp_fee_exceeds_amount");
	}

	return {
		amount,
		burnToken: readAddress(
			message,
			MESSAGE_BODY_INDEX + BURN_TOKEN_INDEX,
			"burn_token",
		),
		destinationDomain: readUint32(message, DESTINATION_DOMAIN_INDEX),
		feeExecuted,
		hookData: decodeOnrampHookData(
			readHex(message, hookDataStart, HOOK_DATA_LENGTH),
		),
		messageHash: keccak256(message),
		mintedAmount: amount - feeExecuted,
		mintRecipient: readAddress(
			message,
			MESSAGE_BODY_INDEX + MINT_RECIPIENT_INDEX,
			"mint_recipient",
		),
		nonce: readHex(message, NONCE_INDEX, 32),
		sourceDomain: readUint32(message, SOURCE_DOMAIN_INDEX),
	};
}

function assertHexBytes(value: string, label: string): void {
	if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
		throw new Error(`invalid_${label}`);
	}
}

function hexByteLength(value: Hex): number {
	return (value.length - 2) / 2;
}

function readHex(value: Hex, offset: number, length: number): Hex {
	const start = 2 + offset * 2;
	const end = start + length * 2;
	return `0x${value.slice(start, end)}` as Hex;
}

function readUint32(value: Hex, offset: number): number {
	return Number(BigInt(readHex(value, offset, 4)));
}

function readUint256(value: Hex, offset: number): bigint {
	return BigInt(readHex(value, offset, 32));
}

function readAddress(value: Hex, offset: number, label: string): Address {
	const raw = readHex(value, offset, 32);
	const numeric = BigInt(raw);

	if (numeric > MAX_UINT160) {
		throw new Error(`invalid_cctp_${label}`);
	}

	return getAddress(`0x${raw.slice(-40)}`);
}
