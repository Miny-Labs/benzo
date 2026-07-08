import { run } from "hardhat";

// Verify the fresh Fuji converter contracts on Routescan/Snowtrace after a
// SKIP_VERIFY=1 deploy (11-converter-realusdc.ts). Reads the constructor args +
// linked library recorded in deployments/fuji.json.
// Run: hardhat run scripts/deploy/verify-fuji-converter.ts --network fuji
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fuji = require("../../deployments/fuji.json");

async function verifyOne(
	name: string,
	rec: { address?: string; constructorArguments?: unknown[]; libraries?: Record<string, string> },
) {
	if (!rec?.address) {
		console.log(`- ${name}: no record`);
		return;
	}
	try {
		await run("verify:verify", {
			address: rec.address,
			constructorArguments: rec.constructorArguments ?? [],
			...(rec.libraries ? { libraries: rec.libraries } : {}),
		});
		console.log(`  ✓ ${name} ${rec.address}`);
	} catch (error) {
		const msg = String((error as Error).message ?? error);
		if (/already verified|Already Verified|Smart-contract already verified/i.test(msg)) {
			console.log(`  • ${name} already verified`);
		} else {
			console.log(`  ✗ ${name} ${msg.replace(/\s+/g, " ").slice(0, 200)}`);
		}
	}
}

async function main() {
	const e = fuji.contracts.eercConverter;
	console.log("Verifying fresh Fuji converter contracts...");
	await verifyOne("babyJubJub", e.libraries?.babyJubJub);
	await verifyOne("encryptedERC", e.encryptedERC);
	console.log("Done.");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
