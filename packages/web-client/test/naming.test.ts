/**
 * §5 mutate key normalization: value keys are accepted in exactly two
 * casings — SQL-truth snake_case and the generated row types' camelCase —
 * via the pinned §12 naming map (same vectors as typegen and the Rust
 * core). No fuzzy matching; both-casings-at-once is an error.
 */
import { describe, expect, test } from 'bun:test';
import {
  type ClientSchema,
  compileClientSchema,
  recordToRowValues,
  snakeToCamel,
} from '@syncular/client';

describe('snakeToCamel — pinned §12 vectors (lockstep with typegen + Rust)', () => {
  const VECTORS: readonly [string, string][] = [
    ['created_at', 'createdAt'],
    ['col_2', 'col2'],
    ['user_id', 'userId'],
    ['_internal', '_internal'],
    ['__foo_bar', '__fooBar'],
    ['row_', 'row_'],
    ['id_url', 'idUrl'],
    ['api_key', 'apiKey'],
    ['title', 'title'],
    ['alreadyCamel', 'alreadyCamel'],
    ['a__b', 'aB'],
    ['_lead_and_trail_', '_leadAndTrail_'],
    ['count(*)', 'count(*)'],
  ];
  for (const [input, expected] of VECTORS) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(snakeToCamel(input)).toBe(expected);
    });
  }
});

const SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'todos',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'list_id', type: 'string', nullable: false },
        { name: 'updated_at_ms', type: 'integer', nullable: false },
        { name: 'note', type: 'string', nullable: true },
      ],
      scopes: ['list:{list_id}'],
    },
    {
      name: 'weird',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'col_2', type: 'string', nullable: true },
        { name: 'col2', type: 'string', nullable: true },
      ],
      scopes: ['w:{id}'],
    },
  ],
};

const compiled = compileClientSchema(SCHEMA);
const todos = compiled.tables.get('todos');
const weird = compiled.tables.get('weird');
if (todos === undefined || weird === undefined) throw new Error('unreachable');

describe('recordToRowValues — two-casing normalization', () => {
  test('camelCase keys bind through the naming map', () => {
    const values = recordToRowValues(todos, {
      id: 't1',
      listId: 'l1',
      updatedAtMs: 42,
    });
    expect(values).toEqual(['t1', 'l1', 42, null]);
  });

  test('snake_case keys stay the SQL truth', () => {
    const values = recordToRowValues(todos, {
      id: 't1',
      list_id: 'l1',
      updated_at_ms: 42,
    });
    expect(values).toEqual(['t1', 'l1', 42, null]);
  });

  test('mixing casings across DIFFERENT columns is fine', () => {
    const values = recordToRowValues(todos, {
      id: 't1',
      listId: 'l1',
      updated_at_ms: 42,
    });
    expect(values).toEqual(['t1', 'l1', 42, null]);
  });

  test('one column in both casings is a loud error', () => {
    expect(() =>
      recordToRowValues(todos, {
        id: 't1',
        list_id: 'a',
        listId: 'b',
        updated_at_ms: 1,
      }),
    ).toThrow(/appears twice/);
  });

  test('anything else is an unknown column (no fuzzy matching)', () => {
    expect(() =>
      recordToRowValues(todos, {
        id: 't1',
        LIST_ID: 'l1',
        updated_at_ms: 1,
      }),
    ).toThrow(/unknown column "LIST_ID"/);
  });

  test('an alias colliding with a real column never steals it', () => {
    // `col_2` camel-maps to `col2`, which IS a column: exact match wins.
    const values = recordToRowValues(weird, { id: 'w1', col2: 'v' });
    expect(values).toEqual(['w1', null, 'v']);
  });
});
