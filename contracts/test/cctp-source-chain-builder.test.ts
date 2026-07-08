import { CCTP_DOMAINS, CCTP_SOURCE_CHAINS } from "@benzo/config";
import { expect } from "chai";
import { ethers } from "hardhat";
import { getAddress } from "viem";
import {
	DEFAULT_CCTP_FAST_FINALITY_THRESHOLD,
	addressToBytes32,
	buildDepositForBurnWithHookArgs,
	depositForBurnWithHookArgsTuple,
} from "../src/cctp";
import { decodeHookData, encodeHookData } from "../src/cctp/hookData";

describe("CCTP source-chain depositForBurnWithHook builder", () => {
	const amount = 123_456_789n;
	const user = "0x1111111111111111111111111111111111111111";
	const router = "0x2222222222222222222222222222222222222222";
	const userEercPubKey = {
		x: 14364545489025837921132814811087340315814711916725125522058321586402130033374n,
		y: 20925574508971738553590624529913342951840891855753600850246458133098606857912n,
	};

	it("builds the exact CCTP V2 burn args for a source-chain USDC onramp", () => {
		const args = buildDepositForBurnWithHookArgs({
			sourceChain: "base",
			token: "USDC",
			amount,
			userAvalancheAddress: user,
			userEercPubKey,
			routerAddress: router,
		});

		expect(args).to.deep.equal({
			amount,
			destinationDomain: CCTP_DOMAINS.avalanche,
			mintRecipient: addressToBytes32(router),
			burnToken: getAddress(
				CCTP_SOURCE_CHAINS.staging.base?.tokens.USDC?.address ?? "",
			),
			destinationCaller: addressToBytes32(router),
			maxFee: 0n,
			minFinalityThreshold: DEFAULT_CCTP_FAST_FINALITY_THRESHOLD,
			hookData: encodeHookData({
				user,
				pkX: userEercPubKey.x,
				pkY: userEercPubKey.y,
			}),
		});
		expect(depositForBurnWithHookArgsTuple(args)).to.deep.equal([
			args.amount,
			args.destinationDomain,
			args.mintRecipient,
			args.burnToken,
			args.destinationCaller,
			args.maxFee,
			args.minFinalityThreshold,
			args.hookData,
		]);
	});

	it("honors explicit maxFee and minFinalityThreshold", () => {
		const args = buildDepositForBurnWithHookArgs({
			sourceChain: "ethereum",
			token: "USDC",
			amount,
			userAvalancheAddress: user,
			userEercPubKey,
			routerAddress: router,
			maxFee: 12_345n,
			minFinalityThreshold: 2_000,
		});

		expect(args.maxFee).to.equal(12_345n);
		expect(args.minFinalityThreshold).to.equal(2_000);
	});

	it("encodes hookData byte-identically to the on-chain CctpMessageV2 decoder layout", async () => {
		const decoder = await ethers.deployContract("MockCctpHookDataDecoder");
		const args = buildDepositForBurnWithHookArgs({
			sourceChain: "ethereum",
			token: "USDC",
			amount,
			userAvalancheAddress: user,
			userEercPubKey,
			routerAddress: router,
		});

		const [decodedUser, decodedPkX, decodedPkY] = await decoder.decode(
			args.hookData,
		);

		expect(decodedUser).to.equal(getAddress(user));
		expect(decodedPkX).to.equal(userEercPubKey.x);
		expect(decodedPkY).to.equal(userEercPubKey.y);
		expect(decodeHookData(args.hookData)).to.deep.equal({
			user: getAddress(user),
			pkX: userEercPubKey.x,
			pkY: userEercPubKey.y,
		});
	});

	it("allows EURC on Ethereum and Base only", () => {
		for (const sourceChain of ["ethereum", "base"] as const) {
			const args = buildDepositForBurnWithHookArgs({
				sourceChain,
				token: "EURC",
				amount,
				userAvalancheAddress: user,
				userEercPubKey,
				routerAddress: router,
			});

			expect(args.burnToken).to.equal(
				getAddress(
					CCTP_SOURCE_CHAINS.staging[sourceChain]?.tokens.EURC?.address ?? "",
				),
			);
		}

		for (const sourceChain of ["arbitrum", "optimism", "avalanche"] as const) {
			expect(() =>
				buildDepositForBurnWithHookArgs({
					sourceChain,
					token: "EURC",
					amount,
					userAvalancheAddress: user,
					userEercPubKey,
					routerAddress: router,
				}),
			).to.throw("EURC CCTP onramp is only supported from Ethereum and Base");
		}
	});

	it("rejects unconfigured tiers and invalid burn parameters", () => {
		expect(() =>
			buildDepositForBurnWithHookArgs({
				tier: "production",
				sourceChain: "base",
				token: "USDC",
				amount,
				userAvalancheAddress: user,
				userEercPubKey,
				routerAddress: router,
			}),
		).to.throw("CCTP source chain base is not configured for production");

		expect(() =>
			buildDepositForBurnWithHookArgs({
				sourceChain: "base",
				token: "USDC",
				amount: 0n,
				userAvalancheAddress: user,
				userEercPubKey,
				routerAddress: router,
			}),
		).to.throw("CCTP onramp amount must be greater than zero");
	});
});
