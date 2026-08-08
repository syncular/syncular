/**
 * @syncular/client is the TypeScript client protocol core.
 * SPEC.md is normative.
 *
 * Browser-safe root: database backends live behind subpath exports
 * (`./sqlite` for Node or Bun, `./wasm` for sqlite-wasm + OPFS); the
 * worker-side bootstrap lives behind `./worker`. The main-thread handle
 * (`worker-host`) and the RPC protocol types are root exports — they
 * import no SQLite.
 */
export * from './apply';
export * from './availability';
export * from './blob';
export * from './browser-storage-persistence';
export * from './client';
export * from './content-type';
export * from './database';
export * from './devtools';
export * from './diagnostics';
export * from './encryption';
export * from './errors';
export * from './http';
export * from './invalidation';
export * from './leader-lock';
export * from './local-purge';
export * from './local-rebootstrap';
export * from './multi-tab';
export * from './naming';
export * from './outbox';
export * from './outcomes';
export * from './query-guard';
export * from './reactive-store';
export * from './remote';
export * from './realtime-supervisor';
export * from './schema';
export * from './sql-tag';
export * from './state';
export * from './sync-scheduler';
export * from './transport';
export * from './window';
export * from './worker-host';
export * from './worker-protocol';
