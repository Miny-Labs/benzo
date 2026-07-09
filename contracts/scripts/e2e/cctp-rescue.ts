/**
 * Recover the CCTP funds stuck after the settleDeposit revert, via the router
 * owner's receiveForRescue (mints the Fuji USDC to the router) + rescue (sends
 * it out). Returns the minted USDC to onramp-user on Fuji. Also validates the
 * router's owner-only recovery path works end-to-end.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "hardhat";

const ROUTER = "0xbADeF08FE085928c36cF1301CfAa4d8061DA2469";
const FUJI_USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const IRIS_BASE = "https://iris-api-sandbox.circle.com";
const BURN_TX = process.env.BURN_TX ?? "0xbe6b584f2c19218fef3acd9425c42280930fbe17e61a81ea35af65b1e65bab5a";
const RECOVER_TO = process.env.RECOVER_TO ?? "0x5291aD86a5D1d8c50b77CeaC9CD395B29626F477"; // onramp-user
const readKeyJson = (f: string) => JSON.parse(fs.readFileSync(path.join(os.homedir(), ".benzo-keys", f), "utf8"));
const SNOW = (h: string) => `https://testnet.snowtrace.io/tx/${h}`;

async function main() {
	const deployer = new ethers.Wallet(readKeyJson("benzonet-roles.json")["benzo-deployer"].privateKey, ethers.provider);
	const router = await ethers.getContractAt("BenzoCCTPRouter", ROUTER);
	const usdc = new ethers.Contract(FUJI_USDC, ["function balanceOf(address) view returns (uint256)"], ethers.provider);

	const owner = await router.owner();
	if (owner.toLowerCase() !== deployer.address.toLowerCase()) throw new Error(`owner ${owner} != deployer`);

	const r = await fetch(`${IRIS_BASE}/v2/messages/2?transactionHash=${BURN_TX}`);
	const m = (await r.json() as any).messages?.[0];
	if (!m?.message || !m?.attestation) throw new Error("iris message/attestation not available");

	const toBefore: bigint = await usdc.balanceOf(RECOVER_TO);
	const routerBefore: bigint = await usdc.balanceOf(ROUTER);
	console.log(`router Fuji USDC before=${routerBefore}, recipient before=${toBefore}`);

	const rescueReceive = await (router.connect(deployer) as any).receiveForRescue(m.message, m.attestation);
	await rescueReceive.wait();
	console.log(`receiveForRescue tx ${rescueReceive.hash} ${SNOW(rescueReceive.hash)}`);
	const routerMinted: bigint = await usdc.balanceOf(ROUTER);
	console.log(`router Fuji USDC after receive=${routerMinted} (minted ${routerMinted - routerBefore})`);

	const rescueTx = await (router.connect(deployer) as any).rescue(FUJI_USDC, RECOVER_TO);
	await rescueTx.wait();
	console.log(`rescue tx ${rescueTx.hash} ${SNOW(rescueTx.hash)}`);
	const toAfter: bigint = await usdc.balanceOf(RECOVER_TO);
	console.log(JSON.stringify({
		recovered: (toAfter - toBefore).toString(),
		recipient: RECOVER_TO,
		recipientUSDC: `${toBefore} -> ${toAfter}`,
		receiveForRescueTx: rescueReceive.hash,
		rescueTx: rescueTx.hash,
	}, null, 2));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
