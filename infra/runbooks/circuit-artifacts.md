# Circuit Artifact Publishing

The eERC browser flows prove locally with `@avalabs/eerc-sdk`. The SDK needs a
`circuitURLs` map whose values point at each circuit's `.wasm` and final
`.zkey`. The artifacts are generated and hashed locally, then served as static
files from the Benzo edge.

## Build and Stage

Run from the repo root:

```bash
pnpm --filter @benzo/contracts zkit:make
pnpm --filter @benzo/contracts artifacts:stage
pnpm --filter @benzo/contracts artifacts:verify
```

The staging script writes the ignored tree at
`packages/config/public/circuits/`. The manifest is
`packages/config/public/circuits/manifest.json` and has this shape:

```json
[
  {
    "circuit": "registration",
    "file": "registration/registration.wasm",
    "sha256": "lowercase-hex-sha256",
    "bytes": 123
  }
]
```

`artifacts:verify` delegates to `@benzo/config` with
`STRICT_CIRCUIT_MANIFEST=1`, so it checks all ten expected files and their
hashes before publishing.

## Publish

Copy the staged `circuits/` directory to the VM path that Caddy serves, for
example:

```bash
rsync -av --delete packages/config/public/circuits/ \
  benzo-edge:/srv/benzo/public/circuits/
```

Do not copy from `contracts/zkit/` directly. Only publish the staged tree after
the manifest verification command passes.

## Caddy Static Site

Enable the optional Caddy site from `infra/vm/caddy/sites-available/` and mount
the publish directory into the Caddy container at `/srv/benzo/public`.

```caddy
artifacts.benzo.space {
	root * /srv/benzo/public

	handle /circuits/* {
		header Access-Control-Allow-Origin "*"
		header Cache-Control "public, max-age=300"
		file_server
	}

	handle {
		respond 404
	}
}
```

The published URLs are:

```text
https://artifacts.benzo.space/circuits/manifest.json
https://artifacts.benzo.space/circuits/registration/registration.wasm
https://artifacts.benzo.space/circuits/registration/registration.zkey
```

## Wallet Consumption

Browser apps pass the static host into `@benzo/config` and give the resulting
map to `@avalabs/eerc-sdk`:

```ts
import { buildCircuitURLs } from "@benzo/config";

const circuitURLs = buildCircuitURLs("https://artifacts.benzo.space/circuits");
```

Use the same base for wallet and console. The artifacts are public integrity
checked files, not secrets.
