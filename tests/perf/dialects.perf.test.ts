import { afterAll, describe, expect, it } from 'bun:test';
import path from 'node:path';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import { createLibsqlDb } from '@syncular/dialect-libsql';
import { createPgliteDialect } from '@syncular/dialect-pglite';
import { createSqlite3Db } from '@syncular/dialect-sqlite3';
import { createConformanceColumnCodecsPlugin } from '@syncular/tests-dialects/column-codecs';
import type { DialectConformanceDb } from '@syncular/tests-dialects/conformance-db';
import { createConformanceSchema } from '@syncular/tests-dialects/schema';
import { Kysely } from 'kysely';
import {
  type BenchmarkResult,
  benchmark,
  formatBenchmarkTable,
} from './benchmark';
import {
  detectRegressions,
  formatRegressionReport,
  hasRegressions,
  hasMissingBaselines,
  loadBaseline,
} from './regression';

interface PerfDialect {
  name: string;
  kind: 'sqlite' | 'postgres';
  createDb(): Promise<Kysely<DialectConformanceDb>>;
}

const BASELINE_PATH = path.join(import.meta.dir, 'baseline.json');

const PERF_DIALECTS: PerfDialect[] = [
  {
    name: 'bun-sqlite',
    kind: 'sqlite',
    async createDb() {
      return new Kysely<DialectConformanceDb>({
        dialect: createBunSqliteDialect({ path: ':memory:' }),
        plugins: [createConformanceColumnCodecsPlugin('sqlite')],
      });
    },
  },
  {
    name: 'sqlite3',
    kind: 'sqlite',
    async createDb() {
      return createSqlite3Db<DialectConformanceDb>({
        path: ':memory:',
      }).withPlugin(createConformanceColumnCodecsPlugin('sqlite'));
    },
  },
  {
    name: 'pglite',
    kind: 'postgres',
    async createDb() {
      return new Kysely<DialectConformanceDb>({
        dialect: createPgliteDialect(),
        plugins: [createConformanceColumnCodecsPlugin('postgres')],
      });
    },
  },
  {
    name: 'libsql',
    kind: 'sqlite',
    async createDb() {
      return createLibsqlDb<DialectConformanceDb>({
        url: ':memory:',
      }).withPlugin(createConformanceColumnCodecsPlugin('sqlite'));
    },
  },
];

function buildRows(kind: PerfDialect['kind'], count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `p-${i}`,
    n_int: i,
    n_bigint: kind === 'sqlite' ? i : BigInt(i),
    bigint_text: String(BigInt(i)),
    t_text: `row-${i}`,
    u_unique: `u-${i}`,
    b_bool: i % 2 === 0,
    j_json: { i } as const,
    j_large: { i, large: true } as const,
    d_date: new Date('2025-01-01T00:00:00.000Z'),
    bytes: new Uint8Array([i % 256]),
    nullable_text: null,
    nullable_int: null,
    nullable_bigint: null,
    nullable_bool: null,
    nullable_bytes: null,
    nullable_json: null,
    nullable_date: null,
  }));
}

async function insertRowsChunked(
  db: Kysely<DialectConformanceDb>,
  rows: Array<DialectConformanceDb['dialect_conformance']>,
  chunkSize: number
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await db.insertInto('dialect_conformance').values(chunk).execute();
  }
}

describe('dialect performance (conformance schema)', () => {
  const results: BenchmarkResult[] = [];

  afterAll(async () => {
    if (results.length === 0) return;
    console.log(`\n${formatBenchmarkTable(results)}`);

    const baseline = await loadBaseline(BASELINE_PATH);
    const regressions = detectRegressions(results, baseline);
    console.log(`\n${formatRegressionReport(regressions)}`);
  });

  for (const dialect of PERF_DIALECTS) {
    it(`${dialect.name}: insert 10k`, async () => {
      const result = await benchmark(
        `dialect_${dialect.name}_insert_10k`,
        async () => {
          const db = await dialect.createDb();
          try {
            await createConformanceSchema(db, dialect.kind);
            await insertRowsChunked(db, buildRows(dialect.kind, 10_000), 500);
          } finally {
            await db.destroy();
          }
        },
        { iterations: 1, warmup: 0, trackMemory: true }
      );
      results.push(result);
      expect(result.median).toBeGreaterThan(0);
    });

    it(`${dialect.name}: select 10k`, async () => {
      const db = await dialect.createDb();
      try {
        await createConformanceSchema(db, dialect.kind);
        await insertRowsChunked(db, buildRows(dialect.kind, 10_000), 500);

        const result = await benchmark(
          `dialect_${dialect.name}_select_10k`,
          async () => {
            const rows = await db
              .selectFrom('dialect_conformance')
              .select(['id', 'n_int', 'n_bigint'])
              .orderBy('n_int', 'asc')
              .execute();
            if (rows.length !== 10_000) {
              throw new Error(`unexpected row count: ${rows.length}`);
            }
          },
          { iterations: 3, warmup: 1, trackMemory: false }
        );
        results.push(result);
        expect(result.median).toBeGreaterThan(0);
      } finally {
        await db.destroy();
      }
    });
  }

  it('generates regression report', async () => {
    const baseline = await loadBaseline(BASELINE_PATH);
    const regressions = detectRegressions(results, baseline);

    console.log(`\n${formatRegressionReport(regressions)}`);

    if (process.env.PERF_STRICT === 'true') {
      expect(hasRegressions(regressions)).toBe(false);
      expect(hasMissingBaselines(regressions)).toBe(false);
    }
  });
});
