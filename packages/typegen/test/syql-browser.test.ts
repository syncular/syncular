import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { IrDocument } from '../src/ir';
import { type QueryDb, synthesizeDdl } from '../src/query';
import { compileSyqlSource, formatSyqlSource } from '../src/syql-browser';
import { SyqlFrontendError } from '../src/syql-lexer';

const IR: IrDocument = {
  irVersion: 1,
  schemaVersion: 1,
  schemaVersions: [{ version: 1, migrations: ['0001'] }],
  tables: [
    {
      name: 'todos',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'list_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'status', type: 'string', nullable: true },
        { name: 'created_at', type: 'integer', nullable: false },
      ],
      scopes: [
        { pattern: 'list:{list_id}', variable: 'list_id', column: 'list_id' },
      ],
      indexes: [],
      ftsIndexes: [],
      extensions: {},
    },
  ],
  subscriptions: [],
  extensions: {},
};

function makeDb(): { readonly db: QueryDb; readonly close: () => void } {
  const sqlite = new Database(':memory:');
  sqlite.run(synthesizeDdl(IR));
  return {
    db: {
      analyze(sql) {
        const statement = sqlite.prepare(sql);
        try {
          const columnNames = statement.columnNames;
          const paramsCount = (
            statement as unknown as { readonly paramsCount: number }
          ).paramsCount;
          (
            statement as unknown as { all: (...params: number[]) => unknown[] }
          ).all(...Array.from({ length: paramsCount }, () => 1));
          const declaredTypes = (
            statement as unknown as {
              readonly declaredTypes: readonly (string | null)[];
            }
          ).declaredTypes;
          return { columnNames, declaredTypes, paramsCount };
        } finally {
          statement.finalize();
        }
      },
    },
    close: () => sqlite.close(),
  };
}

describe('browser-safe SYQL source compiler', () => {
  test('compiles local predicates and multiple queries with the real plan', () => {
    const { db, close } = makeDb();
    try {
      const result = compileSyqlSource(
        `predicate hasStatus(value: string | null) {
  status is :value
}

query listTodos(listId, status?: string | null) {
  select id, title, status from todos
  where list_id = :listId
    and when(status) hasStatus(:status);
}

sync query coveredTodos(listId) {
  select id, list_id, title from todos
  where list_id = :listId;
}`,
        IR,
        db,
      );

      expect(result.queries).toHaveLength(2);
      expect(result.queries[0]?.selected.backend).toBe('variants');
      expect(result.queries[0]?.selected.statements).toHaveLength(2);
      expect(result.queries[0]?.selected.statements[1]?.sql).toContain(
        'status is :status',
      );
      expect(result.queries[1]?.analysis.reactive.coverage).toHaveLength(1);
      expect(result.queries[1]?.analysis.reactive.rowKey).toEqual(['id']);
    } finally {
      close();
    }
  });

  test('rejects imports with a source-spanned playground diagnostic', () => {
    const { db, close } = makeDb();
    try {
      expect(() =>
        compileSyqlSource(
          `import { matchesTitle } from "./predicates.syql";

query listTodos(listId) {
  select id from todos where list_id = :listId;
}`,
          IR,
          db,
        ),
      ).toThrow(SyqlFrontendError);
      try {
        compileSyqlSource(
          `import { matchesTitle } from "./predicates.syql";

query listTodos(listId) {
  select id from todos where list_id = :listId;
}`,
          IR,
          db,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(SyqlFrontendError);
        expect((error as SyqlFrontendError).code).toBe(
          'PLAYGROUND_IMPORTS_UNAVAILABLE',
        );
        expect((error as SyqlFrontendError).span.start.line).toBe(1);
      }
    } finally {
      close();
    }
  });

  test('formats virtual source canonically and idempotently', () => {
    const formatted = formatSyqlSource(
      'query listTodos(listId){select id,title from todos where list_id=:listId;}',
    );
    expect(formatted).toContain('query listTodos(listId) {');
    expect(formatSyqlSource(formatted)).toBe(formatted);
  });

  test('has no Node or Bun runtime imports in its browser bundle', async () => {
    const result = await Bun.build({
      entrypoints: [
        new URL('../src/syql-browser.ts', import.meta.url).pathname,
      ],
      target: 'browser',
      format: 'esm',
      minify: false,
    });
    expect(result.success).toBe(true);
    expect(result.logs).toEqual([]);
    const bundle = await result.outputs[0]?.text();
    expect(bundle).toBeDefined();
    expect(bundle).not.toMatch(/(?:node:|bun:sqlite|from ['"](?:fs|path)['"])/);
    expect(bundle).not.toMatch(/\b(?:Bun|process)\b/);
  });
});
