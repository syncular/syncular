/**
 * Common test assertions for sync operations.
 *
 * Provides reusable assertion helpers for:
 * - Outbox state verification
 * - Conflict detection
 * - Row version checks
 * - Subscription state
 */

import { expect } from 'bun:test';
import type { OutboxCommitStatus, SyncClientDb } from '@syncular/client';
import type { SyncCoreDb } from '@syncular/server';
import type { Kysely } from 'kysely';

// ============================================================================
// Client-side Assertions
// ============================================================================

/**
 * Assert that the outbox is empty (all commits have been acked or removed).
 */
export async function assertOutboxEmpty(
  db: Kysely<SyncClientDb>
): Promise<void> {
  const count = await db
    .selectFrom('sync_outbox_commits')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();

  expect(Number(count.count)).toBe(0);
}

/**
 * Assert that the outbox contains exactly N commits.
 */
export async function assertOutboxHas(
  db: Kysely<SyncClientDb>,
  expectedCount: number
): Promise<void> {
  const count = await db
    .selectFrom('sync_outbox_commits')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();

  expect(Number(count.count)).toBe(expectedCount);
}

/**
 * Assert outbox commits have a specific status.
 */
export async function assertOutboxStatus(
  db: Kysely<SyncClientDb>,
  status: OutboxCommitStatus,
  expectedCount: number
): Promise<void> {
  const count = await db
    .selectFrom('sync_outbox_commits')
    .where('status', '=', status)
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();

  expect(Number(count.count)).toBe(expectedCount);
}

/**
 * Assert that there are exactly N unresolved conflicts.
 */
export async function assertConflictCount(
  db: Kysely<SyncClientDb>,
  expectedCount: number
): Promise<void> {
  const count = await db
    .selectFrom('sync_conflicts')
    .where('resolved_at', 'is', null)
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();

  expect(Number(count.count)).toBe(expectedCount);
}

/**
 * Assert that a specific conflict exists with given properties.
 */
export async function assertConflictExists(
  db: Kysely<SyncClientDb>,
  options: {
    clientCommitId: string;
    resultStatus?: 'conflict' | 'error';
    resolved?: boolean;
  }
): Promise<void> {
  let query = db
    .selectFrom('sync_conflicts')
    .where('client_commit_id', '=', options.clientCommitId);

  if (options.resultStatus) {
    query = query.where('result_status', '=', options.resultStatus);
  }

  if (options.resolved !== undefined) {
    query = options.resolved
      ? query.where('resolved_at', 'is not', null)
      : query.where('resolved_at', 'is', null);
  }

  const conflict = await query.selectAll().executeTakeFirst();
  expect(conflict).toBeDefined();
}

/**
 * Assert that a row exists in a table with expected values.
 */
export async function assertRowExists<
  DB extends SyncClientDb,
  T extends keyof DB & string,
>(
  db: Kysely<DB>,
  table: T,
  rowId: string,
  expected?: Partial<DB[T]>,
  idColumn = 'id'
): Promise<void> {
  const row = await db
    .selectFrom(table)
    // @ts-expect-error - dynamic column name
    .where(idColumn, '=', rowId)
    .selectAll()
    .executeTakeFirst();

  expect(row).toBeDefined();

  if (expected) {
    for (const [key, value] of Object.entries(expected)) {
      expect((row as Record<string, unknown>)[key]).toEqual(value);
    }
  }
}

/**
 * Assert that a row does not exist in a table.
 */
export async function assertRowNotExists<
  DB extends SyncClientDb,
  T extends keyof DB & string,
>(db: Kysely<DB>, table: T, rowId: string, idColumn = 'id'): Promise<void> {
  const row = await db
    .selectFrom(table)
    // @ts-expect-error - dynamic column name
    .where(idColumn, '=', rowId)
    .selectAll()
    .executeTakeFirst();

  expect(row).toBeUndefined();
}

/**
 * Assert that a row has a specific version number.
 */
export async function assertRowVersion<
  DB extends SyncClientDb,
  T extends keyof DB & string,
>(
  db: Kysely<DB>,
  table: T,
  rowId: string,
  expectedVersion: number,
  versionColumn = 'server_version',
  idColumn = 'id'
): Promise<void> {
  const row = await db
    .selectFrom(table)
    // @ts-expect-error - dynamic column name
    .where(idColumn, '=', rowId)
    .select(versionColumn)
    .executeTakeFirst();

  expect(row).toBeDefined();
  expect((row as Record<string, unknown>)[versionColumn]).toBe(expectedVersion);
}

/**
 * Assert subscription cursor value.
 */
export async function assertSubscriptionCursor(
  db: Kysely<SyncClientDb>,
  subscriptionId: string,
  expectedCursor: number,
  stateId = 'default'
): Promise<void> {
  const sub = await db
    .selectFrom('sync_subscription_state')
    .where('state_id', '=', stateId)
    .where('subscription_id', '=', subscriptionId)
    .select(['cursor'])
    .executeTakeFirst();

  expect(sub).toBeDefined();
  expect(sub!.cursor).toBe(expectedCursor);
}

/**
 * Assert subscription status.
 */
export async function assertSubscriptionStatus(
  db: Kysely<SyncClientDb>,
  subscriptionId: string,
  expectedStatus: 'active' | 'revoked',
  stateId = 'default'
): Promise<void> {
  const sub = await db
    .selectFrom('sync_subscription_state')
    .where('state_id', '=', stateId)
    .where('subscription_id', '=', subscriptionId)
    .select(['status'])
    .executeTakeFirst();

  expect(sub).toBeDefined();
  expect(sub!.status).toBe(expectedStatus);
}

// ============================================================================
// Server-side Assertions
// ============================================================================

/**
 * Assert server commit count.
 */
export async function assertServerCommitCount(
  db: Kysely<SyncCoreDb>,
  expectedCount: number
): Promise<void> {
  const count = await db
    .selectFrom('sync_commits')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();

  expect(Number(count.count)).toBe(expectedCount);
}

/**
 * Assert server change count.
 */
export async function assertServerChangeCount(
  db: Kysely<SyncCoreDb>,
  expectedCount: number
): Promise<void> {
  const count = await db
    .selectFrom('sync_changes')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();

  expect(Number(count.count)).toBe(expectedCount);
}

/**
 * Assert a server change exists with specific properties.
 */
export async function assertServerChangeExists(
  db: Kysely<SyncCoreDb>,
  options: {
    table: string;
    rowId: string;
    op?: 'upsert' | 'delete';
    commitSeq?: number;
  }
): Promise<void> {
  let query = db
    .selectFrom('sync_changes')
    .where('table', '=', options.table)
    .where('row_id', '=', options.rowId);

  if (options.op) {
    query = query.where('op', '=', options.op);
  }

  if (options.commitSeq) {
    query = query.where('commit_seq', '=', options.commitSeq);
  }

  const change = await query.selectAll().executeTakeFirst();
  expect(change).toBeDefined();
}

/**
 * Assert client cursor on server.
 */
export async function assertServerClientCursor(
  db: Kysely<SyncCoreDb>,
  clientId: string,
  expectedCursor: number
): Promise<void> {
  const cursor = await db
    .selectFrom('sync_client_cursors')
    .where('client_id', '=', clientId)
    .select(['cursor'])
    .executeTakeFirst();

  expect(cursor).toBeDefined();
  expect(cursor!.cursor).toBe(expectedCursor);
}

// ============================================================================
// Timing Helpers
// ============================================================================

/**
 * Wait for a condition to become true within a timeout.
 * Useful for testing async state changes.
 */
async function waitFor(
  condition: () => Promise<boolean>,
  options?: {
    timeoutMs?: number;
    intervalMs?: number;
    message?: string;
  }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 5000;
  const intervalMs = options?.intervalMs ?? 50;
  const message = options?.message ?? 'Condition not met within timeout';

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(message);
}

/**
 * Wait for the outbox to be empty.
 */
export async function waitForOutboxEmpty(
  db: Kysely<SyncClientDb>,
  timeoutMs = 5000
): Promise<void> {
  await waitFor(
    async () => {
      const count = await db
        .selectFrom('sync_outbox_commits')
        .select(({ fn }) => fn.countAll().as('count'))
        .executeTakeFirstOrThrow();
      return Number(count.count) === 0;
    },
    { timeoutMs, message: 'Outbox not empty within timeout' }
  );
}

/**
 * Wait for a specific number of commits to be acked.
 */
export async function waitForAckedCommits(
  db: Kysely<SyncClientDb>,
  expectedCount: number,
  timeoutMs = 5000
): Promise<void> {
  await waitFor(
    async () => {
      const count = await db
        .selectFrom('sync_outbox_commits')
        .where('status', '=', 'acked')
        .select(({ fn }) => fn.countAll().as('count'))
        .executeTakeFirstOrThrow();
      return Number(count.count) >= expectedCount;
    },
    {
      timeoutMs,
      message: `Expected ${expectedCount} acked commits within timeout`,
    }
  );
}
