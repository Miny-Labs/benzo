import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const contractsRoot = resolve(__dirname, "..");
const repoRoot = resolve(contractsRoot, "..");
const manifestDirectory = join(repoRoot, "packages", "config", "public", "circuits");
const manifestPath = join(manifestDirectory, "manifest.json");

type ManifestEntry = {
  circuit: unknown;
  file: unknown;
  sha256: unknown;
  bytes: unknown;
  zkitVersion: unknown;
  circomVersion: unknown;
  upstreamTag: unknown;
  builtAt: unknown;
};

function main() {
  if (!existsSync(manifestPath)) {
    fail([`Missing ${relative(repoRoot, manifestPath)}. Run "pnpm artifacts:export" first.`]);
  }

  const manifest = readManifest();
  const failures: string[] = [];

  for (const [index, entry] of manifest.entries()) {
    const entryFailures = validateEntry(index, entry);

    if (entryFailures.length > 0) {
      failures.push(...entryFailures);
      continue;
    }

    const file = entry.file as string;
    const expectedSha256 = entry.sha256 as string;
    const expectedBytes = entry.bytes as number;
    const artifactPath = join(manifestDirectory, file);

    if (!existsSync(artifactPath)) {
      failures.push(`${file}: missing file`);
      continue;
    }

    const actualBytes = statSync(artifactPath).size;
    const actualSha256 = sha256File(artifactPath);

    if (actualBytes !== expectedBytes || actualSha256 !== expectedSha256) {
      failures.push(
        [
          `${file}: integrity mismatch`,
          `  expected bytes: ${expectedBytes}`,
          `  actual bytes:   ${actualBytes}`,
          `  expected sha256: ${expectedSha256}`,
          `  actual sha256:   ${actualSha256}`,
        ].join("\n"),
      );
    }
  }

  if (failures.length > 0) {
    fail(failures);
  }

  console.log(
    `Verified ${manifest.length} circuit artifacts from ${relative(repoRoot, manifestPath)}.`,
  );
}

function readManifest(): ManifestEntry[] {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;

  if (!Array.isArray(parsed)) {
    fail([`${relative(repoRoot, manifestPath)} must be a JSON array`]);
  }

  return parsed as ManifestEntry[];
}

function validateEntry(index: number, entry: ManifestEntry): string[] {
  const failures: string[] = [];
  const prefix = `manifest[${index}]`;

  if (typeof entry.circuit !== "string" || entry.circuit.length === 0) {
    failures.push(`${prefix}.circuit must be a non-empty string`);
  }

  if (typeof entry.file !== "string" || !/^[a-z]+[.](wasm|zkey)$/.test(entry.file)) {
    failures.push(`${prefix}.file must be a circuit artifact filename`);
  }

  if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    failures.push(`${prefix}.sha256 must be a lowercase sha256 hex digest`);
  }

  if (
    typeof entry.bytes !== "number" ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 0
  ) {
    failures.push(`${prefix}.bytes must be a non-negative safe integer`);
  }

  for (const key of ["zkitVersion", "circomVersion", "upstreamTag", "builtAt"] as const) {
    if (typeof entry[key] !== "string" || entry[key].length === 0) {
      failures.push(`${prefix}.${key} must be a non-empty string`);
    }
  }

  return failures;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fail(failures: string[]): never {
  console.error("Circuit manifest verification failed:");
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

main();
