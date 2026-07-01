/**
 * Invites (P0-B2) - onboard employees / contractors / customers via a
 * BUSINESS-scoped link. Team invites create a console seat; contractors &
 * customers onboard in the consumer wallet (and the link bounces if opened in the
 * wrong app). Bulk contractor import generates one link per CSV row.
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, Check, Send, Upload, X } from "lucide-react";
import { api, type OrgInvite } from "../lib/api";
import { copyTextToClipboard } from "../lib/clipboard";
import { friendlyError } from "../lib/format";
import { Page, EASE } from "../ui/motion";
import { PageHeader, Card, Button, Modal, Pill, EmptyState, Skeleton } from "../ui/primitives";
import { Field, Input, Select, Textarea, useToast } from "../ui/controls";

type Kind = "member" | "contractor" | "customer";
const TABS: Array<{ id: Kind; label: string }> = [
  { id: "member", label: "Team" },
  { id: "contractor", label: "Contractors" },
  { id: "customer", label: "Customers" },
];

export function Invites() {
  const toast = useToast();
  const [tab, setTab] = useState<Kind>("contractor");
  const [invites, setInvites] = useState<OrgInvite[] | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [handle, setHandle] = useState("");
  const [role, setRole] = useState("approver");
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<{ created: number; errors: Array<{ line: number; error: string }> } | null>(null);
  // Confirm gate + busy flag for revoking a sent invite link.
  const [confirmRevoke, setConfirmRevoke] = useState<OrgInvite | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = () => api.invites().then(setInvites).catch(() => {});
  useEffect(() => {
    void load();
  }, []);

  const rows = invites?.filter((i) => i.kind === tab) ?? null;

  function validateOne(): string | null {
    if (tab === "member") {
      if (!email.trim()) return "Enter the team member's email before creating an invite.";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "Enter a valid email address.";
      if (!role.trim()) return "Choose a role for this team member.";
      return null;
    }
    if (!name.trim()) return `Enter the ${tab}'s name before creating an invite.`;
    if (handle.trim() && !/^@?[a-z0-9_.]{3,20}$/i.test(handle.trim())) return "Enter a valid handle, like @grace.";
    return null;
  }

  async function createOne() {
    const validationError = validateOne();
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setFormError(null);
    setBusy(true);
    try {
      const created = await api.createInvite({ kind: tab, name: name || undefined, email: email || undefined, role: tab === "member" ? role : undefined, handle: handle || undefined });
      setInvites((prev) => (prev ? [created, ...prev.filter((i) => i.id !== created.id)] : [created]));
      setName("");
      setEmail("");
      setHandle("");
      setFormError(null);
      await load();
      toast({ title: "Invite link created", tone: "success" });
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function bulk() {
    setBusy(true);
    setBulkResult(null);
    try {
      const r = await api.bulkInvite(csv);
      setInvites((prev) => (prev ? [...r.invites, ...prev.filter((i) => !r.invites.some((inv) => inv.id === i.id))] : r.invites));
      setBulkResult({ created: r.created, errors: r.errors });
      if (r.errors.length === 0) setCsv("");
      await load();
      toast({
        title: r.errors.length
          ? `${r.created} created, ${r.errors.length} row${r.errors.length === 1 ? "" : "s"} need fixing`
          : `${r.created} contractor invite${r.created === 1 ? "" : "s"} created`,
        tone: r.errors.length ? "warning" : "success",
      });
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setRevoking(true);
    try {
      await api.revokeInvite(id);
      setConfirmRevoke(null);
      await load();
      toast({ title: "Invite revoked", tone: "muted" });
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setRevoking(false);
    }
  }

  return (
    <Page>
      <PageHeader title="Invites" subtitle="Onboard your team, contractors, and customers with a secure link" />

      <div className="mb-5 flex gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            data-testid={`invite-tab-${t.id}`}
            className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-primary/40 ${tab === t.id ? "bg-primary text-white" : "border border-border text-muted hover:bg-[#f4f3ef]"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.24, ease: EASE }}
        >
          <Card className="p-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" data-testid="invite-name" /></Field>
              {tab === "member" ? (
                <Field label="Email"><Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></Field>
              ) : (
                <Field label="@handle (optional)"><Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@handle" /></Field>
              )}
              {tab === "member" ? (
                <Select label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="owner">Owner</option><option value="admin">Admin</option><option value="treasurer">Treasurer</option><option value="approver">Approver</option><option value="auditor">Auditor</option>
                </Select>
              ) : null}
            </div>
            {formError ? <p className="mt-3 text-[13px] font-medium text-danger" data-testid="invite-form-error">{formError}</p> : null}
            <Button className="mt-4" onClick={createOne} loading={busy} data-testid="invite-create">
              <Send size={15} /> Create {tab} invite
            </Button>

            {tab === "contractor" ? (
              <div className="mt-6 border-t border-border pt-5">
                <div className="mb-2 text-[13px] font-semibold text-ink">Bulk import (CSV: name, @handle, rate)</div>
                <Textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={3} placeholder={"Name, @handle, monthly USDC"} data-testid="invite-csv" />
                <Button variant="outline" className="mt-3" onClick={bulk} loading={busy} disabled={!csv.trim()} data-testid="invite-bulk">
                  <Upload size={15} /> Import & invite
                </Button>
                {bulkResult ? (
                  <div
                    className={`mt-3 rounded-lg border px-3 py-2 text-[13px] ${
                      bulkResult.errors.length ? "border-warning/30 bg-warning/10 text-warning" : "border-success/30 bg-success/10 text-success"
                    }`}
                    data-testid="invite-bulk-result"
                  >
                    <div className="font-semibold">
                      {bulkResult.created} invite{bulkResult.created === 1 ? "" : "s"} created
                      {bulkResult.errors.length ? `, ${bulkResult.errors.length} row${bulkResult.errors.length === 1 ? "" : "s"} need fixing` : ""}
                    </div>
                    {bulkResult.errors.length ? (
                      <ul className="mt-1 list-disc pl-5">
                        {bulkResult.errors.map((err) => (
                          <li key={`${err.line}-${err.error}`}>Line {err.line}: {err.error}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </Card>

          <div className="mt-6">
            <div className="mb-2 text-[12px] font-bold uppercase tracking-wide text-muted">Sent {TABS.find((t) => t.id === tab)!.label.toLowerCase()} invites</div>
            {rows === null ? (
              <Card className="divide-y divide-border p-0">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3">
                    <Skeleton className="h-4 w-40 flex-none" />
                    <Skeleton className="h-6 flex-1" />
                    <Skeleton className="h-5 w-14 rounded-full" />
                  </div>
                ))}
              </Card>
            ) : rows.length === 0 ? (
              <EmptyState title="No invites yet" hint="Create a secure invite link above to start onboarding." />
            ) : (
              <Card className="divide-y divide-border p-0">
                {rows.map((inv) => (
                  <div key={inv.id} className="flex items-center gap-3 px-5 py-3 text-[13.5px]" data-testid="invite-row">
                    <span className="w-40 truncate font-medium text-ink">{inv.name ?? inv.email ?? "Invite"}</span>
                    <code className="flex-1 truncate rounded bg-[#f4f3ef] px-2 py-1 text-[11.5px] text-muted" data-testid="invite-link">{inv.link}</code>
                    <Pill tone={inv.status === "accepted" ? "success" : inv.status === "revoked" ? "danger" : "muted"}>{inv.status}</Pill>
                    <CopyBtn value={inv.link} />
                    {inv.status === "sent" ? (
                      <button onClick={() => setConfirmRevoke(inv)} className="rounded p-0.5 text-muted outline-none transition hover:text-danger focus-visible:ring-2 focus-visible:ring-primary/40" aria-label="Revoke" data-testid="invite-revoke"><X size={15} /></button>
                    ) : null}
                  </div>
                ))}
              </Card>
            )}
          </div>
        </motion.div>
      </AnimatePresence>

      <Modal
        open={!!confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        title="Revoke this invite link"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRevoke(null)}>Cancel</Button>
            <Button variant="danger" loading={revoking} onClick={() => confirmRevoke && revoke(confirmRevoke.id)} data-testid="invite-revoke-confirm">
              <X size={15} /> Revoke link
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          The link for <b>{confirmRevoke?.name ?? confirmRevoke?.email ?? "this invite"}</b> will stop working immediately. Anyone who hasn't accepted it yet won't be able to onboard. You can always create a new link.
        </p>
      </Modal>
    </Page>
  );
}

function CopyBtn({ value }: { value: string }) {
  const [done, setDone] = useState<"idle" | "copied" | "blocked">("idle");
  return (
    <button
      onClick={() => {
        void copyTextToClipboard(value).then((ok) => setDone(ok ? "copied" : "blocked"));
        setTimeout(() => setDone("idle"), 1400);
      }}
      className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-semibold text-ink outline-none transition hover:bg-[#f4f3ef] focus-visible:ring-2 focus-visible:ring-primary/40"
      data-testid="invite-copy"
      title={done === "blocked" ? "Copy blocked. Select the link manually." : undefined}
    >
      {done === "copied" ? <Check size={12} /> : <Copy size={12} />} {done === "copied" ? "Copied" : done === "blocked" ? "Select link" : "Copy"}
    </button>
  );
}
