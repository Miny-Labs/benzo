/**
 * Wallet state: one provider that loads session/balance/history/contacts from the
 * BFF and exposes refreshers. Screens call actions on `api` and then `refresh()`
 * so the UI always reflects real on-chain state after a settle.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, AUTH_CHANGED_EVENT, credentialLooksWellFormed, type ActivityRow, type Balance, type Contact, type Session } from "./api";
import { readShieldedBalanceClientSide } from "./benzoClient";

/** The "Public" balance: plain liquid USDC on the account (send to / receive from any wallet). */
export interface PublicBalance {
  stroops: string;
  address: string;
  asset: string;
  issuer: string;
  live: boolean;
}

interface WalletState {
  session: Session | null;
  /** The "Private" balance - shielded in the privacy pool. Only you can see it. */
  balance: Balance | null;
  /** The "Public" balance - plain liquid USDC. What external wallets/exchanges pay to. */
  publicBalance: PublicBalance | null;
  history: ActivityRow[];
  contacts: Contact[];
  loading: boolean;
  error: string | null;
  /** display-mask the balance (eye toggle) - UI-only, never changes protection */
  hidden: boolean;
  toggleHidden: () => void;
  /** the displayed balance was read+computed on THIS device, straight from chain */
  deviceVerified: boolean;
  /** Reload all read models; resolves true when the critical (balance) slice loaded. */
  refresh: () => Promise<boolean>;
  refreshBalance: () => Promise<void>;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [publicBalance, setPublicBalance] = useState<PublicBalance | null>(null);
  const [history, setHistory] = useState<ActivityRow[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<boolean>(() => localStorage.getItem("benzo.hidden") === "1");
  const [deviceVerified, setDeviceVerified] = useState(false);
  const [authenticated, setAuthenticated] = useState(() => credentialLooksWellFormed());

  const toggleHidden = useCallback(() => {
    setHidden((h) => {
      const next = !h;
      localStorage.setItem("benzo.hidden", next ? "1" : "0");
      return next;
    });
  }, []);

  const refreshBalance = useCallback(async () => {
    // Independent loads: a transient history/public-balance miss must not drop a
    // good private balance - each settles on its own.
    const balanceP = api.balance().then((value) => {
      setBalance(value);
      return value;
    });
    const publicP = api.publicBalance().then((value) => {
      setPublicBalance(value);
      return value;
    });
    const historyP = api.history().then((value) => {
      setHistory(value);
      return value;
    });
    const [b] = await Promise.allSettled([balanceP, publicP, historyP]);
    if (b.status === "rejected") setError((b.reason as Error)?.message ?? "Failed to load");
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    // Each read model loads independently - one transient failure can't blank
    // the whole wallet (Promise.all rejected atomically; allSettled degrades).
    const sessionP = api.session().then((value) => {
      setSession(value);
      return value;
    });
    const balanceP = api.balance().then((value) => {
      setBalance(value);
      return value;
    });
    const publicP = api.publicBalance().then((value) => {
      setPublicBalance(value);
      return value;
    });
    const historyP = api.history().then((value) => {
      setHistory(value);
      return value;
    });
    const contactsP = api.contacts().then((value) => {
      setContacts(value);
      return value;
    });
    const results = await Promise.allSettled([sessionP, balanceP, publicP, historyP, contactsP]);
    const b = results[1];
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    setError(failed.length === results.length ? (failed[0]?.reason as Error)?.message ?? "Failed to load" : null);
    setLoading(false);
    return b.status === "fulfilled"; // balance is the critical slice
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    if (!authenticated) {
      setSession(null);
      setBalance(null);
      setPublicBalance(null);
      setHistory([]);
      setContacts([]);
      setError(null);
      setLoading(false);
      return () => {
        cancelled = true;
        if (retry) clearTimeout(retry);
      };
    }
    // First load; if the balance lost a race with a cold-starting backend, retry once.
    void refresh().then((ok) => {
      if (!ok && !cancelled) retry = setTimeout(() => void refresh(), 1500);
    });
    // The chain is the source of truth - keep balance + history live while open.
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && !document.hidden) void refreshBalance();
    }, 25_000);
    // Client-side confirmation: once, read+compute the shielded balance ON THIS
    // DEVICE straight from chain (no BFF in the compute path). It's slower than
    // the BFF read, so it runs in the background; on success it becomes the
    // displayed truth and we mark the balance device-verified. No-op when the
    // account isn't provisioned to the device (falls back to the BFF value).
    void readShieldedBalanceClientSide()
      .then((stroops) => {
        if (stroops == null || cancelled) return;
        setBalance((prev) => ({ stroops, live: prev?.live ?? true }));
        setDeviceVerified(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      clearInterval(interval);
    };
  }, [authenticated, refresh, refreshBalance]);

  useEffect(() => {
    const onAuthChanged = () => setAuthenticated(credentialLooksWellFormed());
    window.addEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
  }, []);

  return (
    <Ctx.Provider value={{ session, balance, publicBalance, history, contacts, loading, error, hidden, toggleHidden, deviceVerified, refresh, refreshBalance }}>
      {children}
    </Ctx.Provider>
  );
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used within WalletProvider");
  return v;
}
