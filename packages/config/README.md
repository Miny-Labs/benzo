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

In CI, set `GITHUB_TOKEN` to a token that can read the package. For local
development, use a PAT with `read:packages`.

Then install the package:

```bash
pnpm add @benzo/config
```

The `benzo-wallet` and `benzo-console` repos can replace their vendored
`TODO(@benzo/config)` constants with imports from the package:

```ts
import { benzoChains, deploymentsByNetwork } from "@benzo/config";
```
