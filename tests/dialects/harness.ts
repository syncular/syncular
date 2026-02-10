import { SerializePlugin } from '@syncular/core';
import { createBetterSqlite3Db } from '@syncular/dialect-better-sqlite3';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import { createLibsqlDb } from '@syncular/dialect-libsql';
import { createPgliteDialect } from '@syncular/dialect-pglite';
import { createSqlite3Db } from '@syncular/dialect-sqlite3';
import { Kysely } from 'kysely';
import type { DialectConformanceDb } from './conformance-db';
import type { ConformanceDialectKind } from './schema';
import { createConformanceSerializePlugin } from './serialize';

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
        plugins: [new SerializePlugin()],
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
            return createBetterSqlite3Db<DialectConformanceDb>({
              path: ':memory:',
            });
          },
        },
      ] satisfies DialectHarness[])
    : []),
  {
    name: 'sqlite3',
    kind: 'sqlite',
    supportsStreaming: false,
    async createDb() {
      return createSqlite3Db<DialectConformanceDb>({ path: ':memory:' });
    },
  },
  {
    name: 'libsql',
    kind: 'sqlite',
    supportsStreaming: true,
    async createDb() {
      return createLibsqlDb<DialectConformanceDb>({ url: ':memory:' });
    },
  },
  {
    name: 'pglite',
    kind: 'postgres',
    supportsStreaming: true,
    async createDb() {
      return new Kysely<DialectConformanceDb>({
        dialect: createPgliteDialect(),
        plugins: [createConformanceSerializePlugin()],
      });
    },
  },
];
