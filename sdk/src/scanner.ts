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

import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { MerkleTreeMirror } from "./merkle.js";
import { noteCommitment, noteNullifier } from "./notes.js";
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

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}
function nativeToBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
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

/** Collect ALL contract events across the RPC retention window (cursor-paged). */
export async function collectEvents(
  rpcUrl: string,
  contractIds: string[],
  startLedger: number,
): Promise<RpcEvent[]> {
  const post = (params: Record<string, unknown>) =>
    fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getEvents", params }),
    }).then((r) => r.json() as Promise<{ result?: EventsPage; error?: { message: string } }>);

  const filters = [{ type: "contract", contractIds }];
  let json = await post({ startLedger, filters, pagination: { limit: 10000 } });
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
  for (let guard = 0; guard < 64; guard++) {
    if (!page.cursor || cursorLedger(page.cursor) >= latest) break;
    const next = await post({ filters, pagination: { cursor: page.cursor, limit: 10000 } });
    if (next.error) break;
    page = next.result!;
    all.push(...page.events);
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
  const events = await collectEvents(rpcUrl, [aspContractId], startLedger);
  const byIndex = new Map<number, bigint>();
  for (const ev of events) {
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
  return leaves;
}
