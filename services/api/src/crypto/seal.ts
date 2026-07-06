import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

// Authenticated sealing for secrets held at rest (org treasury EOAs, eERC
// keys, auditor keys). We use AES-256-GCM from Node's built-in crypto rather
// than pulling in a native libsodium binding: APP_MASTER_KEY is already a
// 32-byte key, and GCM gives the same AEAD guarantee as secretbox
// (confidentiality + tamper detection) with no extra dependency or async init.
//
// Sealed layout (single opaque blob stored as bytea): [12B nonce][16B tag][ciphertext].
// The nonce is random per seal; a wrong key or any bit flip fails the GCM tag
// check on unseal and throws instead of returning garbage.

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const parseMasterKey = (masterKeyHex: string): Buffer => {
	const key = Buffer.from(masterKeyHex, "hex");
	if (key.length !== KEY_BYTES) {
		throw new Error(
			`APP_MASTER_KEY must decode to ${KEY_BYTES} bytes; got ${key.length}`,
		);
	}
	return key;
};

export const seal = (masterKeyHex: string, plaintext: Buffer): Buffer => {
	const key = parseMasterKey(masterKeyHex);
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([nonce, tag, ciphertext]);
};

export const unseal = (masterKeyHex: string, sealed: Buffer): Buffer => {
	if (sealed.length < NONCE_BYTES + TAG_BYTES) {
		throw new Error("sealed blob is too short to contain a nonce and tag");
	}
	const key = parseMasterKey(masterKeyHex);
	const nonce = sealed.subarray(0, NONCE_BYTES);
	const tag = sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
	const ciphertext = sealed.subarray(NONCE_BYTES + TAG_BYTES);
	const decipher = createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

// Seal/unseal UTF-8 strings (private keys are 0x-hex strings).
export const sealString = (masterKeyHex: string, value: string): Buffer =>
	seal(masterKeyHex, Buffer.from(value, "utf8"));

export const unsealString = (masterKeyHex: string, sealed: Buffer): string =>
	unseal(masterKeyHex, sealed).toString("utf8");

// Constant-time equality for comparing recovered secrets in tests/verification.
export const secretsEqual = (a: Buffer, b: Buffer): boolean =>
	a.length === b.length && timingSafeEqual(a, b);
