/**
 * Node-side TDX quote verification via @phala/dcap-qvl (native). Kept in its own
 * module so the browser graph never imports the Node `@phala/dcap-qvl` (which
 * pulls Buffer/node-fetch). Browsers use attestation-web.ts instead.
 */
import {
  DstackAttestationVerifier,
  type QuoteVerifier,
  type DstackVerifierOptions,
} from "./attestation.js";

const toHex = (u8: Uint8Array): string =>
  Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string): Uint8Array => {
  const c = (s || "").replace(/^0x/, "");
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Default Node verifier: dcap-qvl against Intel collateral (via Phala PCCS). */
export const dcapQuoteVerifier: QuoteVerifier = async (quoteHex, _collateral) => {
  const qvl = await import("@phala/dcap-qvl");
  const bytes = fromHex(quoteHex);
  const verified = await qvl.getCollateralAndVerify(Buffer.from(bytes));
  const td = verified.report.asTd10?.() ?? verified.report.asTd15?.()?.base;
  if (!td) throw new Error("quote is not a TDX (td10/td15) report");
  return {
    status: String(verified.status),
    rtmr3: toHex(td.rtMr3),
    mrtd: toHex(td.mrTd),
    mrConfigId: toHex(td.mrConfigId),
    reportData: Uint8Array.from(td.reportData),
  };
};

/** A `DstackAttestationVerifier` wired to the Node dcap-qvl verifier. */
export function makeNodeAttestationVerifier(
  opts: Omit<DstackVerifierOptions, "verifyQuote"> = {},
): DstackAttestationVerifier {
  return new DstackAttestationVerifier({ ...opts, verifyQuote: dcapQuoteVerifier });
}
