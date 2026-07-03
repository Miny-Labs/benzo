import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { type ActivityRow, type Balance, type Contact, type Session } from "./api";
import { readShieldedBalanceClientSide, readPublicBalanceClientSide, getClient } from "./benzoClient";
import { getLocalAccount, isWalletUnlocked, getLocalAccountSummary } from "./localWallet";
import { listLocalHistory } from "./history";
import { listLocal } from "./contacts";

export interface PublicBalance {
  stroops: string;
  address: string;
  asset: string;
  issuer: string;
  live: boolean;
}

interface WalletState {
  session: Session | null;
  balance: Balance | null;
  publicBalance: PublicBalance | null;
  history: ActivityRow[];
  contacts: Contact[];
  loading: boolean;
  error: string | null;
  hidden: boolean;
  toggleHidden: () => void;
  deviceVerified: boolean;
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
  const [authenticated, setAuthenticated] = useState(() => isWalletUnlocked());

  const toggleHidden = useCallback(() => {
    setHidden((h) => {
      const next = !h;
      localStorage.setItem("benzo.hidden", next ? "1" : "0");
      return next;
    });
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!isWalletUnlocked()) return;
    try {
      const pBalVal = await readPublicBalanceClientSide();
      const summary = getLocalAccountSummary();
      if (pBalVal && summary && summary.address) {
        setPublicBalance({
          stroops: pBalVal,
          address: summary.address,
          asset: "USDC",
          issuer: "",
          live: true,
        });
      }
      const sBalVal = await readShieldedBalanceClientSide();
      if (sBalVal) {
        setBalance({
          stroops: sBalVal,
          live: true,
          source: "chain",
        });
        setDeviceVerified(true);
      }
      
      let coreHistory: ActivityRow[] = [];
      const c = await getClient();
      if (c) {
        coreHistory = c.getHistory().map((item) => ({
          id: item.txHash || Math.random().toString(),
          type: item.type,
          name: item.counterparty || "External",
          note: item.memo || "",
          amount: item.amount,
          direction: item.type === "shield" || item.type === "receive" ? "in" : "out",
          status: item.status as any,
          timestamp: item.timestamp,
          txHash: item.txHash,
        }));
      }
      const local = listLocalHistory();
      const merged = [...local];
      for (const item of coreHistory) {
        if (!merged.some((x) => x.txHash === item.txHash)) {
          merged.push(item);
        }
      }
      setHistory(merged.sort((a, b) => b.timestamp - a.timestamp));

      setError(null);
    } catch (e) {
      console.error("refreshBalance error:", e);
      setError((e as Error)?.message ?? "Failed to refresh balance");
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (!isWalletUnlocked()) {
        setSession(null);
        setBalance(null);
        setPublicBalance(null);
        setHistory([]);
        setContacts([]);
        setLoading(false);
        return false;
      }
      const summary = getLocalAccountSummary();
      if (summary && summary.address) {
        const addr = summary.address;
        const shortAddr = `${addr.slice(0, 4)}...${addr.slice(-4)}`;
        setSession({
          profile: { handle: "", name: shortAddr },
          live: true,
          mode: "live",
          missing: [],
          prover: { available: ["local"], mode: "local", location: "local" },
          kycTier: 2,
        });
      }
      await refreshBalance();
      setContacts(listLocal());
      setLoading(false);
      return true;
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to load wallet state");
      setLoading(false);
      return false;
    }
  }, [refreshBalance]);

  useEffect(() => {
    if (!authenticated) {
      setSession(null);
      setBalance(null);
      setPublicBalance(null);
      setHistory([]);
      setContacts([]);
      setError(null);
      setLoading(false);
      return;
    }

    void refresh();

    const interval = setInterval(() => {
      if (typeof document !== "undefined" && !document.hidden) void refreshBalance();
    }, 15_000);

    return () => {
      clearInterval(interval);
    };
  }, [authenticated, refresh, refreshBalance]);

  useEffect(() => {
    const onAuthChanged = () => setAuthenticated(isWalletUnlocked());
    window.addEventListener("benzo:auth-changed", onAuthChanged);
    return () => window.removeEventListener("benzo:auth-changed", onAuthChanged);
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
