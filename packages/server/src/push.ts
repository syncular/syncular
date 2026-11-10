import { retainRollbackFailure } from './storage-errors';
/**
 * Push apply (SPEC.md §6) with §3.4 write-path authorization.
 *
 * Security-critical rules implemented here:
 * - authorization runs against the STORED row when it exists, never the
 *   pushed payload (§3.4 step 2);
 * - declared scope columns are stripped from every update path (§3.4
 *   rule 5) — updates keep the stored row's scope column values;
 * - a lost `baseVersion = 0` insert race re-authorizes the winner's row
 *   before disclosing it in a conflict record (§6.2).
 *
 * Per-commit atomicity (§6.4): one storage transaction per commit; the
 * idempotency record persists in the same transaction as the writes.
 *
 * Optional per-table write validation (§6.7) runs after decode + the §3.4
 * scope check, on the row that will persist (post scope-strip, post CRDT
 * merge); a validator throw rejects the whole commit atomically with a
 * host code.
 */
import {
  decodeRow,
  decodeSparseRow,
  encodeRow,
  type PushCommitFrame,
  type PushOperation,
  type PushOperationResult,
  type PushResultFrame,
  parseBlobRef,
  type RejectionDetails,
  type RowValue,
  type SparseRowValue,
} from '@syncular/core';
import type { BlobStore } from './blob-store';
import type { SyncRequestContext } from './context';
import { clockOf, limitsOf } from './context';
import type { CrdtMergerRegistry } from './crdt-merger';
import { reportError, SyncError, type SyncularErrorHandler } from './errors';
import { emitEvent } from './events';
import {
  prepareReactions,
  type PreparedReaction,
  toNewReactions,
} from './reactions';
import type { CompiledSchema, CompiledTable } from './schema';
import type { ResolvedScopes } from './scopes';
import { authorizeWrite, renderScopeValue, storedScopesForRow } from './scopes';
import { decodeColumnVersions, encodeColumnVersions } from './relational-rows';
import type {
  NewChange,
  PreparedPushApply,
  StorageTransaction,
  StoredCommit,
  StoredPushResult,
  StoredRow,
} from './storage';
import { readCandidateRows, serveGateRefusal } from './storage';
import { StorageConstraintError } from './storage-errors';
import { transactionQuery } from './storage-query';
import { serveNotReadyError } from './readiness';
import type {
  CommitValidationReader,
  CommitValidationRow,
  CommitValidator,
  ValidateCommitOperation,
  ValidateOpKind,
  ValidatorRegistry,
} from './validate';
import {
  CommitAuthorizationRejection,
  CommitValidationRejection,
  toValidateRow,
  ValidationRejection,
} from './validate';

/**
 * Extract the blobIds a decoded row references through its `blob_ref`
 * columns (§5.9.4), skipping NULLs. Malformed BlobRefs already failed at
 * row-codec decode (§5.9.1), so `parseBlobRef` here is total.
 */
export function blobIdsInRow(
  table: CompiledTable,
  values: readonly RowValue[],
): string[] {
  const ids: string[] = [];
  for (const index of table.blobRefColumnIndices) {
    const value = values[index];
    if (typeof value === 'string') ids.push(parseBlobRef(value).blobId);
  }
  return ids;
}

/** Final state of one staged client operation, as the §6.11 reference pass
 * sees it after every client operation has been applied to candidate state. */
interface StagedWrite {
  readonly table: CompiledTable;
  readonly op: 'upsert' | 'delete';
  readonly rowId: string;
  readonly opIndex: number;
  /** Final post-merge, post-scope-strip values (upsert only). */
  readonly values?: readonly RowValue[];
  /** Columns the operation presents (upsert only, §6.11 present reference). */
  readonly present?: readonly boolean[];
  /** Stored row observed immediately before the write; undefined on insert. */
  readonly stored: StoredRow | undefined;
}

type TerminatingOutcome = {
  readonly kind: 'terminate';
  readonly record: PushOperationResult;
};

type OperationOutcome =
  | {
      readonly kind: 'applied';
      readonly changes: readonly NewChange[];
      readonly operations: readonly ValidateCommitOperation[];
      readonly staged: StagedWrite;
    }
  | TerminatingOutcome;

/**
 * A server-authoritative scope move (§2.2). Commands emit it through
 * `CommandMutation`; it is not an SSP2 wire operation, so a client cannot
 * request one. Apply rewrites the stored row in place under the new scopes
 * and emits the delete/upsert change pair in one commit.
 */
export interface RescopeOperation {
  readonly table: string;
  readonly rowId: string;
  readonly op: 'rescope';
  /** Full-row payload (the row's values under the new scopes). */
  readonly payload: Uint8Array;
}

export type ApplyOperation = PushOperation | RescopeOperation;

function errorRecord(
  opIndex: number,
  code: string,
  message: string,
  retryable = false,
  details?: RejectionDetails,
): TerminatingOutcome {
  return {
    kind: 'terminate',
    record: {
      opIndex,
      status: 'error',
      code,
      message,
      retryable,
      ...(details !== undefined ? { details } : {}),
    },
  };
}

function conflictRecord(
  opIndex: number,
  serverVersion: number,
  serverRow: Uint8Array,
  conflictColumns: Uint8Array,
): OperationOutcome {
  return {
    kind: 'terminate',
    record: {
      opIndex,
      status: 'conflict',
      code: 'sync.version_conflict',
      message: 'present columns moved past baseVersion (§6.2)',
      serverVersion,
      serverRow,
      conflictColumns,
    },
  };
}

/** §6.3 `conflictColumns`: a presence-layout bitmap over the marked columns. */
function conflictColumnsBitmap(
  columnCount: number,
  marked: readonly number[],
): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(columnCount / 8));
  for (const index of marked) {
    bytes[index >> 3] = (bytes[index >> 3] ?? 0) | (1 << (index & 7));
  }
  return bytes;
}

interface BlobApplyContext {
  readonly store: BlobStore | undefined;
  readonly partition: string;
  /** §6.6 per-commit existence answers, keyed by blobId. */
  readonly presence: Map<string, boolean>;
}

/** §6.6: answer every not-yet-known blobId with one concurrent round of
 * existence lookups and remember the answers for the rest of the commit. */
async function resolveBlobPresence(
  blobCtx: BlobApplyContext,
  blobIds: Iterable<string>,
): Promise<void> {
  const store = blobCtx.store;
  if (store === undefined) return;
  const unknown = [...new Set(blobIds)].filter(
    (blobId) => !blobCtx.presence.has(blobId),
  );
  await Promise.all(
    unknown.map(async (blobId) => {
      blobCtx.presence.set(blobId, await store.has(blobCtx.partition, blobId));
    }),
  );
}

/**
 * §6.7: run the table's write-validation hook, if configured, on the row
 * that WILL persist (post scope-strip, post CRDT-merge — the values the
 * store receives). Returns a terminating outcome iff the validator rejects
 * (its `ValidationRejection` code, or `sync.constraint_violation` for a
 * non-`ValidationRejection` throw), else `undefined` (accept / no hook).
 * A no-op for tables with no validator — the `undefined` short-circuit
 * keeps the feature zero-cost when off.
 */
async function runValidator(
  validators: ValidatorRegistry | undefined,
  table: CompiledTable,
  op: ValidateOpKind,
  rowId: string,
  values: readonly RowValue[] | undefined,
  storedValues: readonly RowValue[] | undefined,
  opIndex: number,
  tx: StorageTransaction,
  partition: string,
  actorId: string,
): Promise<TerminatingOutcome | undefined> {
  const validator = validators?.[table.name];
  if (validator === undefined) return undefined;
  try {
    await validator(
      {
        op,
        table: table.name,
        rowId,
        row:
          values !== undefined
            ? toValidateRow(table.columns, values)
            : undefined,
        stored:
          storedValues !== undefined
            ? toValidateRow(table.columns, storedValues)
            : undefined,
      },
      {
        actorId,
        partition,
        queryAuthoritative: (query) => transactionQuery(tx, query),
      },
    );
  } catch (error) {
    if (error instanceof ValidationRejection) {
      return errorRecord(
        opIndex,
        error.code,
        error.message,
        false,
        error.details,
      );
    }
    // §6.7: a non-ValidationRejection throw is still a rejection, mapped to
    // the generic server-side constraint code (§10.2) — the validator's
    // failure never crashes the request or leaks its message as a code.
    return errorRecord(
      opIndex,
      'sync.constraint_violation',
      'write validator failed',
    );
  }
  return undefined;
}

/**
 * §5.10.3: merge the row's `crdt` columns in place. For each crdt column,
 * replace the incoming value with `merge(stored, incoming)` (§5.10.2) —
 * never the raw pushed bytes. `storedValues` is undefined on insert (the
 * stored value is `null` — the empty document). Returns `true` iff any crdt
 * column value changed (so the caller re-encodes), or a terminating
 * `sync.crdt_merge_failed` outcome if a merger is missing or throws.
 *
 * A NULL incoming crdt value is a semantic clear, not a merge — it passes
 * through untouched (the app is nulling the column, the same as any other
 * type). Merging only runs for a non-NULL incoming crdt value. `present`
 * marks the sparse payload's present columns (§6.2): an absent crdt column
 * is unchanged and never merges.
 */
async function mergeCrdtColumns(
  table: CompiledTable,
  values: RowValue[],
  storedValues: readonly RowValue[] | undefined,
  present: readonly boolean[],
  opIndex: number,
  mergers: CrdtMergerRegistry | undefined,
): Promise<OperationOutcome | { readonly changed: boolean }> {
  if (table.crdtColumns.length === 0) return { changed: false };
  let changed = false;
  for (const { index, crdtType } of table.crdtColumns) {
    if (!present[index]) continue;
    const incoming = values[index];
    if (!(incoming instanceof Uint8Array)) continue; // NULL clear or absent
    const merger = mergers?.[crdtType];
    if (merger === undefined) {
      return errorRecord(
        opIndex,
        'sync.crdt_merge_failed',
        'no CRDT merger registered',
      );
    }
    const storedRaw = storedValues?.[index];
    const stored = storedRaw instanceof Uint8Array ? storedRaw : null;
    let merged: Uint8Array;
    try {
      merged = await merger(stored, incoming);
    } catch {
      return errorRecord(
        opIndex,
        'sync.crdt_merge_failed',
        'CRDT merger failed',
      );
    }
    values[index] = merged;
    changed = true;
  }
  return { changed };
}

async function applyOperation(
  tx: StorageTransaction,
  schema: CompiledSchema,
  wireSchema: CompiledSchema,
  resolved: ResolvedScopes,
  op: ApplyOperation,
  opIndex: number,
  blobCtx: BlobApplyContext,
  crdtMergers: CrdtMergerRegistry | undefined,
  validators: ValidatorRegistry | undefined,
  partition: string,
  actorId: string,
): Promise<OperationOutcome> {
  const table = schema.tables.get(op.table);
  const wireTable = wireSchema.tables.get(op.table);
  if (table === undefined || wireTable === undefined) {
    return errorRecord(
      opIndex,
      'sync.unknown_table',
      `table ${JSON.stringify(op.table)} is not handled by this server`,
    );
  }
  if (!resolved.ok) {
    return errorRecord(
      opIndex,
      'sync.forbidden',
      'scope resolution failed (§3.4 step 4)',
    );
  }
  if (op.rowId.includes('\u0000')) {
    // §6.1: no store sees a rowId holding U+0000; PostgreSQL refuses it.
    return errorRecord(opIndex, 'sync.invalid_request', 'rowId holds U+0000');
  }
  const stored = await tx.getRow(op.table, op.rowId);

  if (op.op === 'rescope') {
    // §2.2 explicit scope move. One stored row changes its scope values;
    // apply rewrites it in place, keeps `server_version`, and emits the
    // delete under the old scopes plus the upsert under the new ones.
    if (stored === undefined) {
      return errorRecord(
        opIndex,
        'sync.row_missing',
        'rescope targets an absent row (§2.2)',
      );
    }
    if (!authorizeWrite(table, stored.scopes, resolved)) {
      return errorRecord(
        opIndex,
        'sync.forbidden',
        'rescope denied by scope authorization (§3.4)',
      );
    }
    const missing = missingScopeVariable(table, stored.scopes);
    if (missing !== undefined) {
      return errorRecord(
        opIndex,
        'sync.missing_scopes',
        `stored row lacks scope variable ${JSON.stringify(missing)} (§3.1)`,
      );
    }
    let sparse: SparseRowValue[];
    try {
      sparse = decodeSparseRow(
        wireTable.columns,
        wireTable.primaryKeyIndex,
        op.payload,
      );
    } catch (error) {
      return errorRecord(
        opIndex,
        'sync.invalid_request',
        `rescope payload failed row-codec decode (§1.7): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      sparse.length < table.columns.length ||
      sparse.some((value) => value === undefined)
    ) {
      return errorRecord(
        opIndex,
        'sync.invalid_request',
        'rescope requires a full-row payload (§2.2)',
      );
    }
    const values: RowValue[] = sparse.map((value) => value ?? null);
    const pkValue = renderScopeValue(values[table.primaryKeyIndex] ?? null);
    if (pkValue !== op.rowId) {
      return errorRecord(
        opIndex,
        'sync.invalid_request',
        'payload primary key does not match rowId',
      );
    }
    const storedValues = decodeRow(table.columns, stored.payload);
    const scopeIndexes = new Set(
      table.scopePatterns.map((pattern) => pattern.columnIndex),
    );
    const sameValue = (left: RowValue, right: RowValue): boolean => {
      if (left instanceof Uint8Array || right instanceof Uint8Array) {
        return (
          left instanceof Uint8Array &&
          right instanceof Uint8Array &&
          left.length === right.length &&
          left.every((byte, index) => byte === right[index])
        );
      }
      return left === right;
    };
    for (let index = 0; index < table.columns.length; index++) {
      if (index === table.primaryKeyIndex || scopeIndexes.has(index)) continue;
      if (!sameValue(values[index] ?? null, storedValues[index] ?? null)) {
        return errorRecord(
          opIndex,
          'sync.invalid_request',
          'rescope may change only scope columns (§2.2)',
        );
      }
    }
    const extracted = storedScopesForRow(table, values);
    if ('missing' in extracted) {
      return errorRecord(
        opIndex,
        'sync.forbidden',
        `rescope missing scope column value for ${JSON.stringify(extracted.missing)} (§3.4)`,
      );
    }
    if (!authorizeWrite(table, extracted.scopes, resolved)) {
      return errorRecord(
        opIndex,
        'sync.forbidden',
        'rescope denied by scope authorization of the new scopes (§3.4)',
      );
    }
    const deleteReject = await runValidator(
      validators,
      table,
      'delete',
      op.rowId,
      undefined,
      storedValues,
      opIndex,
      tx,
      partition,
      actorId,
    );
    if (deleteReject !== undefined) return deleteReject;
    const upsertReject = await runValidator(
      validators,
      table,
      'upsert',
      op.rowId,
      values,
      storedValues,
      opIndex,
      tx,
      partition,
      actorId,
    );
    if (upsertReject !== undefined) return upsertReject;
    const blobCheck = await checkAndRecordBlobs(
      tx,
      table,
      op.rowId,
      values,
      opIndex,
      blobCtx,
    );
    if (blobCheck !== undefined) return blobCheck;
    const payload = encodeRow(table.columns, values);
    // The move clears any tombstone from an earlier incarnation: the row is
    // live at the end of this commit, so the next move must not hit §5.2.
    await tx.clearTombstone(op.table, op.rowId);
    await tx.upsertRow(
      op.table,
      {
        rowId: op.rowId,
        serverVersion: stored.serverVersion,
        scopes: extracted.scopes,
        payload,
        ...(stored.columnVersions !== undefined
          ? { columnVersions: stored.columnVersions }
          : {}),
      },
      { opIndex },
    );
    const storedRow = toValidateRow(table.columns, storedValues);
    return {
      kind: 'applied',
      changes: [
        {
          table: op.table,
          rowId: op.rowId,
          op: 'delete',
          scopes: stored.scopes,
        },
        {
          table: op.table,
          rowId: op.rowId,
          op: 'upsert',
          rowVersion: stored.serverVersion,
          scopes: extracted.scopes,
          payload,
        },
      ],
      operations: [
        {
          opIndex,
          op: 'delete',
          table: table.name,
          rowId: op.rowId,
          row: undefined,
          stored: storedRow,
          storedServerVersion: stored.serverVersion,
        },
        {
          opIndex,
          op: 'upsert',
          table: table.name,
          rowId: op.rowId,
          row: toValidateRow(table.columns, values),
          stored: storedRow,
          storedServerVersion: stored.serverVersion,
          nextServerVersion: stored.serverVersion,
        },
      ],
      staged: {
        table,
        op: 'upsert',
        rowId: op.rowId,
        opIndex,
        values,
        present: table.columns.map(() => true),
        stored,
      },
    };
  }

  if (op.op === 'delete') {
    if (stored === undefined) {
      // Deleting an absent row is applied (idempotent, §6.2); no change.
      return {
        kind: 'applied',
        changes: [],
        operations: [
          {
            opIndex,
            op: 'delete',
            table: table.name,
            rowId: op.rowId,
            row: undefined,
            stored: undefined,
          },
        ],
        staged: {
          table,
          op: 'delete',
          rowId: op.rowId,
          opIndex,
          stored: undefined,
        },
      };
    }
    if (!authorizeWrite(table, stored.scopes, resolved)) {
      return errorRecord(
        opIndex,
        'sync.forbidden',
        'delete denied by scope authorization (§3.4)',
      );
    }
    const missing = missingScopeVariable(table, stored.scopes);
    if (missing !== undefined) {
      return errorRecord(
        opIndex,
        'sync.missing_scopes',
        `stored row lacks scope variable ${JSON.stringify(missing)} (§3.1)`,
      );
    }
    // §6.7: validate the delete against the stored row (row = undefined,
    // stored = the row about to be removed). Only reached for an existing
    // row — an absent-row delete is an idempotent no-op above.
    const storedValues = decodeRow(table.columns, stored.payload);
    const deleteReject = await runValidator(
      validators,
      table,
      'delete',
      op.rowId,
      undefined,
      storedValues,
      opIndex,
      tx,
      partition,
      actorId,
    );
    if (deleteReject !== undefined) return deleteReject;
    await tx.deleteRow(op.table, op.rowId);
    return {
      kind: 'applied',
      changes: [
        {
          table: op.table,
          rowId: op.rowId,
          op: 'delete',
          deletedVersion: stored.serverVersion,
          scopes: stored.scopes,
        },
      ],
      operations: [
        {
          opIndex,
          op: 'delete',
          table: table.name,
          rowId: op.rowId,
          row: undefined,
          stored: toValidateRow(table.columns, storedValues),
          storedServerVersion: stored.serverVersion,
        },
      ],
      staged: { table, op: 'delete', rowId: op.rowId, opIndex, stored },
    };
  }

  // upsert — payload presence is enforced by the envelope codec (§6.1). The
  // payload is a sparse row (§2.4, wire version 3): `undefined` marks an
  // absent column the apply leaves unchanged.
  const payload = op.payload;
  if (payload === undefined) {
    return errorRecord(
      opIndex,
      'sync.invalid_request',
      'upsert without payload',
    );
  }
  let sparse: SparseRowValue[];
  try {
    sparse = decodeSparseRow(
      wireTable.columns,
      wireTable.primaryKeyIndex,
      payload,
    );
    while (sparse.length < table.columns.length)
      sparse.push(stored === undefined ? null : undefined);
  } catch (error) {
    return errorRecord(
      opIndex,
      'sync.invalid_request',
      `row payload failed row-codec decode (§1.7): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const pkValue = renderScopeValue(sparse[table.primaryKeyIndex] ?? null);
  if (pkValue !== op.rowId) {
    return errorRecord(
      opIndex,
      'sync.invalid_request',
      'payload primary key does not match rowId',
    );
  }
  const present = sparse.map((value) => value !== undefined);
  const presentCount = present.filter(Boolean).length;

  if (stored !== undefined) {
    // §3.4 step 2: authorize against the STORED row, never the payload.
    if (!authorizeWrite(table, stored.scopes, resolved)) {
      return errorRecord(
        opIndex,
        'sync.forbidden',
        'write denied by scope authorization (§3.4)',
      );
    }
    const storedValues = decodeRow(table.columns, stored.payload);
    // §3.4 rule 5 / §6.2: scope columns are immutable on update. A present
    // scope column whose value differs from the stored row is
    // sync.invalid_request; present and equal applies as a no-op.
    for (const pattern of table.scopePatterns) {
      const incoming = sparse[pattern.columnIndex];
      if (incoming === undefined) continue;
      if ((incoming ?? null) !== (storedValues[pattern.columnIndex] ?? null)) {
        return errorRecord(
          opIndex,
          'sync.invalid_request',
          'scope column is immutable on update (§3.4)',
        );
      }
    }
    if (op.baseVersion !== undefined && op.baseVersion > stored.serverVersion) {
      return errorRecord(
        opIndex,
        'sync.invalid_request',
        'baseVersion exceeds the stored server version (§6.2)',
      );
    }
    // §2.2 column versions. A row stored before column versions carries no
    // blob: every column sits at the row's current serverVersion. With a
    // blob, an unlisted column sits at 1.
    const storedVersions = decodeColumnVersions(stored.columnVersions);
    const effectiveVersion = (index: number): number =>
      storedVersions.get(index) ??
      (stored.columnVersions === undefined ? stored.serverVersion : 1);
    const crdtIndexes = new Set(
      table.crdtColumns.map((column) => column.index),
    );
    if (op.baseVersion === 0) {
      // Lost insert race (§6.2); the stored row was authorized above, so
      // disclosure of the winner is permitted. Every present non-crdt
      // column exceeds baseVersion 0.
      const marked: number[] = [];
      for (let i = 0; i < table.columns.length; i++) {
        if (present[i] && !crdtIndexes.has(i) && i !== table.primaryKeyIndex) {
          marked.push(i);
        }
      }
      return conflictRecord(
        opIndex,
        stored.serverVersion,
        stored.payload,
        conflictColumnsBitmap(table.columns.length, marked),
      );
    }
    if (op.baseVersion !== undefined) {
      // §6.2: conflict when any present non-crdt column moved past
      // baseVersion. crdt columns merge and never conflict.
      const marked: number[] = [];
      for (let i = 0; i < table.columns.length; i++) {
        if (
          present[i] &&
          !crdtIndexes.has(i) &&
          i !== table.primaryKeyIndex &&
          effectiveVersion(i) > op.baseVersion
        ) {
          marked.push(i);
        }
      }
      if (marked.length > 0) {
        return conflictRecord(
          opIndex,
          stored.serverVersion,
          stored.payload,
          conflictColumnsBitmap(table.columns.length, marked),
        );
      }
    }
    // §6.2 apply: write the present non-crdt columns, merge the present
    // crdt columns (stored ⊕ incoming, §5.10.3), leave absent columns
    // unchanged, and increment server_version.
    const values: RowValue[] = [...storedValues];
    for (let i = 0; i < table.columns.length; i++) {
      if (!present[i]) continue;
      values[i] = sparse[i] ?? null;
    }
    const mergeOutcome = await mergeCrdtColumns(
      table,
      values,
      storedValues,
      present,
      opIndex,
      crdtMergers,
    );
    if ('kind' in mergeOutcome) return mergeOutcome;
    const newVersion = stored.serverVersion + 1;
    const nextVersions = new Map<number, number>();
    for (let i = 0; i < table.columns.length; i++) {
      // The primary key is immutable: its version never advances past the
      // insert, so it never enters conflictColumns.
      const version =
        present[i] && i !== table.primaryKeyIndex
          ? newVersion
          : effectiveVersion(i);
      if (version > 1) nextVersions.set(i, version);
    }
    // The stored payload is always the full-row codec (§2.4): the sparse
    // push payload never reaches storage, segments, or COMMIT frames.
    const newPayload = encodeRow(table.columns, values);
    // §6.6 / §5.9.6: verify referenced blobs exist before writing.
    const blobCheck = await checkAndRecordBlobs(
      tx,
      table,
      op.rowId,
      values,
      opIndex,
      blobCtx,
    );
    if (blobCheck !== undefined) return blobCheck;
    // §6.7: validate the merged row that will persist — for a crdt column
    // the validator sees the MERGED value (§5.10.3), the state the store
    // holds, not the raw pushed update.
    const updateReject = await runValidator(
      validators,
      table,
      'upsert',
      op.rowId,
      values,
      storedValues,
      opIndex,
      tx,
      partition,
      actorId,
    );
    if (updateReject !== undefined) return updateReject;
    const columnVersions = encodeColumnVersions(nextVersions);
    const newRow = {
      rowId: op.rowId,
      serverVersion: newVersion,
      scopes: stored.scopes,
      payload: newPayload,
      ...(columnVersions !== undefined ? { columnVersions } : {}),
    };
    await tx.upsertRow(op.table, newRow, { opIndex });
    return {
      kind: 'applied',
      changes: [
        {
          table: op.table,
          rowId: op.rowId,
          op: 'upsert',
          rowVersion: newVersion,
          scopes: stored.scopes,
          payload: newPayload,
        },
      ],
      operations: [
        {
          opIndex,
          op: 'upsert',
          table: table.name,
          rowId: op.rowId,
          row: toValidateRow(table.columns, values),
          stored: toValidateRow(table.columns, storedValues),
          storedServerVersion: stored.serverVersion,
          nextServerVersion: newVersion,
        },
      ],
      staged: {
        table,
        op: 'upsert',
        rowId: op.rowId,
        opIndex,
        values,
        present,
        stored,
      },
    };
  }

  // Insert path: no stored row (§5.2). The authorization row is the payload
  // plus the primary key (§3.4 step 2); a missing or empty scope column value
  // ⇒ deny.
  const values: RowValue[] = sparse.map((value) => value ?? null);
  const extracted = storedScopesForRow(table, values);
  const insert =
    'missing' in extracted
      ? errorRecord(
          opIndex,
          'sync.forbidden',
          'insert missing scope column value (§3.4)',
        )
      : authorizeWrite(table, extracted.scopes, resolved)
        ? extracted
        : errorRecord(
            opIndex,
            'sync.forbidden',
            'insert denied by scope authorization (§3.4)',
          );
  if (op.baseVersion !== undefined && op.baseVersion !== 0) {
    // Authorize the payload first so absence is not disclosed to actors
    // without the scope; then §6.2: baseVersion ≠ 0, row absent.
    if ('kind' in insert) {
      return errorRecord(
        opIndex,
        'sync.forbidden',
        'write denied by scope authorization (§3.4)',
      );
    }
    return errorRecord(
      opIndex,
      'sync.row_missing',
      'upsert with baseVersion targets an absent row (§6.2)',
    );
  }
  // §6.2: a payload that presents every scope column is authorized before
  // the tombstone read, so the answer never discloses a deletion to an actor
  // who could not write the row.
  if (
    op.baseVersion === undefined &&
    'kind' in insert &&
    table.scopePatterns.every((pattern) => present[pattern.columnIndex])
  ) {
    return insert;
  }
  // §6.2: a tombstone whose stored scopes the actor fails reads as absent.
  const tombstone = await tx.getTombstone(op.table, op.rowId);
  const deleted =
    tombstone?.scopes === undefined ||
    authorizeWrite(table, tombstone.scopes, resolved)
      ? tombstone
      : undefined;
  if (op.baseVersion === undefined && deleted !== undefined) {
    // §5.2: a delete within the retention horizon beats an unversioned
    // upsert; an explicit insert (baseVersion 0) recreates instead.
    return errorRecord(
      opIndex,
      'sync.row_deleted',
      'a deleted row rejects an unversioned upsert within the retention horizon (§5.2)',
    );
  }
  if (presentCount < table.columns.length) {
    // §6.3: an insert requires every column present.
    return errorRecord(
      opIndex,
      'sync.row_missing',
      'a partial payload targets an absent row (§6.3)',
    );
  }
  if ('kind' in insert) return insert;
  // §5.10.3: on insert a crdt column merges against the empty document
  // (stored = null) — normalizes the initial state through the merger.
  const insertMerge = await mergeCrdtColumns(
    table,
    values,
    undefined,
    present,
    opIndex,
    crdtMergers,
  );
  if ('kind' in insertMerge) return insertMerge;
  // The stored payload is the full-row codec (§2.4); every column is
  // present on an insert.
  const insertPayload = encodeRow(table.columns, values);
  // §6.6 / §5.9.6: verify referenced blobs exist before writing.
  const blobCheck = await checkAndRecordBlobs(
    tx,
    table,
    op.rowId,
    values,
    opIndex,
    blobCtx,
  );
  if (blobCheck !== undefined) return blobCheck;
  // §6.7: validate the insert row (stored = undefined, so a validator can
  // distinguish create from update); crdt columns are already merged
  // against the empty document.
  const insertReject = await runValidator(
    validators,
    table,
    'upsert',
    op.rowId,
    values,
    undefined,
    opIndex,
    tx,
    partition,
    actorId,
  );
  if (insertReject !== undefined) return insertReject;
  // §6.2: an insert recreates over the tombstone and starts above the
  // deleted row's version; without a column-versions blob every column sits
  // at that version.
  if (tombstone !== undefined) await tx.clearTombstone(op.table, op.rowId);
  const serverVersion = (deleted?.serverVersion ?? 0) + 1;
  const newRow = {
    rowId: op.rowId,
    serverVersion,
    scopes: insert.scopes,
    payload: insertPayload,
  };
  await tx.upsertRow(op.table, newRow, { opIndex });
  return {
    kind: 'applied',
    changes: [
      {
        table: op.table,
        rowId: op.rowId,
        op: 'upsert',
        rowVersion: serverVersion,
        scopes: insert.scopes,
        payload: insertPayload,
      },
    ],
    operations: [
      {
        opIndex,
        op: 'upsert',
        table: table.name,
        rowId: op.rowId,
        row: toValidateRow(table.columns, values),
        stored: undefined,
        nextServerVersion: serverVersion,
      },
    ],
    staged: {
      table,
      op: 'upsert',
      rowId: op.rowId,
      opIndex,
      values,
      present,
      stored: undefined,
    },
  };
}

/**
 * §5.9.6/§6.6: for a row's `blob_ref` columns, verify every referenced blob
 * exists, then record the row's reference set in the index (§5.9.4). Returns
 * a terminating `blob.not_found` outcome if any blob is absent (or the store
 * is unconfigured while a ref exists), else `undefined` (proceed). No-op for
 * tables with no `blob_ref` columns.
 */
async function checkAndRecordBlobs(
  tx: StorageTransaction,
  table: CompiledTable,
  rowId: string,
  values: readonly RowValue[],
  opIndex: number,
  blobCtx: BlobApplyContext,
): Promise<OperationOutcome | undefined> {
  if (table.blobRefColumnIndices.length === 0) return undefined;
  const blobIds = blobIdsInRow(table, values);
  if (blobIds.length > 0) {
    if (blobCtx.store === undefined) {
      return errorRecord(
        opIndex,
        'blob.not_found',
        'row references a blob but the server has no blob store (§5.9.6)',
      );
    }
    // Pushed blobIds were answered before the operation loop; a blobId the
    // row keeps from its stored values is answered here.
    await resolveBlobPresence(blobCtx, blobIds);
    if (blobIds.some((blobId) => blobCtx.presence.get(blobId) !== true)) {
      return errorRecord(
        opIndex,
        'blob.not_found',
        'push references a blob that has not been uploaded (§5.9.6)',
      );
    }
  }
  // Update the reference index for this row (empty set clears it, §5.9.4).
  if (tx.setBlobRefs !== undefined) {
    await tx.setBlobRefs(table.name, rowId, blobIds);
  }
  return undefined;
}

function missingScopeVariable(
  table: CompiledTable,
  scopes: Record<string, string>,
): string | undefined {
  for (const pattern of table.scopePatterns) {
    const value = scopes[pattern.variable];
    if (value === undefined || value.length === 0) return pattern.variable;
  }
  return undefined;
}

function commitValidationReader(
  tx: StorageTransaction,
  schema: CompiledSchema,
): CommitValidationReader {
  const tableFor = (name: string): CompiledTable => {
    const table = schema.tables.get(name);
    if (table === undefined) {
      throw new Error(
        `commit validator requested unknown table ${JSON.stringify(name)}`,
      );
    }
    return table;
  };
  return {
    getRow: async (tableName, rowId) => {
      const table = tableFor(tableName);
      const stored = await tx.getRow(tableName, rowId);
      if (stored === undefined) return undefined;
      return {
        row: toValidateRow(
          table.columns,
          decodeRow(table.columns, stored.payload),
        ),
        serverVersion: stored.serverVersion,
      };
    },
    getRows: async (tableName, rowIds) => {
      const table = tableFor(tableName);
      const storedRows = await readCandidateRows(tx, tableName, rowIds);
      const rows = new Map<string, CommitValidationRow>();
      for (const rowId of rowIds) {
        const stored = storedRows.get(rowId);
        if (stored === undefined) continue;
        rows.set(rowId, {
          row: toValidateRow(
            table.columns,
            decodeRow(table.columns, stored.payload),
          ),
          serverVersion: stored.serverVersion,
        });
      }
      return rows;
    },
    scanRows: async ({
      table: tableName,
      scopeFilter,
      afterRowId = null,
      limit = 100,
    }) => {
      const table = tableFor(tableName);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error(
          'commit validator scan limit must be an integer from 1 to 1,000',
        );
      }
      if (tx.scanRows === undefined) {
        throw new Error(
          'storage transaction does not support commit-validator scans',
        );
      }
      const rows = await tx.scanRows({
        table: tableName,
        scopeFilter,
        afterRowId,
        limit,
      });
      return rows.map((stored) => ({
        row: toValidateRow(
          table.columns,
          decodeRow(table.columns, stored.payload),
        ),
        serverVersion: stored.serverVersion,
      }));
    },
    scanRowsByIndex: async ({
      table: tableName,
      index,
      values,
      afterRowId = null,
      limit = 100,
    }) => {
      const table = tableFor(tableName);
      if (tx.scanRowsByIndex === undefined) {
        throw new Error(
          'storage transaction does not support commit-validator index scans',
        );
      }
      const rows = await tx.scanRowsByIndex({
        table: tableName,
        index,
        values,
        afterRowId,
        limit,
      });
      return rows.map((stored) => ({
        row: toValidateRow(
          table.columns,
          decodeRow(table.columns, stored.payload),
        ),
        serverVersion: stored.serverVersion,
      }));
    },
    queryAuthoritative: (query) => transactionQuery(tx, query),
  };
}

async function runCommitValidator(
  validator: CommitValidator | undefined,
  onError: SyncularErrorHandler | undefined,
  tx: StorageTransaction,
  schema: CompiledSchema,
  clientId: string,
  clientCommitId: string,
  actorId: string,
  partition: string,
  operations: readonly ValidateCommitOperation[],
): Promise<OperationOutcome | undefined> {
  if (validator === undefined) return undefined;
  try {
    await validator({
      clientId,
      clientCommitId,
      actorId,
      partition,
      operations,
      read: commitValidationReader(tx, schema),
    });
  } catch (error) {
    if (error instanceof CommitAuthorizationRejection) {
      if (error.opIndex >= operations.length) {
        return errorRecord(
          0,
          'sync.constraint_violation',
          'commit authorization rejection names an unavailable operation',
        );
      }
      return errorRecord(error.opIndex, error.code, error.message, false);
    }
    if (error instanceof CommitValidationRejection) {
      if (error.opIndex >= operations.length) {
        return errorRecord(
          0,
          'sync.constraint_violation',
          `commit validator rejection names unavailable opIndex ${error.opIndex}`,
        );
      }
      return errorRecord(
        error.opIndex,
        error.code,
        error.message,
        false,
        error.details,
      );
    }
    if (error instanceof ValidationRejection) {
      return errorRecord(
        operations[0]?.opIndex ?? 0,
        error.code,
        error.message,
        false,
        error.details,
      );
    }
    // §6.8: a throw that is not a deliberate rejection is a host fault, not a
    // rule refusal. The host's observation hook receives the original (its
    // stack included); the client gets a distinct code and, in the §6.3.1
    // details, the bounded thrown message. Stacks and thrown values stay off
    // the wire.
    reportError(error, onError, 'sync');
    let text = '';
    let bytes = 0;
    const encoder = new TextEncoder();
    const thrown = error instanceof Error ? error.message : String(error);
    for (const char of thrown.replace(/\p{Cc}+/gu, ' ').trim()) {
      const size = encoder.encode(char).length;
      if (bytes + size > 256) break;
      bytes += size;
      text += char;
    }
    text = text.trimEnd();
    return errorRecord(
      operations[0]?.opIndex ?? 0,
      'sync.validator_error',
      'whole-commit validator failed',
      false,
      {
        reason: 'validator_threw',
        ...(text === ''
          ? {}
          : { references: { validator: 'commit', message: text } }),
      },
    );
  }
  return undefined;
}

/** §6.3.1 reference values are bounded to 256 encoded bytes; an over-long
 * row id still rejects with the same code and reason, and the parent table
 * name alone names the reference. */
function parentReference(
  parentTable: string,
  parentRowId: string,
): Readonly<Record<string, string>> {
  return new TextEncoder().encode(parentRowId).length <= 256
    ? { parent: parentTable, row: parentRowId }
    : { parent: parentTable };
}

function referenceRejection(
  opIndex: number,
  message: string,
  details: RejectionDetails,
): PushOperationResult {
  return {
    opIndex,
    status: 'error',
    code: 'sync.reference_violation',
    message,
    retryable: false,
    details,
  };
}

/**
 * §6.11 declared-reference enforcement, once per commit after every client
 * operation is staged and before whole-commit validation: a present non-null
 * reference column must name a live parent, and a parent delete expands
 * through `CASCADE` / `SET NULL` or rejects `restricted_delete` under
 * `RESTRICT`. Candidate state is read through the transaction, so a commit
 * that deletes a parent and its children together passes. Appended
 * operations join the §6.8 staged operation list (`opIndex` ≥ the client
 * operation count) and emit ordinary changes carrying the child's stored
 * scopes; a rejection attributes to the originating client delete.
 */
async function enforceReferences(
  tx: StorageTransaction,
  schema: CompiledSchema,
  resolved: ResolvedScopes,
  staged: readonly StagedWrite[],
  clientOpCount: number,
  cascadeLimit: number,
  validators: ValidatorRegistry | undefined,
  partition: string,
  actorId: string,
): Promise<
  | {
      readonly kind: 'ok';
      readonly changes: NewChange[];
      readonly operations: ValidateCommitOperation[];
      /** Synthetic opIndex → originating client opIndex. */
      readonly originByIndex: readonly number[];
    }
  | { readonly kind: 'terminate'; readonly record: PushOperationResult }
> {
  const changes: NewChange[] = [];
  const operations: ValidateCommitOperation[] = [];
  const originByIndex: number[] = [];

  // A reference column counts as present when any staged upsert of the row
  // presents it; its value is the row's final value (§6.11).
  const finalByRow = new Map<
    string,
    {
      readonly first: StagedWrite;
      readonly last: StagedWrite;
      readonly presentReferences: ReadonlySet<number>;
    }
  >();
  for (const write of staged) {
    const rowKey = `${write.table.name}\u0000${write.rowId}`;
    const existing = finalByRow.get(rowKey);
    const presentReferences = new Set(existing?.presentReferences);
    for (const reference of write.table.references) {
      if (write.present?.[reference.columnIndex] === true) {
        presentReferences.add(reference.columnIndex);
      }
    }
    finalByRow.set(rowKey, {
      first: existing?.first ?? write,
      last: write,
      presentReferences,
    });
  }

  // One candidate-state read per parent table, not one per reference: a
  // commit that points several rows at the same parent (a fight's
  // combatants, its chronicle) reads that parent once. Postgres binds the
  // ids as one array per table; SQLite and D1 answer with one lookup per id.
  const parentIds = new Map<string, Set<string>>();
  for (const { last: write, presentReferences } of finalByRow.values()) {
    if (write.op !== 'upsert' || write.values === undefined) continue;
    for (const reference of write.table.references) {
      if (!presentReferences.has(reference.columnIndex)) continue;
      const value = write.values[reference.columnIndex];
      if (value === null || value === undefined) continue;
      const parentRowId = renderScopeValue(value);
      if (parentRowId === undefined) continue;
      const ids = parentIds.get(reference.parentTable);
      if (ids === undefined)
        parentIds.set(reference.parentTable, new Set([parentRowId]));
      else ids.add(parentRowId);
    }
  }
  const parents = new Map<string, ReadonlyMap<string, StoredRow>>();
  for (const [parentTable, ids] of parentIds) {
    parents.set(
      parentTable,
      await readCandidateRows(tx, parentTable, [...ids]),
    );
  }

  for (const { last: write, presentReferences } of finalByRow.values()) {
    if (write.op !== 'upsert' || write.values === undefined) continue;
    for (const reference of write.table.references) {
      if (!presentReferences.has(reference.columnIndex)) continue;
      const value = write.values[reference.columnIndex];
      if (value === null || value === undefined) continue;
      const parentRowId = renderScopeValue(value);
      if (parentRowId === undefined) continue;
      // A parent the actor cannot authorize (§3.4, on its stored scopes) is
      // an absent parent: the rejection below is identical either way.
      const parent = parents.get(reference.parentTable)?.get(parentRowId);
      const parentTable = schema.tables.get(reference.parentTable);
      if (
        parent !== undefined &&
        parentTable !== undefined &&
        authorizeWrite(parentTable, parent.scopes, resolved)
      ) {
        continue;
      }
      return {
        kind: 'terminate',
        record: referenceRejection(
          write.opIndex,
          'declared reference names an absent parent row (§6.11)',
          {
            reason: 'missing_parent',
            fieldPaths: [reference.column],
            references: parentReference(reference.parentTable, parentRowId),
          },
        ),
      };
    }
  }

  const schedule = (
    table: CompiledTable,
    rowId: string,
    originOpIndex: number,
    scheduled: Set<string>,
    queue: Array<{
      readonly table: CompiledTable;
      readonly rowId: string;
      readonly originOpIndex: number;
    }>,
  ): boolean => {
    const key = `${table.name}\u0000${rowId}`;
    if (scheduled.has(key)) return false;
    scheduled.add(key);
    queue.push({ table, rowId, originOpIndex });
    return true;
  };

  const scheduled = new Set<string>();
  const processed = new Set<string>();
  const queue: Array<{
    readonly table: CompiledTable;
    readonly rowId: string;
    readonly originOpIndex: number;
  }> = [];
  for (const { first, last } of finalByRow.values()) {
    if (last.op === 'delete' && first.stored !== undefined) {
      schedule(last.table, last.rowId, last.opIndex, scheduled, queue);
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const item = queue[cursor];
    if (item === undefined) continue;
    const key = `${item.table.name}\u0000${item.rowId}`;
    if (processed.has(key)) continue;
    processed.add(key);
    const parentPkColumn = item.table.columns[item.table.primaryKeyIndex];
    const parentKeyValue: RowValue =
      parentPkColumn?.type === 'integer'
        ? Number(item.rowId)
        : parentPkColumn?.type === 'boolean'
          ? item.rowId === 'true'
          : item.rowId;
    for (const reference of item.table.referencedBy) {
      if (tx.scanRowsByIndex === undefined) {
        throw new Error(
          'storage transaction does not support declared-reference enforcement (scanRowsByIndex)',
        );
      }
      if (reference.onDelete === 'RESTRICT') {
        // One remaining child decides RESTRICT.
        const blocking = await tx.scanRowsByIndex({
          table: reference.table,
          index: reference.index,
          values: [parentKeyValue],
          afterRowId: null,
          limit: 1,
        });
        if (blocking.length === 0) continue;
        return {
          kind: 'terminate',
          record: referenceRejection(
            item.originOpIndex,
            'delete is blocked by a declared reference with ON DELETE RESTRICT (§6.11)',
            {
              reason: 'restricted_delete',
              references: { child: reference.table },
            },
          ),
        };
      }
      const child = schema.tables.get(reference.table);
      if (child === undefined) {
        throw new Error(
          `unreachable: reference child table ${reference.table} is not compiled`,
        );
      }
      // Each page reads no more than the remaining cascade budget plus one
      // child, so a cascade past the cap stops after one extra row. A page is
      // applied before the next is read; keyset pagination by rowId is
      // unaffected by deleting or nulling rows already read.
      let afterRowId: string | null = null;
      for (;;) {
        const limit = Math.min(1_000, cascadeLimit - originByIndex.length + 1);
        const page = await tx.scanRowsByIndex({
          table: reference.table,
          index: reference.index,
          values: [parentKeyValue],
          afterRowId,
          limit,
        });
        for (const childRow of page) {
          if (!authorizeWrite(child, childRow.scopes, resolved)) {
            return errorRecord(
              item.originOpIndex,
              'sync.forbidden',
              'cascade denied by scope authorization (§3.4)',
            );
          }
          if (reference.onDelete === 'CASCADE') {
            if (
              !schedule(
                child,
                childRow.rowId,
                item.originOpIndex,
                scheduled,
                queue,
              )
            ) {
              continue;
            }
          } else if (scheduled.has(`${child.name}\u0000${childRow.rowId}`)) {
            continue;
          }
          if (originByIndex.length >= cascadeLimit) {
            return {
              kind: 'terminate',
              record: referenceRejection(
                item.originOpIndex,
                'declared-reference cascade exceeded the per-commit operation cap (§6.11)',
                { reason: 'cascade_limit' },
              ),
            };
          }
          const syntheticIndex = clientOpCount + originByIndex.length;
          const storedValues = decodeRow(child.columns, childRow.payload);
          if (reference.onDelete === 'CASCADE') {
            const reject = await runValidator(
              validators,
              child,
              'delete',
              childRow.rowId,
              undefined,
              storedValues,
              item.originOpIndex,
              tx,
              partition,
              actorId,
            );
            if (reject !== undefined) {
              return { kind: 'terminate', record: reject.record };
            }
            await tx.deleteRow(child.name, childRow.rowId);
            changes.push({
              table: child.name,
              rowId: childRow.rowId,
              op: 'delete',
              deletedVersion: childRow.serverVersion,
              scopes: childRow.scopes,
            });
            operations.push({
              opIndex: syntheticIndex,
              op: 'delete',
              table: child.name,
              rowId: childRow.rowId,
              row: undefined,
              stored: toValidateRow(child.columns, storedValues),
              storedServerVersion: childRow.serverVersion,
            });
          } else {
            const values = [...storedValues];
            values[reference.columnIndex] = null;
            const reject = await runValidator(
              validators,
              child,
              'upsert',
              childRow.rowId,
              values,
              storedValues,
              item.originOpIndex,
              tx,
              partition,
              actorId,
            );
            if (reject !== undefined) {
              return { kind: 'terminate', record: reject.record };
            }
            const nextServerVersion = childRow.serverVersion + 1;
            // §6.2: the SET NULL upsert writes only the reference column, so
            // only that column's version moves.
            const storedVersions = decodeColumnVersions(
              childRow.columnVersions,
            );
            const nextVersions = new Map<number, number>();
            for (let i = 0; i < child.columns.length; i++) {
              const version =
                i === reference.columnIndex
                  ? nextServerVersion
                  : (storedVersions.get(i) ??
                    (childRow.columnVersions === undefined
                      ? childRow.serverVersion
                      : 1));
              if (version > 1) nextVersions.set(i, version);
            }
            const payload = encodeRow(child.columns, values);
            const cascadeVersions = encodeColumnVersions(nextVersions);
            await tx.upsertRow(
              child.name,
              {
                rowId: childRow.rowId,
                serverVersion: nextServerVersion,
                scopes: childRow.scopes,
                payload,
                ...(cascadeVersions !== undefined
                  ? { columnVersions: cascadeVersions }
                  : {}),
              },
              { opIndex: syntheticIndex },
            );
            changes.push({
              table: child.name,
              rowId: childRow.rowId,
              op: 'upsert',
              rowVersion: nextServerVersion,
              scopes: childRow.scopes,
              payload,
            });
            operations.push({
              opIndex: syntheticIndex,
              op: 'upsert',
              table: child.name,
              rowId: childRow.rowId,
              row: toValidateRow(child.columns, values),
              stored: toValidateRow(child.columns, storedValues),
              storedServerVersion: childRow.serverVersion,
              nextServerVersion,
            });
          }
          originByIndex.push(item.originOpIndex);
        }
        if (page.length < limit) break;
        afterRowId = page[page.length - 1]?.rowId ?? null;
      }
    }
  }
  return { kind: 'ok', changes, operations, originByIndex };
}

function resultFrame(
  clientCommitId: string,
  stored: StoredPushResult,
  replay: boolean,
): PushResultFrame {
  const status =
    stored.status === 'applied' ? (replay ? 'cached' : 'applied') : 'rejected';
  return {
    type: 'PUSH_RESULT',
    clientCommitId,
    status,
    ...(stored.status === 'applied' && stored.commitSeq !== undefined
      ? { commitSeq: stored.commitSeq }
      : {}),
    results: [...stored.results],
  };
}

export interface ProcessedPushCommit {
  readonly frame: PushResultFrame;
  /** True when this request observed an already-recorded idempotency outcome. */
  readonly replayed: boolean;
  readonly recordedAtMs?: number;
  readonly cacheIdentity?: string;
}

function processedPushCommit(
  clientCommitId: string,
  stored: StoredPushResult,
  replayed: boolean,
): ProcessedPushCommit {
  return {
    frame: resultFrame(clientCommitId, stored, replayed),
    replayed,
    ...(stored.recordedAtMs !== undefined
      ? { recordedAtMs: stored.recordedAtMs }
      : {}),
    ...(stored.cacheIdentity !== undefined
      ? { cacheIdentity: stored.cacheIdentity }
      : {}),
  };
}

function newStoredPushResult(
  recordedAtMs: number,
  result: Omit<StoredPushResult, 'recordedAtMs' | 'cacheIdentity'>,
): StoredPushResult {
  return {
    ...result,
    recordedAtMs,
    cacheIdentity: crypto.randomUUID(),
  };
}

function idempotencyCacheMissFrame(
  clientCommitId: string,
  error: SyncError,
): PushResultFrame {
  return {
    type: 'PUSH_RESULT',
    clientCommitId,
    status: 'rejected',
    results: [
      {
        opIndex: 0,
        status: 'error',
        code: 'sync.idempotency_cache_miss',
        message: error.message,
        retryable: true,
      },
    ],
  };
}

export interface AppliedCommitEvent {
  readonly commit: StoredCommit;
}

/**
 * Process one `PUSH_COMMIT` frame: idempotency replay (§2.3), sequential
 * atomic apply (§6.4), realtime notification for applied commits.
 */
export async function processPushCommit(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  resolved: ResolvedScopes,
  clientId: string,
  frame: PushCommitFrame,
): Promise<PushResultFrame> {
  return (
    await processPushCommitWithTrace(ctx, schema, resolved, clientId, frame)
  ).frame;
}

/**
 * Host-observable variant of `processPushCommit`. The SSP2 wire frame keeps
 * rejected replays as `status: rejected`; this companion result preserves the
 * cache provenance needed by structured events and server helpers.
 */
export async function processPushCommitWithTrace(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  resolved: ResolvedScopes,
  clientId: string,
  frame: PushCommitFrame,
  wireSchema: CompiledSchema = schema,
): Promise<ProcessedPushCommit> {
  // The frame names its rows before the transaction opens, so the admission
  // read carries the commit's read-ahead and the apply issues no separate
  // prefetch statement.
  const targets = new Map<string, string[]>();
  for (const op of frame.operations) {
    // A rowId holding U+0000 is rejected per operation (§6.1) before any
    // store reads it.
    if (!schema.tables.has(op.table) || op.rowId.includes('\u0000')) continue;
    const ids = targets.get(op.table) ?? [];
    ids.push(op.rowId);
    targets.set(op.table, ids);
  }
  return processPushOperationsWithTrace(
    ctx,
    schema,
    resolved,
    clientId,
    frame.clientCommitId,
    async () => frame.operations,
    wireSchema,
    targets.size === 0
      ? undefined
      : [...targets].map(([table, rowIds]) => ({ table, rowIds })),
  );
}

/**
 * Shared serialized apply path for SSP2 commits and authoritative commands.
 * The builder runs after the partition lock and idempotency re-check, so its
 * reads and the returned operations share the transaction that is committed.
 */
export async function processPushOperationsWithTrace(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  resolved: ResolvedScopes,
  clientId: string,
  clientCommitId: string,
  buildOperations: (
    tx: StorageTransaction,
  ) => Promise<readonly ApplyOperation[]>,
  wireSchema: CompiledSchema = schema,
  prefetchTargets?: readonly {
    readonly table: string;
    readonly rowIds: readonly string[];
  }[],
): Promise<ProcessedPushCommit> {
  const { partition } = ctx;
  const createdAtMs = clockOf(ctx)();
  const blobCtx: BlobApplyContext = {
    store: ctx.blobs,
    partition,
    presence: new Map(),
  };
  const crdtMergers = ctx.crdtMergers;
  const validators = ctx.validators;
  const commitValidator = ctx.commitValidator;
  const reactionPlanner = ctx.reactionPlanner;
  const tx = await ctx.storage.begin(partition);
  try {
    if (reactionPlanner !== undefined && tx.enqueueReactions === undefined) {
      throw new Error(
        'storage transaction does not support configured durable reactions',
      );
    }
    // The storage takes the partition lock and then reads the admission token
    // on the transaction's own connection: the RFC 0007 serve gate and the
    // §2.3 idempotency record, plus any read-ahead the caller already knows.
    // A racing duplicate's result commits before the lock releases, so the
    // later read is exact and a duplicate never reruns an operation,
    // validator, or merge.
    let prepared: PreparedPushApply;
    try {
      prepared = await tx.preparePushApply(
        clientId,
        clientCommitId,
        schema.version,
        prefetchTargets,
      );
    } catch (error) {
      if (
        error instanceof SyncError &&
        error.code === 'sync.idempotency_cache_miss'
      ) {
        // §6.3: answer the retryable cache-miss for this commit rather than
        // re-applying. Not persisted — a retry may find a readable record.
        await tx.rollback();
        return {
          frame: idempotencyCacheMissFrame(clientCommitId, error),
          replayed: false,
        };
      }
      throw error;
    }
    // RFC 0007: the gate is evaluated while the partition lock is held, so
    // the migration check and the write share one transaction and no
    // migration can interleave in between.
    const refusal = serveGateRefusal(
      prepared.gate,
      schema.version,
      ctx.checkpoints,
    );
    if (refusal !== undefined) {
      await tx.rollback();
      throw serveNotReadyError(refusal);
    }
    if (prepared.persisted !== undefined) {
      const conflict = prepared.persisted.results.find(
        (result) => result.status === 'conflict',
      );
      const authorization = prepared.persisted.conflictAuthorization;
      const table = authorization && schema.tables.get(authorization.table);
      if (
        conflict !== undefined &&
        (authorization === undefined ||
          authorization.schemaVersion !== schema.version ||
          table === undefined ||
          !authorizeWrite(table, authorization.scopes, resolved))
      ) {
        await tx.rollback();
        return processedPushCommit(
          clientCommitId,
          {
            ...prepared.persisted,
            results: [
              {
                opIndex: conflict.opIndex,
                status: 'error',
                code: 'sync.forbidden',
                message: 'conflict replay denied by scope authorization (§3.4)',
                retryable: false,
              },
            ],
          },
          true,
        );
      }
      await tx.rollback();
      return processedPushCommit(clientCommitId, prepared.persisted, true);
    }
    const results: PushOperationResult[] = [];
    const changes: NewChange[] = [];
    const validatedOperations: ValidateCommitOperation[] = [];
    const stagedWrites: StagedWrite[] = [];
    let terminated: PushOperationResult | undefined;
    const operations = await buildOperations(tx);
    if (tx.prefetchRows !== undefined) {
      const targets = new Map<string, string[]>();
      for (const op of operations) {
        if (!schema.tables.has(op.table) || op.rowId.includes('\u0000'))
          continue;
        const ids = targets.get(op.table) ?? [];
        ids.push(op.rowId);
        targets.set(op.table, ids);
      }
      if (targets.size > 0) {
        await tx.prefetchRows(
          [...targets].map(([table, rowIds]) => ({ table, rowIds })),
        );
      }
    }
    // §6.6: the blobIds the commit pushes are checked once, concurrently,
    // before the operation loop. A payload that fails decode is skipped here
    // and rejected by its operation.
    const pushedBlobIds: string[] = [];
    for (const op of operations) {
      const table = schema.tables.get(op.table);
      const wireTable = wireSchema.tables.get(op.table);
      if (
        op.payload === undefined ||
        table === undefined ||
        wireTable === undefined ||
        table.blobRefColumnIndices.length === 0
      ) {
        continue;
      }
      let sparse: SparseRowValue[];
      try {
        sparse = decodeSparseRow(
          wireTable.columns,
          wireTable.primaryKeyIndex,
          op.payload,
        );
      } catch {
        continue;
      }
      for (const index of table.blobRefColumnIndices) {
        const value = sparse[index];
        if (typeof value === 'string') {
          pushedBlobIds.push(parseBlobRef(value).blobId);
        }
      }
    }
    await resolveBlobPresence(blobCtx, pushedBlobIds);
    // §6.4: the row each touched (table, rowId) held before this commit, so a
    // conflict reports the row as stored once the commit rolls back.
    const storedBeforeCommit = new Map<string, StoredRow | undefined>();
    for (let opIndex = 0; opIndex < operations.length; opIndex++) {
      const op = operations[opIndex];
      if (op === undefined) continue;
      const outcome = await applyOperation(
        tx,
        schema,
        wireSchema,
        resolved,
        op,
        opIndex,
        blobCtx,
        crdtMergers,
        validators,
        partition,
        ctx.actorId,
      );
      if (outcome.kind === 'terminate') {
        terminated = outcome.record;
        break;
      }
      const rowKey = `${op.table}\u0000${op.rowId}`;
      if (!storedBeforeCommit.has(rowKey)) {
        storedBeforeCommit.set(rowKey, outcome.staged.stored);
      }
      results.push({ opIndex, status: 'applied' });
      validatedOperations.push(...outcome.operations);
      stagedWrites.push(outcome.staged);
      changes.push(...outcome.changes);
    }

    // §6.11: reference enforcement runs after every client operation is
    // staged (so the candidate state is final for the client's own writes)
    // and before whole-commit validation.
    let appendedOrigin: readonly number[] = [];
    if (terminated === undefined) {
      const referencePass = await enforceReferences(
        tx,
        schema,
        resolved,
        stagedWrites,
        operations.length,
        limitsOf(ctx).maxCascadeOperationsPerCommit,
        validators,
        partition,
        ctx.actorId,
      );
      if (referencePass.kind === 'terminate') {
        terminated = referencePass.record;
      } else {
        changes.push(...referencePass.changes);
        validatedOperations.push(...referencePass.operations);
        appendedOrigin = referencePass.originByIndex;
      }
    }

    if (terminated === undefined) {
      const commitReject = await runCommitValidator(
        commitValidator,
        ctx.onError,
        tx,
        schema,
        clientId,
        clientCommitId,
        ctx.actorId,
        partition,
        validatedOperations,
      );
      if (commitReject?.kind === 'terminate') {
        // An appended §6.11 cascade operation carries a synthetic opIndex;
        // surface the originating client operation instead.
        const rejected = commitReject.record;
        terminated =
          rejected.opIndex >= operations.length
            ? {
                ...rejected,
                opIndex:
                  appendedOrigin[rejected.opIndex - operations.length] ?? 0,
              }
            : rejected;
      }
    }

    let preparedReactions: PreparedReaction[] = [];
    if (terminated === undefined && reactionPlanner !== undefined) {
      preparedReactions = await prepareReactions(reactionPlanner, {
        clientId,
        clientCommitId,
        actorId: ctx.actorId,
        partition,
        operations: validatedOperations,
        read: commitValidationReader(tx, schema),
      });
    }

    if (terminated !== undefined) {
      // §6.3 rejected: only the terminating operation's record; §6.4:
      // every write of the commit rolls back.
      const conflictOperation =
        terminated.status === 'conflict'
          ? operations[terminated.opIndex]
          : undefined;
      // §6.4: a conflict only arises in the operation loop, so a row no
      // earlier operation touched still reads as stored before the commit.
      const conflictKey =
        conflictOperation === undefined
          ? undefined
          : `${conflictOperation.table}\u0000${conflictOperation.rowId}`;
      const conflictRow =
        conflictOperation === undefined || conflictKey === undefined
          ? undefined
          : storedBeforeCommit.has(conflictKey)
            ? storedBeforeCommit.get(conflictKey)
            : await tx.getRow(conflictOperation.table, conflictOperation.rowId);
      if (terminated.status === 'conflict') {
        terminated =
          conflictRow === undefined
            ? errorRecord(
                terminated.opIndex,
                'sync.row_missing',
                'the conflicting row exists only through an earlier operation of the same commit (§6.4)',
              ).record
            : {
                ...terminated,
                serverVersion: conflictRow.serverVersion,
                serverRow: conflictRow.payload,
              };
      }
      const stored = newStoredPushResult(createdAtMs, {
        status: 'rejected',
        ...(terminated.status === 'conflict' &&
        conflictOperation !== undefined &&
        conflictRow !== undefined
          ? {
              conflictAuthorization: {
                table: conflictOperation.table,
                schemaVersion: schema.version,
                scopes: conflictRow.scopes,
              },
            }
          : {}),
        results: [terminated],
      });
      // Discard candidates and persist the rejection while retaining the same
      // partition lock. There is no unlock gap in which a duplicate can rerun,
      // and the finalization returns the canonical outcome it persisted.
      const canonical = await tx.commitRejectedPushResult(
        clientId,
        clientCommitId,
        stored,
      );
      return processedPushCommit(
        clientCommitId,
        canonical,
        canonical.cacheIdentity !== stored.cacheIdentity,
      );
    }

    const commitSeq = await tx.appendCommit({
      clientId,
      clientCommitId,
      actorId: ctx.actorId,
      createdAtMs,
      changes,
    });
    const newReactions = toNewReactions(preparedReactions, {
      clientId,
      clientCommitId,
      commitSeq,
      createdAtMs,
    });
    if (newReactions.length > 0) {
      const enqueueReactions = tx.enqueueReactions;
      if (enqueueReactions === undefined) {
        throw new Error('storage lost durable reaction enqueue support');
      }
      await enqueueReactions.call(tx, newReactions);
    }
    const stored = newStoredPushResult(createdAtMs, {
      status: 'applied',
      commitSeq,
      results,
    });
    await tx.putPushResult(clientId, clientCommitId, stored);
    await tx.commit();
    if (ctx.events !== undefined) {
      const atMs = clockOf(ctx)();
      for (const reaction of newReactions) {
        emitEvent(ctx.events, {
          type: 'reaction.queued',
          atMs,
          partition,
          actorId: ctx.actorId,
          clientId,
          clientCommitId,
          commitSeq,
          idempotencyKey: reaction.idempotencyKey,
          reactionType: reaction.type,
          version: reaction.version,
        });
      }
    }
    if (ctx.realtime !== undefined && changes.length > 0) {
      // RFC 0007 fanout decision: the notification carries the durable commit
      // entry itself (this commit's `changes`), not a projection read or a pull
      // window, so fanning it out before the request's buffered read-verify can
      // never serve a mixed result. Each peer's next pull is gated at the
      // storage seam; a refused mixed push+pull is safe because the push is
      // durable and replayable under its commit id. This is commit-entry
      // durability, not gate inheritance.
      await ctx.realtime.notifyCommit(partition, {
        commitSeq,
        createdAtMs,
        actorId: ctx.actorId,
        changes,
      });
    }
    return processedPushCommit(clientCommitId, stored, false);
  } catch (error) {
    if (error instanceof StorageConstraintError) {
      const stored = newStoredPushResult(createdAtMs, {
        status: 'rejected',
        results: [
          {
            opIndex: error.opIndex ?? 0,
            status: 'error',
            code: 'sync.constraint_violation',
            message: 'write violates a relational constraint',
            retryable: false,
          },
        ],
      });
      try {
        const canonical = await tx.commitRejectedPushResult(
          clientId,
          clientCommitId,
          stored,
        );
        return processedPushCommit(
          clientCommitId,
          canonical,
          canonical.cacheIdentity !== stored.cacheIdentity,
        );
      } catch (finalizationError) {
        // A failed finalization must still release the transaction: on
        // SQLite an unreleased BEGIN wedges the storage's global begin()
        // queue, on Postgres it leaks the pinned pool client. rollback() is
        // a no-op when the finalization already committed.
        try {
          await tx.rollback();
        } catch (rollbackError) {
          retainRollbackFailure(finalizationError, rollbackError);
        }
        throw finalizationError;
      }
    }
    try {
      await tx.rollback();
    } catch (rollbackError) {
      retainRollbackFailure(error, rollbackError);
    }
    throw error;
  }
}
