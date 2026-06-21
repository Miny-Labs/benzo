/**
 * On-chain note discovery — the scanning core shared by the SDK facade and the
 * standalone @benzo/indexer service.
 *
 * Reads the pool's `new_commitment_event` / `new_nullifier_event` and the
 * viewkey-anchor's `mvk_bound_event` from Soroban RPC (cursor-paginated over
 * the full retention window), and reconstructs:
 *   - the ordered pool commitment list (to rebuild a Merkle mirror),
 *   - the spent-nullifier set,
 *   - the MVK-binding ciphertexts (for auditor disclosure).
 *
 * A viewing-key holder trial-decrypts the discovery ciphertexts to find its
 * notes; the scanner itself only ever sees opaque blobs.
 */

import { toHex, fromHex } from "./crypto/bytes.js";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { MerkleTreeMirror } from "./merkle.js";
import { noteCommitment, noteNullifier, orgNullifier } from "./notes.js";
import { decodeNotePlain, open, type NotePlain } from "./viewkeys.js";

export interface CommitmentRecord {
  leafIndex: number;
  commitment: bigint;
  ciphertext: Uint8Array;
  mvkTag: bigint;
  ledger: number;
  /** ledger close time, unix seconds (0 if unknown) */
  ts: number;
  txHash: string;
}

export interface MvkBindingRecord {
  tag: bigint;
  mvkCt: Uint8Array;
  ledger: number;
}

export interface DiscoveredNote {
  leafIndex: number;
  commitment: bigint;
  plain: NotePlain;
}

/** Durable, resumable scanner state (bigints/bytes encoded as strings/hex). */
export interface ScannerSnapshot {
  v: 1;
  cursorLedger: number;
  commitments: Array<{
    leafIndex: number;
    commitment: string;
    ciphertext: string;
    mvkTag: string;
    ledger: number;
    ts: number;
    txHash: string;
  }>;
  nullifiers: string[];
  mvkBindings: Array<{ tag: string; mvkCt: string; ledger: number }>;
}

/** Durable ASP allow-set state: ordered leaves + the last-scanned ledger. */
export interface AspSnapshot {
  v: 1;
  cursorLedger: number;
  leaves: string[];
}

function hexToBytes(hex: string): Uint8Array {
  return fromHex(hex);
}
function nativeToBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return hexToBytes(v);
  throw new Error("expected bytes-like event field");
}
function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  throw new Error(`cannot coerce ${typeof v} to bigint`);
}

export class NoteScanner {
  readonly commitments: CommitmentRecord[] = [];
  readonly nullifiers = new Set<string>();
  readonly mvkBindings: MvkBindingRecord[] = [];
  readonly tree: MerkleTreeMirror;
  cursorLedger: number;

  constructor(readonly treeLevels: number, startLedger: number) {
    this.tree = new MerkleTreeMirror(treeLevels);
    this.cursorLedger = startLedger;
  }

  ingest(ev: {
    ledger: number;
    closedAt?: number;
    txHash: string;
    topicXdr: string[];
    valueXdr: string;
  }): void {
    const topics = ev.topicXdr.map((t) => scValToNative(xdr.ScVal.fromXDR(t, "base64")));
    const value = scValToNative(xdr.ScVal.fromXDR(ev.valueXdr, "base64"));
    const eventName = topics[0];

    if (eventName === "new_commitment_event") {
      const commitment = toBig(topics[topics.length - 1]);
      const v = value as Record<string, unknown>;
      const rec: CommitmentRecord = {
        leafIndex: Number(v.index),
        commitment,
        ciphertext: nativeToBytes(v.encrypted_output),
        mvkTag: toBig(v.mvk_tag),
        ledger: ev.ledger,
        ts: ev.closedAt ?? 0,
        txHash: ev.txHash,
      };
      this.commitments[rec.leafIndex] = rec;
      this.tree.insert(commitment);
    } else if (eventName === "new_nullifier_event") {
      this.nullifiers.add(toBig(topics[topics.length - 1]).toString());
    } else if (eventName === "mvk_bound_event") {
      const v = value as Record<string, unknown>;
      this.mvkBindings.push({
        tag: toBig(topics[topics.length - 1]),
        mvkCt: nativeToBytes(v.mvk_ct),
        ledger: ev.ledger,
      });
    }
    this.cursorLedger = Math.max(this.cursorLedger, ev.ledger);
  }

  isSpent(nullifier: bigint): boolean {
    return this.nullifiers.has(nullifier.toString());
  }

  /** Serialize the scanner's discovered state for durable, incremental resume. */
  snapshot(): ScannerSnapshot {
    return {
      v: 1,
      cursorLedger: this.cursorLedger,
      commitments: this.commitments
        .filter((r): r is CommitmentRecord => !!r)
        .map((r) => ({
          leafIndex: r.leafIndex,
          commitment: r.commitment.toString(),
          ciphertext: toHex(r.ciphertext),
          mvkTag: r.mvkTag.toString(),
          ledger: r.ledger,
          ts: r.ts,
          txHash: r.txHash,
        })),
      nullifiers: [...this.nullifiers],
      mvkBindings: this.mvkBindings.map((b) => ({
        tag: b.tag.toString(),
        mvkCt: toHex(b.mvkCt),
        ledger: b.ledger,
      })),
    };
  }

  /** Rebuild a scanner (commitments, nullifiers, bindings, Merkle tree) from a snapshot. */
  static restore(treeLevels: number, snap: ScannerSnapshot): NoteScanner {
    const s = new NoteScanner(treeLevels, snap.cursorLedger);
    for (const c of snap.commitments) {
      s.commitments[c.leafIndex] = {
        leafIndex: c.leafIndex,
        commitment: BigInt(c.commitment),
        ciphertext: hexToBytes(c.ciphertext),
        mvkTag: BigInt(c.mvkTag),
        ledger: c.ledger,
        ts: c.ts,
        txHash: c.txHash,
      };
    }
    // Rebuild the incremental Merkle tree by inserting commitments in leaf order.
    for (let i = 0; i < s.commitments.length; i++) {
      const rec = s.commitments[i];
      if (rec) s.tree.insert(rec.commitment);
    }
    for (const n of snap.nullifiers) s.nullifiers.add(n);
    for (const b of snap.mvkBindings) {
      s.mvkBindings.push({ tag: BigInt(b.tag), mvkCt: hexToBytes(b.mvkCt), ledger: b.ledger });
    }
    return s;
  }

  /** Pool-tree leaves in leaf-index order (to rebuild a mirror). */
  orderedLeaves(): bigint[] {
    const out: bigint[] = [];
    for (let i = 0; i < this.commitments.length; i++) {
      const rec = this.commitments[i];
      if (!rec) throw new Error(`commitment leaf ${i} missing from events`);
      out.push(rec.commitment);
    }
    return out;
  }

  /** Trial-decrypt every discovery ciphertext with `viewingSecret`. */
  scan(viewingSecret: Uint8Array): DiscoveredNote[] {
    const out: DiscoveredNote[] = [];
    for (const rec of this.commitments) {
      if (!rec) continue;
      const opened = open(rec.ciphertext, viewingSecret);
      if (!opened) continue;
      let plain: NotePlain;
      try {
        plain = decodeNotePlain(opened);
      } catch {
        continue;
      }
      if (noteCommitment(plain) !== rec.commitment) continue; // binding check
      out.push({ leafIndex: rec.leafIndex, commitment: rec.commitment, plain });
    }
    return out;
  }

  /** Discovered notes whose nullifier is not yet spent (spendable balance). */
  spendable(viewingSecret: Uint8Array, spendSk: bigint): DiscoveredNote[] {
    return this.scan(viewingSecret).filter(
      (n) => !this.isSpent(noteNullifier(spendSk, BigInt(n.leafIndex))),
    );
  }

  /**
   * ORG-treasury notes: those owned by an M-of-N member set (recipientPk ==
   * orgRecipientPk) that the org's viewing key can decrypt and that are not yet
   * spent via the org nullifier (keyed by akGroup + blinding, not a single
   * spendSk). This is how the console rediscovers its dual-controlled treasury
   * from chain — no backend storage; the org MVK + akGroup are sufficient.
   */
  orgSpendable(
    viewingSecret: Uint8Array,
    orgRecipientPk: bigint,
    akGroup: bigint,
  ): DiscoveredNote[] {
    return this.scan(viewingSecret)
      .filter((n) => n.plain.recipientPk === orgRecipientPk)
      .filter(
        (n) => !this.isSpent(orgNullifier(akGroup, n.plain.blinding, BigInt(n.leafIndex))),
      );
  }

  /** Auditor disclosure: decrypt MVK-scope ciphertexts with a scoped TVK. */
  auditorScan(tvkSecret: Uint8Array): NotePlain[] {
    const out: NotePlain[] = [];
    for (const b of this.mvkBindings) {
      const opened = open(b.mvkCt, tvkSecret);
      if (!opened) continue;
      try {
        out.push(decodeNotePlain(opened));
      } catch {
        /* out of scope */
      }
    }
    return out;
  }
}

export interface RpcEvent {
  ledger: number;
  ledgerClosedAt?: string;
  txHash: string;
  topic: string[];
  value: string;
}

interface EventsPage {
  events: RpcEvent[];
  cursor?: string;
  latestLedger: number;
}

function cursorLedger(cursor: string | undefined): number {
  if (!cursor) return 0;
  return Number(BigInt(cursor.split("-")[0]) >> 32n);
}

/** One getEvents POST with bounded exponential-backoff retry + timeout. */
async function getEventsRpc(
  rpcUrl: string,
  params: Record<string, unknown>,
): Promise<{ result?: EventsPage; error?: { message: string } }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getEvents", params }),
          signal: ctl.signal,
        });
        if (res.status >= 500 || res.status === 429) {
          lastErr = new Error(`getEvents HTTP ${res.status}`);
          continue; // transient — retry
        }
        return (await res.json()) as { result?: EventsPage; error?: { message: string } };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastErr = e; // network/timeout — retry
    }
  }
  throw new Error(`getEvents failed after retries: ${String(lastErr)}`);
}

/** Collect ALL contract events across the RPC retention window (cursor-paged). */
export async function collectEvents(
  rpcUrl: string,
  contractIds: string[],
  startLedger: number,
): Promise<RpcEvent[]> {
  const post = (params: Record<string, unknown>) => getEventsRpc(rpcUrl, params);

  const filters = [{ type: "contract", contractIds }];
  let json = await post({ startLedger, filters, pagination: { limit: 10000 } });
  // If startLedger has aged out of the retention window, RPC returns a range
  // error naming the oldest retained ledger; restart from there (explicit, not
  // silent — a durable store keeps anything that aged out from a prior sync).
  for (let attempt = 0; attempt < 6 && json.error; attempt++) {
    const m = /(\d+)\s*-\s*(\d+)/.exec(json.error.message);
    if (!m) break;
    json = await post({ startLedger: Number(m[1]) + 16, filters, pagination: { limit: 10000 } });
  }
  if (json.error) throw new Error(`getEvents: ${json.error.message}`);

  const all: RpcEvent[] = [];
  let page = json.result!;
  const latest = page.latestLedger;
  all.push(...page.events);
  let drained = !page.cursor || cursorLedger(page.cursor) >= latest;
  // 1024 pages × 10k = a 10M-event backstop (far beyond testnet), not a
  // functional cap. If it is ever hit before draining, we throw rather than
  // silently truncate (see below).
  for (let guard = 0; guard < 1024 && !drained; guard++) {
    const next = await post({ filters, pagination: { cursor: page.cursor, limit: 10000 } });
    // A mid-pagination error must NOT be swallowed: returning the partial set
    // as if the sync succeeded would let the caller advance the durable cursor
    // past the gap and permanently skip the un-fetched commitments/nullifiers
    // (a missed note, or a spent note shown as spendable). Fail loudly so the
    // caller does not persist an incomplete sync.
    if (next.error) throw new Error(`getEvents (pagination): ${next.error.message}`);
    page = next.result!;
    all.push(...page.events);
    drained = !page.cursor || cursorLedger(page.cursor) >= latest;
  }
  if (!drained) {
    throw new Error(
      "getEvents: pagination exceeded the page budget before reaching latestLedger (incomplete sync)",
    );
  }
  return all;
}

/** Pull events for the given contracts into a scanner. */
export async function syncFromRpc(
  scanner: NoteScanner,
  rpcUrl: string,
  contractIds: string[],
  startLedger: number,
): Promise<number> {
  const events = await collectEvents(rpcUrl, contractIds, startLedger);
  for (const ev of events) {
    scanner.ingest({
      ledger: ev.ledger,
      closedAt: ev.ledgerClosedAt ? Math.floor(Date.parse(ev.ledgerClosedAt) / 1000) : 0,
      txHash: ev.txHash,
      topicXdr: ev.topic,
      valueXdr: ev.value,
    });
  }
  return events.length;
}

/** Reconstruct ordered ASP allow-set leaves from on-chain LeafAdded events. */
export async function fetchAspLeaves(
  rpcUrl: string,
  aspContractId: string,
  startLedger: number,
): Promise<bigint[]> {
  return (await fetchAspLeavesSince(rpcUrl, aspContractId, startLedger, [])).leaves;
}

/**
 * Incremental ASP allow-set fetch: merge new LeafAdded events (from
 * `startLedger`) into `prior` ordered leaves, returning the merged ordered
 * list plus the highest ledger seen (the resume cursor). The allow-set is
 * append-only and index-addressed, so a durable caller persists `{leaves,
 * cursor}` and resumes from `cursor + 1` — never re-fetching the whole set.
 */
export async function fetchAspLeavesSince(
  rpcUrl: string,
  aspContractId: string,
  startLedger: number,
  prior: bigint[],
): Promise<{ leaves: bigint[]; cursor: number }> {
  const events = await collectEvents(rpcUrl, [aspContractId], startLedger);
  const byIndex = new Map<number, bigint>();
  prior.forEach((l, i) => {
    byIndex.set(i, l);
  });
  let cursor = startLedger > 0 ? startLedger - 1 : 0;
  for (const ev of events) {
    if (ev.ledger > cursor) cursor = ev.ledger;
    const name = scValToNative(xdr.ScVal.fromXDR(ev.topic[0], "base64"));
    if (name !== "LeafAdded") continue;
    const v = scValToNative(xdr.ScVal.fromXDR(ev.value, "base64")) as Record<string, unknown>;
    byIndex.set(Number(v.index), toBig(v.leaf));
  }
  const max = byIndex.size === 0 ? -1 : Math.max(...byIndex.keys());
  const leaves: bigint[] = [];
  for (let i = 0; i <= max; i++) {
    const leaf = byIndex.get(i);
    if (leaf === undefined) throw new Error(`ASP leaf index ${i} missing from events`);
    leaves.push(leaf);
  }
  return { leaves, cursor };
}

/**
 * Reconstruct the ordered authorized-MVK registry leaves from on-chain
 * `MvkRegistered` events — the raw leaf values, indexed by the event's `index`,
 * so `MvkRegistryMirror.syncLeaves(...)` can resume a registry that already
 * holds entries (e.g. a second e2e flow appending to the same deployment).
 */
export async function fetchMvkRegistryLeaves(
  rpcUrl: string,
  registryContractId: string,
  startLedger: number,
): Promise<bigint[]> {
  const events = await collectEvents(rpcUrl, [registryContractId], startLedger);
  const byIndex = new Map<number, bigint>();
  for (const ev of events) {
    const name = scValToNative(xdr.ScVal.fromXDR(ev.topic[0], "base64"));
    if (name !== "MvkRegistered") continue;
    const v = scValToNative(xdr.ScVal.fromXDR(ev.value, "base64")) as Record<string, unknown>;
    byIndex.set(Number(v.index), toBig(v.leaf));
  }
  const max = byIndex.size === 0 ? -1 : Math.max(...byIndex.keys());
  const leaves: bigint[] = [];
  for (let i = 0; i <= max; i++) {
    const leaf = byIndex.get(i);
    if (leaf === undefined) throw new Error(`MVK registry leaf index ${i} missing from events`);
    leaves.push(leaf);
  }
  return leaves;
}
