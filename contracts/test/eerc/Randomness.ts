// BENZO PATCH (upstream v0.0.4): Regression tests for unbiased BabyJubJub randomness sampling.
import { Base8 } from "@zk-kit/baby-jubjub";
import { expect } from "chai";
import { createRequire } from "node:module";
import { BASE_POINT_ORDER } from "../../src/constants";

type JubModule = typeof import("../../src/jub/jub");
type MaciCryptoModule = typeof import("maci-crypto");
type PoseidonModule = typeof import("../../src/poseidon/poseidon");

const SAMPLE_COUNT = 300;
const requireForTest = createRequire(__filename);
const maciCrypto = requireForTest("maci-crypto") as MaciCryptoModule;
const originalRandomDescriptor = Object.getOwnPropertyDescriptor(
	maciCrypto,
	"genRandomBabyJubValue",
);
const publicKey = Base8.map((coordinate) => BigInt(coordinate));

const loadModule = <T>(modulePath: string): T => {
	const resolvedPath = requireForTest.resolve(modulePath);
	delete requireForTest.cache[resolvedPath];
	return requireForTest(modulePath) as T;
};

const clearHelperModuleCache = () => {
	delete requireForTest.cache[requireForTest.resolve("../../src/jub/jub")];
	delete requireForTest.cache[
		requireForTest.resolve("../../src/poseidon/poseidon")
	];
};

const restoreRandomness = () => {
	if (originalRandomDescriptor) {
		Object.defineProperty(
			maciCrypto,
			"genRandomBabyJubValue",
			originalRandomDescriptor,
		);
	}
	clearHelperModuleCache();
};

const stubRandomness = (...values: bigint[]) => {
	let calls = 0;

	Object.defineProperty(maciCrypto, "genRandomBabyJubValue", {
		configurable: true,
		value: () => {
			const value = values[calls] ?? values[values.length - 1];
			calls += 1;
			return value;
		},
	});

	return () => calls;
};

describe("eERC randomness", () => {
	afterEach(restoreRandomness);

	// BENZO PATCH (upstream v0.0.4): Prove encryptMessage retries invalid randomness instead of dividing it.
	it("rejection-samples encryptMessage randomness until it is in range", () => {
		const getCallCount = stubRandomness(BASE_POINT_ORDER, 7n);
		const { encryptMessage } = loadModule<JubModule>("../../src/jub/jub");

		const { random } = encryptMessage(publicKey, 1n);

		expect(random).to.equal(7n);
		expect(random < BASE_POINT_ORDER).to.equal(true);
		expect(getCallCount()).to.equal(2);
	});

	// BENZO PATCH (upstream v0.0.4): Prove processPoseidonEncryption retries invalid randomness instead of dividing it.
	it("rejection-samples Poseidon encryption randomness until it is in range", () => {
		const getCallCount = stubRandomness(BASE_POINT_ORDER, 7n);
		const { processPoseidonEncryption } = loadModule<PoseidonModule>(
			"../../src/poseidon/poseidon",
		);

		const { encRandom } = processPoseidonEncryption([1n], publicKey);

		expect(encRandom).to.equal(7n);
		expect(encRandom < BASE_POINT_ORDER).to.equal(true);
		expect(getCallCount()).to.equal(2);
	});

	// BENZO PATCH (upstream v0.0.4): Sample both public helpers to guard their default RNG path.
	it("keeps returned randomness below the BabyJubJub base point order", () => {
		restoreRandomness();
		const { encryptMessage } = loadModule<JubModule>("../../src/jub/jub");
		const { processPoseidonEncryption } = loadModule<PoseidonModule>(
			"../../src/poseidon/poseidon",
		);

		for (let i = 0; i < SAMPLE_COUNT; i += 1) {
			expect(encryptMessage(publicKey, 1n).random < BASE_POINT_ORDER).to.equal(
				true,
			);
			expect(
				processPoseidonEncryption([1n], publicKey).encRandom <
					BASE_POINT_ORDER,
			).to.equal(true);
		}
	});
});
