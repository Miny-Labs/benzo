import { deployEncryptedERC, getDeploymentContext } from "./eerc-deployments";

const main = async () => {
	const context = await getDeploymentContext();
	await deployEncryptedERC(context);
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
