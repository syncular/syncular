/**
 * @syncular-v2/server — framework-free embeddable SSP2 protocol library
 * (SPEC.md is normative; REVISE.md B2 is the architectural mandate).
 *
 * Core surface: `handleSyncRequest(bytes, ctx) → bytes` over host-provided
 * storage / scope-resolution / segment-store interfaces, plus a
 * transport-agnostic realtime session (§8), the direct segment download
 * handler (§5.5), and signed-URL token issuance/verification (§5.4).
 */
export * from './admin';
export * from './blob-handlers';
export * from './blob-store';
export * from './content-encoding';
export * from './context';
export * from './crdt-merger';
export * from './d1-storage';
export * from './errors';
export * from './events';
export * from './events-ring';
export * from './frame-bytes';
export * from './handler';
export * from './lease-store';
// The `PgExecutor` seam + Postgres storage/fanout are driver-agnostic (zero
// runtime deps). Concrete driver adapters (pglite for tests; Bun.sql /
// node-postgres for production, documented in the README) live in separate
// entry points so the barrel never imports a driver.
export * from './pg-executor';
export * from './postgres-fanout';
export * from './postgres-storage';
export * from './prune';
export * from './pull';
export * from './push';
export * from './realtime';
export * from './s3-blob-store';
export * from './s3-segment-store';
export * from './schema';
export * from './scopes';
export * from './segment-download';
export * from './segment-store';
export * from './signed-url';
// Bun-specific storages (top-level `bun:sqlite`): re-exported for Bun/Node
// hosts. Workers/edge builds tree-shake them (and their `bun:sqlite` import)
// away — the runtime-neutral core closure is enforced by
// `test/runtime-neutrality.test.ts`.
export * from './sqlite-blob-store';
export * from './sqlite-dialect';
export * from './sqlite-image';
export * from './sqlite-lease-store';
export * from './sqlite-segment-store';
export * from './sqlite-storage';
export * from './storage';
export * from './validate';
