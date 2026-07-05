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
  encodeRow,
  type PushCommitFrame,
  type PushOperation,
  type PushOperationResult,
  type PushResultFrame,
  parseBlobRef,
  type RowValue,
} from '@syncular/core';
import type { BlobStore } from './blob-store';
import type { SyncRequestContext } from './context';
import { clockOf } from './context';
import type { CrdtMergerRegistry } from './crdt-merger';
import { SyncError } from './errors';
import type { CompiledSchema, CompiledTable } from './schema';
import type { ResolvedScopes } from './scopes';
import { authorizeWrite, renderScopeValue, storedScopesForRow } from './scopes';
import type {
  NewChange,
  StorageTransaction,
  StoredCommit,
  StoredPushResult,
} from './storage';
import type { ValidateOpKind, ValidatorRegistry } from './validate';
import { toValidateRow, ValidationRejection } from './validate';

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

type OperationOutcome =
  | { readonly kind: 'applied'; readonly change: NewChange | undefined }
  | { readonly kind: 'terminate'; readonly record: PushOperationResult };

function errorRecord(
  opIndex: number,
  code: string,
  message: string,
  retryable = false,
): OperationOutcome {
  return {
    kind: 'terminate',
    record: { opIndex, status: 'error', code, message, retryable },
  };
}

function conflictRecord(
  opIndex: number,
  serverVersion: number,
  serverRow: Uint8Array,
): OperationOutcome {
  return {
    kind: 'terminate',
    record: {
      opIndex,
      status: 'conflict',
      code: 'sync.version_conflict',
      message: 'row version does not match baseVersion (§6.2)',
      serverVersion,
      serverRow,
    },
  };
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
): Promise<OperationOutcome | undefined> {
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
      return errorRecord(opIndex, error.code, error.message);
    }
    // §6.7: a non-ValidationRejection throw is still a rejection, mapped to
    // the generic server-side constraint code (§10.2) — the validator's
    // failure never crashes the request or leaks its message as a code.
    return errorRecord(
      opIndex,
      'sync.constraint_violation',
      `write validator for table ${JSON.stringify(table.name)} threw: ${error instanceof Error ? error.message : String(error)}`,
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
 * type). Merging only runs for a non-NULL incoming crdt value.
 */
async function mergeCrdtColumns(
  table: CompiledTable,
  values: RowValue[],
  storedValues: readonly RowValue[] | undefined,
  opIndex: number,
  mergers: CrdtMergerRegistry | undefined,
): Promise<OperationOutcome | { readonly changed: boolean }> {
  if (table.crdtColumns.length === 0) return { changed: false };
  let changed = false;
  for (const { index, crdtType } of table.crdtColumns) {
    const incoming = values[index];
    if (!(incoming instanceof Uint8Array)) continue; // NULL clear or absent
    const merger = mergers?.[crdtType];
    if (merger === undefined) {
      return errorRecord(
        opIndex,
        'sync.crdt_merge_failed',
        `no CRDT merger registered for crdtType ${JSON.stringify(crdtType)} (§5.10.2)`,
      );
    }
    const storedRaw = storedValues?.[index];
    const stored = storedRaw instanceof Uint8Array ? storedRaw : null;
    let merged: Uint8Array;
    try {
      merged = await merger(stored, incoming);
    } catch (error) {
      return errorRecord(
        opIndex,
        'sync.crdt_merge_failed',
        `CRDT merger for ${JSON.stringify(crdtType)} threw: ${error instanceof Error ? error.message : String(error)}`,
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
      return { kind: 'applied', change: undefined };
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
    const deleteReject = await runValidator(
      validators,
      table,
      'delete',
      op.rowId,
      undefined,
      decodeRow(table.columns, stored.payload),
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
    };
  }

  // upsert — payload presence is enforced by the envelope codec (§6.1).
  const payload = op.payload;
  if (payload === undefined) {
    return errorRecord(
      opIndex,
      'sync.invalid_request',
      'upsert without payload',
    );
  }
  let values: RowValue[];
  try {
    values = decodeRow(table.columns, payload);
  } catch (error) {
    return errorRecord(
      opIndex,
      'sync.invalid_request',
      `row payload failed row-codec decode (§1.7): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const pkValue = renderScopeValue(values[table.primaryKeyIndex]);
  if (pkValue !== op.rowId) {
    return errorRecord(
      opIndex,
      'sync.invalid_request',
      'payload primary key does not match rowId',
    );
  }

  if (stored !== undefined) {
    // §3.4 step 2: authorize against the STORED row, never the payload.
    if (!authorizeWrite(table, stored.scopes, resolved)) {
      return errorRecord(
        opIndex,
        'sync.forbidden',
        'write denied by scope authorization (§3.4)',
      );
    }
    if (op.baseVersion === 0) {
      // Lost insert race (§6.2); the stored row was authorized above,
      // so disclosure of the winner is permitted.
      return conflictRecord(opIndex, stored.serverVersion, stored.payload);
    }
    if (
      op.baseVersion !== undefined &&
      op.baseVersion !== stored.serverVersion
    ) {
      return conflictRecord(opIndex, stored.serverVersion, stored.payload);
    }
    // §3.4 rule 5: scope columns are immutable on update — keep the
    // stored row's scope column values on both the baseVersion and
    // last-write-wins paths.
    const storedValues = decodeRow(table.columns, stored.payload);
    let mutated = false;
    for (const pattern of table.scopePatterns) {
      const storedValue = storedValues[pattern.columnIndex] ?? null;
      if (values[pattern.columnIndex] !== storedValue) {
        values[pattern.columnIndex] = storedValue;
        mutated = true;
      }
    }
    // §5.10.3: crdt columns merge (stored ⊕ incoming) — never LWW, never
    // baseVersion-conflict (they were excluded from the checks above).
    const mergeOutcome = await mergeCrdtColumns(
      table,
      values,
      storedValues,
      opIndex,
      crdtMergers,
    );
    if ('kind' in mergeOutcome) return mergeOutcome;
    if (mergeOutcome.changed) mutated = true;
    const newPayload = mutated ? encodeRow(table.columns, values) : payload;
    const newVersion = stored.serverVersion + 1;
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
    // §6.7: validate the merged, scope-stripped row that will persist —
    // for a crdt column the validator sees the MERGED value (§5.10.3), the
    // state the store holds, not the raw pushed update.
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
    const newRow = {
      rowId: op.rowId,
      serverVersion: newVersion,
      scopes: stored.scopes,
      payload: newPayload,
    };
    await tx.upsertRow(op.table, newRow);
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
    };
  }

  // Insert path: no stored row.
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
    opIndex,
    crdtMergers,
  );
  if ('kind' in insertMerge) return insertMerge;
  const insertPayload = insertMerge.changed
    ? encodeRow(table.columns, values)
    : payload;
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
  const newRow = {
    rowId: op.rowId,
    serverVersion: 1,
    scopes: extracted.scopes,
    payload: insertPayload,
  };
  await tx.upsertRow(op.table, newRow);
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
  const { storage, partition } = ctx;
  let persisted: StoredPushResult | undefined;
  try {
    persisted = await storage.getPushResult(
      partition,
      clientId,
      frame.clientCommitId,
    );
  } catch (error) {
    if (
      error instanceof SyncError &&
      error.code === 'sync.idempotency_cache_miss'
    ) {
      // §6.3: answer the retryable cache-miss for this commit rather than
      // re-applying. Not persisted — a retry may find a readable record.
      return {
        type: 'PUSH_RESULT',
        clientCommitId: frame.clientCommitId,
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
    throw error;
  }
  if (persisted !== undefined) {
    return resultFrame(frame.clientCommitId, persisted, true);
  }

  const createdAtMs = clockOf(ctx)();
  const blobCtx: BlobApplyContext = { store: ctx.blobs, partition };
  const crdtMergers = ctx.crdtMergers;
  const validators = ctx.validators;
  const tx = await storage.begin(partition);
  try {
    const results: PushOperationResult[] = [];
    const changes: NewChange[] = [];
    let terminated: PushOperationResult | undefined;
    for (let opIndex = 0; opIndex < frame.operations.length; opIndex++) {
      const op = frame.operations[opIndex];
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
      if (outcome.change !== undefined) changes.push(outcome.change);
    }

    if (terminated !== undefined) {
      // §6.3 rejected: only the terminating operation's record; §6.4:
      // every write of the commit rolls back.
      await tx.rollback();
      const stored: StoredPushResult = {
        status: 'rejected',
        results: [terminated],
      };
      const rejectionTx = await storage.begin(partition);
      try {
        await rejectionTx.putPushResult(clientId, frame.clientCommitId, stored);
        await rejectionTx.commit();
      } catch (error) {
        await rejectionTx.rollback();
        throw error;
      }
      return resultFrame(frame.clientCommitId, stored, false);
    }

    const commitSeq = await tx.appendCommit({
      clientId,
      clientCommitId: frame.clientCommitId,
      actorId: ctx.actorId,
      createdAtMs,
      changes,
    });
    const stored: StoredPushResult = { status: 'applied', commitSeq, results };
    await tx.putPushResult(clientId, frame.clientCommitId, stored);
    await tx.commit();
    if (ctx.realtime !== undefined && changes.length > 0) {
      await ctx.realtime.notifyCommit(partition, {
        commitSeq,
        createdAtMs,
        actorId: ctx.actorId,
        changes,
      });
    }
    return resultFrame(frame.clientCommitId, stored, false);
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
