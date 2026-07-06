import { runEercSmoke } from "./eerc-smoke";

runEercSmoke().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
