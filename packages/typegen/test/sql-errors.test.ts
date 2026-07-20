/**
 * The SQL subset is a fence: everything outside CREATE TABLE (typed
 * columns + single primary key), ALTER TABLE ADD COLUMN, CREATE INDEX, and
 * DROP TABLE is a hard error naming the unsupported construct.
 */
import { describe, expect, test } from 'bun:test';
import { compileSchema } from '@syncular/server';
import {
  applyMigrationSql,
  type ParsedTable,
  TypegenError,
  validateFinalSchemaIdentifiers,
} from '../src';

function parse(sql: string): Map<string, ParsedTable> {
  const tables = new Map<string, ParsedTable>();
  applyMigrationSql(tables, sql, 'test.sql');
  return tables;
}

function parseFinal(sql: string): Map<string, ParsedTable> {
  const tables = parse(sql);
  validateFinalSchemaIdentifiers(tables);
  return tables;
}

describe('supported subset', () => {
  test('accepts Unicode bare identifiers in the migration subset', () => {
    expect(
      parse('CREATE TABLE prüfung (id TEXT PRIMARY KEY)').get('prüfung')?.name,
    ).toBe('prüfung');
  });

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

  test('ALTER TABLE rejects required additions even when SQL declares a default', () => {
    for (const suffix of [
      'NOT NULL',
      "NOT NULL DEFAULT 'participant_summary_only_v1'",
    ]) {
      expect(() =>
        parse(`
          CREATE TABLE t (id TEXT PRIMARY KEY);
          ALTER TABLE t ADD COLUMN retained_history_policy TEXT ${suffix};
        `),
      ).toThrow(
        'added column "retained_history_policy" must be nullable — SQL defaults do not backfill Syncular row payloads',
      );
    }
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

  test('CREATE VIRTUAL TABLE fts5 attaches a local projection to its owner', () => {
    const tables = parse(`
      CREATE TABLE catalogue_codes (
        id TEXT PRIMARY KEY, release_id TEXT NOT NULL,
        code TEXT NOT NULL, title TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE catalogue_codes_fts USING fts5(
        code, title,
        content = catalogue_codes,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    expect(tables.get('catalogue_codes')?.ftsIndexes).toEqual([
      {
        name: 'catalogue_codes_fts',
        columns: ['code', 'title'],
        tokenize: 'unicode61 remove_diacritics 2',
      },
    ]);
    expect(tables.has('catalogue_codes_fts')).toBe(false);
  });

  test('FTS5 defaults to the deterministic unicode61 tokenizer', () => {
    const tables = parse(`
      CREATE TABLE docs (id TEXT PRIMARY KEY, body TEXT);
      CREATE VIRTUAL TABLE docs_fts USING fts5(body, content=docs);
    `);
    expect(tables.get('docs')?.ftsIndexes[0]?.tokenize).toBe('unicode61');
  });
});

describe('portable relational identifier parity', () => {
  test('accepts an exactly-63-byte final index name', () => {
    const name = 'i'.repeat(63);
    expect(() =>
      parseFinal(
        `CREATE TABLE t (id TEXT PRIMARY KEY); CREATE INDEX ${name} ON t (id)`,
      ),
    ).not.toThrow();
  });

  test('rejects final ASCII and UTF-8 index names over 63 bytes', () => {
    for (const name of ['i'.repeat(64), 'ü'.repeat(32)]) {
      let error: unknown;
      try {
        parseFinal(
          `CREATE TABLE t (id TEXT PRIMARY KEY); CREATE INDEX ${name} ON t (id)`,
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TypegenError);
      expect((error as TypegenError).source).toBe('test.sql');
      expect((error as Error).message).toContain(
        'exceeds 63 bytes (Postgres identifier limit; actual UTF-8 length: 64 bytes)',
      );
    }
  });

  test('uses the same diagnostic as runtime schema compilation', () => {
    const name = 'i'.repeat(64);
    let generated: unknown;
    let runtime: unknown;
    try {
      parseFinal(
        `CREATE TABLE t (id TEXT PRIMARY KEY); CREATE INDEX ${name} ON t (id)`,
      );
    } catch (caught) {
      generated = caught;
    }
    try {
      compileSchema({
        version: 1,
        tables: [
          {
            name: 't',
            columns: [{ name: 'id', type: 'string', nullable: false }],
            primaryKey: 'id',
            scopes: ['t:{id}'],
            indexes: [{ name, columns: ['id'] }],
          },
        ],
      });
    } catch (caught) {
      runtime = caught;
    }
    expect((generated as Error).message.replace(/^test\.sql: /u, '')).toBe(
      (runtime as Error).message,
    );
  });

  test('non-ASCII final identifiers fail loudly as unportable', () => {
    expect(() =>
      parseFinal('CREATE TABLE aufgaben_übersicht (id TEXT PRIMARY KEY)'),
    ).toThrow(
      'table name "aufgaben_übersicht" must be an ASCII identifier matching [A-Za-z_][A-Za-z0-9_]*',
    );
    expect(() =>
      parseFinal('CREATE TABLE t (id TEXT PRIMARY KEY, größe INTEGER)'),
    ).toThrow('column name "größe" must be an ASCII identifier');
    expect(() =>
      parseFinal(
        'CREATE TABLE t (id TEXT PRIMARY KEY); CREATE INDEX idx_prüfung ON t (id)',
      ),
    ).toThrow('index name "idx_prüfung" must be an ASCII identifier');
  });

  test('locked history keeps replaying non-ASCII identifiers', () => {
    const tables = new Map<string, ParsedTable>();
    applyMigrationSql(
      tables,
      'CREATE TABLE aufgaben_übersicht (id TEXT PRIMARY KEY, größe INTEGER); CREATE INDEX idx_prüfung ON aufgaben_übersicht (id)',
      '0001_locked/up.sql',
      new Set(),
      { lockedHistory: true },
    );
    expect(() => validateFinalSchemaIdentifiers(tables)).not.toThrow();
    // A migration appended beyond the locked prefix enforces the rule, even
    // on a table the locked history created.
    applyMigrationSql(
      tables,
      'ALTER TABLE aufgaben_übersicht ADD COLUMN qualität TEXT',
      '0002_new/up.sql',
      new Set(),
    );
    expect(() => validateFinalSchemaIdentifiers(tables)).toThrow(
      'column name "qualität" must be an ASCII identifier',
    );
  });

  test('locked history replays a required ADD COLUMN; appended migrations enforce nullability', () => {
    const tables = new Map<string, ParsedTable>();
    applyMigrationSql(
      tables,
      'CREATE TABLE t (id TEXT PRIMARY KEY); ALTER TABLE t ADD COLUMN kind TEXT NOT NULL',
      '0001_locked/up.sql',
      new Set(),
      { lockedHistory: true },
    );
    expect(tables.get('t')?.columns).toEqual([
      { name: 'id', type: 'string', nullable: false },
      { name: 'kind', type: 'string', nullable: false },
    ]);
    expect(() =>
      applyMigrationSql(
        tables,
        'ALTER TABLE t ADD COLUMN extra TEXT NOT NULL',
        '0002_new/up.sql',
        new Set(),
      ),
    ).toThrow('added column "extra" must be nullable');
  });

  test('permits a locked invalid historical name after a forward repair', () => {
    const tables = new Map<string, ParsedTable>();
    const longName = 'i'.repeat(64);
    applyMigrationSql(
      tables,
      `CREATE TABLE t (id TEXT PRIMARY KEY); CREATE INDEX ${longName} ON t (id)`,
      '0050_locked/up.sql',
    );
    applyMigrationSql(
      tables,
      `DROP INDEX ${longName}; CREATE INDEX t_by_id ON t (id)`,
      '0051_repair/up.sql',
    );
    expect(() => validateFinalSchemaIdentifiers(tables)).not.toThrow();
  });
});

describe('CREATE VIRTUAL TABLE fts5 subset — hard errors', () => {
  const base =
    'CREATE TABLE docs (id TEXT PRIMARY KEY, body TEXT, score INT); ';
  test('requires a known owning content table', () => {
    expectError(
      'CREATE VIRTUAL TABLE docs_fts USING fts5(body, content=docs)',
      /content table "docs" does not exist at this point/,
    );
  });
  test('requires existing string columns', () => {
    expectError(
      `${base}CREATE VIRTUAL TABLE docs_fts USING fts5(nope, content=docs)`,
      /column "nope" does not exist/,
    );
    expectError(
      `${base}CREATE VIRTUAL TABLE docs_fts USING fts5(score, content=docs)`,
      /column "score" must have TEXT\/string type/,
    );
  });
  test('rejects duplicate columns/options and columns after options', () => {
    expectError(
      `${base}CREATE VIRTUAL TABLE docs_fts USING fts5(body, body, content=docs)`,
      /column "body" appears twice/,
    );
    expectError(
      `${base}CREATE VIRTUAL TABLE docs_fts USING fts5(body, tokenize='unicode61', tokenize='unicode61', content=docs)`,
      /tokenize is declared twice/,
    );
    expectError(
      `${base}CREATE VIRTUAL TABLE docs_fts USING fts5(content=docs, body)`,
      /indexed columns must precede FTS5 options/,
    );
  });
  test('rejects passthrough options, modules, and unallowlisted tokenizers', () => {
    expectError(
      `${base}CREATE VIRTUAL TABLE docs_fts USING fts5(body, content=docs, prefix='2 3')`,
      /unsupported FTS5 option "prefix"/,
    );
    expectError(
      `${base}CREATE VIRTUAL TABLE docs_fts USING fts5(body, content=docs, tokenize='custom')`,
      /tokenizer "custom" is not allowlisted/,
    );
    expectError(
      `${base}CREATE VIRTUAL TABLE docs_fts USING rtree(body)`,
      /expected FTS5/,
    );
  });
  test('names are globally unique across tables, indexes, and FTS', () => {
    expectError(
      `${base}CREATE INDEX docs_fts ON docs(body); CREATE VIRTUAL TABLE docs_fts USING fts5(body, content=docs)`,
      /conflicts with an index/,
    );
    expectError(
      `${base}CREATE VIRTUAL TABLE docs_fts USING fts5(body, content=docs); CREATE TABLE docs_fts (id TEXT PRIMARY KEY)`,
      /conflicts with an index or FTS virtual table/,
    );
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
    expectError(
      'DROP INDEX idx',
      /DROP INDEX idx: index does not exist at this point/,
    );
    expectError(
      'CREATE TRIGGER trg AFTER INSERT ON t BEGIN SELECT 1; END',
      /unsupported CREATE statement.*found "TRIGGER"/,
    );
    expectError(
      "INSERT INTO t VALUES ('x')",
      /INSERT data migration is unsupported.*migration SQL is schema-only/,
    );
  });

  test('top-level DML fails before inner punctuation with rollout guidance', () => {
    const cases = [
      {
        kind: 'UPDATE',
        sql: 'UPDATE evidence AS outcome SET state = 1 WHERE outcome.incident_id = source.incident_id',
      },
      {
        kind: 'INSERT',
        sql: 'INSERT INTO evidence (id, state) SELECT source.id, source.state FROM source',
      },
      {
        kind: 'DELETE',
        sql: 'DELETE FROM evidence WHERE evidence.incident_id = source.incident_id',
      },
    ] as const;

    for (const item of cases) {
      let error: unknown;
      try {
        parse(item.sql);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TypegenError);
      const message = (error as TypegenError).message;
      expect(message).toContain(`${item.kind} data migration is unsupported`);
      expect(message).toContain('migration SQL is schema-only');
      expect(message).toContain('nullable expansion');
      expect(message).toContain(
        'versioned server-authoritative Syncular writes',
      );
      expect(message).toContain('retire the old representation');
      expect(message).toContain(
        'https://syncular.dev/guide-schema/#data-changes-and-backfills',
      );
      expect(message).not.toContain('unexpected character');
    }
  });

  test('DROP INDEX removes or replaces one declared index', () => {
    const tables = parse(`
      CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT, b TEXT);
      CREATE UNIQUE INDEX by_value ON t (a);
      DROP INDEX by_value;
      CREATE INDEX by_value ON t (b);
      DROP INDEX IF EXISTS absent;
    `);
    expect(tables.get('t')?.indexes).toEqual([
      { name: 'by_value', columns: ['b'], unique: false },
    ]);
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY); DROP INDEX missing trailing',
      /unsupported trailing SQL "trailing"/,
    );
    expectError(
      'CREATE TABLE t (id TEXT PRIMARY KEY); DROP VIEW nope',
      /unsupported DROP statement.*"VIEW"/,
    );
  });

  test('DROP INDEX on an FTS virtual table names the actual construct', () => {
    expectError(
      `CREATE TABLE docs (id TEXT PRIMARY KEY, body TEXT);
       CREATE VIRTUAL TABLE docs_fts USING fts5(body, content=docs);
       DROP INDEX docs_fts`,
      /DROP INDEX docs_fts: docs_fts is an FTS5 virtual table .*removes an FTS projection together with its owning content table \(DROP TABLE docs\)/,
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
