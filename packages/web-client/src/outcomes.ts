/**
 * Durable per-client commit outcomes.
 *
 * The journal is client-local protected database state. A final push result is
 * written in the same SQLite transaction that drains its outbox commit, so a
 * restart can never turn "rejected" into an inferred success. Conflict payloads
 * deliberately stay local; retention never deletes an unresolved failure.
 */
import type { RejectionDetails, RowValue } from '@syncular/core';
import type { ClientDatabase } from './database';
import { ClientSyncError } from './errors';
import type { OutboxOperation } from './outbox';
import {
  mapRowValues,
  type JsonRowValue,
  jsonToRowValue,
  rowValueToJson,
} from './schema';

export interface ConflictRecord {
  readonly clientCommitId: string;
  readonly opIndex: number;
  readonly table: string;
  readonly rowId: string;
  readonly code: string;
  readonly message: string;
  readonly serverVersion: number;
  /** The current server row, decoded — resolve without a round-trip. */
  readonly serverRow: Readonly<Record<string, RowValue>>;
  /**
   * §6.3: the present columns whose `column_version` exceeded the losing
   * operation's `baseVersion`. A custom merge recomputes exactly these;
   * keep-server and keep-local ignore them (§6.5).
   */
  readonly conflictColumns: readonly string[];
  /** The losing local operation (absent only for malformed op indexes). */
  readonly operation?: OutboxOperation;
}

export interface RejectionRecord {
  readonly clientCommitId: string;
  readonly opIndex: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  /** Bounded host-declared metadata safe for authorized recovery UI. */
  readonly details?: RejectionDetails;
  readonly operation?: OutboxOperation;
}

export type CommitOutcomeStatus =
  | 'applied'
  | 'cached'
  | 'conflict'
  | 'rejected';

export type CommitOutcomeResolution =
  | 'active'
  | 'resolved_keep_server'
  | 'superseded'
  | 'dismissed';

export type CommitOperationOutcome =
  | {
      readonly status: 'applied';
      readonly opIndex: number;
    }
  | {
      readonly status: 'conflict';
      readonly conflict: ConflictRecord;
    }
  | {
      readonly status: 'error';
      readonly rejection: RejectionRecord;
    };

export interface RetainedCommitRow {
  /** Authorized different-primary-key server rows matching intended unique keys. */
  readonly uniqueConflicts?: readonly {
    readonly index: string;
    readonly columns: readonly string[];
    readonly rowId: string;
    readonly serverRow: Readonly<Record<string, RowValue>>;
    readonly serverVersion: number;
  }[];
  readonly table: string;
  readonly rowId: string;
  /** Complete intended row, or null for a local deletion. */
  readonly localRow: Readonly<Record<string, RowValue>> | null;
  /** Latest authorized server base, or null for an absent server row. */
  readonly serverRow: Readonly<Record<string, RowValue>> | null;
  readonly serverVersion: number | null;
}

export interface CommitOutcome {
  /** Monotonic local journal order; not a server sequence. */
  readonly sequence: number;
  readonly clientCommitId: string;
  readonly status: CommitOutcomeStatus;
  readonly recordedAtMs: number;
  readonly results: readonly CommitOperationOutcome[];
  /**
   * Complete local failed-commit envelope, retained after outbox drain so an
   * authorized application can reconstruct atomic aggregate intent. Absent
   * for successful and historical outcomes. Never sent over the wire.
   */
  readonly operations?: readonly OutboxOperation[];
  readonly retainedRows?: readonly RetainedCommitRow[];
  readonly resolution: CommitOutcomeResolution;
  readonly resolvedAtMs?: number;
  readonly replacementClientCommitId?: string;
}

export interface CommitOutcomeQuery {
  /** Newest-first result cap. Defaults to all retained entries. */
  readonly limit?: number;
  /** Only unresolved conflict/rejection outcomes. */
  readonly activeOnly?: boolean;
}

export interface ResolveCommitOutcomeInput {
  readonly clientCommitId: string;
  readonly resolution: Exclude<CommitOutcomeResolution, 'active'>;
  readonly replacementClientCommitId?: string;
}

interface StoredConflictRecord extends Omit<
  ConflictRecord,
  'serverRow' | 'conflictColumns'
> {
  readonly serverRow: Readonly<Record<string, JsonRowValue>>;
  /** Absent in journal entries written before wire version 3. */
  readonly conflictColumns?: readonly string[];
}

type StoredCommitOperationOutcome =
  | Extract<CommitOperationOutcome, { status: 'applied' }>
  | { readonly status: 'conflict'; readonly conflict: StoredConflictRecord }
  | Extract<CommitOperationOutcome, { status: 'error' }>;

function encodeResults(results: readonly CommitOperationOutcome[]): string {
  const stored: StoredCommitOperationOutcome[] = results.map((result) => {
    if (result.status !== 'conflict') return result;
    return {
      status: 'conflict',
      conflict: {
        ...result.conflict,
        serverRow: mapRowValues(result.conflict.serverRow, rowValueToJson),
      },
    };
  });
  return JSON.stringify(stored);
}

function decodeResults(raw: string): CommitOperationOutcome[] {
  const stored = JSON.parse(raw) as StoredCommitOperationOutcome[];
  return stored.map((result) => {
    if (result.status !== 'conflict') return result;
    return {
      status: 'conflict',
      conflict: {
        ...result.conflict,
        // Pre-column-version journal entries carry no conflictColumns.
        conflictColumns: result.conflict.conflictColumns ?? [],
        serverRow: mapRowValues(result.conflict.serverRow, jsonToRowValue),
      },
    };
  });
}

function parseOutcome(
  db: ClientDatabase,
  row: Readonly<Record<string, unknown>>,
): CommitOutcome {
  const retainedRows: RetainedCommitRow[] = db
    .query(
      'SELECT tbl,id,intent,base,version,unique_conflicts FROM _syncular_failed_rows WHERE commit_id=? ORDER BY idx',
      [String(row.client_commit_id)],
    )
    .map((retained) => {
      const decode = (value: unknown): Record<string, RowValue> | null =>
        value === null
          ? null
          : Object.fromEntries(
              Object.entries(
                JSON.parse(String(value)) as Record<string, JsonRowValue>,
              ).map(([key, value]) => [key, jsonToRowValue(value)]),
            );
      return {
        table: String(retained.tbl),
        rowId: String(retained.id),
        localRow: decode(retained.intent),
        ...(retained.unique_conflicts === null
          ? {}
          : {
              uniqueConflicts: (
                JSON.parse(String(retained.unique_conflicts)) as NonNullable<
                  RetainedCommitRow['uniqueConflicts']
                >
              ).map((conflict) => ({
                ...conflict,
                serverRow: decode(JSON.stringify(conflict.serverRow))!,
              })),
            }),
        serverRow: decode(retained.base),
        serverVersion:
          retained.version === null ? null : Number(retained.version),
      };
    });
  return {
    sequence: row.seq as number,
    clientCommitId: row.client_commit_id as string,
    status: row.status as CommitOutcomeStatus,
    recordedAtMs: row.recorded_at_ms as number,
    results: decodeResults(row.results as string),
    ...(typeof row.operations === 'string'
      ? { operations: JSON.parse(row.operations) as OutboxOperation[] }
      : {}),
    ...(retainedRows.length > 0 ? { retainedRows } : {}),
    resolution: row.resolution as CommitOutcomeResolution,
    ...(typeof row.resolved_at_ms === 'number'
      ? { resolvedAtMs: row.resolved_at_ms }
      : {}),
    ...(typeof row.replacement_client_commit_id === 'string'
      ? { replacementClientCommitId: row.replacement_client_commit_id }
      : {}),
  };
}

export function recordCommitOutcome(
  db: ClientDatabase,
  outcome: Omit<CommitOutcome, 'sequence' | 'resolution'>,
): CommitOutcome {
  db.exec(
    "INSERT INTO _syncular_commit_outcomes(client_commit_id,status,recorded_at_ms,results,operations,resolution)VALUES(?,?,?,?,?,'active')",
    [
      outcome.clientCommitId,
      outcome.status,
      outcome.recordedAtMs,
      encodeResults(outcome.results),
      outcome.operations === undefined
        ? null
        : JSON.stringify(outcome.operations),
    ],
  );
  return commitOutcome(db, outcome.clientCommitId) as CommitOutcome;
}

export function commitOutcome(
  db: ClientDatabase,
  clientCommitId: string,
): CommitOutcome | undefined {
  const row = db.query(
    'SELECT seq,client_commit_id,status,recorded_at_ms,results,operations,resolution,resolved_at_ms,replacement_client_commit_id FROM _syncular_commit_outcomes WHERE client_commit_id=?',
    [clientCommitId],
  )[0];
  return row === undefined ? undefined : parseOutcome(db, row);
}

export function listCommitOutcomes(
  db: ClientDatabase,
  query: CommitOutcomeQuery = {},
): CommitOutcome[] {
  const limit = query.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new ClientSyncError(
      'sync.invalid_request',
      'commit outcome limit must be a positive safe integer',
    );
  }
  const where = query.activeOnly
    ? "WHERE resolution = 'active' AND status IN ('conflict', 'rejected')"
    : '';
  const rows = db.query(
    `SELECT seq,client_commit_id,status,recorded_at_ms,results,operations,resolution,resolved_at_ms,replacement_client_commit_id FROM _syncular_commit_outcomes ${where} ORDER BY seq DESC${limit === undefined ? '' : ' LIMIT ?'}`,
    limit === undefined ? [] : [limit],
  );
  return rows.map((row) => parseOutcome(db, row));
}

export function persistCommitOutcomeResolution(
  db: ClientDatabase,
  input: ResolveCommitOutcomeInput,
  nowMs: number,
): CommitOutcome | undefined {
  db.exec(
    "UPDATE _syncular_commit_outcomes SET resolution=?,resolved_at_ms=?,replacement_client_commit_id=? WHERE client_commit_id=? AND resolution='active'",
    [
      input.resolution,
      nowMs,
      input.replacementClientCommitId ?? null,
      input.clientCommitId,
    ],
  );
  return commitOutcome(db, input.clientCommitId);
}

/**
 * Bound journal growth without deleting active failures. If active failures
 * alone exceed the cap the journal intentionally remains over-capacity.
 */
export function pruneCommitOutcomes(
  db: ClientDatabase,
  maxEntries: number,
): number {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new ClientSyncError(
      'sync.invalid_request',
      'outcome retention maxEntries must be a positive safe integer',
    );
  }
  const count = db.query(
    'SELECT COUNT(*) AS count FROM _syncular_commit_outcomes',
  )[0]?.count as number | undefined;
  const excess = Math.max(0, (count ?? 0) - maxEntries);
  if (excess === 0) return 0;
  const candidates = db.query(
    "SELECT seq FROM _syncular_commit_outcomes WHERE status IN('applied','cached')OR resolution !='active' ORDER BY seq ASC LIMIT ?",
    [excess],
  );
  for (const candidate of candidates) {
    db.exec('DELETE FROM _syncular_commit_outcomes WHERE seq=?', [
      candidate.seq as number,
    ]);
  }
  return candidates.length;
}

export function activeFailureRecords(outcomes: readonly CommitOutcome[]): {
  readonly conflicts: ConflictRecord[];
  readonly rejections: RejectionRecord[];
} {
  const conflicts: ConflictRecord[] = [];
  const rejections: RejectionRecord[] = [];
  for (const outcome of outcomes) {
    if (outcome.resolution !== 'active') continue;
    for (const result of outcome.results) {
      if (result.status === 'conflict') conflicts.push(result.conflict);
      if (result.status === 'error') rejections.push(result.rejection);
    }
  }
  return { conflicts, rejections };
}
