/**
 * Durable client sync state: per-subscription cursor, bootstrap resume
 * token (round-tripped opaquely, §4.7), and the last-echoed effective
 * scopes the §3.3 purge contract is keyed on — persisted per subscription
 * exactly for that purpose.
 */
import type { ScopeMap } from '@syncular/core';
import type { ClientDatabase } from './database';

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
