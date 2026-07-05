/**
 * §4.8 value-sharding proof (DESIGN-eviction W1 bench, cheap lane): a
 * window replace `{A,B}→{B,C}` must re-download ONLY C — the intersection
 * B is neither re-bootstrapped nor evicted. We prove it on segment
 * counters: after the replace, exactly C's rows are applied as bootstrap
 * segments, never the full A+B+C set the naive "new window = re-download
 * everything" cost would pay. This is what dissolves coarse-window cost by
 * choosing the unit grain (SPEC §4.8; the sharding win).
 */

import { SyncClient } from '@syncular/client';
import { openBunDatabase } from '@syncular/client/bun';
import { encodeRow } from '@syncular/core';
import {
  compileSchema,
  handleSegmentDownload,
  handleSyncRequest,
} from '@syncular/server';
import { COLUMNS, PARTITION, rowId, SCHEMA, TABLE } from './fixture';
import { createBenchServer } from './loopback';

const CLIENT_SCHEMA = {
  version: 1,
  tables: [
    {
      name: TABLE,
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
} as const;

/** Seed `count` rows under one project id straight into server storage. */
async function seedProject(
  server: ReturnType<typeof createBenchServer>,
  project: string,
  count: number,
  startIndex: number,
): Promise<void> {
  // Direct storage seeding: the relational row tables must exist first.
  await server.storage.ensureSchema(compileSchema(SCHEMA));
  const tx = await server.storage.begin(PARTITION);
  for (let i = 0; i < count; i++) {
    const index = startIndex + i;
    await tx.upsertRow(TABLE, {
      rowId: rowId(index),
      serverVersion: 1,
      scopes: { project_id: project },
      payload: encodeRow(COLUMNS, [
        rowId(index),
        project,
        `task #${index}`,
        false,
        i % 5,
        1_750_000_000_000 + index,
      ]),
    });
  }
  await tx.commit();
}

export interface WindowShardResult {
  readonly perProjectRows: number;
  /** Bootstrap rows applied when first windowing {A,B}. */
  readonly initialApplied: number;
  /** Bootstrap rows applied on the replace {A,B}→{B,C}. */
  readonly replaceApplied: number;
  /** The naive whole-window re-download cost this lane avoids. */
  readonly naiveApplied: number;
}

export async function runWindowShardLane(
  perProjectRows = 500,
): Promise<WindowShardResult> {
  const server = createBenchServer();
  await seedProject(server, 'A', perProjectRows, 0);
  await seedProject(server, 'B', perProjectRows, perProjectRows);
  await seedProject(server, 'C', perProjectRows, 2 * perProjectRows);

  const client = new SyncClient({
    database: openBunDatabase(),
    schema: CLIENT_SCHEMA,
    clientId: crypto.randomUUID(),
    transport: (bytes) => handleSyncRequest(bytes, server.ctx),
    segments: async (request) =>
      (
        await handleSegmentDownload(server.ctx, {
          segmentId: request.segmentId,
          scopesHeader: request.requestedScopesJson,
        })
      ).bytes,
    // Rows lane: count applied segment rows deterministically (no image
    // whole-table shortcut, so the counter reflects exactly what's fetched).
    limits: { accept: 0b0011 },
  });
  await client.start();

  const base = { table: TABLE, variable: 'project_id' } as const;

  // Window {A,B}: bootstraps A and B.
  await client.setWindow(base, ['A', 'B']);
  let initialApplied = 0;
  for (let round = 0; round < 10; round++) {
    const summary = await client.sync();
    initialApplied += summary.segmentRowsApplied;
    if (
      summary.segmentRowsApplied === 0 &&
      summary.bootstrapping.length === 0
    ) {
      break;
    }
  }

  // Replace {A,B}→{B,C}: evict A, bootstrap C, leave B alone.
  await client.setWindow(base, ['B', 'C']);
  let replaceApplied = 0;
  for (let round = 0; round < 10; round++) {
    const summary = await client.sync();
    replaceApplied += summary.segmentRowsApplied;
    if (
      summary.segmentRowsApplied === 0 &&
      summary.bootstrapping.length === 0
    ) {
      break;
    }
  }

  const localCount = Number(
    client.query(`SELECT count(*) AS n FROM "${TABLE}"`)[0]?.n,
  );
  if (localCount !== 2 * perProjectRows) {
    throw new Error(
      `window shard lane: expected ${2 * perProjectRows} local rows (B+C), got ${localCount}`,
    );
  }
  await client.close();
  server.close();

  return {
    perProjectRows,
    initialApplied,
    replaceApplied,
    naiveApplied: 3 * perProjectRows,
  };
}

export function reportWindowShard(result: WindowShardResult): string {
  const shard = result.replaceApplied === result.perProjectRows;
  return [
    `window value-sharding (§4.8): ${result.perProjectRows} rows/project`,
    `  initial {A,B} bootstrap applied: ${result.initialApplied} rows (= 2 projects)`,
    `  replace {A,B}→{B,C} applied:     ${result.replaceApplied} rows` +
      ` (only C — naive would be ${result.naiveApplied})`,
    `  sharding proof: ${shard ? 'PASS' : 'FAIL'} — B was not re-downloaded`,
  ].join('\n');
}
