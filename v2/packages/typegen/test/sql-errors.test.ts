/**
 * The SQL subset is a fence: everything outside CREATE TABLE (typed
 * columns + single primary key) and ALTER TABLE ADD COLUMN is a hard
 * error naming the unsupported construct.
 */
import { describe, expect, test } from 'bun:test';
import { applyMigrationSql, type ParsedTable, TypegenError } from '../src';

function parse(sql: string): Map<string, ParsedTable> {
  const tables = new Map<string, ParsedTable>();
  applyMigrationSql(tables, sql, 'test.sql');
  return tables;
}

describe('supported subset', () => {
  test('create + alter accumulate columns in declaration order', () => {
    const tables = parse(`
      -- comment
      CREATE TABLE IF NOT EXISTS t (
        id TEXT PRIMARY KEY,
        n BIGINT NOT NULL DEFAULT 0,
        note TEXT NULL DEFAULT 'a''b'
      ) WITHOUT ROWID;
      /* block comment */
      ALTER TABLE t ADD COLUMN extra BOOLEAN;
    `);
    const t = tables.get('t');
    expect(t?.primaryKey).toBe('id');
    expect(t?.columns).toEqual([
      { name: 'id', type: 'string', nullable: false },
      { name: 'n', type: 'integer', nullable: false },
      { name: 'note', type: 'string', nullable: true },
      { name: 'extra', type: 'boolean', nullable: true },
    ]);
  });

  test('table-level single-column PRIMARY KEY forces non-null', () => {
    const tables = parse('CREATE TABLE t (id TEXT, PRIMARY KEY (id))');
    expect(tables.get('t')?.columns[0]?.nullable).toBe(false);
  });

  test('all six column types map from SQL keywords', () => {
    const tables = parse(`CREATE TABLE t (
      a TEXT PRIMARY KEY, b INTEGER, c REAL, d BOOL, e JSONB, f BYTEA
    )`);
    expect(tables.get('t')?.columns.map((c) => c.type)).toEqual([
      'string',
      'integer',
      'float',
      'boolean',
      'json',
      'bytes',
    ]);
  });
});

function expectError(sql: string, pattern: RegExp): void {
  let error: unknown;
  try {
    parse(sql);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TypegenError);
  expect((error as TypegenError).message).toMatch(pattern);
}

describe('unsupported constructs are hard errors that name the construct', () => {
  test('other statements', () => {
    expectError('DROP TABLE t', /unsupported SQL statement.*"DROP"/);
    expectError(
      'CREATE INDEX idx ON t (id)',
      /expected TABLE after CREATE, found "INDEX"/,
    );
    expectError(
      "INSERT INTO t VALUES ('x')",
      /unsupported SQL statement.*"INSERT"/,
    );
  });

  test('unsupported and parameterized column types', () => {
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY, ts TIMESTAMP)',
      /unsupported column type "TIMESTAMP"/,
    );
    expectError(
      'CREATE TABLE t (id VARCHAR(36) PRIMARY KEY)',
      /parameterized column types are unsupported \(VARCHAR/,
    );
  });

  test('table constraints', () => {
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY, UNIQUE (id))',
      /unsupported table constraint "UNIQUE"/,
    );
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY, o TEXT, FOREIGN KEY (o) REFERENCES other (id))',
      /unsupported table constraint "FOREIGN"/,
    );
  });

  test('column constraints', () => {
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY, o TEXT REFERENCES other (id))',
      /unsupported column constraint "REFERENCES"/,
    );
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY, n INT CHECK (n))',
      /unsupported column constraint "CHECK"/,
    );
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY, n INT CHECK (n > 0))',
      /unexpected character ">"/,
    );
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY, ts BIGINT DEFAULT (unixepoch()))',
      /DEFAULT expressions are unsupported/,
    );
  });

  test('primary-key violations', () => {
    expectError('CREATE TABLE t (id TEXT)', /declares no primary key/);
    expectError(
      'CREATE TABLE t (a TEXT, b TEXT, PRIMARY KEY (a, b))',
      /composite primary keys are unsupported/,
    );
    expectError(
      'CREATE TABLE t (a TEXT PRIMARY KEY, b TEXT PRIMARY KEY)',
      /composite primary keys are unsupported/,
    );
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY); ALTER TABLE t ADD COLUMN x TEXT PRIMARY KEY',
      /PRIMARY KEY is not supported on ADD COLUMN/,
    );
  });

  test('quoted identifiers', () => {
    expectError(
      'CREATE TABLE "t" (id TEXT PRIMARY KEY)',
      /quoted identifiers are unsupported/,
    );
  });

  test('structural errors', () => {
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY); CREATE TABLE t (id TEXT PRIMARY KEY)',
      /table t is created twice/,
    );
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY, id TEXT)',
      /duplicate column "id"/,
    );
    expectError(
      'ALTER TABLE missing ADD COLUMN x TEXT',
      /table does not exist/,
    );
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY) STRICT',
      /unsupported trailing SQL "STRICT"/,
    );
    expectError(
      'ALTER TABLE t RENAME TO u',
      /unsupported SQL statement|does not exist/,
    );
  });

  test('errors carry the migration source name', () => {
    expectError('DROP TABLE t', /^test\.sql:/);
  });
});
