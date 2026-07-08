import { expect } from "chai";
import {
	type CctpHookData,
	decodeHookData,
	encodeHookData,
} from "../src/cctp/hookData";

// Pure, chain-free unit test — no proofs, no zkit, no deployed contracts.
describe("CCTP hookData codec", () => {
	const sample: CctpHookData = {
		user: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
		pkX: 14364545489025837921132814811087340315814711916725125522058321586402130033374n,
		pkY: 20925574508971738553590624529913342951840891855753600850246458133098606857912n,
	};

	it("round-trips { user, pkX, pkY } through encode/decode", () => {
		const decoded = decodeHookData(encodeHookData(sample));

		expect(decoded).to.deep.equal(sample);
	});

	it("encodes to exactly 3 * 32 bytes (abi.encode(address, uint256, uint256))", () => {
		const encoded = encodeHookData(sample);
		const byteLength = (encoded.length - 2) / 2;

		expect(byteLength).to.equal(96);
	});
});
