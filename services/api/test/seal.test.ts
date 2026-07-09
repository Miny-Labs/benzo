import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	seal,
	sealString,
	secretsEqual,
	unseal,
	unsealString,
} from "../src/crypto/seal.js";

const masterKey =
	"1111111111111111111111111111111111111111111111111111111111111111";
const otherKey =
	"2222222222222222222222222222222222222222222222222222222222222222";

describe("seal", () => {
	it("round-trips a secret under the master key", () => {
		const secret = randomBytes(32);
		const sealed = seal(masterKey, secret);
		expect(secretsEqual(unseal(masterKey, sealed), secret)).toBe(true);
	});

	it("round-trips a private-key string", () => {
		const key = `0x${randomBytes(32).toString("hex")}`;
		const sealed = sealString(masterKey, key);
		expect(unsealString(masterKey, sealed)).toBe(key);
	});

	it("produces a distinct nonce per seal (ciphertext differs for same input)", () => {
		const secret = Buffer.from("same-plaintext");
		const a = seal(masterKey, secret);
		const b = seal(masterKey, secret);
		expect(a.equals(b)).toBe(false);
		expect(secretsEqual(unseal(masterKey, a), secret)).toBe(true);
		expect(secretsEqual(unseal(masterKey, b), secret)).toBe(true);
	});

	it("does not store the plaintext in the sealed blob", () => {
		const key = `0x${"ab".repeat(32)}`;
		const sealed = sealString(masterKey, key);
		expect(sealed.toString("utf8")).not.toContain(key);
		expect(sealed.includes(Buffer.from(key, "utf8"))).toBe(false);
	});

	it("fails to unseal with the wrong key (GCM tag mismatch)", () => {
		const sealed = seal(masterKey, randomBytes(32));
		expect(() => unseal(otherKey, sealed)).toThrow();
	});

	it("a blob sealed with the staging master key fails to unseal with the prod key", () => {
		// Staging and prod MUST use distinct APP_MASTER_KEYs, so a secret sealed in
		// staging can never be unsealed by the mainnet process (and vice versa).
		const stagingMasterKey = `${"aa".repeat(32)}`;
		const prodMasterKey = `${"bb".repeat(32)}`;
		const opsKey = `0x${randomBytes(32).toString("hex")}`;
		const sealed = sealString(stagingMasterKey, opsKey);
		expect(() => unsealString(prodMasterKey, sealed)).toThrow();
		// The staging key still round-trips its own blob.
		expect(unsealString(stagingMasterKey, sealed)).toBe(opsKey);
	});

	it("fails to unseal a tampered blob", () => {
		const sealed = seal(masterKey, randomBytes(32));
		// Flip a bit in the ciphertext region (past nonce+tag).
		sealed[sealed.length - 1] ^= 0x01;
		expect(() => unseal(masterKey, sealed)).toThrow();
	});

	it("rejects a master key that is not 32 bytes", () => {
		expect(() => seal("00", Buffer.from("x"))).toThrow(/32 bytes/);
	});
});
