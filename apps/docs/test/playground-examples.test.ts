import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { QueryDb } from '../../../packages/typegen/src/query';
import { synthesizeDdl } from '../../../packages/typegen/src/query';
import { compileSyqlSource } from '../../../packages/typegen/src/syql-browser';
import {
  PLAYGROUND_EXAMPLES,
  PLAYGROUND_SCHEMAS,
} from '../src/playground/examples';

function withSchema<T>(
  schemaId: keyof typeof PLAYGROUND_SCHEMAS,
  run: (db: QueryDb) => T,
): T {
  const sqlite = new Database(':memory:');
  sqlite.run(synthesizeDdl(PLAYGROUND_SCHEMAS[schemaId]));
  try {
    return run({
      analyze(sql) {
        const statement = sqlite.prepare(sql);
        try {
          const paramsCount = (
            statement as unknown as { readonly paramsCount: number }
          ).paramsCount;
          (
            statement as unknown as {
              all: (...params: number[]) => unknown[];
            }
          ).all(...Array.from({ length: paramsCount }, () => 1));
          return {
            columnNames: statement.columnNames,
            declaredTypes: (
              statement as unknown as {
                readonly declaredTypes: readonly (string | null)[];
              }
            ).declaredTypes,
            paramsCount,
          };
        } finally {
          statement.finalize();
        }
      },
    });
  } finally {
    sqlite.close();
  }
}

const EXPECTED_PLANS = {
  basic: {
    backend: 'variants',
    statements: 1,
    inputs: ['listId'],
    bindKinds: ['value'],
    sql: 'where todos.list_id = :listId',
  },
  optional: {
    backend: 'neutralize',
    statements: 1,
    inputs: ['listId', 'status', 'range', 'unassigned'],
    bindKinds: [
      'value',
      'condition-active',
      'value',
      'condition-active',
      'group-member',
      'group-member',
      'condition-active',
    ],
    sql: 'case when :__syqlActive0 = 0',
  },
  'sort-limit': {
    backend: 'variants',
    statements: 3,
    inputs: ['listId', 'sortBy', 'pageSize'],
    bindKinds: ['value', 'limit'],
    sql: 'limit min(coalesce(:__syqlLimit, 50), 200)',
  },
  'sync-coverage': {
    backend: 'variants',
    statements: 1,
    inputs: ['listId'],
    bindKinds: ['value'],
    sql: 'select id, list_id AS listId',
  },
  predicate: {
    backend: 'variants',
    statements: 1,
    inputs: ['listId', 'q'],
    bindKinds: ['value', 'value'],
    sql: "title like '%' || :q || '%'",
  },
} as const;

describe('SYQL playground examples', () => {
  for (const example of PLAYGROUND_EXAMPLES) {
    test(`${example.label} compiles through the portable compiler boundary`, () => {
      withSchema(example.schemaId, (db) => {
        const result = compileSyqlSource(
          example.source,
          PLAYGROUND_SCHEMAS[example.schemaId],
          db,
        );
        const query = result.queries[0];
        const expected = EXPECTED_PLANS[example.id];

        expect(result.queries).toHaveLength(1);
        expect(query?.selected.backend).toBe(expected.backend);
        expect(query?.selected.statements).toHaveLength(expected.statements);
        expect(query?.selected.statements[0]?.sql).toContain(expected.sql);
        expect(query?.selected.statements[0]?.positionalSql).toContain('?');
        expect(query?.analysis.syql?.inputs.map((input) => input.name)).toEqual(
          [...expected.inputs],
        );
        expect(
          query?.selected.statements[0]?.binds.map((bind) => bind.kind),
        ).toEqual([...expected.bindKinds]);
        expect(query?.analysis.reactive.dependencies).toEqual([
          {
            table: 'todos',
            scopes: [
              {
                table: 'todos',
                variable: 'list_id',
                pattern: 'list:{list_id}',
                params: ['listId'],
              },
            ],
          },
        ]);
        expect(query?.analysis.reactive.rowKey).toEqual(['id']);
        if (example.id === 'sync-coverage') {
          expect(query?.analysis.reactive.coverage).toEqual([
            {
              table: 'todos',
              variable: 'list_id',
              units: ['listId'],
              fixedScopes: [],
            },
          ]);
        } else {
          expect(query?.analysis.reactive.coverage).toEqual([]);
        }
        if (example.id === 'sort-limit') {
          expect(
            query?.selected.statements.map(
              (statement) => statement.sortProfile,
            ),
          ).toEqual(['newest', 'oldest', 'title']);
        }
      });
    });
  }
});
