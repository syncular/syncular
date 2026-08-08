/**
 * @syncular/server — framework-free embeddable SSP2 protocol library
 * (SPEC.md is normative).
 *
 * Core surface: `handleSyncRequest(bytes, ctx) → bytes` over host-provided
 * storage / scope-resolution / segment-store interfaces, plus a
 * transport-agnostic realtime session (§8), the direct segment download
 * handler (§5.5), and signed-URL token issuance/verification (§5.4).
 */
export * from './admin';
export * from './authoritative-query';
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
export * from './operations';
export * from './operations-realtime';
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
export * from './readiness';
export {
  DEFAULT_REACTION_INITIAL_BACKOFF_MS,
  DEFAULT_REACTION_LEASE_MS,
  DEFAULT_REACTION_MAX_ATTEMPTS,
  DEFAULT_REACTION_MAX_BACKOFF_MS,
  DEFAULT_REACTION_RETENTION,
  MAX_REACTION_FAILURE_DETAILS_BYTES,
  MAX_REACTION_PAYLOAD_BYTES,
  MAX_REACTIONS_PER_COMMIT,
  PermanentReactionError,
  pruneReactions,
  ReactionRunner,
  reactionIdempotencyKey,
  retryDeadLetterReaction,
  RetryableReactionError,
  type PlannedReaction,
  type PruneReactionsOptions,
  type ReactionHandler,
  type ReactionHandlerInput,
  type ReactionHandlers,
  type ReactionPlan,
  type ReactionPlanner,
  type ReactionPlannerInput,
  type ReactionPruneResult,
  type ReactionRetentionPolicy,
  type ReactionRunnerOptions,
  type ReactionRunResult,
  type ReactionTypeMap,
} from './reactions';
export * from './realtime';
export * from './restore';
export * from './relational-rows';
export * from './s3-blob-store';
export * from './s3-segment-store';
export * from './schema';
export * from './scopes';
export * from './seed';
export * from './segment-download';
export * from './segment-store';
export * from './signed-url';
export * from './sqlite-dialect';
export * from './sqlite-driver';
export {
  IMAGE_METADATA_TABLE,
  IMAGE_VERSION_COLUMN,
  type SqliteImageBuilder,
  type SqliteImageInput,
} from './sqlite-image';
export * from './sqlite-blob-store';
export * from './sqlite-lease-store';
export * from './sqlite-segment-store';
export * from './sqlite-storage';
export * from './storage';
export {
  StorageQueryError,
  type StorageQueryErrorCode,
} from './storage-errors';
export * from './validate';
