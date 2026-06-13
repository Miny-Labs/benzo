import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildChallenge, verifyChallenge } from "../src/sep10.js";

const PASSPHRASE = Networks.TESTNET;

function makeChallenge(server: Keypair, client: string) {
  return buildChallenge({
    signingKeypair: server,
    clientAccount: client,
    homeDomain: "benzo.local",
    webAuthDomain: "benzo.local",
    networkPassphrase: PASSPHRASE,
    nonce: Buffer.from(new Array(48).fill(7)).toString("base64"),
    now: Math.floor(Date.UTC(2026, 5, 13) / 1000),
  });
}

describe("SEP-10 cryptographic verification", () => {
  it("accepts a properly server- and client-signed challenge", () => {
    const server = Keypair.random();
    const client = Keypair.random();
    const xdr = makeChallenge(server, client.publicKey());
    // client counter-signs the exact bytes
    const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
    tx.sign(client);
    const r = verifyChallenge(tx.toXDR(), server.publicKey(), PASSPHRASE);
    expect(r.ok).toBe(true);
    expect(r.clientAccount).toBe(client.publicKey());
  });

  it("rejects a MISSING client signature (server-only)", () => {
    const server = Keypair.random();
    const client = Keypair.random();
    const xdr = makeChallenge(server, client.publicKey()); // not client-signed
    const r = verifyChallenge(xdr, server.publicKey(), PASSPHRASE);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/client signature/);
  });

  it("rejects a FORGED server signature (challenge not signed by SIGNING_KEY)", () => {
    const realServer = Keypair.random();
    const attacker = Keypair.random(); // signs in place of the real anchor
    const client = Keypair.random();
    // Attacker builds + signs a challenge with their own key, then client signs.
    const xdr = makeChallenge(attacker, client.publicKey());
    const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
    tx.sign(client);
    // Verified against the REAL anchor signing key -> must fail (wrong source/sig).
    const r = verifyChallenge(tx.toXDR(), realServer.publicKey(), PASSPHRASE);
    expect(r.ok).toBe(false);
  });

  it("rejects a challenge whose client signature is from the WRONG key", () => {
    const server = Keypair.random();
    const client = Keypair.random();
    const imposter = Keypair.random();
    const xdr = makeChallenge(server, client.publicKey());
    const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
    tx.sign(imposter); // someone other than `client` signs
    const r = verifyChallenge(tx.toXDR(), server.publicKey(), PASSPHRASE);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/client signature/);
  });

  it("rejects unparseable input", () => {
    const server = Keypair.random();
    const r = verifyChallenge("not-a-real-xdr", server.publicKey(), PASSPHRASE);
    expect(r.ok).toBe(false);
  });
});
