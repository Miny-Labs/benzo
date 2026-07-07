# @benzo/config

Shared public Benzo configuration for app and service consumers: chain
definitions, deployed contract addresses, and circuit URL helpers.

This package contains public chain metadata and deployed addresses only. It does
not contain secrets, private keys, or generated proving artifacts.

## Consuming @benzo/config

`@benzo/config` is published to GitHub Packages under the `@benzo` npm scope.
Consumers need GitHub Packages auth with `read:packages` access. In the
consuming repo, add these lines to `.npmrc`:

```ini
@benzo:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

In CI, set `GITHUB_TOKEN` to a token that can read the package. The default
Actions `GITHUB_TOKEN` belongs to the consumer repo, so the package's visibility
must be set to internal/public for the org, or the workflow must supply a PAT (or
a repo/org secret) with `read:packages` on the publishing repo — otherwise
`pnpm install` fails with 401/403. For local development, use a PAT with
`read:packages`.

Then install the package:

```bash
pnpm add @benzo/config
```

The `benzo-wallet` and `benzo-console` repos can replace their vendored
`TODO(@benzo/config)` constants with imports from the package:

```ts
import { benzoChains, deploymentsByNetwork } from "@benzo/config";
```

## Circuit Artifacts

Browser provers use `@avalabs/eerc-sdk` with static Groth16 proving artifacts.
The artifacts are generated in `contracts/`, staged into the ignored public
tree, and then published by the operator:

```bash
pnpm --filter @benzo/contracts zkit:make
pnpm --filter @benzo/contracts artifacts:stage
pnpm --filter @benzo/contracts artifacts:verify
```

`artifacts:stage` copies the five eERC circuits into:

```text
packages/config/public/circuits/
  registration/registration.wasm
  registration/registration.zkey
  transfer/transfer.wasm
  transfer/transfer.zkey
  mint/mint.wasm
  mint/mint.zkey
  withdraw/withdraw.wasm
  withdraw/withdraw.zkey
  burn/burn.wasm
  burn/burn.zkey
  manifest.json
```

`manifest.json` is generated and contains one entry per artifact:

```ts
{
  circuit: "registration" | "transfer" | "mint" | "withdraw" | "burn";
  file: "registration/registration.wasm" | "registration/registration.zkey" | "...";
  sha256: string;
  bytes: number;
}
```

Both scripts honor `BENZO_CIRCUIT_PUBLIC_DIR` to stage/verify an alternate output
root (e.g. a publish staging dir). The whole `packages/config/public/circuits/`
tree is gitignored — do not commit `.wasm`, `.zkey`, or generated manifest
output. `artifacts:verify` re-reads the staged `manifest.json` and re-hashes each
artifact; with `STRICT_CIRCUIT_MANIFEST=1` a missing file, byte-count drift,
SHA-256 drift, duplicate entry, or missing circuit is a hard failure during the
artifact publishing step.

Apps build SDK URLs from the published static base:

```ts
import { buildCircuitURLs } from "@benzo/config";

const circuitURLs = buildCircuitURLs("https://artifacts.benzo.space/circuits");
```

That produces the map expected by `@avalabs/eerc-sdk`, for example
`registration.wasm` at
`https://artifacts.benzo.space/circuits/registration/registration.wasm`.
