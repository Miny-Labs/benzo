/**
 * @benzo/indexer — self-hosted note-discovery indexer.
 *
 * The scanning core now lives in @benzo/sdk (`NoteScanner`, `collectEvents`,
 * `syncFromRpc`, `fetchAspLeaves`) so the SDK facade and this standalone
 * service share one implementation. This package re-exports that core under
 * the historical names and adds the HTTP server (`src/server.ts`).
 */

export {
  NoteScanner,
  NoteScanner as BenzoIndexer, // historical alias
  collectEvents,
  syncFromRpc,
  fetchAspLeaves,
  type CommitmentRecord,
  type MvkBindingRecord,
  type DiscoveredNote,
  type RpcEvent,
} from "@benzo/sdk";
