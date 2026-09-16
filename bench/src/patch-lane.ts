/**
 * RFC-WRITE-SEMANTICS §11 lane: 500 `patch` calls, each writing two of
 * twenty columns on a distinct seeded row, drained in one sync round on the
 * bun:sqlite loopback lane (TS client core + real server library, in-process
 * SSP2 bytes). The pre-flip client sends the full twenty-column row for every
 * patch; the sparse client sends the primary key plus the two written
 * columns. Request bytes are deterministic; drain time varies run to run.
 */
import type { ClientSchema } from '@syncular/client';
import { encodeRow, type RowColumn, type RowValue } from '@syncular/core';
import {
  compileSchema,
  createRealtimeHub,
  handleSyncRequest,
  MemorySegmentStore,
  type RealtimeHub,
  type ServerSchema,
  type ServerStorage,
  SqliteServerStorage,
  type SyncRequestContext,
} from '@syncular/server';
import { ACTOR_ID, median, PARTITION, PROJECT_ID, TABLE } from './fixture';
import {
  closeBenchClients,
  createBenchClient,
  type BenchServer,
} from './loopback';

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'done', type: 'boolean', nullable: false },
  { name: 'priority', type: 'integer', nullable: false },
  { name: 'updated_at_ms', type: 'integer', nullable: false },
  { name: 'm01', type: 'integer', nullable: false },
  { name: 'm02', type: 'integer', nullable: false },
  { name: 'm03', type: 'integer', nullable: false },
  { name: 'm04', type: 'integer', nullable: false },
  { name: 'm05', type: 'integer', nullable: false },
  { name: 'm06', type: 'integer', nullable: false },
  { name: 'm07', type: 'integer', nullable: false },
  { name: 'm08', type: 'integer', nullable: false },
  { name: 'm09', type: 'integer', nullable: false },
  { name: 'm10', type: 'integer', nullable: false },
  { name: 'm11', type: 'integer', nullable: false },
  { name: 'm12', type: 'integer', nullable: false },
  { name: 'm13', type: 'integer', nullable: false },
  { name: 'm14', type: 'integer', nullable: false },
];

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: TABLE,
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};

const CLIENT_SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    {
      name: TABLE,
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};

function rowId(index: number): string {
  return `row-${String(index).padStart(7, '0')}`;
}

function rowValues(index: number): RowValue[] {
  const values: RowValue[] = [
    rowId(index),
    PROJECT_ID,
    `task #${index}`,
    false,
    index % 5,
    1_750_000_000_000 + index,
  ];
  for (let ordinal = 1; ordinal <= 14; ordinal++) values.push(index * ordinal);
  return values;
}

export interface PatchLaneResult {
  readonly commits: number;
  readonly rows: number;
  /** Request bytes for the patch drain (bootstrap excluded). */
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly drainedMs: number;
  readonly transportMs: number;
  /** Requests the drain sent: one push carrying all 500 commits, plus the follow-up pull. */
  readonly requestCount: number;
  readonly validatedRows: number;
}

export async function runPatchLane(options?: {
  readonly commits?: number;
  readonly rows?: number;
}): Promise<PatchLaneResult> {
  const commits = options?.commits ?? 500;
  const rows = options?.rows ?? 2_000;
  if (commits > rows)
    throw new Error('Patch lane requires at least one seeded row per commit');
  const sqlite = new SqliteServerStorage();
  const storage: ServerStorage = sqlite;
  const segments = new MemorySegmentStore();
  const resolveScopes = () => ({ project_id: ['*'] });
  const hub: RealtimeHub = createRealtimeHub({
    schema: SCHEMA,
    storage,
    resolveScopes,
    segments,
  });
  const ctx: SyncRequestContext = {
    partition: PARTITION,
    actorId: ACTOR_ID,
    schema: SCHEMA,
    storage,
    segments,
    resolveScopes,
    realtime: hub,
  };
  const server: BenchServer = {
    storage,
    hub,
    ctx,
    close: () => sqlite.db.close(),
  };
  await server.storage.ensureSchema(compileSchema(SCHEMA));
  const seeding = await server.storage.begin(PARTITION);
  try {
    for (let index = 0; index < rows; index++) {
      await seeding.upsertRow(TABLE, {
        rowId: rowId(index),
        serverVersion: 1,
        scopes: { project_id: PROJECT_ID },
        payload: encodeRow(COLUMNS, rowValues(index)),
      });
    }
    await seeding.commit();
  } catch (error) {
    await seeding.rollback();
    throw error;
  }

  let requestBytes = 0;
  let responseBytes = 0;
  let transportMs = 0;
  let requestCount = 0;
  const writer = await createBenchClient(server, {
    schema: CLIENT_SCHEMA,
    transport: async (bytes) => {
      requestBytes += bytes.byteLength;
      requestCount += 1;
      const started = performance.now();
      const response = await handleSyncRequest(bytes, ctx);
      transportMs += performance.now() - started;
      responseBytes += response.byteLength;
      return response;
    },
  });
  try {
    await writer.client.syncUntilIdle();
    const localCount = Number(
      writer.client.query(`SELECT count(*) AS n FROM "${TABLE}"`)[0]?.n,
    );
    if (localCount !== rows)
      throw new Error(
        `Patch lane bootstrap applied ${localCount} of ${rows} rows`,
      );

    requestBytes = 0;
    responseBytes = 0;
    transportMs = 0;
    requestCount = 0;
    const localIds = new Set(
      writer.client
        .query(`SELECT id FROM "${TABLE}"`)
        .map((row) => String(row.id)),
    );
    for (let index = 0; index < commits; index++) {
      const expectedId = rowId(index);
      if (!localIds.has(expectedId))
        throw new Error(`Patch lane is missing seeded row ${expectedId}`);
      writer.client.patch(TABLE, expectedId, {
        m01: index * 3 + 1,
        m02: index * 7 + 2,
      });
    }
    const started = performance.now();
    const summary = await writer.client.syncUntilIdle(commits + 10);
    const drainedMs = performance.now() - started;
    if (
      summary.rejected.length ||
      summary.conflicts.length ||
      writer.client.statusSnapshot().outbox !== 0
    )
      throw new Error('Patch lane did not drain every commit successfully');

    const final = new Map(
      writer.client
        .query(`SELECT id, title, m01, m02 FROM "${TABLE}"`)
        .map((row) => [String(row.id), row]),
    );
    if (final.size !== rows)
      throw new Error('Patch lane final row count differs from fixture');
    for (let index = 0; index < commits; index++) {
      const row = final.get(rowId(index));
      if (
        row?.m01 !== index * 3 + 1 ||
        row.m02 !== index * 7 + 2 ||
        row.title !== `task #${index}`
      )
        throw new Error(`Patch lane row ${rowId(index)} differs from expected`);
    }
    return {
      commits,
      rows,
      requestBytes,
      responseBytes,
      drainedMs,
      transportMs,
      requestCount,
      validatedRows: final.size,
    };
  } finally {
    await closeBenchClients([writer]);
    await server.close();
  }
}

if (import.meta.main) {
  const trials = Number(Bun.argv[2] ?? '3');
  if (!Number.isInteger(trials) || trials < 1)
    throw new Error('Usage: bun src/patch-lane.ts [trials]');
  const results: PatchLaneResult[] = [];
  for (let trial = 0; trial < trials; trial++)
    results.push(await runPatchLane());
  const medians = {
    requestBytes: median(results.map((result) => result.requestBytes)),
    responseBytes: median(results.map((result) => result.responseBytes)),
    drainedMs: median(results.map((result) => result.drainedMs)),
  };
  console.log(
    JSON.stringify(
      {
        date: new Date().toISOString(),
        runtime: Bun.version,
        platform: `${process.platform}/${process.arch}`,
        boundary:
          'bun:sqlite loopback; TS client core + real server library in one process; bootstrap excluded; deterministic request bytes',
        commits: results[0]?.commits,
        rows: results[0]?.rows,
        trials: results,
        medians,
      },
      null,
      2,
    ),
  );
}
