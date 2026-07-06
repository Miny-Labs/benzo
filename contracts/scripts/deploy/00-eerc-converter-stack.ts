import { deployEercConverterStack } from "./eerc-deployments";

deployEercConverterStack().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
