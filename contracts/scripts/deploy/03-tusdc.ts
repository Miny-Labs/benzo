import { deployTestUSDC, getDeploymentContext } from "./eerc-deployments";

const main = async () => {
	const context = await getDeploymentContext();
	await deployTestUSDC(context);
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
