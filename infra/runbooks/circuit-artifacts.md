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

`artifacts:verify` runs the standalone `scripts/verify-circuit-manifest.ts` with
`STRICT_CIRCUIT_MANIFEST=1` (honoring `BENZO_CIRCUIT_PUBLIC_DIR`), so it checks
all ten expected files and their hashes before publishing — independently of
`@benzo/config` (whose `check-config.ts` has a separate look-alike check).

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

Enable the optional Caddy site from `infra/vm/caddy/sites-available/`. The site's
`root` is a path **inside** the Caddy container. The compose `caddy` service
(`infra/vm/docker-compose.yml`) already bind-mounts the host publish root at that
same path (`/srv/benzo/public:ro`), so with the compose stack you only publish the
bundle (rsync above) and enable the site. If you instead run Caddy via a bespoke
`docker run`, add the mount yourself — without it the container serves an empty
root and every artifact URL 404s:

```bash
sudo mkdir -p /srv/benzo/public/circuits            # host publish root (rsync target above)
# add this volume when (re)starting benzo-caddy:
#   -v /srv/benzo/public:/srv/benzo/public:ro
# or, in docker compose:
#   volumes:
#     - /srv/benzo/public:/srv/benzo/public:ro
```

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
