export const CIRCUIT_OPERATIONS = [
  "registration",
  "transfer",
  "mint",
  "withdraw",
  "burn",
] as const;

export const CIRCUIT_EXTENSIONS = ["wasm", "zkey"] as const;

export const CIRCUIT_PUBLIC_BASE_PATH = "/circuits";
export const CIRCUIT_MANIFEST_FILE = "manifest.json";
export const CIRCUIT_MANIFEST_URL = `${CIRCUIT_PUBLIC_BASE_PATH}/${CIRCUIT_MANIFEST_FILE}`;

export type CircuitOperation = (typeof CIRCUIT_OPERATIONS)[number];
export type CircuitExtension = (typeof CIRCUIT_EXTENSIONS)[number];

export type CircuitArtifactManifestEntry = {
  circuit: CircuitOperation;
  file: `${CircuitOperation}/${CircuitOperation}.${CircuitExtension}`;
  sha256: string;
  bytes: number;
};

export type CircuitArtifactManifest = CircuitArtifactManifestEntry[];

export type CircuitArtifactURLs = {
  wasm: string;
  zkey: string;
};

export type CircuitURLs = Record<CircuitOperation, CircuitArtifactURLs>;

export function circuitArtifactFile(
  circuit: CircuitOperation,
  extension: CircuitExtension,
): CircuitArtifactManifestEntry["file"] {
  return `${circuit}/${circuit}.${extension}`;
}

export function buildCircuitURLs(
  basePath = CIRCUIT_PUBLIC_BASE_PATH,
): CircuitURLs {
  return Object.fromEntries(
    CIRCUIT_OPERATIONS.map((circuit) => [
      circuit,
      {
        wasm: buildArtifactURL(basePath, circuitArtifactFile(circuit, "wasm")),
        zkey: buildArtifactURL(basePath, circuitArtifactFile(circuit, "zkey")),
      },
    ]),
  ) as CircuitURLs;
}

export const circuitURLs = buildCircuitURLs();

function buildArtifactURL(basePath: string, file: string): string {
  const trimmedBasePath = basePath.replace(/\/+$/, "");

  return `${trimmedBasePath}/${file}`;
}
