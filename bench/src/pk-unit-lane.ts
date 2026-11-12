/**
 * Per-unit cost of one-row primary-key units (§4.1, §4.5, §4.8): a window
 * over a scope variable mapped to the primary key keeps N referenced rows of
 * a reference table. Measures, at each N, the traveling list, steady-state
 * and one-key-change pulls, a live commit, the first sync and the client's
 * persisted unit state, with the server's storage calls broken out.
 *
 *   bun bench/src/pk-unit-lane.ts --units 500,2000,10000
 */
import { SyncClient } from '@syncular/client';
import { openBunDatabase } from '@syncular/client/bun';
import { encodeRow, type RowColumn } from '@syncular/core';
import {
  compileSchema,
  handleSegmentDownload,
  handleSyncRequest,
  MemorySegmentStore,
  type ServerSchema,
  SqliteServerStorage,
  type SyncRequestContext,
} from '@syncular/server';
import { buildSqliteImage } from '@syncular/server/sqlite';
import { measureMethods, type MethodMeasurement } from './instrumentation';

const TABLE = 'catalogue_codes';
const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'release_id', type: 'string', nullable: false },
  { name: 'code', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
];
const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: TABLE,
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: [
        'release:{release_id}',
        { pattern: 'code:{code_id}', column: 'id' },
      ],
    },
  ],
};
const CLIENT_SCHEMA = {
  version: 1,
  tables: SCHEMA.tables.map((table) => ({
    name: table.name,
    columns: table.columns,
    primaryKey: table.primaryKey,
    scopes: table.scopes,
  })),
};
const SEEDED = 20_000;
const codeId = (index: number) => `code-${String(index).padStart(6, '0')}`;

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function measure(units: number) {
  const storage = new SqliteServerStorage();
  const calls: Record<string, MethodMeasurement> = {};
  let resolverMs = 0;
  const ctx: SyncRequestContext = {
    sqliteImageBuilder: buildSqliteImage,
    partition: 'bench',
    actorId: 'bench-actor',
    schema: SCHEMA,
    storage: measureMethods(storage, calls, 'storage'),
    segments: new MemorySegmentStore(),
    resolveScopes: () => {
      const started = performance.now();
      const scopes = { release_id: ['*'], code_id: ['*'] };
      resolverMs += performance.now() - started;
      return scopes;
    },
    limits: { maxSubscriptionsPerRequest: 20_000 },
  };
  await storage.ensureSchema(compileSchema(SCHEMA));
  const tx = await storage.begin('bench');
  for (let i = 0; i < SEEDED; i++) {
    const id = codeId(i);
    const release = i % 2 === 0 ? 'r1' : 'r2';
    await tx.upsertRow(TABLE, {
      rowId: id,
      serverVersion: 1,
      scopes: { release_id: release, code_id: id },
      payload: encodeRow(COLUMNS, [
        id,
        release,
        `A${i}`,
        `Reference title number ${i} of the catalogue`,
      ]),
    });
  }
  await tx.commit();

  let rounds: {
    requestBytes: number;
    responseBytes: number;
    serverMs: number;
  }[] = [];
  const transport = async (bytes: Uint8Array) => {
    const started = performance.now();
    const response = await handleSyncRequest(bytes, ctx);
    rounds.push({
      requestBytes: bytes.length,
      responseBytes: response.length,
      serverMs: performance.now() - started,
    });
    return response;
  };
  const database = openBunDatabase();
  const client = new SyncClient({
    database,
    schema: CLIENT_SCHEMA,
    clientId: crypto.randomUUID(),
    transport,
    segments: async (request) =>
      (
        await handleSegmentDownload(ctx, {
          segmentId: request.segmentId,
          scopesHeader: request.requestedScopesJson,
        })
      ).bytes,
  });
  await client.start();
  const base = { variable: 'code_id' } as const;
  // Every 2nd seeded code: the referenced set spans both releases.
  const keys = Array.from({ length: units }, (_, i) => codeId(i * 2));

  const phase = async (run: () => Promise<void>) => {
    rounds = [];
    resolverMs = 0;
    for (const key of Object.keys(calls)) delete calls[key];
    const started = performance.now();
    await run();
    const wallMs = performance.now() - started;
    const serverMs = rounds.reduce((n, r) => n + r.serverMs, 0);
    return {
      wallMs,
      rounds: rounds.length,
      requestBytes: rounds.reduce((n, r) => n + r.requestBytes, 0),
      responseBytes: rounds.reduce((n, r) => n + r.responseBytes, 0),
      serverMs,
      clientMs: wallMs - serverMs,
      resolverMs,
      storage: Object.fromEntries(
        Object.entries(calls).map(([name, m]) => [
          name.replace('storage.', ''),
          { calls: m.calls, ms: Number(m.elapsedMs.toFixed(2)) },
        ]),
      ),
    };
  };

  const first = await phase(async () => {
    await client.setWindow(base, keys);
    await client.syncUntilIdle({ timeoutMs: 600_000, maxRounds: 1_000 });
  });
  const held = Number(
    client.query(`SELECT count(*) AS n FROM "${TABLE}"`)[0]?.n,
  );
  if (held !== units)
    throw new Error(`expected ${units} local rows, found ${held}`);

  const steady = [];
  for (let i = 0; i < 20; i++)
    steady.push(await phase(async () => void (await client.sync())));

  const change = [];
  for (let i = 0; i < 10; i++) {
    keys[i] = codeId(i * 2 + 1);
    change.push(
      await phase(async () => {
        await client.setWindow(base, keys);
        await client.syncUntilIdle({ timeoutMs: 600_000 });
      }),
    );
  }

  // A live commit on a referenced row, written by a second client.
  const writer = new SyncClient({
    database: openBunDatabase(),
    schema: CLIENT_SCHEMA,
    clientId: crypto.randomUUID(),
    transport: (bytes) => handleSyncRequest(bytes, ctx),
  });
  await writer.start();
  const live = [];
  for (let i = 0; i < 10; i++) {
    writer.mutate([
      {
        table: TABLE,
        op: 'upsert',
        values: {
          id: keys[100]!,
          release_id: 'r1',
          code: `B${i}`,
          title: `Edited title ${i}`,
        },
      },
    ]);
    await writer.sync();
    live.push(await phase(async () => void (await client.sync())));
  }
  await writer.close();

  const state = database.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '\\_syncular\\_%' ESCAPE '\\'`,
  ) as { name: string }[];
  const stateBytes: Record<string, { rows: number; bytes: number }> = {};
  for (const { name } of state) {
    const columns = database.query(`PRAGMA table_info("${name}")`) as {
      name: string;
    }[];
    const sum = columns
      .map((c) => `coalesce(length(CAST("${c.name}" AS BLOB)),0)`)
      .join('+');
    const [row] = database.query(
      `SELECT count(*) AS rows, coalesce(sum(${sum}),0) AS bytes FROM "${name}"`,
    ) as { rows: number; bytes: number }[];
    if (row && row.rows > 0)
      stateBytes[name] = { rows: row.rows, bytes: row.bytes };
  }
  await client.close();
  storage.db.close();

  const pick = (samples: Awaited<ReturnType<typeof phase>>[]) => ({
    requestBytes: median(samples.map((s) => s.requestBytes)),
    responseBytes: median(samples.map((s) => s.responseBytes)),
    rounds: median(samples.map((s) => s.rounds)),
    serverMs: Number(median(samples.map((s) => s.serverMs)).toFixed(2)),
    clientMs: Number(median(samples.map((s) => s.clientMs)).toFixed(2)),
    storage: samples[Math.floor(samples.length / 2)]!.storage,
  });
  return {
    units,
    first,
    steady: pick(steady),
    oneKeyChange: pick(change),
    liveCommit: pick(live),
    clientState: stateBytes,
  };
}

const arg = process.argv.indexOf('--units');
const sizes = (arg >= 0 ? process.argv[arg + 1]! : '500,2000,10000')
  .split(',')
  .map(Number);
for (const units of sizes) console.log(JSON.stringify(await measure(units)));
