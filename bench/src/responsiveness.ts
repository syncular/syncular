import { createHash } from 'node:crypto';
import { cpus, platform } from 'node:os';
import { parseArgs } from 'node:util';
import { SyncClient } from '../../packages/web-client/src/client';
import { ReactiveClientStore } from '../../packages/web-client/src/reactive-store';
import { BunClientDatabase } from '../../packages/web-client/src/bun-database';
import {
  encodeMessage,
  encodeRowsSegment,
  type RowColumn,
  type ResponseFrame,
} from '../../packages/core/src/index';

/** The same fixture runs against an earlier checkout without rewriting its engine. */
export async function runResponsiveness(
  rows: number,
  format: 'rows' | 'sqlite' = 'rows',
) {
  const columns: readonly RowColumn[] = [
    { name: 'id', type: 'string', nullable: false },
    { name: 'project_id', type: 'string', nullable: false },
    { name: 'title', type: 'string', nullable: false },
  ];
  const base = { table: 'catalogue', variable: 'project_id' };
  const database = new BunClientDatabase();
  let subId = '';
  let delivered = false;
  let hold: Promise<void> | undefined;
  const payload = encodeRowsSegment({
    table: 'catalogue',
    schemaVersion: 1,
    columns,
    blocks: Array.from({ length: Math.ceil(rows / 1000) }, (_, block) =>
      Array.from(
        { length: Math.min(1000, rows - block * 1000) },
        (_, offset) => ({
          serverVersion: 1,
          values: [
            `code-${String(block * 1000 + offset).padStart(8, '0')}`,
            'p1',
            'searchable catalogue entry',
          ],
        }),
      ),
    ),
  });
  let imageBytes: Uint8Array | undefined;
  let segment: ResponseFrame = { type: 'SEGMENT_INLINE', payload };
  if (format === 'sqlite') {
    const image = new BunClientDatabase();
    try {
      image.exec(
        'CREATE TABLE catalogue(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, _syncular_version INTEGER NOT NULL)',
      );
      image.exec(
        "WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x+1 < ?) INSERT INTO catalogue SELECT 'code-'||printf('%08d',x),'p1','searchable catalogue entry',1 FROM n",
        [rows],
      );
      image.exec(
        'CREATE TABLE _syncular_segment(format INTEGER, "table" TEXT, "schemaVersion" INTEGER, "asOfCommitSeq" INTEGER, "scopeDigest" TEXT, "rowCount" INTEGER)',
      );
      const digest = createHash('sha256')
        .update('{"project_id":["p1"]}')
        .digest('hex');
      image.exec(
        "INSERT INTO _syncular_segment VALUES (1,'catalogue',1,1,?,?)",
        [digest, rows],
      );
      imageBytes = image.db.serialize();
      segment = {
        type: 'SEGMENT_REF',
        segmentId: `sha256:${createHash('sha256').update(imageBytes).digest('hex')}`,
        mediaType: 'sqlite',
        table: 'catalogue',
        byteLength: imageBytes.byteLength,
        rowCount: rows,
        asOfCommitSeq: 1,
        scopeDigest: digest,
      };
    } finally {
      image.close();
    }
  }
  const client = new SyncClient({
    database,
    ...(imageBytes !== undefined ? { segments: async () => imageBytes! } : {}),
    schema: {
      version: 1,
      tables: [
        {
          name: 'catalogue',
          columns,
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
          ftsIndexes: [
            {
              name: 'catalogue_fts',
              columns: ['title'],
              tokenize: 'unicode61',
            },
          ],
        },
      ],
    },
    transport: async () => {
      await hold;
      const bootstrap = !delivered;
      delivered = true;
      return encodeMessage({
        wireVersion: 3,
        msgKind: 'response',
        frames: [
          { type: 'RESP_HEADER', logEpoch: 'benchmark', resetRequired: false },
          ...(bootstrap
            ? [
                {
                  type: 'SUB_START' as const,
                  id: subId,
                  status: 'active' as const,
                  reasonCode: '',
                  effectiveScopes: { project_id: ['p1'] },
                  bootstrap: true,
                },
                segment,
                { type: 'SUB_END' as const, nextCursor: 1 },
              ]
            : []),
        ],
      });
    },
  });
  const channel = new MessageChannel();
  let store: ReactiveClientStore | undefined;
  let unsubscribe: (() => void) | undefined;
  let cachedPhase: string | undefined;
  try {
    await client.start();
    database.exec(
      "INSERT OR REPLACE INTO _syncular_meta(key,value) VALUES ('logEpoch','benchmark')",
    );
    await client.setWindow(base, ['p1']);
    subId = client.subscriptions()[0]!.id;
    const measurements: {
      operation: string;
      elapsedMs: number;
      firstReadMs: number;
      readElapsedMs: number;
      rowsAtFirstRead: number;
      readBeforeCompletion: boolean;
      transactions: number;
    }[] = [];
    for (const operation of ['import', 'evict']) {
      let finished = false;
      let queuedAt: number | undefined;
      let transactions = 0;
      let finishRead!: (result: {
        firstReadMs: number;
        readElapsedMs: number;
        rowsAtFirstRead: number;
        readBeforeCompletion: boolean;
      }) => void;
      const reading = new Promise<{
        firstReadMs: number;
        readElapsedMs: number;
        rowsAtFirstRead: number;
        readBeforeCompletion: boolean;
      }>((resolve) => {
        finishRead = resolve;
      });
      channel.port1.onmessage = () => {
        const snapshot = client.querySnapshot({
          sql: 'SELECT count(*) AS n FROM catalogue',
        });
        finishRead({
          firstReadMs: performance.now() - queuedAt!,
          readElapsedMs: performance.now() - started,
          rowsAtFirstRead: Number(snapshot.rows[0]?.n),
          readBeforeCompletion: !finished,
        });
      };
      const off = client.onChange((batch) => {
        if (!batch.tables.some((table) => table.table === 'catalogue')) return;
        transactions++;
        if (queuedAt !== undefined) return;
        queuedAt = performance.now();
        channel.port2.postMessage(null);
      });
      const started = performance.now();
      if (operation === 'import') await client.sync();
      else await client.setWindow(base, []);
      const elapsedMs = performance.now() - started;
      finished = true;
      const firstRead = await reading;
      off();
      measurements.push({ operation, elapsedMs, ...firstRead, transactions });
      const expectedRows = operation === 'import' ? rows : 0;
      const count = Number(
        client.query('SELECT count(*) AS n FROM catalogue')[0]?.n,
      );
      const ftsCount = Number(
        client.query(
          "SELECT count(*) AS n FROM catalogue_fts WHERE catalogue_fts MATCH 'searchable'",
        )[0]?.n,
      );
      if (count !== expectedRows || ftsCount !== expectedRows)
        throw new Error('Responsiveness fixture did not converge');
      if (operation === 'import') {
        let release!: () => void;
        hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const syncing = client.sync();
        store = new ReactiveClientStore(client);
        const entry = store.query({
          id: 'cached-code',
          sql: 'SELECT id FROM catalogue ORDER BY id LIMIT 1',
          dependencies: [{ table: 'catalogue' }],
          coverage: [{ base, units: ['p1'] }],
        });
        unsubscribe = entry.subscribe(() => {});
        for (let turn = 0; turn < 20; turn++) await Promise.resolve();
        cachedPhase = entry.getSnapshot().phase;
        release();
        await syncing;
        for (let turn = 0; turn < 20; turn++) await Promise.resolve();
        hold = undefined;
      }
    }
    return { rows, format, cachedPhase, measurements };
  } finally {
    unsubscribe?.();
    store?.dispose();
    channel.port1.close();
    channel.port2.close();
    await client.close();
    database.close();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      sizes: { type: 'string', default: '2500,5000,10000' },
      trials: { type: 'string', default: '3' },
      output: { type: 'string' },
    },
  });
  const sizes = values.sizes!.split(',').map(Number);
  const trials = Number(values.trials);
  if (
    !Number.isInteger(trials) ||
    trials < 1 ||
    sizes.some((n) => !Number.isInteger(n) || n < 2048 || n > 1000000)
  )
    throw new Error('Invalid benchmark sizes or trials');
  const results = [];
  for (const format of ['rows', 'sqlite'] as const) {
    for (const rows of sizes) {
      await runResponsiveness(rows, format);
      for (let trial = 0; trial < trials; trial++)
        results.push({ trial, ...(await runResponsiveness(rows, format)) });
    }
  }
  const sources = [
    'client.ts',
    'schema.ts',
    'apply.ts',
    'reactive-store.ts',
    'database.ts',
    'bun-database.ts',
  ];
  const artifact = {
    date: new Date().toISOString(),
    runtime: Bun.version,
    platform: platform(),
    cpu: cpus()[0]?.model,
    boundary:
      'TypeScript core, Bun SQLite in memory; synthetic SSP2 transport; one warmup per size',
    sourceHash: createHash('sha256')
      .update(
        (
          await Promise.all(
            sources.map((path) =>
              Bun.file(
                new URL(
                  `../../packages/web-client/src/${path}`,
                  import.meta.url,
                ),
              ).text(),
            ),
          )
        ).join('\n'),
      )
      .digest('hex'),
    results,
  };
  if (values.output) {
    if (await Bun.file(values.output).exists())
      throw new Error('Benchmark output already exists');
    await Bun.write(values.output, JSON.stringify(artifact, null, 2));
  } else console.log(JSON.stringify(artifact, null, 2));
}
