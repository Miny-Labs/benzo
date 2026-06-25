/**
 * Settings & team — members + roles, counterparties, and connected integrations.
 * Read-mostly here; the heavy actions live on their own screens.
 */
import { Fragment, useEffect, useState } from "react";
import { Building2, Check, Minus, Plug, ShieldCheck, Users } from "lucide-react";
import type { Integration } from "@benzo/types";
import { api } from "../lib/api";
import { useConsole } from "../lib/store";
import { ROLES, roleHas, PERMISSION_GROUPS, ROLE_BLURB } from "../lib/permissions";
import { Page, Stagger } from "../ui/motion";
import { Card, Pill, Skeleton, StatusPill } from "../ui/primitives";

export function SettingsScreen() {
  const { members, counterparties, session, loading } = useConsole();
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  useEffect(() => {
    api.integrations().then(setIntegrations).catch(() => setIntegrations([]));
  }, []);

  return (
    <Page>
      <div className="mb-5">
        <h1 className="font-display text-2xl">Settings & team</h1>
        <p className="mt-1 text-[13.5px] text-muted">{session?.org.legalName ?? session?.org.name} · {session?.org.country ?? "Country not set"} · KYB {session?.org.kybStatus}</p>
      </div>

      <Stagger className="space-y-4">
        <Stagger.Item index={0}>
          <Card className="p-0">
            <div className="flex items-center gap-2 border-b border-border px-5 py-3.5 text-[13px] font-semibold">
              <Users size={15} /> Team
            </div>
            <div className="divide-y divide-border">
              {loading && members.length === 0 ? (
                [0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3">
                    <Skeleton className="h-8 w-8 flex-none rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-32" />
                      <Skeleton className="h-3 w-44" />
                    </div>
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </div>
                ))
              ) : members.length === 0 ? (
                <div className="px-5 py-4 text-[13px] text-muted">No team members yet.</div>
              ) : (
                members.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 px-5 py-3 text-[13.5px]">
                    <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-ink text-[11px] font-bold text-white">
                      {(m.name ?? m.email).slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{m.name ?? m.email}</div>
                      <div className="truncate text-[12px] text-muted">{m.email}</div>
                    </div>
                    <Pill tone="primary">{m.role}</Pill>
                    <StatusPill status={m.status} />
                  </div>
                ))
              )}
            </div>
          </Card>
        </Stagger.Item>

        {/* B5 — roles & permissions matrix (driven by ROLE_PERMISSIONS) */}
        <Stagger.Item index={1}>
          <Card className="p-0" data-testid="roles-matrix">
            <div className="flex items-center gap-2 border-b border-border px-5 py-3.5 text-[13px] font-semibold">
              <ShieldCheck size={15} /> Roles & permissions
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[660px] text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="px-5 py-3 font-medium text-muted">Permission</th>
                    {ROLES.map((r) => (
                      <th key={r} className="px-3 py-3 text-center align-top">
                        <div className="font-semibold capitalize">{r}</div>
                        <div className="mx-auto mt-0.5 max-w-[110px] text-[11px] font-normal leading-tight text-muted">{ROLE_BLURB[r]}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PERMISSION_GROUPS.map((g) => (
                    <Fragment key={g.group}>
                      <tr>
                        <td colSpan={ROLES.length + 1} className="bg-canvas px-5 py-1.5 text-[11px] font-bold uppercase tracking-[0.05em] text-muted">{g.group}</td>
                      </tr>
                      {g.items.map((item) => (
                        <tr key={item.key} className="border-b border-border/60">
                          <td className="px-5 py-2.5">{item.label}</td>
                          {ROLES.map((r) => (
                            <td key={r} className="px-3 py-2.5 text-center" data-testid={`perm-${r}-${item.key}`}>
                              {roleHas(r, item.key) ? <Check size={15} className="mx-auto text-success" /> : <Minus size={14} className="mx-auto text-border" />}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-1.5 border-t border-border px-5 py-3 text-[12px] text-muted">
              <ShieldCheck size={13} className="text-primary" /> Auditor is a scoped viewing-key holder — read-only, never a signer. A privacy-native role.
            </div>
          </Card>
        </Stagger.Item>

        <Stagger.Item index={2}>
          <Card className="p-0">
            <div className="flex items-center gap-2 border-b border-border px-5 py-3.5 text-[13px] font-semibold">
              <Building2 size={15} /> Vendors & contractors
            </div>
            <div className="divide-y divide-border">
              {loading && counterparties.length === 0 ? (
                [0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3">
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-36" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </div>
                ))
              ) : counterparties.length === 0 ? (
                <div className="px-5 py-4 text-[13px] text-muted">No vendors or contractors yet.</div>
              ) : (
                counterparties.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 px-5 py-3 text-[13.5px]">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{c.name}</div>
                      <div className="text-[12px] capitalize text-muted">{c.type}</div>
                    </div>
                    <StatusPill status={c.status} />
                  </div>
                ))
              )}
            </div>
          </Card>
        </Stagger.Item>

        <Stagger.Item index={3}>
          <Card className="p-0">
            <div className="flex items-center gap-2 border-b border-border px-5 py-3.5 text-[13px] font-semibold">
              <Plug size={15} /> Integrations
            </div>
            <div className="divide-y divide-border">
              {integrations === null ? (
                [0, 1].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3">
                    <Skeleton className="h-3.5 w-28 flex-1" />
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </div>
                ))
              ) : integrations.length === 0 ? (
                <div className="px-5 py-4 text-[13px] text-muted">No integrations connected.</div>
              ) : (
                integrations.map((it) => (
                  <div key={it.id} className="flex items-center gap-3 px-5 py-3 text-[13.5px]">
                    <div className="min-w-0 flex-1 truncate capitalize">{it.provider}</div>
                    <StatusPill status={it.status} />
                  </div>
                ))
              )}
            </div>
          </Card>
        </Stagger.Item>
      </Stagger>
    </Page>
  );
}
