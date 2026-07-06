import "@nomicfoundation/hardhat-toolbox";
import "@solarity/chai-zkit";
import "@solarity/hardhat-zkit";
import * as dotenv from "dotenv";
import type { HardhatUserConfig } from "hardhat/config";
import path from "node:path";

// Root .env so contracts/ and future apps/ share one config.
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const FUJI_RPC =
  process.env.RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc";
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
  },
  etherscan: {
    // Routescan verifies Fuji contracts without a real API key.
    apiKey: { fuji: "verifyContract" },
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
