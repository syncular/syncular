import { isDeepStrictEqual } from 'node:util';
import type { OutboxCommitStatus, SyncClientDb } from '@syncular/client';
import type { SyncCoreDb } from '@syncular/server';
import type { Kysely } from 'kysely';

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string
): void {
  if (!isDeepStrictEqual(actual, expected)) {
    fail(
      `${message} (expected=${formatValue(expected)} actual=${formatValue(actual)})`
    );
  }
}

function assertDefined<T>(
  value: T | null | undefined,
  message: string
): asserts value is T {
  if (value == null) {
    fail(message);
  }
}

export async function outboxCount(db: Kysely<SyncClientDb>): Promise<number> {
  const count = await db
    .selectFrom('sync_outbox_commits')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();

  return Number(count.count);
}

export async function conflictCount(db: Kysely<SyncClientDb>): Promise<number> {
  const count = await db
    .selectFrom('sync_conflicts')
    .where('resolved_at', 'is', null)
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();

  return Number(count.count);
}

export async function serverCommitCount(
  db: Kysely<SyncCoreDb>
): Promise<number> {
  const count = await db
    .selectFrom('sync_commits')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();

  return Number(count.count);
}

export async function serverChangeCount(
  db: Kysely<SyncCoreDb>
): Promise<number> {
  const count = await db
    .selectFrom('sync_changes')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();

  return Number(count.count);
}

export async function assertOutboxEmpty(
  db: Kysely<SyncClientDb>
): Promise<void> {
  const count = await outboxCount(db);
  assertEqual(count, 0, 'Outbox is not empty');
}

export async function assertOutboxHas(
  db: Kysely<SyncClientDb>,
  expectedCount: number
): Promise<void> {
  const count = await outboxCount(db);
  assertEqual(count, expectedCount, 'Unexpected outbox commit count');
}

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

  assertEqual(
    Number(count.count),
    expectedCount,
    `Unexpected outbox count for status=${status}`
  );
}

export async function assertConflictCount(
  db: Kysely<SyncClientDb>,
  expectedCount: number
): Promise<void> {
  const count = await conflictCount(db);
  assertEqual(count, expectedCount, 'Unexpected unresolved conflict count');
}

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
  assertDefined(
    conflict,
    `Expected conflict for client_commit_id=${options.clientCommitId}`
  );
}

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

  assertDefined(row, `Expected row ${rowId} to exist in table ${table}`);

  if (!expected) {
    return;
  }

  const rowRecord = row as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    assertEqual(
      rowRecord[key],
      value,
      `Unexpected value for ${table}.${key} (row ${rowId})`
    );
  }
}

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

  if (row !== undefined) {
    fail(`Expected row ${rowId} to be absent in table ${table}`);
  }
}

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

  assertDefined(row, `Expected row ${rowId} to exist in table ${table}`);
  const rowRecord = row as Record<string, unknown>;
  assertEqual(
    rowRecord[versionColumn],
    expectedVersion,
    `Unexpected version for ${table}.${rowId}`
  );
}

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

  assertDefined(
    sub,
    `Expected subscription state row for ${stateId}/${subscriptionId}`
  );
  assertEqual(
    sub.cursor,
    expectedCursor,
    `Unexpected cursor for subscription ${subscriptionId}`
  );
}

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

  assertDefined(
    sub,
    `Expected subscription state row for ${stateId}/${subscriptionId}`
  );
  assertEqual(
    sub.status,
    expectedStatus,
    `Unexpected status for subscription ${subscriptionId}`
  );
}

export async function assertServerCommitCount(
  db: Kysely<SyncCoreDb>,
  expectedCount: number
): Promise<void> {
  const count = await serverCommitCount(db);
  assertEqual(count, expectedCount, 'Unexpected server commit count');
}

export async function assertServerChangeCount(
  db: Kysely<SyncCoreDb>,
  expectedCount: number
): Promise<void> {
  const count = await serverChangeCount(db);
  assertEqual(count, expectedCount, 'Unexpected server change count');
}

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
  assertDefined(
    change,
    `Expected server change for table=${options.table} rowId=${options.rowId}`
  );
}

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

  assertDefined(cursor, `Expected sync_client_cursors row for ${clientId}`);
  assertEqual(
    cursor.cursor,
    expectedCursor,
    `Unexpected cursor for ${clientId}`
  );
}

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

  fail(message);
}

export async function waitForOutboxEmpty(
  db: Kysely<SyncClientDb>,
  timeoutMs = 5000
): Promise<void> {
  await waitFor(
    async () => {
      const count = await outboxCount(db);
      return count === 0;
    },
    { timeoutMs, message: 'Outbox not empty within timeout' }
  );
}

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

export const assertOutbox = {
  empty: assertOutboxEmpty,
  count: assertOutboxHas,
  status: assertOutboxStatus,
};

export const assertConflicts = {
  count: assertConflictCount,
  exists: assertConflictExists,
};

export const assertRows = {
  exists: assertRowExists,
  missing: assertRowNotExists,
  version: assertRowVersion,
};

export const assertServer = {
  commits: assertServerCommitCount,
  changes: assertServerChangeCount,
  changeExists: assertServerChangeExists,
  clientCursor: assertServerClientCursor,
};

export const assertSubscription = {
  cursor: assertSubscriptionCursor,
  status: assertSubscriptionStatus,
};

export const waitForSync = {
  outboxEmpty: waitForOutboxEmpty,
  ackedCommits: waitForAckedCommits,
};
