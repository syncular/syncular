import { describe, expect, test } from 'bun:test';
import {
  type AnalyzedQuery,
  emitQueriesRustModule,
  TypegenError,
} from '../src';

const QUERY: AnalyzedQuery = {
  name: 'compositeIdentity',
  file: 'composite-identity.sql',
  sourceSql: 'SELECT id, revision FROM records',
  sql: 'SELECT id, revision FROM records',
  positionalSql: 'SELECT id, revision FROM records',
  params: [],
  columns: [
    {
      name: 'id',
      langName: 'id',
      type: 'string',
      nullable: false,
      fidelity: 'exact',
    },
    {
      name: 'revision',
      langName: 'revision',
      type: 'integer',
      nullable: false,
      fidelity: 'exact',
    },
  ],
  tables: ['records'],
  reactive: {
    dependencies: [{ table: 'records', scopes: [] }],
    coverage: [],
    rowKey: ['id', 'revision'],
  },
};

describe('Rust query emitter contract', () => {
  test('emits a composite lossless row key and crate alias', () => {
    const output = emitQueriesRustModule(
      [QUERY],
      'sha256:test',
      1,
      'aliased_syncular',
    );
    expect(output).toContain('use aliased_syncular::{');
    expect(output).toContain(
      'vec![bind_string(&row.id), bind_integer(&row.revision)]',
    );
    expect(output).not.toContain('use serde_json');
  });

  test('strict decoders cover exact integers, bytes, and missing columns', () => {
    const output = emitQueriesRustModule([QUERY], 'sha256:test', 1);
    expect(output).toContain('invalid $bigint envelope');
    expect(output).toContain('invalid hexadecimal $bytes envelope');
    expect(output).toContain('missing column');
    expect(output).toContain('rows.into_iter().map(decode).collect()');
  });

  test('rejects post-conversion Rust collisions before emitting source', () => {
    const collision: AnalyzedQuery = {
      ...QUERY,
      columns: [
        QUERY.columns[0] as (typeof QUERY.columns)[number],
        {
          name: 'foo_bar',
          langName: 'fooBar',
          type: 'string',
          nullable: false,
          fidelity: 'exact',
        },
        {
          name: 'foo_bar_2',
          langName: 'foo_bar',
          type: 'string',
          nullable: false,
          fidelity: 'exact',
        },
      ],
    };
    expect(() => emitQueriesRustModule([collision], 'sha256:test', 1)).toThrow(
      TypegenError,
    );
  });
});
