/**
 * The public seeding helper (RFC 0002 §2.5): push app-shaped mutations
 * through the REAL push path — one `handleSyncRequest` round built from the
 * server schema — so demos, dev servers, and ops scripts seed data with one
 * supported call. This is the same §6 pipeline every client write takes
 * (authorization, validation, idempotency, realtime fanout), so seeded rows
 * behave exactly like synced rows.
 *
 * Idempotent by construction (§2.3): the commit id is stable, so re-running
 * the seed replays the cached push result and writes nothing twice.
 */
import {
  decodeMessage,
  encodeMessage,
  encodeRow,
  PROTOCOL_WIRE_VERSION,
  type PushOperation,
  type PushResultFrame,
  type RequestFrame,
  type RowValue,
} from '@syncular/core';
import type { SyncServerConfig } from './context';
import { SyncError } from './errors';
import type { SyncularServerEvent, SyncularServerEvents } from './events';
import { composeEvents } from './events-ring';
import { handleSyncRequest } from './handler';

/** One app-shaped seed mutation — the same vocabulary as client mutations. */
export type SeedMutation =
  | {
      readonly table: string;
      readonly op: 'upsert';
      /**
       * Full-row values keyed by column name (§6.1). Keys are accepted in
       * the SQL-truth snake_case or the generated row types' camelCase;
       * missing nullable columns become NULL.
       */
      readonly values: Readonly<Record<string, unknown>>;
    }
  | {
      readonly table: string;
      readonly op: 'delete';
      readonly rowId: string;
    };

export interface SeedTarget {
  readonly partition: string;
  readonly actorId: string;
  /**
   * The synthetic client identity of the seed (default `'seed'`). Together
   * with `commitId` it forms the §2.3 idempotency key — keep both stable
   * for a re-runnable seed, vary `commitId` to seed additional batches.
   */
  readonly clientId?: string;
  /** The client commit id (default `'seed-commit-1'`). */
  readonly commitId?: string;
}

export interface SeedMutationErrorOptions {
  readonly clientId: string;
  readonly clientCommitId: string;
  readonly opIndex: number;
  readonly code: string;
  readonly replayed: boolean;
  readonly retryable: boolean;
  readonly message: string;
  readonly recordedAtMs?: number;
  readonly cacheIdentity?: string;
}

/** Structured terminal failure from the real push path used by a seed. */
export class SeedMutationError extends Error {
  override readonly name = 'SeedMutationError';
  readonly clientId: string;
  readonly clientCommitId: string;
  readonly opIndex: number;
  /** Exact protocol or host-validator rejection code. */
  readonly code: string;
  readonly replayed: boolean;
  readonly retryable: boolean;
  readonly recordedAtMs?: number;
  readonly cacheIdentity?: string;

  constructor(options: SeedMutationErrorOptions) {
    super(options.message);
    this.clientId = options.clientId;
    this.clientCommitId = options.clientCommitId;
    this.opIndex = options.opIndex;
    this.code = options.code;
    this.replayed = options.replayed;
    this.retryable = options.retryable;
    if (options.recordedAtMs !== undefined) {
      this.recordedAtMs = options.recordedAtMs;
    }
    if (options.cacheIdentity !== undefined) {
      this.cacheIdentity = options.cacheIdentity;
    }
  }
}

const MAPPABLE_RE = /^_*[A-Za-z][A-Za-z0-9_]*$/;

/** Pinned §12 schema alias used by generated row types and every client host. */
function snakeToCamel(name: string): string {
  if (!MAPPABLE_RE.test(name)) return name;
  const lead = /^_*/.exec(name)?.[0] ?? '';
  const bare = name.slice(lead.length);
  const trail = /_*$/.exec(bare)?.[0] ?? '';
  const middle = bare.slice(0, bare.length - trail.length);
  const segments = middle.split('_').filter((segment) => segment.length > 0);
  if (segments.length === 0) return name;
  const first = segments[0] as string;
  return (
    lead +
    first +
    segments
      .slice(1)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join('') +
    trail
  );
}

/**
 * Seed `mutations` into a partition through the real push path. Throws a
 * `SeedMutationError` when the push is rejected and `SyncError` for malformed
 * helper input, so a broken seed fails loud instead of serving an empty store.
 */
export async function seedMutations(
  config: SyncServerConfig,
  target: SeedTarget,
  mutations: readonly SeedMutation[],
): Promise<void> {
  const clientId = target.clientId ?? 'seed';
  const clientCommitId = target.commitId ?? 'seed-commit-1';
  const operations: PushOperation[] = mutations.map((mutation) => {
    const table = config.schema.tables.find((t) => t.name === mutation.table);
    if (table === undefined) {
      throw new SyncError(
        'sync.invalid_request',
        `seedMutations: unknown table ${JSON.stringify(mutation.table)}`,
      );
    }
    if (mutation.op === 'delete') {
      return { table: mutation.table, rowId: mutation.rowId, op: 'delete' };
    }
    // Normalize record keys to column positions (snake_case or camelCase,
    // the two casings the client tier accepts).
    const byColumn = new Map<string, unknown>();
    for (const [key, value] of Object.entries(mutation.values)) {
      const column = table.columns.find(
        (candidate) =>
          candidate.name === key || snakeToCamel(candidate.name) === key,
      );
      if (column === undefined) {
        throw new SyncError(
          'sync.invalid_request',
          `seedMutations: table ${table.name}: unknown column ${JSON.stringify(key)}`,
        );
      }
      const name = column.name;
      if (byColumn.has(name)) {
        throw new SyncError(
          'sync.invalid_request',
          `seedMutations: table ${table.name}: column ${JSON.stringify(name)} appears twice (snake_case and camelCase) — pass it once`,
        );
      }
      byColumn.set(name, value);
    }
    const values = table.columns.map(
      (column) => (byColumn.get(column.name) ?? null) as RowValue,
    );
    const pkIndex = table.columns.findIndex((c) => c.name === table.primaryKey);
    const rowId = values[pkIndex];
    if (typeof rowId !== 'string' || rowId.length === 0) {
      throw new SyncError(
        'sync.invalid_request',
        `seedMutations: table ${table.name}: upsert requires a non-empty string primary key`,
      );
    }
    return {
      table: mutation.table,
      rowId,
      op: 'upsert',
      payload: encodeRow(table.columns, values),
    };
  });

  const frames: RequestFrame[] = [
    { type: 'REQ_HEADER', clientId, schemaVersion: config.schema.version },
    { type: 'PUSH_COMMIT', clientCommitId, operations },
    // A pull that asks for nothing: the round exists for its push half.
    {
      type: 'PULL_HEADER',
      limitCommits: 0,
      limitSnapshotRows: 0,
      maxSnapshotPages: 0,
      accept: 0b0011,
    },
  ];
  type SeedTerminalEvent = Extract<
    SyncularServerEvent,
    { type: 'push.rejected' | 'push.conflicted' }
  >;
  let terminalEvent: SeedTerminalEvent | undefined;
  const capture: SyncularServerEvents = {
    emit(event) {
      if (
        (event.type === 'push.rejected' || event.type === 'push.conflicted') &&
        event.clientId === clientId &&
        event.clientCommitId === clientCommitId
      ) {
        terminalEvent = event;
      }
    },
  };
  const response = await handleSyncRequest(
    encodeMessage({
      wireVersion: PROTOCOL_WIRE_VERSION,
      msgKind: 'request',
      frames,
    }),
    {
      ...config,
      partition: target.partition,
      actorId: target.actorId,
      events:
        config.events === undefined
          ? capture
          : composeEvents(config.events, capture),
    },
  );

  // Fail loud: surface the first rejected/failed operation.
  const message = decodeMessage(response);
  const result = message.frames.find(
    (frame): frame is PushResultFrame =>
      frame.type === 'PUSH_RESULT' && frame.clientCommitId === clientCommitId,
  );
  if (result === undefined) {
    throw new SyncError(
      'sync.invalid_request',
      'seedMutations: the sync response carried no push result',
    );
  }
  if (result.status === 'rejected') {
    const failed = result.results.find((r) => r.status !== 'applied');
    const code = failed?.code ?? 'sync.invalid_request';
    const opIndex = failed?.opIndex ?? 0;
    const retryable = failed?.status === 'error' ? failed.retryable : false;
    const detail =
      failed === undefined
        ? ''
        : ` (op ${opIndex}: ${code} — ${failed.message})`;
    const replayed = terminalEvent?.replay ?? false;
    throw new SeedMutationError({
      clientId,
      clientCommitId,
      opIndex,
      code,
      replayed,
      retryable,
      message: `seedMutations: the seed commit was rejected${
        replayed ? ' (cached replay)' : ''
      }${detail}`,
      ...(terminalEvent?.recordedAtMs !== undefined
        ? { recordedAtMs: terminalEvent.recordedAtMs }
        : {}),
      ...(terminalEvent?.cacheIdentity !== undefined
        ? { cacheIdentity: terminalEvent.cacheIdentity }
        : {}),
    });
  }
}
