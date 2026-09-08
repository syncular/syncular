import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBunDatabase } from '@syncular/client/bun';
import {
  canonicalTaskRows,
  sqliteConfiguration,
  SQLITE_CONFIGURATION_SQL,
  COLUMNS,
  rowId,
  rowValues,
  seededRandom,
  TABLE,
  SCHEMA,
} from './fixture';
import { createBenchClient, type BenchClient } from './loopback';
import { withinDeadline } from './instrumentation';
import {
  createProcessDriver,
  processObject,
  assertProcessSync,
} from './process-driver';
import { createPerformanceServer, startSocketServer } from './socket-server';

function readFixture(rows: number) {
  const select = `SELECT ${COLUMNS.map((column) => `"${column.name}"`).join(', ')} FROM "${TABLE}"`;
  const random = seededRandom(0xb6b6b6);
  const expected = canonicalTaskRows(
    Array.from({ length: rows }, (_, index) => {
      const values = rowValues(index, random);
      return Object.fromEntries(
        COLUMNS.map((column, position) => [column.name, values[position]]),
      );
    }),
  );
  return {
    select,
    expected,
    queries: [
      { name: 'primary-key', sql: `${select} WHERE id = ?`, limit: 1 },
      {
        name: 'bounded-result',
        sql: `${select} WHERE id >= ? ORDER BY id LIMIT 100`,
        limit: 100,
      },
    ],
  };
}

/** Fixed SQL and schema. Setup, validation, and counter passes are untimed. */
export async function runReadLane(options: {
  rows: number;
  iterations: number;
  persistent: boolean;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'syncular-read-'));
  let server: Awaited<ReturnType<typeof createPerformanceServer>> | undefined;
  let handle: BenchClient | undefined;
  try {
    server = await createPerformanceServer(options.rows, 'engine', 'sqlite');
    const database = openBunDatabase(
      options.persistent ? join(directory, 'reader.sqlite') : ':memory:',
    );
    handle = await createBenchClient(server.endpoints, {
      database,
      limits: { limitSnapshotRows: 50_000, maxSnapshotPages: 50 },
    });
    const client = handle.client;
    const sqlite = sqliteConfiguration(
      client.query(SQLITE_CONFIGURATION_SQL),
      options.persistent,
    );
    await withinDeadline(client.syncUntilIdle(), 'read fixture bootstrap');
    const { select, expected, queries } = readFixture(options.rows);
    const expectedJson = JSON.stringify(expected);
    if (
      JSON.stringify(
        canonicalTaskRows(client.query(`${select} ORDER BY id`)),
      ) !== expectedJson
    )
      throw new Error('Read fixture did not converge to the generated rows');
    const revision = client.localRevision;
    const schema = database.query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name",
    );
    const read = (surface: string, sql: string, id: string) => {
      if (surface === 'database') return database.query(sql, [id]);
      if (surface === 'query') return client.query(sql, [id]);
      if (surface !== 'snapshot')
        throw new Error('Unknown read measurement surface');
      return client.querySnapshot({ sql, params: [id] }).rows;
    };
    const beforeCpu = process.cpuUsage();
    const rssBefore = process.memoryUsage().rss;
    const results = [];
    for (const query of queries) {
      const samplesMs: Record<string, number[]> = {
        database: [],
        query: [],
        snapshot: [],
      };
      const surfaces = Object.keys(samplesMs);
      const ids: string[] = [];
      for (let iteration = -3; iteration < options.iterations; iteration++) {
        const index =
          ((iteration + 3) * 997) % Math.max(1, options.rows - query.limit + 1);
        const id = rowId(index);
        const wanted = JSON.stringify(
          expected.slice(index, index + query.limit),
        );
        if (iteration >= 0) ids.push(id);
        // Rotate execution order so each public surface also runs first.
        for (let offset = 0; offset < surfaces.length; offset++) {
          const surface = surfaces[(iteration + 3 + offset) % surfaces.length]!;
          const started = performance.now();
          const rows = read(surface, query.sql, id);
          const elapsedMs = performance.now() - started;
          if (iteration >= 0) samplesMs[surface]!.push(elapsedMs);
          if (
            JSON.stringify(canonicalTaskRows(rows)) !== wanted ||
            JSON.stringify(rows.map((row) => row.id)) !==
              JSON.stringify(
                expected.slice(index, index + query.limit).map((row) => row.id),
              )
          )
            throw new Error('Read result differs from the generated fixture');
        }
      }
      const work: Record<string, { queries: string[]; transactions: number }> =
        {};
      const originalQuery = database.query;
      const originalTransaction = database.transaction.bind(database);
      try {
        for (const surface of surfaces) {
          const counts = { queries: [] as string[], transactions: 0 };
          database.query = (sql, params) => {
            counts.queries.push(sql);
            return originalQuery.call(database, sql, params);
          };
          database.transaction = <T>(fn: () => T): T => {
            counts.transactions++;
            return originalTransaction(fn);
          };
          read(surface, query.sql, rowId(0));
          if (
            counts.queries.length > (surface === 'snapshot' ? 2 : 1) ||
            counts.transactions > (surface === 'snapshot' ? 1 : 0)
          )
            throw new Error('Read statement or transaction budget exceeded');
          work[surface] = counts;
        }
      } finally {
        database.query = originalQuery;
        database.transaction = originalTransaction;
      }
      results.push({
        ...query,
        ids,
        samplesMs,
        work,
        plan: database.query(`EXPLAIN QUERY PLAN ${query.sql}`, [rowId(0)]),
      });
    }
    const cpu = process.cpuUsage(beforeCpu);
    const snapshot = client.querySnapshot({
      sql: `${select} WHERE id = ?`,
      params: [rowId(0)],
    });
    if (
      snapshot.revision !== revision ||
      !snapshot.coverage.complete ||
      client.statusSnapshot().outbox !== 0
    )
      throw new Error('Read benchmark changed revision, coverage, or outbox');
    if (
      JSON.stringify(
        canonicalTaskRows(client.query(`${select} ORDER BY id`)),
      ) !== expectedJson
    )
      throw new Error('Read benchmark changed the fixture');
    return {
      serverMetrics: await server.metrics(),
      rows: options.rows,
      iterations: options.iterations,
      warmups: 3,
      sqlite,
      clientSqlite: [
        {
          role: 'reader',
          pid: process.pid,
          clientId: client.clientId,
          ...sqlite,
        },
      ],
      schema,
      queries: results,
      revision: revision.toString(),
      validatedRows: expected.length,
      digest: createHash('sha256').update(expectedJson).digest('hex'),
      cpuMs: (cpu.user + cpu.system) / 1000,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      boundaries:
        'Synchronous Bun database, public query, and public querySnapshot on the same fully synced client. Raw samples include SQLite execution and row materialization; public samples include the guard and reserved-column check. The explicit projection contains no reserved columns, so filtering returns the original rows. Snapshots also read the revision inside a transaction, with empty coverage requirements. Three warmup cycles precede rotating surface order on warm SQLite pages. Fixture generation, result validation, query plans, and structural counter passes are outside latency samples. CPU includes validation and counters; RSS is process-wide. No application indexes or SQL tuning.',
    };
  } finally {
    try {
      await handle?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

/** Same read fixture, bootstrapped over sockets; measurement loops stay in Rust. */
export async function runProcessReads(options: {
  binary: string;
  rows: number;
  iterations: number;
  persistent: boolean;
  boundary: 'direct' | 'command' | 'ffi';
  swiftLibraries?: Record<string, string>;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'syncular-native-read-'));
  let server: Awaited<ReturnType<typeof startSocketServer>> | undefined;
  let client: Awaited<ReturnType<typeof createProcessDriver>> | undefined;
  try {
    server = await startSocketServer(options.rows, 'sqlite');
    client = await createProcessDriver(
      options.binary,
      server.endpoints,
      options.persistent ? join(directory, 'reader.sqlite') : undefined,
      undefined,
      SCHEMA,
      options.boundary === 'ffi',
      { limitSnapshotRows: 50_000, maxSnapshotPages: 50 },
    );
    const sqlite = sqliteConfiguration(
      processObject(
        await client.invoke('query', {
          sql: SQLITE_CONFIGURATION_SQL,
        }),
      ).rows,
      options.persistent,
    );
    assertProcessSync(await client.invoke('syncUntilIdle'));
    const { select, expected, queries } = readFixture(options.rows);
    const expectedJson = JSON.stringify(expected);
    const before = canonicalTaskRows(
      processObject(
        await client.invoke('query', { sql: `${select} ORDER BY id` }),
      ).rows,
    );
    if (JSON.stringify(before) !== expectedJson)
      throw new Error('Native read fixture did not converge');
    const revision = processObject(
      await client.invoke('localRevision'),
    ).revision;
    const inputs = queries.map((query) => ({
      ...query,
      inputs: Array.from({ length: options.iterations + 3 }, (_, iteration) => {
        const index =
          (iteration * 997) % Math.max(1, options.rows - query.limit + 1);
        return {
          params: [rowId(index)],
          rows: expected.slice(index, index + query.limit),
        };
      }),
    }));
    const beforeDelivery = client.deliveryStats();
    const started = performance.now();
    const result = processObject(
      await client.invoke('benchRead', {
        mode: options.swiftLibraries ? 'swift' : options.boundary,
        iterations: options.iterations,
        queries: inputs,
      }),
    );
    const processElapsedMs = performance.now() - started;
    const afterDelivery = client.deliveryStats();
    if (
      result.iterations !== options.iterations ||
      result.warmups !== 3 ||
      result.revision !== revision ||
      !Array.isArray(result.queries) ||
      result.queries.length !== 2
    )
      throw new Error('Native read report differs from requested fixture');
    if (options.swiftLibraries) {
      if (
        result.binding !== 'swift' ||
        !Array.isArray(result.loadedLibraries) ||
        JSON.stringify([...result.loadedLibraries].sort()) !==
          JSON.stringify(Object.keys(options.swiftLibraries).sort())
      )
        throw new Error(
          `Swift loaded libraries differ from the recorded build: ${JSON.stringify(result.loadedLibraries)}`,
        );
      for (const [path, hash] of Object.entries(options.swiftLibraries))
        if (
          createHash('sha256')
            .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
            .digest('hex') !== hash
        )
          throw new Error('Swift loaded library changed during the attempt');
    }
    let reportedSqlite;
    if (options.swiftLibraries) reportedSqlite = processObject(result.sqlite);
    else {
      if (!Array.isArray(result.sqlite) || result.sqlite.length !== 1)
        throw new Error('Native read SQLite version missing');
      reportedSqlite = processObject(result.sqlite[0]);
    }
    const afterSqlite = sqliteConfiguration(
      processObject(
        await client.invoke('query', {
          sql: SQLITE_CONFIGURATION_SQL,
        }),
      ).rows,
      options.persistent,
    );
    if (
      reportedSqlite.version !== sqlite.version ||
      JSON.stringify(afterSqlite) !== JSON.stringify(sqlite) ||
      (options.swiftLibraries &&
        JSON.stringify(
          sqliteConfiguration([result.sqlite], options.persistent),
        ) !== JSON.stringify(sqlite))
    )
      throw new Error('Read SQLite configuration changed during measurement');
    const measured = result.queries.map((raw, index) => {
      const query = processObject(raw);
      if (
        query.name !== queries[index]?.name ||
        query.sql !== queries[index]?.sql ||
        !Array.isArray(query.plan) ||
        query.plan.length === 0
      )
        throw new Error('Native read query or plan differs from fixture');
      const samples = processObject(query.samplesNs);
      const samplesMs: Record<string, number[]> = {};
      for (const name of options.swiftLibraries
        ? ['query', 'snapshot']
        : ['database', 'query', 'snapshot']) {
        const values = samples[name];
        if (
          !Array.isArray(values) ||
          values.length !== options.iterations ||
          values.some(
            (value) =>
              typeof value !== 'number' || !Number.isFinite(value) || value < 0,
          )
        )
          throw new Error('Native read samples are missing or invalid');
        samplesMs[name] = values.map((value: number) => value / 1_000_000);
        if (options.swiftLibraries) continue;
        const statements = processObject(
          processObject(query.work)[name],
        ).statements;
        if (
          !Array.isArray(statements) ||
          statements.length < 1 ||
          statements.length >
            (name === 'snapshot' ? 4 : 1) +
              (options.boundary === 'ffi' && name !== 'database' ? 5 : 0) ||
          statements.some((value) => typeof value !== 'string')
        )
          throw new Error('Native read statement budget exceeded');
      }
      const ffi =
        options.boundary === 'ffi' && !options.swiftLibraries
          ? processObject(query.ffi)
          : undefined;
      if (ffi) {
        for (const surface of ['query', 'snapshot']) {
          const timings = ffi[surface];
          if (!Array.isArray(timings) || timings.length !== options.iterations)
            throw new Error('FFI read timings are missing');
          for (const [index, raw] of timings.entries()) {
            const timing = processObject(raw);
            for (const key of [
              'requestSerializeNs',
              'callNs',
              'responseCopyNs',
              'responseFreeNs',
              'responseParseNs',
              'requestBytes',
              'responseBytes',
            ]) {
              if (
                typeof timing[key] !== 'number' ||
                !Number.isSafeInteger(timing[key]) ||
                timing[key] < 0
              )
                throw new Error('FFI read timing or byte count is invalid');
            }
            const exportedSamples = samples[surface];
            if (
              !Array.isArray(exportedSamples) ||
              timing.callNs !== exportedSamples[index] ||
              Number(timing.requestBytes) < 1 ||
              Number(timing.responseBytes) < 1
            )
              throw new Error(
                'FFI read sample differs from exported call timing',
              );
          }
        }
      }
      return {
        name: query.name,
        sql: query.sql,
        limit: queries[index]!.limit,
        ids: inputs[index]!.inputs.slice(3).map((input) => input.params[0]),
        samplesMs,
        work: query.work,
        plan: query.plan,
        ...(ffi ? { ffi } : {}),
      };
    });
    if (
      processObject(await client.invoke('localRevision')).revision !==
        revision ||
      processObject(await client.invoke('statusSnapshot')).outbox !== 0 ||
      JSON.stringify(
        canonicalTaskRows(
          processObject(
            await client.invoke('query', { sql: `${select} ORDER BY id` }),
          ).rows,
        ),
      ) !== expectedJson
    )
      throw new Error('Native read benchmark changed replica state');
    await client.close();
    return {
      serverMetrics: await server.metrics(),
      rows: options.rows,
      iterations: options.iterations,
      warmups: 3,
      queries: measured,
      schema: result.schema,
      sqlite: result.sqlite,
      clientSqlite: [
        {
          role: 'reader',
          pid: client.pid,
          clientId: client.clientId,
          ...sqlite,
        },
      ],
      revision,
      validatedRows: expected.length,
      digest: createHash('sha256').update(expectedJson).digest('hex'),
      processElapsedMs,
      delivery: Object.fromEntries(
        Object.entries(afterDelivery).map(([key, value]) => [
          key,
          value - beforeDelivery[key as keyof typeof beforeDelivery],
        ]),
      ),
      clientResources: [{ role: 'reader', ...client.resourceUsage() }],
      ...(options.swiftLibraries
        ? { binding: 'swift', loadedLibraries: result.loadedLibraries }
        : {}),
      boundaries: options.swiftLibraries
        ? 'Swift SDK query and querySnapshot calls on one fully synced client. Swift and the SDK compile as separate optimized modules and load the recorded release FFI library. Three warmup cycles precede alternating surface order. Samples include Foundation request encoding, serial command queue dispatch, C ABI execution and diagnostics, response decoding, and SDK result materialization. Snapshot samples also include extracting its row array. Result validation and autorelease-pool drain follow each timer. Background event polling and a dedicated serial delivery queue remain enabled; the app installs no event callback. Bootstrap, fixture transfer, full-result validation, query plans, schema/configuration reads, and report serialization are outside per-read timers. Aggregate process elapsed includes controller delivery, validation, and metadata collection. OS resources cover client lifetime. This profile exposes no raw SQLite timing or internal phase counters. No application indexes or SQL tuning.'
        : `Rust ${options.boundary} reads on one fully synced client connection. Socket bootstrap is untimed. Raw SQLite and public query/snapshot reads use the same connection, SQL, parameters, and dynamic row materialization. The raw fixture converter supports only its null, safe integer, finite real, and UTF-8 text cells. Direct samples stop before converting typed results for validation; command samples include the shipping router's JSON value construction. FFI query/snapshot samples time the actual exported call, including input parsing, command dispatch, diagnostics, and response serialization. Their ffi records separately report host request serialization, response copying, freeing, JSON parsing, and byte counts including NUL terminators. These sequential phase durations exclude construction of the timing report. Four diagnostic storage statements plus a local-revision read accompany each FFI read in this task-only schema. Three warmup cycles precede rotating surface order. SQL trace callbacks run only in a separate untimed pass. Validation, query plans, and fixture generation are outside per-read timers. The aggregate process elapsed includes IPC, validation, and counter passes. OS resources cover client process lifetime. No application indexes or SQL tuning.`,
    };
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
