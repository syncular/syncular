/**
 * @syncular/client - Subscription state helpers
 *
 * Stable accessors for sync subscription metadata.
 */

import type { ScopeValues, SyncBootstrapState } from '@syncular/core';
import { isRecord } from '@syncular/core';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type {
  SubscriptionStatus,
  SyncClientDb,
  SyncSubscriptionStateTable,
} from './schema';

export const DEFAULT_SYNC_STATE_ID = 'default';

export interface SubscriptionState {
  stateId: string;
  subscriptionId: string;
  table: string;
  scopes: ScopeValues;
  params: Record<string, unknown>;
  cursor: number;
  bootstrapState: SyncBootstrapState | null;
  status: SubscriptionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ListSubscriptionStatesOptions {
  stateId?: string;
  table?: string;
  status?: SubscriptionStatus;
}

export interface GetSubscriptionStateOptions {
  stateId?: string;
  subscriptionId: string;
}

export interface UpsertSubscriptionStateInput {
  stateId?: string;
  subscriptionId: string;
  table: string;
  scopes: ScopeValues;
  params?: Record<string, unknown>;
  cursor: number;
  bootstrapState?: SyncBootstrapState | null;
  status?: SubscriptionStatus;
  nowMs?: number;
}

function isScopeValues(value: unknown): value is ScopeValues {
  if (!isRecord(value)) return false;

  for (const entry of Object.values(value)) {
    if (typeof entry === 'string') continue;
    if (Array.isArray(entry) && entry.every((v) => typeof v === 'string')) {
      continue;
    }
    return false;
  }

  return true;
}

export function parseBootstrapState(
  value: string | object | null | undefined
): SyncBootstrapState | null {
  if (!value) return null;

  try {
    const parsed: unknown =
      typeof value === 'string' ? JSON.parse(value) : value;

    if (!isRecord(parsed)) return null;
    if (typeof parsed.asOfCommitSeq !== 'number') return null;
    if (!Array.isArray(parsed.tables)) return null;
    if (!parsed.tables.every((table) => typeof table === 'string')) return null;
    if (typeof parsed.tableIndex !== 'number') return null;
    if (parsed.rowCursor !== null && typeof parsed.rowCursor !== 'string') {
      return null;
    }

    return {
      asOfCommitSeq: parsed.asOfCommitSeq,
      tables: parsed.tables,
      tableIndex: parsed.tableIndex,
      rowCursor: parsed.rowCursor,
    };
  } catch {
    return null;
  }
}

function parseScopes(value: string): ScopeValues {
  try {
    const parsed: unknown = JSON.parse(value);
    return isScopeValues(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseParams(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapSubscriptionState(
  row: SyncSubscriptionStateTable
): SubscriptionState {
  return {
    stateId: row.state_id,
    subscriptionId: row.subscription_id,
    table: row.table,
    scopes: parseScopes(row.scopes_json),
    params: parseParams(row.params_json),
    cursor: row.cursor,
    bootstrapState: parseBootstrapState(row.bootstrap_state_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSubscriptionStates<DB extends SyncClientDb>(
  db: Kysely<DB>,
  options: ListSubscriptionStatesOptions = {}
): Promise<SubscriptionState[]> {
  const filters: Array<ReturnType<typeof sql>> = [];
  if (options.stateId) {
    filters.push(sql`${sql.ref('state_id')} = ${sql.val(options.stateId)}`);
  }
  if (options.table) {
    filters.push(sql`${sql.ref('table')} = ${sql.val(options.table)}`);
  }
  if (options.status) {
    filters.push(sql`${sql.ref('status')} = ${sql.val(options.status)}`);
  }

  const whereClause =
    filters.length > 0 ? sql`where ${sql.join(filters, sql` and `)}` : sql``;

  const rows = await sql<SyncSubscriptionStateTable>`
    select
      ${sql.ref('state_id')},
      ${sql.ref('subscription_id')},
      ${sql.ref('table')},
      ${sql.ref('scopes_json')},
      ${sql.ref('params_json')},
      ${sql.ref('cursor')},
      ${sql.ref('bootstrap_state_json')},
      ${sql.ref('status')},
      ${sql.ref('created_at')},
      ${sql.ref('updated_at')}
    from ${sql.table('sync_subscription_state')}
    ${whereClause}
    order by ${sql.ref('state_id')} asc, ${sql.ref('subscription_id')} asc
  `.execute(db);

  return rows.rows.map((row) => mapSubscriptionState(row));
}

export async function getSubscriptionState<DB extends SyncClientDb>(
  db: Kysely<DB>,
  options: GetSubscriptionStateOptions
): Promise<SubscriptionState | null> {
  const stateId = options.stateId ?? DEFAULT_SYNC_STATE_ID;

  const rows = await sql<SyncSubscriptionStateTable>`
    select
      ${sql.ref('state_id')},
      ${sql.ref('subscription_id')},
      ${sql.ref('table')},
      ${sql.ref('scopes_json')},
      ${sql.ref('params_json')},
      ${sql.ref('cursor')},
      ${sql.ref('bootstrap_state_json')},
      ${sql.ref('status')},
      ${sql.ref('created_at')},
      ${sql.ref('updated_at')}
    from ${sql.table('sync_subscription_state')}
    where
      ${sql.ref('state_id')} = ${sql.val(stateId)}
      and ${sql.ref('subscription_id')} = ${sql.val(options.subscriptionId)}
    limit 1
  `.execute(db);

  const row = rows.rows[0];
  return row ? mapSubscriptionState(row) : null;
}

export async function upsertSubscriptionState<DB extends SyncClientDb>(
  db: Kysely<DB>,
  input: UpsertSubscriptionStateInput
): Promise<SubscriptionState> {
  const now = input.nowMs ?? Date.now();
  const stateId = input.stateId ?? DEFAULT_SYNC_STATE_ID;

  const bootstrapStateJson =
    input.bootstrapState === null || input.bootstrapState === undefined
      ? null
      : JSON.stringify(input.bootstrapState);

  await sql`
    insert into ${sql.table('sync_subscription_state')} (
      ${sql.ref('state_id')},
      ${sql.ref('subscription_id')},
      ${sql.ref('table')},
      ${sql.ref('scopes_json')},
      ${sql.ref('params_json')},
      ${sql.ref('cursor')},
      ${sql.ref('bootstrap_state_json')},
      ${sql.ref('status')},
      ${sql.ref('created_at')},
      ${sql.ref('updated_at')}
    ) values (
      ${sql.val(stateId)},
      ${sql.val(input.subscriptionId)},
      ${sql.val(input.table)},
      ${sql.val(JSON.stringify(input.scopes ?? {}))},
      ${sql.val(JSON.stringify(input.params ?? {}))},
      ${sql.val(input.cursor)},
      ${sql.val(bootstrapStateJson)},
      ${sql.val(input.status ?? 'active')},
      ${sql.val(now)},
      ${sql.val(now)}
    )
    on conflict (${sql.join([sql.ref('state_id'), sql.ref('subscription_id')])})
    do update set
      ${sql.ref('table')} = ${sql.val(input.table)},
      ${sql.ref('scopes_json')} = ${sql.val(JSON.stringify(input.scopes ?? {}))},
      ${sql.ref('params_json')} = ${sql.val(JSON.stringify(input.params ?? {}))},
      ${sql.ref('cursor')} = ${sql.val(input.cursor)},
      ${sql.ref('bootstrap_state_json')} = ${sql.val(bootstrapStateJson)},
      ${sql.ref('status')} = ${sql.val(input.status ?? 'active')},
      ${sql.ref('updated_at')} = ${sql.val(now)}
  `.execute(db);

  const next = await getSubscriptionState(db, {
    stateId,
    subscriptionId: input.subscriptionId,
  });

  if (!next) {
    throw new Error(
      `[subscription-state] Failed to load upserted state for "${input.subscriptionId}"`
    );
  }

  return next;
}
