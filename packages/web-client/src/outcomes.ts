export const OUTCOMES_TABLE = '_syncular_commit_outcomes';
const SELECT_OUTCOME = `SELECT * FROM ${OUTCOMES_TABLE}`;
import { RETAINED_ROWS } from './failed-overlay';
/**
 * Durable per-client commit outcomes.
 *
 * The journal is client-local protected database state. A final push result is
 * written in the same SQLite transaction that drains its outbox commit, so a
 * restart can never turn "rejected" into an inferred success. Conflict payloads
 * deliberately stay local; retention never deletes an unresolved failure.
 */
import {
  normalizeRejectionDetails,
  type RejectionDetails,
  type RowValue,
} from '@syncular/core';
import type { ClientDatabase } from './database';
import { ClientSyncError } from './errors';
import type { OutboxOperation } from './outbox';
import {
  isBytesEnvelope,
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

/** A JSON object that is neither null nor an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredRow(value: unknown): value is Record<string, JsonRowValue> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (cell) =>
        cell === null ||
        typeof cell === 'string' ||
        typeof cell === 'boolean' ||
        (typeof cell === 'number' && Number.isFinite(cell)) ||
        isBytesEnvelope(cell),
    )
  );
}

export function isStoredOperation(value: unknown): value is OutboxOperation {
  return (
    isRecord(value) &&
    typeof value.table === 'string' &&
    typeof value.rowId === 'string' &&
    (value.baseVersion === undefined ||
      Number.isSafeInteger(value.baseVersion)) &&
    ((value.op === 'upsert' && isStoredRow(value.values)) ||
      (value.op === 'delete' && value.values === undefined))
  );
}

function decodeResults(raw: string): CommitOperationOutcome[] {
  function corrupt(): never {
    throw new ClientSyncError(
      'sync.local_corrupt',
      'persisted commit outcome is invalid',
    );
  }
  const stored = JSON.parse(raw) as StoredCommitOperationOutcome[];
  if (!Array.isArray(stored)) corrupt();
  return stored.map((result) => {
    if (!isRecord(result)) corrupt();
    if (result.status === 'applied') {
      if (
        !Number.isInteger(result.opIndex) ||
        result.opIndex < -2147483648 ||
        result.opIndex > 2147483647
      )
        corrupt();
      return result;
    }
    if (result.status === 'conflict') {
      const conflict = result.conflict;
      if (
        !isRecord(conflict) ||
        !isStoredRow(conflict.serverRow) ||
        typeof conflict.clientCommitId !== 'string' ||
        !Number.isInteger(conflict.opIndex) ||
        conflict.opIndex < -2147483648 ||
        conflict.opIndex > 2147483647 ||
        typeof conflict.table !== 'string' ||
        typeof conflict.rowId !== 'string' ||
        typeof conflict.code !== 'string' ||
        typeof conflict.message !== 'string' ||
        (conflict.operation !== undefined &&
          !isStoredOperation(conflict.operation)) ||
        !Number.isSafeInteger(conflict.serverVersion) ||
        (conflict.conflictColumns !== undefined &&
          (!Array.isArray(conflict.conflictColumns) ||
            !conflict.conflictColumns.every(
              (column) => typeof column === 'string',
            )))
      ) {
        corrupt();
      }
      return {
        status: 'conflict',
        conflict: {
          ...conflict,
          // Pre-column-version journal entries carry no conflictColumns.
          conflictColumns: conflict.conflictColumns ?? [],
          serverRow: mapRowValues(conflict.serverRow, jsonToRowValue),
        },
      };
    }
    if (result.status === 'error') {
      const rejection = result.rejection;
      if (
        !isRecord(rejection) ||
        typeof rejection.clientCommitId !== 'string' ||
        !Number.isInteger(rejection.opIndex) ||
        rejection.opIndex < -2147483648 ||
        rejection.opIndex > 2147483647 ||
        typeof rejection.code !== 'string' ||
        typeof rejection.message !== 'string' ||
        typeof rejection.retryable !== 'boolean' ||
        (rejection.operation !== undefined &&
          !isStoredOperation(rejection.operation))
      ) {
        corrupt();
      }
      try {
        const { details, ...fields } = rejection;
        return {
          status: 'error',
          rejection: {
            ...fields,
            ...(details == null
              ? {}
              : { details: normalizeRejectionDetails(details) }),
          },
        };
      } catch {
        corrupt();
      }
    }
    corrupt();
  });
}

function parseOutcome(
  db: ClientDatabase,
  row: Readonly<Record<string, unknown>>,
  attachRetainedRows = true,
): CommitOutcome {
  const retainedRows: RetainedCommitRow[] = attachRetainedRows
    ? db
        .query(
          `SELECT tbl,id,intent,base,version,unique_conflicts FROM ${RETAINED_ROWS} WHERE commit_seq IS NULL AND commit_id=? ORDER BY idx`,
          [row.client_commit_id as string],
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
            table: retained.tbl as string,
            rowId: retained.id as string,
            localRow: decode(retained.intent),
            ...(retained.unique_conflicts === null
              ? {}
              : {
                  uniqueConflicts: (
                    JSON.parse(
                      retained.unique_conflicts as string,
                    ) as NonNullable<RetainedCommitRow['uniqueConflicts']>
                  ).map((conflict) => ({
                    ...conflict,
                    serverRow: decode(JSON.stringify(conflict.serverRow))!,
                  })),
                }),
            serverRow: decode(retained.base),
            serverVersion:
              retained.version === null ? null : (retained.version as number),
          };
        })
    : [];
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
    `INSERT INTO ${OUTCOMES_TABLE}(client_commit_id,status,recorded_at_ms,results,operations,resolution)VALUES(?,?,?,?,?,'active')`,
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
  const row = db.query(`${SELECT_OUTCOME} WHERE client_commit_id=?`, [
    clientCommitId,
  ])[0];
  return row === undefined ? undefined : parseOutcome(db, row);
}

/**
 * §7.5 persisted-journal view: the stored outcome WITHOUT the owner-derived
 * `retainedRows` images. A malformed journal row (invalid status, resolution,
 * results, or operations JSON) raises the same static `sync.local_corrupt` the
 * native sidecar reports, never a raw `SyntaxError`.
 */
export function persistedCommitOutcome(
  db: ClientDatabase,
  clientCommitId: string,
): CommitOutcome | undefined {
  const row = db.query(`${SELECT_OUTCOME} WHERE client_commit_id=?`, [
    clientCommitId,
  ])[0];
  if (row === undefined) return undefined;
  function corrupt(): never {
    throw new ClientSyncError(
      'sync.local_corrupt',
      'persisted commit outcome is invalid',
    );
  }
  const status = row.status;
  const resolution = row.resolution;
  if (
    (status !== 'applied' &&
      status !== 'cached' &&
      status !== 'conflict' &&
      status !== 'rejected') ||
    (resolution !== 'active' &&
      resolution !== 'resolved_keep_server' &&
      resolution !== 'superseded' &&
      resolution !== 'dismissed') ||
    !Number.isSafeInteger(row.seq) ||
    typeof row.client_commit_id !== 'string' ||
    !Number.isSafeInteger(row.recorded_at_ms) ||
    typeof row.results !== 'string' ||
    (row.operations !== null && typeof row.operations !== 'string') ||
    (row.resolved_at_ms !== null &&
      !Number.isSafeInteger(row.resolved_at_ms)) ||
    (row.replacement_client_commit_id !== null &&
      typeof row.replacement_client_commit_id !== 'string')
  ) {
    corrupt();
  }
  try {
    const outcome = parseOutcome(db, row, false);
    const hasConflict = outcome.results.some(
      (result) => result.status === 'conflict',
    );
    const hasError = outcome.results.some(
      (result) => result.status === 'error',
    );
    const redacted =
      outcome.results.length === 0 && outcome.operations === undefined;
    if (
      ((status === 'applied' || status === 'cached') &&
        (hasConflict || hasError)) ||
      (status === 'conflict' && !(hasConflict || redacted)) ||
      (status === 'rejected' && (hasConflict || !(hasError || redacted)))
    )
      corrupt();
    if (
      outcome.operations !== undefined &&
      (!Array.isArray(outcome.operations) ||
        !outcome.operations.every(isStoredOperation))
    )
      corrupt();
    return outcome;
  } catch {
    corrupt();
  }
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
    `${SELECT_OUTCOME} ${where} ORDER BY seq DESC${limit === undefined ? '' : ' LIMIT ?'}`,
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
    `UPDATE ${OUTCOMES_TABLE} SET resolution=?,resolved_at_ms=?,replacement_client_commit_id=? WHERE client_commit_id=? AND resolution='active'`,
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
  const count = db.query(`SELECT COUNT(*) AS count FROM ${OUTCOMES_TABLE}`)[0]
    ?.count as number | undefined;
  const excess = Math.max(0, (count ?? 0) - maxEntries);
  if (excess === 0) return 0;
  const candidates = db.query(
    `SELECT seq FROM ${OUTCOMES_TABLE} WHERE status IN('applied','cached')OR resolution !='active' ORDER BY seq ASC LIMIT ?`,
    [excess],
  );
  for (const candidate of candidates) {
    db.exec(`DELETE FROM ${OUTCOMES_TABLE} WHERE seq=?`, [
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
