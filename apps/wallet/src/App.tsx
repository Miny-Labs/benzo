/**
 * The wallet shell - a phone frame (full-screen on mobile, a centered device on
 * desktop) with the cursor-interactive canvas living BEHIND the cards, animated
 * route transitions, and a tab bar with a sliding active indicator + center FAB.
 */
import { AnimatePresence, motion } from "framer-motion";
import { Clock, Home as HomeIcon, Landmark, ArrowUpRight, User } from "lucide-react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { VideoBackground } from "./ui/VideoBackground";
import { StageVideo } from "./ui/StageVideo";
import { LockGate } from "./ui/LockGate";
import { shouldLockOnOpen } from "./lib/lock";
import { spring } from "./ui/motion";
import { useEffect, useState } from "react";
import { Home } from "./screens/Home";
import { Send } from "./screens/Send";
import { Request } from "./screens/Request";
import { Activity } from "./screens/Activity";
import { TxDetail } from "./screens/TxDetail";
import { Cash } from "./screens/Cash";
import { Convert } from "./screens/Convert";
import { Deposit } from "./screens/Deposit";
import { Profile } from "./screens/Profile";
import { Notifications } from "./screens/Notifications";
import { Contacts } from "./screens/Contacts";
import { ShareProof } from "./screens/ShareProof";
import { InviteExternal } from "./screens/InviteExternal";
import { Claim } from "./screens/Claim";
import { Work } from "./screens/Work";
import { Onboarding } from "./screens/Onboarding";
import { AUTH_REQUIRED_EVENT } from "./lib/api";
import { walletExists, isWalletUnlocked } from "./lib/localWallet";

const TABS = [
  { to: "/", label: "Home", icon: HomeIcon },
  { to: "/activity", label: "Activity", icon: Clock },
  { to: "/cash", label: "Cash", icon: Landmark },
  { to: "/profile", label: "Profile", icon: User },
] as const;

function BottomNav() {
  const loc = useLocation();
  const nav = useNavigate();
  const active = (to: string) => (to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(to));
  return (
    <nav className="relative flex items-end justify-between border-t border-hair bg-card px-6 pb-6 pt-2.5" data-testid="bottom-nav">
      {TABS.slice(0, 2).map((t) => (
        <NavBtn key={t.to} {...t} on={active(t.to)} onClick={() => nav(t.to)} />
      ))}
      {/* center FAB → Send (the primary action) */}
      <motion.button
        whileTap={{ scale: 0.9 }}
        whileHover={{ y: -2 }}
        onClick={() => nav("/send")}
        aria-label="Send money"
        data-testid="fab-send"
        className="-mt-7 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-[var(--shadow-glow)] outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      >
        <ArrowUpRight size={26} />
      </motion.button>
      {TABS.slice(2).map((t) => (
        <NavBtn key={t.to} {...t} on={active(t.to)} onClick={() => nav(t.to)} />
      ))}
    </nav>
  );
}

function NavBtn({ label, icon: Icon, on, onClick }: { label: string; icon: typeof HomeIcon; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-current={on ? "page" : undefined}
      className={`relative flex flex-col items-center gap-1 rounded-lg px-1 py-0.5 text-[11px] font-semibold transition outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${on ? "text-accent" : "text-muted hover:text-ink"}`}
    >
      <Icon size={21} />
      {label}
      {on ? <motion.span layoutId="nav-dot" className="absolute -top-1.5 h-1 w-1 rounded-full bg-accent" transition={spring} /> : null}
    </button>
  );
}

/**
 * Desktop = the phone floats on a wide screen, so the video lives BEHIND it
 * (StageVideo) and the phone keeps its own canvas grid. Mobile = the phone IS the
 * screen (nothing "behind" is visible), so the video lives INSIDE the phone
 * (VideoBackground). Re-evaluates live when the viewport crosses the `sm` line.
 */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const on = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return isDesktop;
}

export function App() {
  const loc = useLocation();
  const isDesktop = useIsDesktop();
  const [onboarded, setOnboarded] = useState(false);
  const [locked, setLocked] = useState(true);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    async function checkWallet() {
      const exists = await walletExists();
      setOnboarded(exists);
      setLocked(!isWalletUnlocked());
      setChecking(false);
    }
    checkWallet();

    const onAuthRequired = () => {
      setLocked(true);
      setOnboarded(false);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  function finishOnboarding() {
    setOnboarded(true);
    setLocked(false);
  }

  const showShell = onboarded && !locked;

  if (checking) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-canvas">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  // Send/Request/Share are presented as sheets over Home in real use, but each is
  // also a routable screen so deep-links + back work. The shell stays mounted.
  return (
    <div
      className="fixed inset-0 flex h-[100dvh] w-full items-center justify-center overflow-hidden bg-[#dfe0dc] sm:bg-[radial-gradient(125%_85%_at_50%_-10%,#ecece7,#dcdcd5_55%,#d3d4cd)] sm:p-6"
      data-testid="app-root"
    >
      {/* desktop ambient: the looping video stage BEHIND the device (not inside it) */}
      {isDesktop ? <StageVideo /> : null}
      <div className="device relative z-10 flex h-[100dvh] w-full flex-col overflow-hidden bg-canvas shadow-[0_40px_90px_rgba(25,40,55,0.28)] sm:h-[min(798px,calc(100dvh-48px))] sm:w-[min(380px,calc((100dvh-48px)/2.1))] sm:rounded-[44px] sm:p-2.5">
        <div className="relative flex flex-1 flex-col overflow-hidden sm:rounded-[34px]">
          {/* the app's background - the looping sky video, inside the phone on
              EVERY viewport (desktop + mobile). On desktop the StageVideo also
              plays behind the device; on mobile the phone is the whole screen. */}
          <VideoBackground tint="#f2f2ee" />
          <AnimatePresence>{onboarded && locked ? <LockGate onUnlock={() => setLocked(false)} /> : null}</AnimatePresence>
          <AnimatePresence>{!onboarded ? <Onboarding onDone={finishOnboarding} /> : null}</AnimatePresence>
          {showShell ? (
          <div className="relative z-10 flex flex-1 flex-col overflow-hidden">
            <main className="no-scrollbar flex-1 overflow-y-auto">
              <Routes location={loc} key={loc.pathname}>
                <Route path="/" element={<Home />} />
                <Route path="/send" element={<Send />} />
                <Route path="/request" element={<Request />} />
                <Route path="/activity" element={<Activity />} />
                <Route path="/activity/:id" element={<TxDetail />} />
                <Route path="/cash" element={<Cash />} />
                <Route path="/convert" element={<Convert />} />
                <Route path="/deposit" element={<Deposit />} />
                <Route path="/profile" element={<Profile />} />
                <Route path="/notifications" element={<Notifications />} />
                <Route path="/contacts" element={<Contacts />} />
                <Route path="/share-proof" element={<ShareProof />} />
                <Route path="/invite" element={<InviteExternal />} />
                <Route path="/claim" element={<Claim />} />
                <Route path="/work" element={<Work />} />
                <Route path="*" element={<Home />} />
              </Routes>
            </main>
            <BottomNav />
          </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
