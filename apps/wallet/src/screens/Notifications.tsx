/**
 * Notifications (C8). A real, client-side feed derived from on-device activity
 * history - incoming payments, settles, cash-outs. Tap the bell to get here;
 * "Mark all read" clears the badge. No server, no push service.
 */
import { useEffect, useMemo } from "react";
import { ArrowDownLeft, ArrowUpRight, Landmark } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../lib/store";
import { deriveNotifications, markAllRead, type Notif } from "../lib/notifications";
import { Screen, Stagger } from "../ui/motion";
import { ScreenHeader } from "../ui/chrome";
import { Card } from "../ui/primitives";
import { ProofNote } from "../ui/privacy";

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function Notifications() {
  const { history, session } = useWallet();
  const notifs = useMemo(() => deriveNotifications(history, { live: !!session?.live }), [history, session?.live]);
  // Opening the screen marks everything read (the badge clears on next render).
  useEffect(() => {
    if (history.length) markAllRead(history);
  }, [history]);

  return (
    <Screen>
      <ScreenHeader title="Notifications" />
      {notifs.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-8 py-24 text-center" data-testid="notifs-empty">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-card text-muted">
            <ArrowDownLeft size={22} />
          </div>
          <p className="text-[15px] font-semibold">You're all caught up</p>
          <p className="mt-1 text-[13px] text-muted">Payments and updates show up here.</p>
        </div>
      ) : (
        <Stagger className="space-y-3 px-5 pt-2" data-testid="notifs-list">
          {notifs.map((n, i) => (
            <Stagger.Item index={i} key={n.id}>
              <NotifRow n={n} when={timeAgo(n.ts)} />
            </Stagger.Item>
          ))}
        </Stagger>
      )}
    </Screen>
  );
}

function NotifRow({ n, when }: { n: Notif; when: string }) {
  const nav = useNavigate();
  const Icon = n.kind === "in" ? ArrowDownLeft : n.kind === "out" ? ArrowUpRight : Landmark;
  const tone = n.kind === "in" ? "bg-pos/12 text-pos" : "bg-accent/10 text-accent";
  return (
    <button type="button" onClick={() => nav(`/activity/${n.id}`)} className="block w-full text-left" data-testid="notif-row">
      <Card className="flex items-center gap-3 p-3.5">
      <div className={`flex h-10 w-10 items-center justify-center rounded-full ${tone}`}>
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-semibold">{n.title}</div>
        <div className="truncate text-[13px] text-muted">{n.body}</div>
        {n.verified ? <div className="mt-0.5"><ProofNote label="Private payment · proof verified" /></div> : null}
      </div>
      <div className="flex flex-col items-end gap-1">
        <span className="text-[11.5px] text-muted">{when}</span>
        {!n.read ? <span className="h-2 w-2 rounded-full bg-accent" data-testid="notif-unread" /> : null}
      </div>
      </Card>
    </button>
  );
}
