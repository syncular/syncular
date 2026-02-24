import { createDatabase } from '@syncular/core';
import { createBetterSqlite3Dialect } from '@syncular/dialect-better-sqlite3';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import { createLibsqlDialect } from '@syncular/dialect-libsql';
import { createPgliteDialect } from '@syncular/dialect-pglite';
import { createSqlite3Dialect } from '@syncular/dialect-sqlite3';
import { Kysely } from 'kysely';
import { createConformanceColumnCodecsPlugin } from './column-codecs';
import type { DialectConformanceDb } from './conformance-db';
import type { ConformanceDialectKind } from './schema';

interface DialectHarness {
  name: string;
  kind: ConformanceDialectKind;
  supportsStreaming: boolean;
  createDb(): Promise<Kysely<DialectConformanceDb>>;
}

function isBunRuntime(): boolean {
  return (
    typeof (process.versions as Record<string, string | undefined>).bun ===
    'string'
  );
}

export const DIALECT_HARNESSES: DialectHarness[] = [
  {
    name: 'bun-sqlite',
    kind: 'sqlite',
    supportsStreaming: false,
    async createDb() {
      return new Kysely<DialectConformanceDb>({
        dialect: createBunSqliteDialect({ path: ':memory:' }),
        plugins: [createConformanceColumnCodecsPlugin('sqlite')],
      });
    },
  },
  ...(!isBunRuntime()
    ? ([
        {
          name: 'better-sqlite3',
          kind: 'sqlite',
          supportsStreaming: false,
          async createDb() {
            return createDatabase<DialectConformanceDb>({
              dialect: createBetterSqlite3Dialect({
                path: ':memory:',
              }),
              family: 'sqlite',
            }).withPlugin(createConformanceColumnCodecsPlugin('sqlite'));
          },
        },
      ] satisfies DialectHarness[])
    : []),
  {
    name: 'sqlite3',
    kind: 'sqlite',
    supportsStreaming: false,
    async createDb() {
      return createDatabase<DialectConformanceDb>({
        dialect: createSqlite3Dialect({
          path: ':memory:',
        }),
        family: 'sqlite',
      }).withPlugin(createConformanceColumnCodecsPlugin('sqlite'));
    },
  },
  {
    name: 'libsql',
    kind: 'sqlite',
    supportsStreaming: true,
    async createDb() {
      return createDatabase<DialectConformanceDb>({
        dialect: createLibsqlDialect({
          url: ':memory:',
        }),
        family: 'sqlite',
      }).withPlugin(createConformanceColumnCodecsPlugin('sqlite'));
    },
  },
  {
    name: 'pglite',
    kind: 'postgres',
    supportsStreaming: true,
    async createDb() {
      return new Kysely<DialectConformanceDb>({
        dialect: createPgliteDialect(),
        plugins: [createConformanceColumnCodecsPlugin('postgres')],
      });
    },
  },
];
