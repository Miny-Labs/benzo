import { deployRegistrar, getDeploymentContext } from "./eerc-deployments";

const main = async () => {
	const context = await getDeploymentContext();
	await deployRegistrar(context);
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
