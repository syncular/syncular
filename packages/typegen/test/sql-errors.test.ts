/**
 * The SQL subset is a fence: everything outside CREATE TABLE (typed
 * columns + single primary key), ALTER TABLE ADD COLUMN, CREATE INDEX, and
 * DROP TABLE is a hard error naming the unsupported construct.
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

  test('CREATE INDEX — plain, IF NOT EXISTS, compound, and UNIQUE', () => {
    const tables = parse(`
      CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT, b TEXT, c TEXT);
      CREATE INDEX idx_a ON t (a);
      CREATE INDEX IF NOT EXISTS idx_bc ON t (b, c);
      CREATE UNIQUE INDEX idx_uniq_a ON t (a);
    `);
    expect(tables.get('t')?.indexes).toEqual([
      { name: 'idx_a', columns: ['a'], unique: false },
      { name: 'idx_bc', columns: ['b', 'c'], unique: false },
      { name: 'idx_uniq_a', columns: ['a'], unique: true },
    ]);
  });

  test('index columns may reference a column added by a later ALTER', () => {
    const tables = parse(`
      CREATE TABLE t (id TEXT PRIMARY KEY);
      ALTER TABLE t ADD COLUMN a TEXT;
      CREATE INDEX idx_a ON t (a);
    `);
    expect(tables.get('t')?.indexes).toEqual([
      { name: 'idx_a', columns: ['a'], unique: false },
    ]);
  });

  test('a table with no index has an empty indexes list', () => {
    const tables = parse('CREATE TABLE t (id TEXT PRIMARY KEY)');
    expect(tables.get('t')?.indexes).toEqual([]);
  });

  test('DROP TABLE removes a table and its indexes from the head schema', () => {
    const tables = parse(`
      CREATE TABLE retired (id TEXT PRIMARY KEY, title TEXT);
      CREATE INDEX retired_by_title ON retired (title);
      CREATE TABLE kept (id TEXT PRIMARY KEY);
      DROP TABLE retired;
    `);
    expect([...tables.keys()]).toEqual(['kept']);
  });

  test('DROP TABLE IF EXISTS is a no-op for an absent table', () => {
    const tables = parse(`
      DROP TABLE IF EXISTS absent;
      CREATE TABLE kept (id TEXT PRIMARY KEY);
    `);
    expect([...tables.keys()]).toEqual(['kept']);
  });
});

describe('CREATE INDEX subset — hard errors naming the construct', () => {
  const base = 'CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT, b TEXT); ';
  test('index on an unknown table', () => {
    expectError(
      'CREATE INDEX idx ON nope (id)',
      /CREATE INDEX idx: table nope does not exist/,
    );
  });
  test('index on an unknown column', () => {
    expectError(
      `${base}CREATE INDEX idx ON t (nope)`,
      /index idx: column "nope" does not exist on table t/,
    );
  });
  test('duplicate index name across the schema', () => {
    expectError(
      `${base}CREATE INDEX idx ON t (a); CREATE INDEX idx ON t (b)`,
      /index idx is created twice/,
    );
  });
  test('duplicate column within one index', () => {
    expectError(
      `${base}CREATE INDEX idx ON t (a, a)`,
      /index idx: column "a" appears twice/,
    );
  });
  test('ASC/DESC index columns are rejected', () => {
    expectError(
      `${base}CREATE INDEX idx ON t (a DESC)`,
      /index idx: ASC\/DESC index columns are unsupported/,
    );
    expectError(
      `${base}CREATE INDEX idx ON t (a ASC)`,
      /index idx: ASC\/DESC index columns are unsupported/,
    );
  });
  test('expression index columns are rejected', () => {
    expectError(
      `${base}CREATE INDEX idx ON t (lower(a))`,
      /index idx: expression index columns are unsupported|unexpected character/,
    );
  });
  test('partial (WHERE) indexes are rejected', () => {
    expectError(
      `${base}CREATE INDEX idx ON t (a) WHERE a IS NOT NULL`,
      /index idx: partial indexes \(WHERE …\) are unsupported/,
    );
  });
  test('quoted index/table identifiers are rejected', () => {
    expectError(
      `${base}CREATE INDEX "idx" ON t (a)`,
      /quoted identifiers are unsupported/,
    );
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
    expectError('DROP INDEX idx', /expected TABLE after DROP/);
    expectError(
      'CREATE TRIGGER trg AFTER INSERT ON t BEGIN SELECT 1; END',
      /unsupported CREATE statement.*found "TRIGGER"/,
    );
    expectError(
      "INSERT INTO t VALUES ('x')",
      /unsupported SQL statement.*"INSERT"/,
    );
  });

  test('DROP TABLE rejects unsafe or ambiguous evolution', () => {
    expectError(
      'DROP TABLE missing',
      /DROP TABLE missing: table does not exist at this point/,
    );
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY); DROP TABLE t CASCADE',
      /unsupported trailing SQL "CASCADE"/,
    );
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY); DROP TABLE t; CREATE TABLE t (id TEXT PRIMARY KEY)',
      /cannot be re-created after DROP TABLE/,
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
