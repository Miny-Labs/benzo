import "@nomicfoundation/hardhat-toolbox";
import "@solarity/chai-zkit";
import "@solarity/hardhat-zkit";
import * as dotenv from "dotenv";
import type { HardhatUserConfig } from "hardhat/config";
import path from "node:path";

if (process.argv.includes("zkit")) {
  // hardhat-zkit stores downloaded circom compilers under os.homedir().
  process.env.HOME = path.join(__dirname, "zkit", "home");

  if (__dirname.includes(" ") || process.env.BENZO_ZKIT_FORCE_WASM === "1") {
    const { CircomCompilerDownloader } = require("@solarity/hardhat-zkit/dist/src/core/compiler/CircomCompilerDownloader") as {
      CircomCompilerDownloader: { getCompilerPlatformBinary: () => string };
    };
    CircomCompilerDownloader.getCompilerPlatformBinary = () => "circom.wasm";
  }
}

// Root .env so contracts/ and future apps/ share one config.
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const FUJI_RPC =
  process.env.RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc";
// BenzoNet is Benzo's sovereign Avalanche L1 (chain id 68420, gas token BGAS).
// Unlike Fuji's C-Chain there is no public RPC — you reach the L1 through a
// node you run (or an SSH tunnel to one), so BENZONET_RPC_URL must point at a
// BenzoNet node's blockchain RPC. The localhost default is the local-node /
// tunnel convention; `||` (not `??`) so an empty env var falls back too.
const BENZONET_RPC =
  process.env.BENZONET_RPC_URL ||
  "http://127.0.0.1:9650/ext/bc/21iisL1nkpM2AauUadAz7p1gK3waRBZLEJme3LU3gsWpaxy792/rpc";
const accounts = [process.env.PRIVATE_KEY, process.env.PRIVATE_KEY_2].filter(
  (k): k is string => Boolean(k),
);

const config: HardhatUserConfig = {
  // 0.8.27 matches ava-labs/EncryptedERC v0.0.4.
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    fuji: {
      url: FUJI_RPC,
      chainId: 43113,
      accounts,
    },
    benzonet: {
      url: BENZONET_RPC,
      chainId: 68420,
      accounts,
    },
  },
  etherscan: {
    // Routescan verifies Fuji contracts without a real API key; our self-hosted
    // BenzoNet Blockscout accepts any key string on its Etherscan-compatible API.
    apiKey: { fuji: "verifyContract", benzonet: "verifyContract" },
    customChains: [
      {
        network: "fuji",
        chainId: 43113,
        urls: {
          apiURL:
            "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan",
          browserURL: "https://testnet.snowtrace.io",
        },
      },
      {
        network: "benzonet",
        chainId: 68420,
        urls: {
          apiURL: "https://explorer.benzo.space/api",
          browserURL: "https://explorer.benzo.space",
        },
      },
    ],
  },
  // BenzoNet runs a self-hosted Blockscout; hardhat-verify's native Blockscout
  // provider speaks its API directly (the Etherscan-compat path mis-detects it).
  blockscout: {
    enabled: true,
    customChains: [
      {
        network: "benzonet",
        chainId: 68420,
        urls: {
          apiURL: "https://explorer.benzo.space/api",
          browserURL: "https://explorer.benzo.space",
        },
      },
    ],
  },
  zkit: {
    compilerVersion: "2.1.9",
    circuitsDir: "circuits",
    compilationSettings: {
      artifactsDir: "zkit/artifacts",
      onlyFiles: [],
      skipFiles: [],
      c: false,
      json: false,
      optimization: "O2",
    },
    setupSettings: {
      // TESTNET-ONLY: contributions: 0 creates a development trusted setup.
      // Verifiers generated into contracts/verifiers from this config must
      // never back a mainnet deployment.
      contributionSettings: {
        provingSystem: "groth16",
        contributions: 0,
      },
      onlyFiles: [],
      skipFiles: [],
      ptauDir: "zkit/ptau",
      ptauDownload: true,
    },
    verifiersSettings: {
      verifiersDir: "contracts/verifiers",
      verifiersType: "sol",
    },
    typesDir: "generated-types/zkit",
    quiet: false,
  },
};

export default config;
