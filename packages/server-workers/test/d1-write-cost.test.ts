/**
 * Real Miniflare D1 write-cost regression for the server's liveness writes and
 * scope-index maintenance.
 *
 * The test drives the actual `handleSyncRequest` over a real `D1ServerStorage`
 * backed by a real Miniflare D1 database and reads `meta.rows_written` (D1's
 * billed row-write unit, which also counts index work) from every statement.
 * Absolute counts depend on the schema and the generated statements, so the
 * assertions pin the mechanism-sensitive facts for this exact schema: an
 * established idle round stops paying for a delete-and-insert client replace,
 * and a same-value commit leaves the scope index untouched. It is not a
 * general D1 billing prediction.
 */
import { expect, test } from 'bun:test';
import { Miniflare } from 'miniflare';
import {
  compileSchema,
  D1ServerStorage,
  handleSyncRequest,
  MemorySegmentStore,
  type D1Database,
  type D1PreparedStatement,
  type ServerSchema,
  type SyncRequestContext,
} from '@syncular/server';
import {
  decodeMessage,
  encodeMessage,
  encodeSparseRow,
  PROTOCOL_WIRE_VERSION,
  type PushResultFrame,
  type RequestFrame,
  type ResponseFrame,
  type ResponseMessage,
} from '@syncular/core';

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
      ],
      scopes: ['project:{project_id}'],
    },
  ],
};

interface D1RunMeta {
  readonly rows_written?: number;
}
interface RawStatement {
  bind(...values: unknown[]): RawStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    meta?: D1RunMeta;
  }>;
  run(): Promise<{ meta?: D1RunMeta }>;
}
interface RawDatabase {
  prepare(query: string): RawStatement;
  batch(statements: RawStatement[]): Promise<readonly { meta?: D1RunMeta }[]>;
  exec(query: string): Promise<unknown>;
}

interface MeasuredWrite {
  readonly sql: string;
  readonly rowsWritten: number;
}

/** Wrap a real D1 binding to record `meta.rows_written` per statement. */
class MeasuringD1Database implements D1Database {
  readonly writes: MeasuredWrite[] = [];
  readonly #raw: RawDatabase;
  readonly #statements = new WeakMap<
    D1PreparedStatement,
    { readonly raw: RawStatement; readonly sql: string }
  >();

  constructor(raw: RawDatabase) {
    this.#raw = raw;
  }

  reset(): void {
    this.writes.length = 0;
  }

  get rowsWritten(): number {
    return this.writes.reduce((total, write) => total + write.rowsWritten, 0);
  }

  #record(sql: string, meta: D1RunMeta | undefined): void {
    const rowsWritten = meta?.rows_written;
    // Missing instrumentation must fail, never read as a zero-write result.
    if (
      typeof rowsWritten !== 'number' ||
      !Number.isFinite(rowsWritten) ||
      rowsWritten < 0
    ) {
      throw new Error(`D1 result for ${sql} has no valid rows_written`);
    }
    if (rowsWritten > 0) this.writes.push({ sql, rowsWritten });
  }

  #wrap(statement: RawStatement, sql: string): D1PreparedStatement {
    const wrapped: D1PreparedStatement = {
      bind: (...values: unknown[]) =>
        this.#wrap(statement.bind(...values), sql),
      first: <T = Record<string, unknown>>() => statement.first<T>(),
      all: async <T = Record<string, unknown>>() => {
        const result = await statement.all<T>();
        this.#record(sql, result.meta);
        return { results: result.results };
      },
      run: async () => {
        const result = await statement.run();
        this.#record(sql, result.meta);
        return {};
      },
    };
    this.#statements.set(wrapped, { raw: statement, sql });
    return wrapped;
  }

  prepare(query: string): D1PreparedStatement {
    return this.#wrap(this.#raw.prepare(query), query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    const records = statements.map((statement) => {
      const record = this.#statements.get(statement);
      if (record === undefined) throw new Error('unwrapped D1 statement');
      return record;
    });
    const results = await this.#raw.batch(records.map((record) => record.raw));
    if (results.length !== records.length) {
      throw new Error(
        `D1 batch returned ${results.length} results for ${records.length} statements`,
      );
    }
    records.forEach((record, index) => {
      this.#record(record.sql, results[index]?.meta);
    });
    return results as unknown[];
  }

  exec(query: string): Promise<unknown> {
    return this.#raw.exec(query);
  }
}

const PULL_HEADER: RequestFrame = {
  type: 'PULL_HEADER',
  limitCommits: 0,
  limitSnapshotRows: 0,
  maxSnapshotPages: 0,
  accept: 3,
};

const SUBSCRIPTION: RequestFrame = {
  type: 'SUBSCRIPTION',
  id: 'tasks/p1',
  table: 'tasks',
  scopes: { project_id: ['p1'] },
  cursor: 0,
};

function request(frames: readonly RequestFrame[]): Uint8Array {
  return encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [
      {
        type: 'REQ_HEADER',
        clientId: 'client-1',
        schemaVersion: 1,
        logEpoch: 'epoch',
      },
      ...frames,
    ],
  });
}

function pushRequest(
  clientCommitId: string,
  baseVersion: number | undefined,
): Uint8Array {
  return request([
    {
      type: 'PUSH_COMMIT',
      clientCommitId,
      operations: [
        {
          table: 'tasks',
          rowId: 'one',
          op: 'upsert',
          ...(baseVersion !== undefined ? { baseVersion } : {}),
          payload: encodeSparseRow(SCHEMA.tables[0]!.columns, 0, ['one', 'p1']),
        },
      ],
    },
    PULL_HEADER,
  ]);
}

function decodeResponse(bytes: Uint8Array): ResponseMessage {
  const message = decodeMessage(bytes);
  if (message.msgKind !== 'response') throw new Error('expected a response');
  return message;
}

function pushResult(
  frames: readonly ResponseFrame[],
): PushResultFrame | undefined {
  return frames.find(
    (frame): frame is PushResultFrame => frame.type === 'PUSH_RESULT',
  );
}

async function withMiniflare(
  run: (env: {
    readonly measure: MeasuringD1Database;
    readonly storage: D1ServerStorage;
    readonly ctx: SyncRequestContext;
    readonly advance: (ms: number) => void;
    readonly now: () => number;
  }) => Promise<void>,
): Promise<void> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
    compatibilityDate: '2026-07-01',
  });
  try {
    const raw: RawDatabase = await mf.getD1Database('DB');
    const measure = new MeasuringD1Database(raw);
    const storage = new D1ServerStorage(measure, { pushApplySerialized: true });
    await storage.migrate();
    await storage.ensureSchema(compileSchema(SCHEMA));
    await storage.touchPartition('part-1', 1_000, 'epoch');
    let now = 2_000;
    const ctx: SyncRequestContext = {
      partition: 'part-1',
      actorId: 'actor-1',
      schema: SCHEMA,
      storage,
      segments: new MemorySegmentStore(),
      resolveScopes: () => ({ project_id: ['p1'] }),
      clock: () => now,
    };
    await run({
      measure,
      storage,
      ctx,
      advance: (ms) => {
        now += ms;
      },
      now: () => now,
    });
  } finally {
    await mf.dispose();
  }
}

const PARTITION = 'part-1';

test('an established idle round stops paying for a client replace', async () => {
  await withMiniflare(async ({ measure, storage, ctx, advance, now }) => {
    const bytes = request([PULL_HEADER, SUBSCRIPTION]);
    const totals: number[] = [];
    const cursors: number[] = [];
    const authenticated: number[] = [];
    for (let round = 0; round < 3; round++) {
      measure.reset();
      advance(100);
      const response = decodeResponse(await handleSyncRequest(bytes, ctx));
      expect(response.frames[0]?.type).toBe('RESP_HEADER');
      totals.push(measure.rowsWritten);
      const record = await storage.getClientRecord(PARTITION, 'client-1');
      cursors.push(record?.cursor ?? Number.NaN);
      const registry = (await storage.listPartitionRegistry()).find(
        (entry) => entry.partition === PARTITION,
      );
      authenticated.push(registry?.lastAuthenticatedAtMs ?? Number.NaN);
    }
    // Round 0 inserts the client row; rounds 1 and 2 update it in place. The
    // baseline delete-and-insert replace cost one more row write.
    expect(totals).toEqual([3, 2, 2]);
    // The update kept every field and one row: the cursor never moves on a
    // caught-up round, and the liveness timestamps advance with the clock.
    expect(cursors[0]).toBe(cursors[1]);
    expect(cursors[1]).toBe(cursors[2]);
    expect(authenticated).toEqual([2_100, 2_200, 2_300]);
    expect(now()).toBe(2_300);
    const record = await storage.getClientRecord(PARTITION, 'client-1');
    expect(record).toMatchObject({
      clientId: 'client-1',
      actorId: 'actor-1',
      wireVersion: PROTOCOL_WIRE_VERSION,
      updatedAtMs: 2_300,
    });
    expect((await storage.listClientCursors(PARTITION)).length).toBe(1);
  });
});

test('a same-value commit leaves the scope index untouched and still advances', async () => {
  await withMiniflare(async ({ measure, storage, ctx }) => {
    // Warm the client record so the measured rounds use the established
    // update-in-place shape instead of a first-time insert.
    await handleSyncRequest(request([PULL_HEADER, SUBSCRIPTION]), ctx);

    measure.reset();
    const first = decodeResponse(
      await handleSyncRequest(pushRequest('write-1', undefined), ctx),
    );
    expect(pushResult(first.frames)?.status).toBe('applied');
    // Pinned for this explicit schema and warmed client. D1 counts index
    // rows, so the totals include the scope-index work.
    expect(measure.rowsWritten).toBe(19);
    expect(
      measure.writes.some((write) => write.sql.includes('sync_row_scopes')),
    ).toBe(true);

    measure.reset();
    const second = decodeResponse(
      await handleSyncRequest(pushRequest('write-2', 1), ctx),
    );
    const secondResult = pushResult(second.frames);
    // The identical payload still applies: skipping it would freeze the
    // version and drop the change.
    expect(secondResult?.status).toBe('applied');
    expect(secondResult?.commitSeq).toBe(2);
    const row = await storage.getRow(PARTITION, 'tasks', 'one');
    expect(row?.serverVersion).toBe(2);
    // The scope index is already correct, so no scope statement wrote a row,
    // and the whole commit costs the pinned baseline.
    expect(
      measure.writes.some((write) => write.sql.includes('sync_row_scopes')),
    ).toBe(false);
    expect(measure.rowsWritten).toBe(14);
  });
});
