import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const CIRCUITS = [
  { circuit: "registration", zkitCircuit: "RegistrationCircuit" },
  { circuit: "transfer", zkitCircuit: "TransferCircuit" },
  { circuit: "mint", zkitCircuit: "MintCircuit" },
  { circuit: "withdraw", zkitCircuit: "WithdrawCircuit" },
  { circuit: "burn", zkitCircuit: "BurnCircuit" },
] as const;

const EXTENSIONS = ["wasm", "zkey"] as const;
const CIRCOM_VERSION = "2.1.9";
const UPSTREAM_TAG = "v0.0.4";

type Circuit = (typeof CIRCUITS)[number];
type Extension = (typeof EXTENSIONS)[number];

type ManifestEntry = {
  circuit: Circuit["circuit"];
  file: `${Circuit["circuit"]}.${Extension}`;
  sha256: string;
  bytes: number;
  zkitVersion: string;
  circomVersion: typeof CIRCOM_VERSION;
  upstreamTag: typeof UPSTREAM_TAG;
  builtAt: string;
};

const contractsRoot = resolve(__dirname, "..");
const repoRoot = resolve(contractsRoot, "..");
const artifactsRoot = join(contractsRoot, "zkit", "artifacts");
const outputRoot = join(repoRoot, "packages", "config", "public", "circuits");
const manifestPath = join(outputRoot, "manifest.json");

function main() {
  assertDirectory(
    artifactsRoot,
    `Missing ${relative(repoRoot, artifactsRoot)}. Run "pnpm hardhat zkit make" from contracts/ first.`,
  );

  mkdirSync(outputRoot, { recursive: true });

  const builtAt = new Date().toISOString();
  const zkitVersion = readHardhatZkitVersion();
  const manifest: ManifestEntry[] = [];

  for (const circuit of CIRCUITS) {
    for (const extension of EXTENSIONS) {
      const source = findGeneratedArtifact(circuit, extension);
      const file = `${circuit.circuit}.${extension}` as ManifestEntry["file"];
      const destination = join(outputRoot, file);

      copyFileSync(source, destination);

      const bytes = statSync(destination).size;
      const sha256 = sha256File(destination);

      manifest.push({
        circuit: circuit.circuit,
        file,
        sha256,
        bytes,
        zkitVersion,
        circomVersion: CIRCOM_VERSION,
        upstreamTag: UPSTREAM_TAG,
        builtAt,
      });

      console.log(
        `exported ${relative(repoRoot, source)} -> ${relative(repoRoot, destination)} (${bytes} bytes, sha256 ${sha256})`,
      );
    }
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${relative(repoRoot, manifestPath)} (${manifest.length} entries)`);
}

function assertDirectory(path: string, message: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(message);
  }
}

function findGeneratedArtifact(circuit: Circuit, extension: Extension): string {
  const expectedBasenames = new Set([
    `${circuit.circuit}.${extension}`.toLowerCase(),
    `${circuit.zkitCircuit}.${extension}`.toLowerCase(),
    `${circuit.circuit}.groth16.${extension}`.toLowerCase(),
    `${circuit.zkitCircuit}.groth16.${extension}`.toLowerCase(),
  ]);
  const matches = listFiles(artifactsRoot).filter((file) =>
    expectedBasenames.has(basename(file).toLowerCase()),
  );

  if (matches.length === 0) {
    throw new Error(
      `Missing ${circuit.circuit}.${extension} under ${relative(repoRoot, artifactsRoot)}. Expected one of: ${[
        ...expectedBasenames,
      ].join(", ")}`,
    );
  }

  matches.sort((left, right) => left.length - right.length);

  return matches[0];
}

function listFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...listFiles(path));
      continue;
    }

    if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readHardhatZkitVersion(): string {
  const packageJsonPath = require.resolve("@solarity/hardhat-zkit/package.json", {
    paths: [contractsRoot],
  });
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("@solarity/hardhat-zkit package.json does not expose a version");
  }

  return packageJson.version;
}

main();
