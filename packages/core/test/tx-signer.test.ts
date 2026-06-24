/**
 * Non-custodial signing (B.5) — headless coverage of the custody-seam removal,
 * no live chain:
 *   - LocalKeypairSigner actually signs the tx (signature verifies against the
 *     tx hash with the signer's public key, and only that key's sig is added).
 *   - signAndSubmit is pure transport: signs via the port, sends once, polls to
 *     finality, surfaces the return value; FAILED/ERROR throw.
 *   - scvalForWriteArg lifts the Groth16 `--proof` JSON into the right struct
 *     ScVal and types the other write args, so a browser can build a write
 *     itself instead of trusting a custodial relayer.
 */
import { describe, it, expect } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  LocalKeypairSigner,
  signerFromFn,
  signAndSubmit,
  type SubmitRpc,
} from "../src/tx-signer.js";
import { scvalForWriteArg, proofToScVal } from "../src/scval.js";
import { toHex } from "../src/crypto/bytes.js";

const NET = Networks.TESTNET;

/** A minimal self-contained tx (no network needed) for signing tests. */
function sampleXdr(sourcePub: string): string {
  const account = new Account(sourcePub, "0");
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(Operation.bumpSequence({ bumpTo: "1" }))
    .setTimeout(180)
    .build()
    .toXDR();
}

describe("LocalKeypairSigner", () => {
  it("adds a valid signature for exactly the signer's key", async () => {
    const kp = Keypair.random();
    const signer = new LocalKeypairSigner(kp.secret());
    expect(await signer.publicKey()).toBe(kp.publicKey());

    const signedXdr = await signer.signTransaction(sampleXdr(kp.publicKey()), {
      networkPassphrase: NET,
    });
    const signed = TransactionBuilder.fromXDR(signedXdr, NET) as Transaction;

    expect(signed.signatures).toHaveLength(1);
    // The signature must verify against the tx hash under the signer's key.
    expect(kp.verify(signed.hash(), signed.signatures[0].signature())).toBe(true);
  });
});

describe("signerFromFn", () => {
  it("delegates to the injected sign function (Freighter-shaped)", async () => {
    let seen: { xdr: string; net: string } | undefined;
    const signer = signerFromFn("GABC", async (xdr, opts) => {
      seen = { xdr, net: opts.networkPassphrase };
      return "SIGNED_XDR";
    });
    expect(await signer.publicKey()).toBe("GABC");
    expect(await signer.signTransaction("UNSIGNED", { networkPassphrase: NET })).toBe("SIGNED_XDR");
    expect(seen).toEqual({ xdr: "UNSIGNED", net: NET });
  });
});

describe("signAndSubmit", () => {
  const kp = Keypair.random();
  const signer = new LocalKeypairSigner(kp.secret());
  const prepared = sampleXdr(kp.publicKey());

  it("signs, sends once, polls past NOT_FOUND, and returns the value + hash", async () => {
    let sends = 0;
    let polls = 0;
    const server: SubmitRpc = {
      async sendTransaction(tx) {
        sends++;
        // It must hand us a *signed* tx.
        expect((tx as Transaction).signatures).toHaveLength(1);
        return { status: "PENDING", hash: "deadbeef" };
      },
      async getTransaction() {
        polls++;
        if (polls < 2) return { status: "NOT_FOUND" };
        return { status: "SUCCESS", returnValue: nativeToScVal(7, { type: "u32" }) };
      },
    };
    const res = await signAndSubmit({
      server,
      preparedXdr: prepared,
      signer,
      networkPassphrase: NET,
      pollIntervalMs: 0,
    });
    expect(res.txHash).toBe("deadbeef");
    expect(res.result).toBe(7);
    expect(sends).toBe(1); // submitted exactly once (non-idempotent)
    expect(polls).toBe(2);
  });

  it("throws when send is rejected", async () => {
    const server: SubmitRpc = {
      async sendTransaction() {
        return { status: "ERROR", hash: "", errorResult: { code: "tx_failed" } };
      },
      async getTransaction() {
        throw new Error("should not poll");
      },
    };
    await expect(
      signAndSubmit({ server, preparedXdr: prepared, signer, networkPassphrase: NET }),
    ).rejects.toThrow(/ERROR/);
  });

  it("throws when the transaction FAILS on-chain", async () => {
    const server: SubmitRpc = {
      async sendTransaction() {
        return { status: "PENDING", hash: "cafe" };
      },
      async getTransaction() {
        return { status: "FAILED" };
      },
    };
    await expect(
      signAndSubmit({ server, preparedXdr: prepared, signer, networkPassphrase: NET, pollIntervalMs: 0 }),
    ).rejects.toThrow(/FAILED/);
  });
});

describe("scvalForWriteArg", () => {
  it("lifts the Groth16 proof JSON into a 3-field bytes struct", () => {
    const a = "ab".repeat(64); // 64-byte G1
    const b = "cd".repeat(128); // 128-byte G2
    const c = "ef".repeat(64); // 64-byte G1
    const sv = proofToScVal(JSON.stringify({ a, b, c }));
    expect(sv.switch()).toBe(xdr.ScValType.scvMap());
    const map = sv.map()!;
    expect(map).toHaveLength(3);
    const byKey: Record<string, Uint8Array> = {};
    for (const e of map) {
      byKey[e.key().sym().toString()] = new Uint8Array(e.val().bytes());
    }
    expect(toHex(byKey.a)).toBe(a);
    expect(toHex(byKey.b)).toBe(b);
    expect(toHex(byKey.c)).toBe(c);
  });

  it("types amounts as i128 and scalars as u256", () => {
    expect(scvalForWriteArg("amount", "1000000").switch()).toBe(xdr.ScValType.scvI128());
    expect(scvalForWriteArg("commitment", "42").switch()).toBe(xdr.ScValType.scvU256());
  });

  it("types ramp references and handle registry keys as fixed 32-byte values", () => {
    const ref = scvalForWriteArg("reference", "1234");
    expect(ref.switch()).toBe(xdr.ScValType.scvBytes());
    expect(ref.bytes()).toHaveLength(32);
    expect(ref.bytes()[30]).toBe(0x12);
    expect(ref.bytes()[31]).toBe(0x34);

    for (const name of ["spend_pub", "view_pub", "mvk_scalar"]) {
      const sv = scvalForWriteArg(name, "ab".repeat(32));
      expect(sv.switch()).toBe(xdr.ScValType.scvBytes());
      expect(sv.bytes()).toHaveLength(32);
    }
  });

  it("rejects oversized fixed bytes32 values loudly", () => {
    expect(() => scvalForWriteArg("reference", "ab".repeat(33))).toThrow(/longer than 32 bytes/);
  });

  it("types org_account ids, thresholds, and member lists for setup calls", () => {
    expect(scvalForWriteArg("org_id", "1").switch()).toBe(xdr.ScValType.scvU64());
    expect(scvalForWriteArg("threshold", "2").switch()).toBe(xdr.ScValType.scvU32());

    const members = scvalForWriteArg(
      "members",
      JSON.stringify(["GBRMUZELYDNXSBYF5KOLLSV4XLQYNZJQNLXQ3HTFCWNRIBS3I6EUBCMP"]),
    );
    expect(members.switch()).toBe(xdr.ScValType.scvVec());
    expect(members.vec()).toHaveLength(1);
    expect(members.vec()![0].switch()).toBe(xdr.ScValType.scvAddress());
  });

  it("types unit enum variants as Vec(Symbol(Variant))", () => {
    const status = scvalForWriteArg("status", "Approved");
    expect(status.switch()).toBe(xdr.ScValType.scvVec());
    expect(status.vec()).toHaveLength(1);
    expect(status.vec()![0].switch()).toBe(xdr.ScValType.scvSymbol());
    expect(status.vec()![0].sym().toString()).toBe("Approved");
  });

  it("routes --proof through the struct coercion", () => {
    const a = "11".repeat(64);
    const b = "22".repeat(128);
    const c = "33".repeat(64);
    const sv = scvalForWriteArg("proof", JSON.stringify({ a, b, c }));
    expect(sv.switch()).toBe(xdr.ScValType.scvMap());
  });
});
