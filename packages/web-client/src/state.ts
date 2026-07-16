/**
 * Durable client sync state: per-subscription cursor, bootstrap resume
 * token (round-tripped opaquely, §4.7), and the last-echoed effective
 * scopes the §3.3 purge contract is keyed on — persisted per subscription
 * exactly for that purpose.
 */
import type { ScopeMap } from '@syncular/core';
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
    .query('SELECT * FROM _syncular_subscriptions ORDER BY rowid ASC')
    .map(rowToRecord);
}

export function getSubscription(
  db: ClientDatabase,
  id: string,
): SubscriptionRecord | undefined {
  const row = db.query('SELECT * FROM _syncular_subscriptions WHERE id = ?', [
    id,
  ])[0];
  return row === undefined ? undefined : rowToRecord(row);
}

export function saveSubscription(
  db: ClientDatabase,
  record: SubscriptionRecord,
): void {
  db.exec(
    `INSERT OR REPLACE INTO _syncular_subscriptions(
       id, tbl, requested_scopes, params, cursor, bootstrap_state,
       effective_scopes, status, reason_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  db.exec('DELETE FROM _syncular_subscriptions WHERE id = ?', [id]);
}

/**
 * §7.4.3 reset: keep every subscription REGISTRATION (id, table,
 * requested scopes, params — the app's declared intent) but discard all
 * synced state (cursor → -1, no resume token, no effective-scope map,
 * status → active), so the next round fresh-bootstraps exactly the
 * subscriptions the app still wants. Caller owns the transaction.
 */
export function resetSubscriptionsForBump(db: ClientDatabase): void {
  db.exec(
    `UPDATE _syncular_subscriptions
       SET cursor = -1, bootstrap_state = NULL, effective_scopes = NULL,
           status = 'active', reason_code = NULL`,
  );
}

/**
 * Remove registrations whose table no longer exists in the running schema.
 * Keeping one would make every subsequent pull fail with
 * `sync.unknown_table`. Window bookkeeping belongs to the registration and
 * is removed with it.
 */
export function pruneUnknownSubscriptions(
  db: ClientDatabase,
  tableNames: ReadonlySet<string>,
): void {
  const staleIds = db
    .query('SELECT id, tbl FROM _syncular_subscriptions')
    .filter((row) => !tableNames.has(String(row.tbl)))
    .map((row) => String(row.id));
  for (const id of staleIds) {
    db.exec('DELETE FROM _syncular_windows WHERE sub_id = ?', [id]);
    db.exec('DELETE FROM _syncular_window_pending_evict WHERE sub_id = ?', [
      id,
    ]);
    db.exec('DELETE FROM _syncular_subscriptions WHERE id = ?', [id]);
  }
}

export function getMeta(db: ClientDatabase, key: string): string | undefined {
  const row = db.query('SELECT value FROM _syncular_meta WHERE key = ?', [
    key,
  ])[0];
  return row === undefined ? undefined : (row.value as string);
}

export function setMeta(db: ClientDatabase, key: string, value: string): void {
  db.exec('INSERT OR REPLACE INTO _syncular_meta(key, value) VALUES (?, ?)', [
    key,
    value,
  ]);
}

/** Read the durable client-local observer revision (SPEC §7.5). */
export function getLocalRevision(db: ClientDatabase): LocalRevision {
  const raw = getMeta(db, LOCAL_REVISION_KEY);
  if (raw === undefined) return 0n;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`invalid persisted local revision ${JSON.stringify(raw)}`);
  }
  const revision = BigInt(raw);
  if (revision > MAX_U64) {
    throw new Error(`persisted local revision exceeds u64: ${raw}`);
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
    throw new Error('local revision exhausted u64');
  }
  const next = current + 1n;
  setMeta(db, LOCAL_REVISION_KEY, next.toString());
  return next;
}
