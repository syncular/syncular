/**
 * CRDT column merge registry (SPEC.md §5.10.2) — the pluggability seam.
 *
 * The server core NEVER depends on a CRDT library. A `crdt` column (§2.4
 * tag 8) is merged server-side on push (§5.10.3) by a host-supplied
 * `CrdtMerger`, selected per column by its schema-IR `crdtType` (§5.10.1).
 * The reference `yjs-doc` merger lives in `@syncular/crdt-yjs`, keeping
 * Yjs out of core/server (the blob-store placement rule, §5.9.2, applied to
 * CRDT).
 */

/**
 * Merge a `crdt` column's stored value with an incoming push value,
 * returning the new stored bytes (§5.10.2). `stored` is `null` when the row
 * is new or the column was NULL. Implementations MUST be commutative,
 * associative, and idempotent over the updates they consume — the CRDT
 * contract that makes concurrent-order-independent convergence and
 * idempotent replay hold (§5.10.3).
 *
 * A synchronous return is fine; async is allowed so a native/WASM merger can
 * cross an FFI boundary.
 */
export type CrdtMerger = (
  stored: Uint8Array | null,
  incoming: Uint8Array,
) => Uint8Array | Promise<Uint8Array>;

/**
 * `crdtType` (§5.10.1) → merger. Supplied through `SyncServerConfig`
 * (§ context). Absent ⇒ no column can CRDT-merge: a push touching a `crdt`
 * column then fails `sync.crdt_merge_failed` (§5.10.2, §5.10.6).
 */
export type CrdtMergerRegistry = Readonly<Record<string, CrdtMerger>>;
