/**
 * BenzoAttestations — native Stellar attestation layer over AttestProtocol. The
 * SDK client is faked (structural) to verify schema UID derivation, schema
 * registration, the KYC attestation value, and read-back parsing — no network.
 */
import { describe, it, expect } from "vitest";
import { BenzoAttestations, BENZO_KYC_SCHEMA, type AttestClientLike } from "../src/index.js";

function fakeClient() {
  const calls: { createSchema: unknown[]; attest: unknown[] } = { createSchema: [], attest: [] };
  const client: AttestClientLike = {
    generateSchemaUid: (p) => `uid:${p.definition}:${p.authority}`,
    async createSchema(p) {
      calls.createSchema.push(p);
      return { schemaUid: `uid:${p.definition}` };
    },
    async attest(p) {
      calls.attest.push(p);
      return { attestationUid: "att_1" };
    },
    async getAttestation() {
      return { result: { value: JSON.stringify({ verified: true, tier: 2, expiry: 1_900_000_000 }) } };
    },
  };
  return { client, calls };
}

describe("BenzoAttestations", () => {
  it("derives a deterministic schema UID from the Benzo KYC schema + authority", () => {
    const { client } = fakeClient();
    const a = new BenzoAttestations(client, "GAUTH");
    expect(a.schemaUid()).toBe(`uid:${BENZO_KYC_SCHEMA}:GAUTH`);
  });

  it("attests verified=true at the given tier with an expiry", async () => {
    const { client, calls } = fakeClient();
    const a = new BenzoAttestations(client, "GAUTH");
    await a.attestKyc({ subject: "GUSER", tier: 2, expiry: 1_900_000_000, signer: {} });
    const p = calls.attest[0] as { subject: string; value: string; expirationTime: number };
    expect(p.subject).toBe("GUSER");
    expect(JSON.parse(p.value)).toEqual({ verified: true, tier: 2, expiry: 1_900_000_000 });
    expect(p.expirationTime).toBe(1_900_000_000);
  });

  it("reads back + parses a KYC attestation", async () => {
    const { client } = fakeClient();
    const a = new BenzoAttestations(client, "GAUTH");
    const v = await a.readKyc("att_1");
    expect(v).toEqual({ verified: true, tier: 2, expiry: 1_900_000_000 });
  });

  it("ensureSchema registers the Benzo KYC schema", async () => {
    const { client, calls } = fakeClient();
    await new BenzoAttestations(client, "GAUTH").ensureSchema({});
    expect((calls.createSchema[0] as { definition: string }).definition).toBe(BENZO_KYC_SCHEMA);
  });
});
