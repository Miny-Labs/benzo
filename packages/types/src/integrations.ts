import type { IntegrationId, OrgId, Timestamp } from "./common.js";

/** Third-party connector records for provider sync status. */
export type IntegrationProvider =
  | "merge"
  | "quickbooks"
  | "xero"
  | "plaid"
  | "slack"
  | "gusto";

export type IntegrationCategory = "accounting" | "hris" | "banking_data" | "notifications";

export const PROVIDER_CATEGORY: Record<IntegrationProvider, IntegrationCategory> = {
  merge: "accounting",
  quickbooks: "accounting",
  xero: "accounting",
  plaid: "banking_data",
  slack: "notifications",
  gusto: "hris",
};

export type IntegrationStatus = "disconnected" | "connected" | "error";

/** A connected integration for an org. */
export interface Integration {
  id: IntegrationId;
  orgId: OrgId;
  provider: IntegrationProvider;
  status: IntegrationStatus;
  /** provider-side ids (linked account / company / item), non-secret */
  externalRefs?: Record<string, string>;
  connectedAt?: Timestamp;
  lastSyncAt?: Timestamp;
  lastError?: string;
}
