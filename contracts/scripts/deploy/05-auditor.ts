import { configureAuditor, getDeploymentContext } from "./eerc-deployments";

const main = async () => {
	const context = await getDeploymentContext();
	await configureAuditor(context);
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
