/**
 * Scope-value erasure (SPEC.md §4.6.1): remove every row whose stored scope
 * binds one variable to one value, the upsert change records that carried
 * those rows, and the blob bytes no remaining row references.
 *
 * Live rows leave through one ordinary delete commit per call, applied on
 * the shared push path (partition lock, tombstones, blob reference index,
 * realtime fanout). The commit advances the binding's scoped change seq, so
 * no cached segment taken before the erasure is reused, and every client
 * holding the rows receives the deletes. Once no live row is left, each call
 * scrubs the change log of the binding. Hosts loop until `done`.
 */
import { decodeRow, type PushOperation } from '@syncular/core';
import { limitsOf, type SyncServerConfig } from './context';
import { SyncError } from './errors';
import { blobIdsInRow, processPushOperationsWithTrace } from './push';
import { compileSchema } from './schema';
import { StorageQueryError } from './storage-errors';

export interface EraseScopeValueOptions {
  readonly partition: string;
  /** The scope variable as declared by the schema's scope patterns. */
  readonly variable: string;
  readonly value: string;
  /**
   * Rows deleted per call, and change records removed per table per call
   * (default 200, at most the push operation cap).
   */
  readonly maxRows?: number;
  /** Actor recorded on the erasure commits (default `syncular.erase`). */
  readonly actorId?: string;
}

export interface EraseScopeValueResult {
  /** Rows the erasure commit of this call deleted. */
  readonly rowsErased: number;
  /** The erasure commit of this call, when it deleted rows. */
  readonly commitSeq?: number;
  /** Change log records this call removed. */
  readonly historyErased: number;
  /** Blobs whose last reference this call removed; their bytes are gone. */
  readonly blobsErased: readonly string[];
  /** Nothing of the binding is left; further calls change nothing. */
  readonly done: boolean;
}

/** Erase one scope binding of one partition, one budgeted step per call. */
export async function eraseScopeValue(
  config: SyncServerConfig,
  options: EraseScopeValueOptions,
): Promise<EraseScopeValueResult> {
  const { storage } = config;
  const { partition, variable, value } = options;
  const maxRows = options.maxRows ?? 200;
  const listRows = storage.listScopeValueRows?.bind(storage);
  const eraseHistory = storage.eraseScopeValueHistory?.bind(storage);
  const listReferences = storage.listRowsReferencingBlob?.bind(storage);
  if (
    listRows === undefined ||
    eraseHistory === undefined ||
    listReferences === undefined
  ) {
    throw new StorageQueryError('sync.storage.erase_unsupported');
  }
  const schema = compileSchema(config.schema);
  const tables = [...schema.tables.values()].filter((table) =>
    table.scopePatterns.some((pattern) => pattern.variable === variable),
  );
  if (
    tables.length === 0 ||
    value.length === 0 ||
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > limitsOf(config).maxOperationsPerRequest
  ) {
    throw new StorageQueryError('sync.storage.invalid_erase_query');
  }
  if ((await storage.getPartitionLogEpoch(partition)) === undefined) {
    return { rowsErased: 0, historyErased: 0, blobsErased: [], done: true };
  }
  await storage.ensureSchema(schema, config.checkpoints);

  const targets: { table: string; rowId: string }[] = [];
  for (const table of tables) {
    const limit = maxRows - targets.length;
    if (limit === 0) break;
    const query = { table: table.name, variable, value, limit };
    for (const rowId of await listRows(partition, query)) {
      targets.push({ table: table.name, rowId });
    }
  }

  if (targets.length > 0) {
    // Erasure is the operator's act: app validators do not gate it.
    const { validators, commitValidator, ...trusted } = config;
    const blobIds = new Set<string>();
    let rowsErased = 0;
    const processed = await processPushOperationsWithTrace(
      { ...trusted, partition, actorId: options.actorId ?? 'syncular.erase' },
      schema,
      {
        ok: true,
        allowed: Object.fromEntries(
          [...schema.tables.values()].flatMap((table) =>
            table.scopePatterns.map((pattern) => [pattern.variable, ['*']]),
          ),
        ),
      },
      'syncular.erase',
      crypto.randomUUID(),
      async (tx) => {
        const operations: PushOperation[] = [];
        for (const target of targets) {
          // Re-read under the partition lock: a row may have moved or gone.
          const stored = await tx.getRow(target.table, target.rowId);
          if (stored?.scopes[variable] !== value) continue;
          const table = schema.tables.get(target.table)!;
          for (const blobId of blobIdsInRow(
            table,
            decodeRow(table.columns, stored.payload),
          )) {
            blobIds.add(blobId);
          }
          operations.push({
            table: target.table,
            op: 'delete',
            rowId: target.rowId,
          });
        }
        rowsErased = operations.length;
        return operations;
      },
    );
    const { frame } = processed;
    if (frame.status !== 'applied') {
      const failed = frame.results.find((result) => 'code' in result);
      throw failed !== undefined && 'code' in failed
        ? new SyncError(failed.code, failed.message)
        : new Error('eraseScopeValue: the erasure commit was not applied');
    }
    const blobsErased: string[] = [];
    for (const blobId of blobIds) {
      if ((await listReferences(partition, blobId)).length > 0) continue;
      await config.blobs?.delete(partition, blobId);
      blobsErased.push(blobId);
    }
    return {
      rowsErased,
      ...(frame.commitSeq !== undefined ? { commitSeq: frame.commitSeq } : {}),
      historyErased: 0,
      blobsErased,
      done: false,
    };
  }

  const throughSeq = await storage.getMaxCommitSeq(partition);
  let historyErased = 0;
  for (const table of tables) {
    historyErased += await eraseHistory(partition, {
      table: table.name,
      variable,
      value,
      throughSeq,
      limit: maxRows,
    });
  }
  return {
    rowsErased: 0,
    historyErased,
    blobsErased: [],
    done: historyErased === 0,
  };
}
