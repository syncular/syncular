export const META_TABLE = '_syncular_meta';
import { PENDING_EVICTIONS } from './window';
import { WINDOWS_TABLE } from './window';
export const SUBSCRIPTIONS_TABLE = '_syncular_subscriptions';
/**
 * Durable client sync state: per-subscription cursor, bootstrap resume
 * token (round-tripped opaquely, §4.7), and the last-echoed effective
 * scopes the §3.3 purge contract is keyed on — persisted per subscription
 * exactly for that purpose.
 */
import type { ScopeMap } from '@syncular/core';
import { ClientSyncError } from './errors';
import type { CompiledClientSchema } from './schema';
import type { ClientDatabase } from './database';
import type { LocalRevision } from './invalidation';

export const LOCAL_REVISION_KEY = 'localRevision';
const MAX_U64 = 18_446_744_073_709_551_615n;

export type SubscriptionStatus = 'active' | 'revoked' | 'failed';

export interface SubscriptionRecord {
  readonly id: string;
  readonly table: string;
  /** Requested scopes (§3.2), chosen by the app. */
  readonly scopes: ScopeMap;
  /** Host-opaque JSON params, preserved verbatim. */
  readonly params?: string;
  /** Last fully-applied commitSeq; -1 = never synced (§4.3). */
  readonly cursor: number;
  /** Opaque resume token from `SUB_END` (§4.7); present mid-bootstrap. */
  readonly bootstrapState?: string;
  /** Last effective scopes echoed while active (§3.3 purge key). */
  readonly effectiveScopes?: ScopeMap;
  readonly status: SubscriptionStatus;
  /** §10 code when not active (`sync.scope_revoked`, …). */
  readonly reasonCode?: string;
}

function rowToRecord(row: Record<string, unknown>): SubscriptionRecord {
  return {
    id: row.id as string,
    table: row.tbl as string,
    scopes: JSON.parse(row.requested_scopes as string) as ScopeMap,
    ...(row.params !== null ? { params: row.params as string } : {}),
    cursor: row.cursor as number,
    ...(row.bootstrap_state !== null
      ? { bootstrapState: row.bootstrap_state as string }
      : {}),
    ...(row.effective_scopes !== null
      ? {
          effectiveScopes: JSON.parse(
            row.effective_scopes as string,
          ) as ScopeMap,
        }
      : {}),
    status: row.status as SubscriptionStatus,
    ...(row.reason_code !== null
      ? { reasonCode: row.reason_code as string }
      : {}),
  };
}

export function loadSubscriptions(db: ClientDatabase): SubscriptionRecord[] {
  return db
    .query(`SELECT * FROM ${SUBSCRIPTIONS_TABLE} ORDER BY rowid ASC`)
    .map(rowToRecord);
}

export function getSubscription(
  db: ClientDatabase,
  id: string,
): SubscriptionRecord | undefined {
  const row = db.query(`SELECT * FROM ${SUBSCRIPTIONS_TABLE} WHERE id=?`, [
    id,
  ])[0];
  return row === undefined ? undefined : rowToRecord(row);
}

export function saveSubscription(
  db: ClientDatabase,
  record: SubscriptionRecord,
): void {
  db.exec(
    `INSERT OR REPLACE INTO ${SUBSCRIPTIONS_TABLE}(id,tbl,requested_scopes,params,cursor,bootstrap_state,effective_scopes,status,reason_code)VALUES(?,?,?,?,?,?,?,?,?)`,
    [
      record.id,
      record.table,
      JSON.stringify(record.scopes),
      record.params ?? null,
      record.cursor,
      record.bootstrapState ?? null,
      record.effectiveScopes === undefined
        ? null
        : JSON.stringify(record.effectiveScopes),
      record.status,
      record.reasonCode ?? null,
    ],
  );
}

export function deleteSubscription(db: ClientDatabase, id: string): void {
  db.exec(`DELETE FROM ${SUBSCRIPTIONS_TABLE} WHERE id=?`, [id]);
}

/**
 * §7.4.3 reset: keep compatible subscription REGISTRATIONS (id, table,
 * requested scopes, params — the app's declared intent) but discard all
 * synced state (cursor → -1, no resume token, no effective-scope map,
 * status → active), so the next round fresh-bootstraps exactly the
 * subscriptions the app still wants. Caller owns the transaction.
 */
export function resetSubscriptionsForBump(db: ClientDatabase): void {
  db.exec(
    `UPDATE ${SUBSCRIPTIONS_TABLE} SET cursor=-1,bootstrap_state=NULL,effective_scopes=NULL,status='active',reason_code=NULL`,
  );
}

type ScopeDeclarations = Record<
  string,
  Record<string, readonly [string, string]>
>;

/** Persist declarations separately from the previous-version row descriptor. */
export function saveSubscriptionScopeSchema(
  db: ClientDatabase,
  schema: CompiledClientSchema,
): void {
  const declarations: ScopeDeclarations = {};
  for (const table of schema.tables.values()) {
    declarations[table.name] = Object.fromEntries(
      [...table.scopeColumnByVariable].map(([variable, column]) => [
        variable,
        [table.scopePrefixByVariable.get(variable)!, column],
      ]),
    );
  }
  setMeta(db, 'subscriptionScopeSchema', JSON.stringify(declarations));
}

/** Drop incompatible registrations and their windows; never translate scopes. */
export function pruneUnknownSubscriptions(
  db: ClientDatabase,
  subscriptions: readonly SubscriptionRecord[],
  schema: CompiledClientSchema,
  bump = false,
): SubscriptionRecord[] {
  const stored = bump ? getMeta(db, 'subscriptionScopeSchema') : undefined;
  const previous =
    stored === undefined
      ? undefined
      : (JSON.parse(stored) as ScopeDeclarations);
  const compatible = (
    record: Pick<SubscriptionRecord, 'table' | 'scopes'>,
  ): boolean => {
    const table = schema.tables.get(record.table);
    if (table === undefined) return false;
    const variables = Object.keys(record.scopes);
    if (
      !variables.every((variable) => table.scopeColumnByVariable.has(variable))
    )
      return false;
    if (!bump) return true;
    // An old binary stored no declaration evidence. Re-registration is required
    // at a bump: matching names cannot prove unchanged column/prefix meaning.
    const old = previous?.[record.table];
    if (old === undefined) return false;
    const compared =
      variables.length === 0
        ? [
            ...new Set([
              ...Object.keys(old),
              ...table.scopeColumnByVariable.keys(),
            ]),
          ]
        : variables;
    return compared.every(
      (variable) =>
        old[variable]?.[0] === table.scopePrefixByVariable.get(variable) &&
        old[variable]?.[1] === table.scopeColumnByVariable.get(variable),
    );
  };
  const retained = subscriptions.filter(compatible);
  const staleIds = new Set(
    subscriptions
      .filter((record) => !compatible(record))
      .map((record) => record.id),
  );
  // Shrinking a pinned window already removed its registration. Its deferred
  // eviction still carries the old scope declaration and needs the same fence.
  for (const row of db.query(
    `SELECT sub_id,tbl,effective_scopes FROM ${PENDING_EVICTIONS}`,
  )) {
    if (
      !compatible({
        table: String(row.tbl),
        scopes: JSON.parse(String(row.effective_scopes)) as ScopeMap,
      })
    )
      staleIds.add(String(row.sub_id));
  }
  if (staleIds.size === 0) return retained;
  db.transaction(() => {
    for (const id of staleIds) {
      db.exec(`DELETE FROM ${WINDOWS_TABLE} WHERE sub_id=?`, [id]);
      db.exec(`DELETE FROM ${PENDING_EVICTIONS} WHERE sub_id=?`, [id]);
      db.exec(`DELETE FROM ${SUBSCRIPTIONS_TABLE} WHERE id=?`, [id]);
    }
  });
  return retained;
}

export function getMeta(db: ClientDatabase, key: string): string | undefined {
  const row = db.query(`SELECT value FROM ${META_TABLE} WHERE key=?`, [key])[0];
  return row === undefined ? undefined : (row.value as string);
}

export function setMeta(db: ClientDatabase, key: string, value: string): void {
  db.exec(`INSERT OR REPLACE INTO ${META_TABLE}(key,value)VALUES(?,?)`, [
    key,
    value,
  ]);
}

/** Read the durable client-local observer revision (SPEC §7.5). */
export function getLocalRevision(db: ClientDatabase): LocalRevision {
  const raw = getMeta(db, LOCAL_REVISION_KEY);
  if (raw === undefined) return 0n;
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new ClientSyncError(
      'sync.local_corrupt',
      'persisted local revision is invalid',
    );
  }
  const revision = BigInt(raw);
  if (revision > MAX_U64) {
    throw new ClientSyncError(
      'sync.local_corrupt',
      'persisted local revision is invalid',
    );
  }
  return revision;
}

/**
 * Increment the durable revision. The caller MUST own the same transaction as
 * the observer-visible writes represented by the corresponding change batch.
 */
export function bumpLocalRevision(db: ClientDatabase): LocalRevision {
  const current = getLocalRevision(db);
  if (current === MAX_U64) {
    throw new ClientSyncError(
      'sync.local_corrupt',
      'local revision exhausted u64',
    );
  }
  const next = current + 1n;
  setMeta(db, LOCAL_REVISION_KEY, next.toString());
  return next;
}
