/**
 * @benzo/plaid — minimal Plaid client for the NON-identity (financial) surface:
 * Auth + Balance in Sandbox. This is the data source behind proof-of-funds — a
 * Plaid balance feeds the funds-attestation oracle (which signs `balance ≥ X`
 * for the `funds_attestation` circuit). NO Plaid Identity/IDV here — identity is
 * handled by the tiered KYC stack (zkLogin / Self / passport), not Plaid.
 *
 * Sandbox is fully self-serve: no real bank, no real money. `sandboxBalance()`
 * creates a test Item, exchanges it, and reads the balance in one call. Use a
 * custom Sandbox user to pin a specific balance for deterministic proof-of-funds
 * thresholds.
 */

export type PlaidEnv = "sandbox" | "production";

const HOSTS: Record<PlaidEnv, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env?: PlaidEnv;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
}

export interface PlaidAccount {
  account_id: string;
  name?: string;
  balances: {
    available: number | null;
    current: number | null;
    iso_currency_code: string | null;
  };
}

export interface SandboxBalance {
  accountId: string;
  available: number | null;
  current: number | null;
  currency: string | null;
}

export interface SandboxItemOpts {
  /** non-OAuth test bank; First Platypus Bank by default */
  institutionId?: string;
  products?: string[];
  /** custom Sandbox user to pin specific data (e.g. a set balance) */
  overrideUsername?: string;
  overridePassword?: string;
}

export class PlaidClient {
  constructor(private readonly cfg: PlaidConfig) {}

  private host(): string {
    return HOSTS[this.cfg.env ?? "sandbox"];
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.host()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.cfg.clientId, secret: this.cfg.secret, ...body }),
    });
    const j = (await res.json()) as Record<string, unknown> & {
      error_code?: string;
      error_message?: string;
    };
    if (!res.ok || j.error_code) {
      throw new Error(`plaid ${path}: ${j.error_code ?? res.status} ${j.error_message ?? ""}`.trim());
    }
    return j as T;
  }

  /** Sandbox-only: create an Item without the Link UI; returns a public_token. */
  async sandboxCreatePublicToken(opts: SandboxItemOpts = {}): Promise<string> {
    const j = await this.post<{ public_token: string }>("/sandbox/public_token/create", {
      institution_id: opts.institutionId ?? "ins_109508", // First Platypus Bank (non-OAuth)
      // NOTE: "balance" is NOT a Link product — it's queryable on any Item via
      // /accounts/balance/get. Including it in initial_products → INVALID_PRODUCT.
      initial_products: opts.products ?? ["auth"],
      options: opts.overrideUsername
        ? { override_username: opts.overrideUsername, override_password: opts.overridePassword ?? "pass_good" }
        : undefined,
    });
    return j.public_token;
  }

  /** Exchange a public_token for a long-lived access_token. */
  async exchangePublicToken(publicToken: string): Promise<string> {
    const j = await this.post<{ access_token: string }>("/item/public_token/exchange", {
      public_token: publicToken,
    });
    return j.access_token;
  }

  /** Fetch live balances for an Item's accounts. */
  async getBalances(accessToken: string): Promise<PlaidAccount[]> {
    const j = await this.post<{ accounts: PlaidAccount[] }>("/accounts/balance/get", {
      access_token: accessToken,
    });
    return j.accounts;
  }

  /** One-shot sandbox helper: create Item → exchange → read the first account's balance. */
  async sandboxBalance(opts: SandboxItemOpts = {}): Promise<SandboxBalance> {
    const publicToken = await this.sandboxCreatePublicToken(opts);
    const accessToken = await this.exchangePublicToken(publicToken);
    const accounts = await this.getBalances(accessToken);
    if (accounts.length === 0) throw new Error("plaid: no accounts on sandbox item");
    const a = accounts[0];
    return {
      accountId: a.account_id,
      available: a.balances.available,
      current: a.balances.current,
      currency: a.balances.iso_currency_code,
    };
  }
}

/**
 * Plaid Transfer (ACH) — the fiat RAIL behind the SEP-24 anchor's bank leg
 * (WS11). In Sandbox no real money moves and events stay `pending` until you
 * simulate them, but the full lifecycle (authorize → create → posted → settled,
 * with returns) runs against the real Plaid Transfer API — so this is "real
 * rail, simulated settlement," a strict upgrade over the pure `/sep24/sim` mock.
 * MoneyGram/production swaps in here unchanged. (Transfer must be enabled on the
 * Plaid account, even in Sandbox.)
 */
export type TransferType = "debit" | "credit";
export interface TransferAuthorization {
  authorizationId: string;
  decision: string; // "approved" | "declined"
}
export interface Transfer {
  transferId: string;
  status: string; // "pending" | "posted" | "settled" | "failed" | "returned" | "cancelled"
}
export interface TransferEvent {
  event_id: number;
  event_type: string;
  transfer_id: string;
}

export class PlaidTransferClient {
  constructor(private readonly cfg: PlaidConfig) {}

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const host = HOSTS[this.cfg.env ?? "sandbox"];
    const res = await fetchImpl(`${host}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.cfg.clientId, secret: this.cfg.secret, ...body }),
    });
    const j = (await res.json()) as Record<string, unknown> & { error_code?: string; error_message?: string };
    if (!res.ok || j.error_code) {
      throw new Error(`plaid ${path}: ${j.error_code ?? res.status} ${j.error_message ?? ""}`.trim());
    }
    return j as T;
  }

  /** Authorize a transfer (Plaid's risk decision) before creating it. */
  async authorize(opts: {
    accessToken: string;
    accountId: string;
    amount: string;
    type?: TransferType;
    user: { legal_name: string };
  }): Promise<TransferAuthorization> {
    const j = await this.post<{ authorization: { id: string; decision: string } }>(
      "/transfer/authorization/create",
      {
        access_token: opts.accessToken,
        account_id: opts.accountId,
        type: opts.type ?? "debit",
        network: "ach",
        amount: opts.amount,
        ach_class: "ppd",
        user: opts.user,
      },
    );
    return { authorizationId: j.authorization.id, decision: j.authorization.decision };
  }

  /** Create the transfer against an approved authorization. */
  async create(opts: {
    accessToken: string;
    accountId: string;
    authorizationId: string;
    amount: string;
    description: string;
  }): Promise<Transfer> {
    const j = await this.post<{ transfer: { id: string; status: string } }>("/transfer/create", {
      access_token: opts.accessToken,
      account_id: opts.accountId,
      authorization_id: opts.authorizationId,
      amount: opts.amount,
      description: opts.description.slice(0, 15),
    });
    return { transferId: j.transfer.id, status: j.transfer.status };
  }

  /** Sandbox-only: advance a transfer through its lifecycle (e.g. "posted", "settled"). */
  async sandboxSimulate(transferId: string, eventType: string): Promise<void> {
    await this.post("/sandbox/transfer/simulate", { transfer_id: transferId, event_type: eventType });
  }

  /** Read the transfer event stream (drives reconciliation with on-chain USDC). */
  async eventSync(afterId = 0, count = 25): Promise<TransferEvent[]> {
    const j = await this.post<{ transfer_events: TransferEvent[] }>("/transfer/event/sync", {
      after_id: afterId,
      count,
    });
    return j.transfer_events;
  }
}

/** Build a sandbox PlaidClient from the standard env vars. */
export function plaidFromEnv(env: NodeJS.ProcessEnv = process.env): PlaidClient {
  const clientId = env.PLAID_CLIENT_ID;
  const secret = env.PLAID_SECRET;
  if (!clientId || !secret) throw new Error("PLAID_CLIENT_ID / PLAID_SECRET not set");
  return new PlaidClient({ clientId, secret, env: (env.PLAID_ENV as PlaidEnv) ?? "sandbox" });
}
