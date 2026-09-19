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
import { SyncError } from './errors';
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
  StorageTransaction,
  StoredCommit,
  StoredPushResult,
  StoredRow,
} from './storage';
import { serveGateRefusal } from './storage';
import { StorageConstraintError } from './storage-errors';
import { serveNotReadyError } from './readiness';
import type {
  CommitValidationReader,
  CommitValidator,
  ValidateCommitOperation,
  ValidateOpKind,
  ValidatorRegistry,
} from './validate';
import {
  CommitValidationRejection,
  toValidateRow,
  ValidationRejection,
} from './validate';

/**
 * Extract the blobIds a decoded row references through its `blob_ref`
 * columns (§5.9.4), skipping NULLs. Malformed BlobRefs already failed at
 * row-codec decode (§5.9.1), so `parseBlobRef` here is total.
 */
function blobIdsInRow(
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
      readonly change: NewChange | undefined;
      readonly operation: ValidateCommitOperation;
      readonly staged: StagedWrite;
    }
  | TerminatingOutcome;

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
      { actorId, partition },
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
  resolved: ResolvedScopes,
  op: PushOperation,
  opIndex: number,
  blobCtx: BlobApplyContext,
  crdtMergers: CrdtMergerRegistry | undefined,
  validators: ValidatorRegistry | undefined,
  partition: string,
  actorId: string,
): Promise<OperationOutcome> {
  const table = schema.tables.get(op.table);
  if (table === undefined) {
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
  const stored = await tx.getRow(op.table, op.rowId);

  if (op.op === 'delete') {
    if (stored === undefined) {
      // Deleting an absent row is applied (idempotent, §6.2); no change.
      return {
        kind: 'applied',
        change: undefined,
        operation: {
          opIndex,
          op: 'delete',
          table: table.name,
          rowId: op.rowId,
          row: undefined,
          stored: undefined,
        },
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
      partition,
      actorId,
    );
    if (deleteReject !== undefined) return deleteReject;
    await tx.deleteRow(op.table, op.rowId);
    return {
      kind: 'applied',
      change: {
        table: op.table,
        rowId: op.rowId,
        op: 'delete',
        scopes: stored.scopes,
      },
      operation: {
        opIndex,
        op: 'delete',
        table: table.name,
        rowId: op.rowId,
        row: undefined,
        stored: toValidateRow(table.columns, storedValues),
        storedServerVersion: stored.serverVersion,
      },
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
    sparse = decodeSparseRow(table.columns, table.primaryKeyIndex, payload);
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
      change: {
        table: op.table,
        rowId: op.rowId,
        op: 'upsert',
        rowVersion: newVersion,
        scopes: stored.scopes,
        payload: newPayload,
      },
      operation: {
        opIndex,
        op: 'upsert',
        table: table.name,
        rowId: op.rowId,
        row: toValidateRow(table.columns, values),
        stored: toValidateRow(table.columns, storedValues),
        storedServerVersion: stored.serverVersion,
        nextServerVersion: newVersion,
      },
      staged: { table, op: 'upsert', rowId: op.rowId, opIndex, values, stored },
    };
  }

  // Insert path: no stored row (§5.2).
  const values: RowValue[] = sparse.map((value) => value ?? null);
  if (op.baseVersion !== undefined && op.baseVersion !== 0) {
    // Authorize the payload first so absence is not disclosed to actors
    // without the scope; then §6.2: baseVersion ≠ 0, row absent.
    const extractedFirst = storedScopesForRow(table, values);
    if (
      'missing' in extractedFirst ||
      !authorizeWrite(table, extractedFirst.scopes, resolved)
    ) {
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
  if (op.baseVersion === undefined) {
    // §5.2: a delete within the retention horizon beats an unversioned
    // upsert; an explicit insert (baseVersion 0) recreates instead.
    const tombstoneSeq = await tx.getTombstoneSeq(op.table, op.rowId);
    if (tombstoneSeq !== undefined) {
      return errorRecord(
        opIndex,
        'sync.row_deleted',
        'a deleted row rejects an unversioned upsert within the retention horizon (§5.2)',
      );
    }
  }
  if (presentCount < table.columns.length) {
    // §6.3: an insert requires every column present.
    return errorRecord(
      opIndex,
      'sync.row_missing',
      'a partial payload targets an absent row (§6.3)',
    );
  }
  const extracted = storedScopesForRow(table, values);
  if ('missing' in extracted) {
    // §3.4 step 2: a missing or empty scope column value ⇒ deny.
    return errorRecord(
      opIndex,
      'sync.forbidden',
      `insert missing scope column value for ${JSON.stringify(extracted.missing)} (§3.4)`,
    );
  }
  if (!authorizeWrite(table, extracted.scopes, resolved)) {
    return errorRecord(
      opIndex,
      'sync.forbidden',
      'insert denied by scope authorization (§3.4)',
    );
  }
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
    partition,
    actorId,
  );
  if (insertReject !== undefined) return insertReject;
  // §5.2: an explicit insert recreates — the tombstone goes with it.
  await tx.clearTombstone(op.table, op.rowId);
  const newRow = {
    rowId: op.rowId,
    serverVersion: 1,
    scopes: extracted.scopes,
    payload: insertPayload,
  };
  await tx.upsertRow(op.table, newRow, { opIndex });
  return {
    kind: 'applied',
    change: {
      table: op.table,
      rowId: op.rowId,
      op: 'upsert',
      rowVersion: 1,
      scopes: extracted.scopes,
      payload: insertPayload,
    },
    operation: {
      opIndex,
      op: 'upsert',
      table: table.name,
      rowId: op.rowId,
      row: toValidateRow(table.columns, values),
      stored: undefined,
      nextServerVersion: 1,
    },
    staged: {
      table,
      op: 'upsert',
      rowId: op.rowId,
      opIndex,
      values,
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
    for (const blobId of blobIds) {
      if (!(await blobCtx.store.has(blobCtx.partition, blobId))) {
        return errorRecord(
          opIndex,
          'blob.not_found',
          `push references blob ${blobId} which has not been uploaded (§5.9.6)`,
        );
      }
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
  };
}

async function runCommitValidator(
  validator: CommitValidator | undefined,
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
    return errorRecord(
      operations[0]?.opIndex ?? 0,
      'sync.constraint_violation',
      'whole-commit validator failed',
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

  for (const write of staged) {
    if (write.op !== 'upsert' || write.values === undefined) continue;
    for (const reference of write.table.references) {
      const value = write.values[reference.columnIndex];
      if (value === null || value === undefined) continue;
      const parentRowId = renderScopeValue(value);
      if (parentRowId === undefined) continue;
      if ((await tx.getRow(reference.parentTable, parentRowId)) !== undefined) {
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
  for (const write of staged) {
    if (write.op === 'delete' && write.stored !== undefined) {
      schedule(write.table, write.rowId, write.opIndex, scheduled, queue);
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const item = queue[cursor];
    if (item === undefined) continue;
    const key = `${item.table.name}\u0000${item.rowId}`;
    if (processed.has(key)) continue;
    processed.add(key);
    for (const reference of item.table.referencedBy) {
      if (tx.scanRowsByIndex === undefined) {
        throw new Error(
          'storage transaction does not support declared-reference enforcement (scanRowsByIndex)',
        );
      }
      const children: StoredRow[] = [];
      let afterRowId: string | null = null;
      for (;;) {
        const page = await tx.scanRowsByIndex({
          table: reference.table,
          index: reference.index,
          values: [item.rowId],
          afterRowId,
          limit: 1_000,
        });
        children.push(...page);
        if (page.length < 1_000) break;
        afterRowId = page[page.length - 1]?.rowId ?? null;
      }
      if (children.length === 0) continue;
      if (reference.onDelete === 'RESTRICT') {
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
      for (const childRow of children) {
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
        if (
          !schedule(child, childRow.rowId, item.originOpIndex, scheduled, queue)
        ) {
          continue;
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
            partition,
            actorId,
          );
          if (reject !== undefined) {
            return { kind: 'terminate', record: reject.record };
          }
          const nextServerVersion = childRow.serverVersion + 1;
          // §6.2: the SET NULL upsert writes only the reference column, so
          // only that column's version moves.
          const storedVersions = decodeColumnVersions(childRow.columnVersions);
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
): Promise<ProcessedPushCommit> {
  return processPushOperationsWithTrace(
    ctx,
    schema,
    resolved,
    clientId,
    frame.clientCommitId,
    async () => frame.operations,
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
  ) => Promise<readonly PushOperation[]>,
): Promise<ProcessedPushCommit> {
  const { storage, partition } = ctx;
  let persisted: StoredPushResult | undefined;
  try {
    persisted = await storage.getPushResult(
      partition,
      clientId,
      clientCommitId,
    );
  } catch (error) {
    if (
      error instanceof SyncError &&
      error.code === 'sync.idempotency_cache_miss'
    ) {
      // §6.3: answer the retryable cache-miss for this commit rather than
      // re-applying. Not persisted — a retry may find a readable record.
      return {
        frame: idempotencyCacheMissFrame(clientCommitId, error),
        replayed: false,
      };
    }
    throw error;
  }
  if (persisted !== undefined) {
    return processedPushCommit(clientCommitId, persisted, true);
  }

  const createdAtMs = clockOf(ctx)();
  const blobCtx: BlobApplyContext = { store: ctx.blobs, partition };
  const crdtMergers = ctx.crdtMergers;
  const validators = ctx.validators;
  const commitValidator = ctx.commitValidator;
  const reactionPlanner = ctx.reactionPlanner;
  const tx = await storage.begin(partition);
  const lockPartitionForPush =
    tx.lockPartitionForPush?.bind(tx) ??
    tx.lockPartitionForCommitValidation?.bind(tx);
  const commitRejectedPushResult = tx.commitRejectedPushResult?.bind(tx);
  try {
    if (
      lockPartitionForPush === undefined ||
      commitRejectedPushResult === undefined ||
      (reactionPlanner !== undefined && tx.enqueueReactions === undefined)
    ) {
      throw new Error(
        'storage transaction does not support serialized push apply, atomic rejection finalization, and configured durable reactions',
      );
    }
    await lockPartitionForPush();
    // RFC 0007: evaluate the gate on this transaction's own connection while
    // the partition lock is held, so the migration check and the write share
    // one transaction and no migration can interleave in between.
    const gate = await tx.readServeGate(schema.version);
    const refusal = serveGateRefusal(gate, schema.version, ctx.checkpoints);
    if (refusal !== undefined) {
      await tx.rollback();
      throw serveNotReadyError(refusal);
    }
    // The optimistic lookup above may have raced another delivery. Re-check
    // only after acquiring partition serialization and before any operation
    // read, validation, merge, or staged write. The re-check runs on the
    // transaction's own connection when the backend provides one: a pooled
    // Postgres client holding the partition lock would otherwise wait for a
    // second pool slot and deadlock against pushes waiting on the lock. A
    // racing duplicate's result commits before the lock releases, so the
    // transaction-scoped read observes it.
    try {
      const serializedPersisted =
        tx.getPushResult !== undefined
          ? await tx.getPushResult(clientId, clientCommitId)
          : await storage.getPushResult(partition, clientId, clientCommitId);
      if (serializedPersisted !== undefined) {
        await tx.rollback();
        return processedPushCommit(clientCommitId, serializedPersisted, true);
      }
    } catch (error) {
      if (
        error instanceof SyncError &&
        error.code === 'sync.idempotency_cache_miss'
      ) {
        await tx.rollback();
        return {
          frame: idempotencyCacheMissFrame(clientCommitId, error),
          replayed: false,
        };
      }
      throw error;
    }
    const results: PushOperationResult[] = [];
    const changes: NewChange[] = [];
    const validatedOperations: ValidateCommitOperation[] = [];
    const stagedWrites: StagedWrite[] = [];
    let terminated: PushOperationResult | undefined;
    const operations = await buildOperations(tx);
    for (let opIndex = 0; opIndex < operations.length; opIndex++) {
      const op = operations[opIndex];
      if (op === undefined) continue;
      const outcome = await applyOperation(
        tx,
        schema,
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
      results.push({ opIndex, status: 'applied' });
      validatedOperations.push(outcome.operation);
      stagedWrites.push(outcome.staged);
      if (outcome.change !== undefined) changes.push(outcome.change);
    }

    // §6.11: reference enforcement runs after every client operation is
    // staged (so the candidate state is final for the client's own writes)
    // and before whole-commit validation.
    let appendedOrigin: readonly number[] = [];
    if (terminated === undefined) {
      const referencePass = await enforceReferences(
        tx,
        schema,
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
      const stored = newStoredPushResult(createdAtMs, {
        status: 'rejected',
        results: [terminated],
      });
      // Discard candidates and persist the rejection while retaining the same
      // partition lock. There is no unlock gap in which a duplicate can rerun.
      await commitRejectedPushResult(clientId, clientCommitId, stored);
      const canonical = await storage.getPushResult(
        partition,
        clientId,
        clientCommitId,
      );
      if (canonical === undefined) {
        throw new Error(
          'push rejection finalization did not persist an outcome',
        );
      }
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
      if (commitRejectedPushResult === undefined) {
        await tx.rollback();
        throw new Error(
          'storage transaction lost atomic push rejection finalization support',
        );
      }
      try {
        await commitRejectedPushResult(clientId, clientCommitId, stored);
        const canonical = await storage.getPushResult(
          partition,
          clientId,
          clientCommitId,
        );
        if (canonical === undefined) {
          throw new Error(
            'push rejection finalization did not persist an outcome',
          );
        }
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
        } catch {
          // Surface the finalization failure; a rollback failure would
          // otherwise mask it.
        }
        throw finalizationError;
      }
    }
    await tx.rollback();
    throw error;
  }
}
