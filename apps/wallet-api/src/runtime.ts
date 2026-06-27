export function hostedRuntime(): boolean {
  return process.env.VERCEL === "1" || process.env.BENZO_HOSTED_RUNTIME === "1";
}

export function serverlessRuntime(): boolean {
  return process.env.VERCEL === "1";
}
