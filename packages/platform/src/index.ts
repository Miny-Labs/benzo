/**
 * @benzo/platform — IBenzoPlatform port (Tonkeeper IAppSdk pattern).
 *
 * One headless core, many surfaces. Each surface (web / mobile / extension /
 * Telegram / CLI) implements IBenzoPlatform once — storage, keychain, prover,
 * clipboard, openLink — and the shared app/UI logic runs unchanged on top.
 */
import type { ProverPort } from "@benzo/prover";
import { NodeProver } from "@benzo/prover";

export interface KVStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Keychain {
  /** secure storage for secrets (passkey-derived seeds, claim secrets) */
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
}

export interface Clipboard {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

export interface IBenzoPlatform {
  readonly name: string;
  readonly storage: KVStorage;
  readonly keychain: Keychain;
  readonly prover: ProverPort;
  readonly clipboard: Clipboard;
  openLink(url: string): Promise<void>;
}

/**
 * In-memory reference platform (Node/tests). The CLI manages its own
 * file-backed store directly rather than through this adapter; the real surface
 * adapters (WebPlatform in apps/web, etc.) implement IBenzoPlatform against
 * their runtime's storage/keychain/clipboard. The clipboard/openLink here are
 * intentional no-op stubs — Node has no clipboard or browser navigation.
 */
export class NodePlatform implements IBenzoPlatform {
  readonly name = "node";
  readonly prover: ProverPort = new NodeProver();

  private readonly mem = new Map<string, string>();
  readonly storage: KVStorage = {
    get: async (k) => this.mem.get(k) ?? null,
    set: async (k, v) => void this.mem.set(k, v),
    remove: async (k) => void this.mem.delete(k),
  };

  private readonly secrets = new Map<string, string>();
  readonly keychain: Keychain = {
    getSecret: async (k) => this.secrets.get(k) ?? null,
    setSecret: async (k, v) => void this.secrets.set(k, v),
  };

  readonly clipboard: Clipboard = {
    read: async () => "",
    write: async () => {},
  };

  async openLink(url: string): Promise<void> {
    console.log("[open]", url);
  }
}
