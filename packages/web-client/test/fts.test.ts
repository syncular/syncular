/** Built-in FTS5 projections: the source triggers fill external content. */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  type ClientSchema,
  compileClientSchema,
  resetLocalReplica,
  ensureLocalSchema,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { compileLocalProjections } from '@syncular/client/projections';
import { applySqliteSegment } from '../src/apply';

const SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'catalogue_codes',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'release_id', type: 'string', nullable: false },
        { name: 'code', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: ['release:{release_id}'],
      localProjections: [
        {
          name: 'catalogue_codes_fts',
          generation: '1',
          columns: [
            { name: 'code', declaredType: 'string', source: 'code' },
            { name: 'title', declaredType: 'string', source: 'title' },
          ],
          fts: {
            tokenize: 'unicode61 remove_diacritics 2',
            columns: ['code', 'title'],
          },
        },
      ],
    },
  ],
};

const compile = (schema: ClientSchema) =>
  compileClientSchema(schema, compileLocalProjections);

function search(db: BunClientDatabase, query: string): string[] {
  return db
    .query(
      `SELECT c.id FROM catalogue_codes_fts f
       JOIN catalogue_codes c
         ON CAST(c.id AS TEXT) = f._syncular_source_id
       WHERE catalogue_codes_fts MATCH ? ORDER BY c.id`,
      [query],
    )
    .map((row) => String(row.id));
}

/**
 * Raw projection hits WITHOUT the source-table join, so an orphaned entry
 * for a REPLACE-displaced row (a ghost) is visible to the assertion.
 */
function rawFtsHits(db: BunClientDatabase, query: string): string[] {
  return db
    .query(
      `SELECT _syncular_source_id AS sid FROM catalogue_codes_fts
       WHERE catalogue_codes_fts MATCH ? ORDER BY sid`,
      [query],
    )
    .map((row) => String(row.sid));
}

function catalogueImage(
  titles: readonly string[],
  version: number,
): Uint8Array {
  const image = new Database(':memory:');
  try {
    image.exec(`
      CREATE TABLE catalogue_codes (id TEXT PRIMARY KEY, release_id TEXT NOT NULL,
        code TEXT NOT NULL, title TEXT NOT NULL, _syncular_version INTEGER NOT NULL);
      CREATE TABLE _syncular_segment (format INTEGER NOT NULL, "table" TEXT NOT NULL,
        "schemaVersion" INTEGER NOT NULL, "asOfCommitSeq" INTEGER NOT NULL,
        "scopeDigest" TEXT NOT NULL, "rowCount" INTEGER NOT NULL);
    `);
    image
      .query('INSERT INTO _syncular_segment VALUES (1, ?, 1, 7, ?, ?)')
      .run('catalogue_codes', 'digest', titles.length);
    const insert = image.query(
      "INSERT INTO catalogue_codes VALUES (?, 'r1', ?, ?, ?)",
    );
    titles.forEach((title, index) =>
      insert.run(`c${index}`, `A${index}`, title, version),
    );
    return new Uint8Array(image.serialize());
  } finally {
    image.close();
  }
}

describe('built-in FTS5 projections', () => {
  test('an image range applied again keeps every held row findable', async () => {
    const db = new BunClientDatabase();
    try {
      const compiled = compile(SCHEMA);
      ensureLocalSchema(db, compiled);
      const apply = (titles: readonly string[], version: number) =>
        applySqliteSegment(
          db,
          compiled,
          compiled.tables.get('catalogue_codes')!,
          catalogueImage(titles, version),
          {
            table: 'catalogue_codes',
            rowCount: titles.length,
            asOfCommitSeq: 7,
            scopeDigest: 'digest',
          },
          {
            clearFirst: false,
            effective: { release_id: ['r1'] },
            owners: () => [],
          },
        );
      const titles = Array.from({ length: 1500 }, () => 'meniscus');
      await apply(titles, 3);
      expect(search(db, 'meniscus')).toHaveLength(1500);
      // The same versions again, then older ones: no row lands.
      await apply(titles, 3);
      await apply(titles, 2);
      expect(search(db, 'meniscus')).toHaveLength(1500);
      // Newer versions replace every row and its projection entry.
      await apply(
        titles.map(() => 'cartilage'),
        4,
      );
      expect(search(db, 'meniscus')).toEqual([]);
      expect(search(db, 'cartilage')).toHaveLength(1500);
      expect(
        db.query('SELECT count(*) AS n FROM _syncular_fts_catalogue_codes_fts'),
      ).toEqual([{ n: 1500 }]);
    } finally {
      db.close();
    }
  });

  test('the projection stores external content and an open rebuilds it on a count mismatch', () => {
    const db = new BunClientDatabase();
    try {
      const compiled = compile(SCHEMA);
      ensureLocalSchema(db, compiled);
      expect(
        db.query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('catalogue_codes_fts','_syncular_projection_catalogue_codes_fts','_syncular_fts_catalogue_codes_fts') ORDER BY name",
        ),
      ).toEqual([
        { name: '_syncular_fts_catalogue_codes_fts' },
        { name: '_syncular_projection_catalogue_codes_fts' },
        { name: 'catalogue_codes_fts' },
      ]);
      expect(
        String(
          db.query(
            "SELECT sql FROM sqlite_master WHERE name='catalogue_codes_fts'",
          )[0]?.sql,
        ),
      ).toContain("content='_syncular_projection_catalogue_codes_fts'");
      db.exec(
        "INSERT INTO catalogue_codes VALUES ('c1','r1','A01','Cholera',1),('c2','r1','B01','Typhoid',1)",
      );
      expect(
        db.query(
          'SELECT "_syncular_source_id" AS id, code, title FROM _syncular_projection_catalogue_codes_fts ORDER BY id',
        ),
      ).toEqual([
        { id: 'c1', code: 'A01', title: 'Cholera' },
        { id: 'c2', code: 'B01', title: 'Typhoid' },
      ]);
      // Damage: c2 loses its index entry, content row and mapping.
      db.exec('DROP TRIGGER _syncular_project_catalogue_codes_fts_ad');
      db.exec(
        'INSERT INTO catalogue_codes_fts(catalogue_codes_fts,rowid,"_syncular_source_id",code,title) SELECT \'delete\',rowid,"_syncular_source_id",code,title FROM _syncular_projection_catalogue_codes_fts WHERE "_syncular_source_id"=\'c2\'',
      );
      db.exec(
        'DELETE FROM _syncular_projection_catalogue_codes_fts WHERE "_syncular_source_id"=\'c2\'',
      );
      db.exec(
        "DELETE FROM _syncular_fts_catalogue_codes_fts WHERE source_id='c2'",
      );
      expect(search(db, 'typhoid')).toEqual([]);
      ensureLocalSchema(db, compiled);
      expect(search(db, 'typhoid')).toEqual(['c2']);
      expect(search(db, 'cholera')).toEqual(['c1']);
      expect(rawFtsHits(db, 'cholera OR typhoid')).toEqual(['c1', 'c2']);
      db.exec("DELETE FROM catalogue_codes WHERE id='c2'");
      expect(rawFtsHits(db, 'cholera OR typhoid')).toEqual(['c1']);
      const plan = db.db.prepare(
        'EXPLAIN QUERY PLAN SELECT rowid FROM catalogue_codes_fts WHERE rowid = (SELECT id FROM _syncular_fts_catalogue_codes_fts WHERE source_id = ?)',
      );
      const details = JSON.stringify(plan.all('c1'));
      plan.finalize();
      expect(details).toContain('COVERING INDEX');
      expect(details).toContain('INDEX 0:=');
    } finally {
      db.close();
    }
  });

  test('an old contentful FTS replica is dropped and rebuilt once', () => {
    const db = new BunClientDatabase();
    try {
      // The layout releases before 0.102 created for a built-in projection.
      db.exec(
        'CREATE TABLE catalogue_codes(id TEXT PRIMARY KEY, release_id TEXT NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, _sync_version INTEGER NOT NULL DEFAULT 0)',
      );
      db.exec(
        'CREATE VIRTUAL TABLE catalogue_codes_fts USING fts5("_syncular_source_id" UNINDEXED,code,title,tokenize=\'unicode61 remove_diacritics 2\')',
      );
      db.exec(
        'CREATE TABLE _syncular_fts_catalogue_codes_fts(id INTEGER PRIMARY KEY,source_id TEXT NOT NULL UNIQUE)',
      );
      db.exec(
        'CREATE TRIGGER catalogue_codes_fts_ai AFTER INSERT ON catalogue_codes BEGIN INSERT INTO _syncular_fts_catalogue_codes_fts(source_id) VALUES (new.id); INSERT INTO catalogue_codes_fts(rowid,"_syncular_source_id",code,title) VALUES (last_insert_rowid(),new.id,new.code,new.title); END',
      );
      db.exec(
        "INSERT INTO catalogue_codes(id,release_id,code,title) VALUES ('c1','r1','A01','Cholera'),('c2','r1','B01','Typhoid')",
      );
      const compiled = compile(SCHEMA);
      ensureLocalSchema(db, compiled);
      expect(
        db.query(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name NOT LIKE '_syncular_project_%'",
        ),
      ).toEqual([]);
      expect(search(db, 'cholera OR typhoid')).toEqual(['c1', 'c2']);
      expect(
        db.query(
          'SELECT count(*) AS n FROM _syncular_projection_catalogue_codes_fts',
        ),
      ).toEqual([{ n: 2 }]);
      // The second open neither drops nor refills the projection.
      db.exec(
        "CREATE TRIGGER forbid_refill BEFORE INSERT ON _syncular_projection_catalogue_codes_fts BEGIN SELECT RAISE(ABORT,'refilled'); END",
      );
      ensureLocalSchema(db, compiled);
      expect(search(db, 'cholera OR typhoid')).toEqual(['c1', 'c2']);
      db.exec('DROP TRIGGER forbid_refill');
      expect(() =>
        db.transaction(() => {
          db.exec("DELETE FROM catalogue_codes WHERE id='c1'");
          throw new Error('rollback');
        }),
      ).toThrow('rollback');
      expect(search(db, 'cholera')).toEqual(['c1']);
      db.exec("DELETE FROM catalogue_codes WHERE id='c1'");
      expect(search(db, 'cholera')).toEqual([]);
      expect(
        db.query('SELECT source_id FROM _syncular_fts_catalogue_codes_fts'),
      ).toEqual([{ source_id: 'c2' }]);
    } finally {
      db.close();
    }
  });

  test('initial build and insert/update/delete stay transactionally current', () => {
    const db = new BunClientDatabase();
    const compiled = compile(SCHEMA);
    // Simulate content created before a newly-added projection is ensured.
    db.exec(
      `CREATE TABLE catalogue_codes(id TEXT PRIMARY KEY, release_id TEXT NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, _sync_version INTEGER NOT NULL DEFAULT 0)`,
    );
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Cholera')`,
    );
    ensureLocalSchema(db, compiled);
    expect(search(db, 'cholera')).toEqual(['c1']);

    const insertTrigger = db.query(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='_syncular_project_catalogue_codes_fts_ai'",
    )[0]?.sql;
    const replaceGuard = db.query(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='_syncular_project_catalogue_codes_fts_bi'",
    )[0]?.sql;
    expect(String(insertTrigger)).not.toContain('DELETE FROM');
    expect(String(replaceGuard)).toContain('BEFORE INSERT');
    expect(String(replaceGuard)).toContain('WHEN EXISTS');

    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Typhoid fever')`,
    );
    expect(search(db, 'typhoid')).toEqual(['c2']);

    // REPLACE is intentionally covered: the indexed BEFORE INSERT guard owns
    // cleanup without scanning FTS for every clean insert or depending on
    // SQLite firing DELETE triggers for REPLACE.
    db.exec(
      `INSERT OR REPLACE INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Paratyphoid')`,
    );
    expect(search(db, '"typhoid fever"')).toEqual([]);
    expect(search(db, 'paratyphoid')).toEqual(['c2']);

    expect(() =>
      db.exec(
        `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Must fail')`,
      ),
    ).toThrow();
    expect(search(db, 'paratyphoid')).toEqual(['c2']);

    db.exec(
      `UPDATE catalogue_codes SET title='Enteric infection' WHERE id='c2'`,
    );
    expect(search(db, 'paratyphoid')).toEqual([]);
    expect(search(db, 'enteric')).toEqual(['c2']);

    db.exec(`DELETE FROM catalogue_codes WHERE id='c2'`);
    expect(search(db, 'enteric')).toEqual([]);
  });

  test('ensure is idempotent and schema reset recreates a working projection', () => {
    const db = new BunClientDatabase();
    const compiled = compile(SCHEMA);
    ensureLocalSchema(db, compiled);
    db.exec('DROP TRIGGER _syncular_project_catalogue_codes_fts_bi');
    db.exec('DROP TRIGGER _syncular_project_catalogue_codes_fts_ai');
    db.exec(
      `CREATE TRIGGER _syncular_project_catalogue_codes_fts_ai AFTER INSERT ON catalogue_codes BEGIN
        DELETE FROM catalogue_codes_fts WHERE _syncular_source_id = CAST(new.id AS TEXT);
        INSERT INTO catalogue_codes_fts (_syncular_source_id, code, title)
          VALUES (CAST(new.id AS TEXT), new.code, new.title);
      END`,
    );
    ensureLocalSchema(db, compiled);
    expect(
      String(
        db.query(
          "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='_syncular_project_catalogue_codes_fts_ai'",
        )[0]?.sql,
      ),
    ).not.toContain('DELETE FROM');
    expect(
      db.query(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='_syncular_project_catalogue_codes_fts_bi'",
      ),
    ).toHaveLength(1);
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Cholera')`,
    );
    expect(search(db, 'cholera')).toEqual(['c1']);
    db.transaction(() => resetLocalReplica(db, compiled));
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Typhoid')`,
    );
    expect(search(db, 'typhoid')).toEqual(['c2']);
  });

  test('REPLACE displacing a different-PK row via a secondary unique index leaves no ghost hit', () => {
    const schema: ClientSchema = {
      version: 1,
      tables: [
        {
          ...(SCHEMA.tables[0] as NonNullable<(typeof SCHEMA.tables)[0]>),
          indexes: [
            {
              name: 'catalogue_codes_code_unique',
              columns: ['code'],
              unique: true,
            },
          ],
        },
      ],
    };
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compile(schema));
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Cholera')`,
    );
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Typhoid')`,
    );
    // Different PK, same unique `code`: REPLACE displaces c1 without firing
    // a DELETE trigger for it. The BEFORE INSERT guard cleans its FTS entry.
    db.exec(
      `INSERT OR REPLACE INTO catalogue_codes(id, release_id, code, title) VALUES ('c9', 'r1', 'A01', 'Smallpox')`,
    );
    expect(
      db.query(`SELECT id FROM catalogue_codes ORDER BY id`).map((r) => r.id),
    ).toEqual(['c2', 'c9']);
    expect(rawFtsHits(db, 'cholera')).toEqual([]);
    expect(rawFtsHits(db, 'smallpox')).toEqual(['c9']);
    expect(search(db, 'typhoid')).toEqual(['c2']);

    // One REPLACE displacing through BOTH paths at once: pk c2 plus c9's
    // unique code. Both projection entries are cleaned.
    db.exec(
      `INSERT OR REPLACE INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'A01', 'Measles')`,
    );
    expect(
      db.query(`SELECT id FROM catalogue_codes ORDER BY id`).map((r) => r.id),
    ).toEqual(['c2']);
    expect(rawFtsHits(db, 'typhoid')).toEqual([]);
    expect(rawFtsHits(db, 'smallpox')).toEqual([]);
    expect(search(db, 'measles')).toEqual(['c2']);
  });

  test('multi-column unique displacement cleans exactly the displaced row', () => {
    const schema: ClientSchema = {
      version: 1,
      tables: [
        {
          ...(SCHEMA.tables[0] as NonNullable<(typeof SCHEMA.tables)[0]>),
          indexes: [
            {
              name: 'catalogue_codes_release_code_unique',
              columns: ['release_id', 'code'],
              unique: true,
            },
          ],
        },
      ],
    };
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compile(schema));
    // Same code in two releases coexists under the composite unique key.
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Cholera')`,
    );
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r2', 'A01', 'Typhoid')`,
    );
    db.exec(
      `INSERT OR REPLACE INTO catalogue_codes(id, release_id, code, title) VALUES ('c9', 'r1', 'A01', 'Smallpox')`,
    );
    expect(
      db.query(`SELECT id FROM catalogue_codes ORDER BY id`).map((r) => r.id),
    ).toEqual(['c2', 'c9']);
    expect(rawFtsHits(db, 'cholera')).toEqual([]);
    // The r2 row matches only one of the two unique columns and survives.
    expect(search(db, 'typhoid')).toEqual(['c2']);
    expect(search(db, 'smallpox')).toEqual(['c9']);
  });

  test('reopening an upgraded database regenerates the unique-aware guard', () => {
    const schema: ClientSchema = {
      version: 1,
      tables: [
        {
          ...(SCHEMA.tables[0] as NonNullable<(typeof SCHEMA.tables)[0]>),
          indexes: [
            {
              name: 'catalogue_codes_code_unique',
              columns: ['code'],
              unique: true,
            },
          ],
        },
      ],
    };
    const compiled = compile(schema);
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compiled);
    // Simulate a database written by the pk-only guard generation.
    db.exec('DROP TRIGGER _syncular_project_catalogue_codes_fts_bi');
    db.exec(
      `CREATE TRIGGER _syncular_project_catalogue_codes_fts_bi BEFORE INSERT ON catalogue_codes
       WHEN EXISTS (SELECT 1 FROM catalogue_codes WHERE id = new.id) BEGIN
         DELETE FROM catalogue_codes_fts WHERE _syncular_source_id = CAST(new.id AS TEXT);
       END`,
    );
    // Every open re-ensures the schema, which drops and recreates the
    // triggers — the upgraded database picks up the unique-aware guard.
    ensureLocalSchema(db, compiled);
    const guard = String(
      db.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='_syncular_project_catalogue_codes_fts_bi'",
      )[0]?.sql,
    );
    expect(guard).toContain('IN (SELECT');
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Cholera')`,
    );
    db.exec(
      `INSERT OR REPLACE INTO catalogue_codes(id, release_id, code, title) VALUES ('c9', 'r1', 'A01', 'Smallpox')`,
    );
    expect(rawFtsHits(db, 'cholera')).toEqual([]);
    expect(search(db, 'smallpox')).toEqual(['c9']);
  });

  test('UPDATE OR REPLACE displacing a different-PK row leaves no ghost hit', () => {
    const UNIQUE_SCHEMA: ClientSchema = {
      version: 1,
      tables: [
        {
          name: 'catalogue_codes',
          columns: [
            { name: 'id', type: 'string', nullable: false },
            { name: 'release_id', type: 'string', nullable: false },
            { name: 'code', type: 'string', nullable: false },
            { name: 'title', type: 'string', nullable: false },
          ],
          primaryKey: 'id',
          scopes: ['release:{release_id}'],
          indexes: [
            { name: 'catalogue_codes_code', columns: ['code'], unique: true },
          ],
          localProjections: SCHEMA.tables[0]!.localProjections!,
        },
      ],
    };
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compile(UNIQUE_SCHEMA));

    // The migration recreates the BEFORE UPDATE guard for the unique index.
    expect(
      db.query(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='_syncular_project_catalogue_codes_fts_bu'",
      ),
    ).toHaveLength(1);

    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Cholera')`,
    );
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c2', 'r1', 'B01', 'Typhoid fever')`,
    );
    expect(search(db, 'cholera')).toEqual(['c1']);
    expect(search(db, '"typhoid fever"')).toEqual(['c2']);

    // Moving c2's code onto c1's unique 'A01' displaces c1 via the unique
    // index (OR REPLACE deletes c1). c1's projection entry must go with it.
    db.exec(
      `UPDATE OR REPLACE catalogue_codes SET code='A01', title='Merged entry' WHERE id='c2'`,
    );

    expect(db.query('SELECT id FROM catalogue_codes ORDER BY id')).toEqual([
      { id: 'c2' },
    ]);
    // No ghost: c1's old text is no longer searchable.
    expect(search(db, 'cholera')).toEqual([]);
    expect(search(db, '"typhoid fever"')).toEqual([]);
    // c2 reflects its new values exactly once.
    expect(search(db, 'merged')).toEqual(['c2']);
    expect(search(db, 'A01')).toEqual(['c2']);
    // The projection has exactly one row (no orphaned c1 entry).
    expect(
      db.query(
        'SELECT COUNT(*) AS n FROM _syncular_projection_catalogue_codes_fts',
      )[0]?.n,
    ).toBe(1);
  });

  test('clean bulk inserts do not scan the growing FTS projection', () => {
    // The scanning control arm is O(rows^2) by construction; 1,500 rows keeps
    // it near two seconds (a decisive >3x margin over the linear clean arm)
    // while staying well under the harness deadline.
    const rows = 1_500;
    const bulkInsertMs = (db: BunClientDatabase): number => {
      const insert = db.db.query(
        'INSERT INTO catalogue_codes(id, release_id, code, title) VALUES (?, ?, ?, ?)',
      );
      const startedAt = performance.now();
      db.transaction(() => {
        for (let index = 0; index < rows; index += 1) {
          insert.run(
            `c${index}`,
            'r1',
            `C${String(index).padStart(5, '0')}`,
            `Synthetic title ${index}`,
          );
        }
      });
      return performance.now() - startedAt;
    };

    const clean = new BunClientDatabase();
    ensureLocalSchema(clean, compile(SCHEMA));
    const cleanMs = bulkInsertMs(clean);
    expect(search(clean, '"synthetic" "1499"')).toEqual(['c1499']);

    // Comparative bound: an insert trigger that looks up the source id in
    // the FTS table scans the whole projection per row. The clean triggers must stay decisively
    // faster than that hazard on the same machine — a wall-clock cap here
    // would flake on loaded CI.
    const scanning = new BunClientDatabase();
    ensureLocalSchema(scanning, compile(SCHEMA));
    scanning.exec('DROP TRIGGER _syncular_project_catalogue_codes_fts_ai');
    scanning.exec(
      `CREATE TRIGGER _syncular_project_catalogue_codes_fts_ai AFTER INSERT ON catalogue_codes BEGIN
        SELECT count(*) FROM catalogue_codes_fts WHERE _syncular_source_id = CAST(new.id AS TEXT);
        INSERT INTO _syncular_fts_catalogue_codes_fts(source_id) VALUES (CAST(new.id AS TEXT));
        INSERT INTO _syncular_projection_catalogue_codes_fts(rowid, _syncular_source_id, code, title)
          VALUES (last_insert_rowid(), CAST(new.id AS TEXT), new.code, new.title);
        INSERT INTO catalogue_codes_fts(rowid, _syncular_source_id, code, title)
          VALUES (last_insert_rowid(), CAST(new.id AS TEXT), new.code, new.title);
      END`,
    );
    const scanningMs = bulkInsertMs(scanning);
    expect(cleanMs * 3).toBeLessThan(scanningMs);
  }, 20_000);

  test('encrypted declared-string columns feed only the local plaintext projection', () => {
    const table = SCHEMA.tables[0];
    if (table === undefined) throw new Error('fixture table missing');
    const encrypted: ClientSchema = {
      version: 1,
      tables: [
        {
          ...table,
          columns: table.columns.map((column) =>
            column.name === 'title'
              ? {
                  ...column,
                  type: 'bytes' as const,
                  encrypted: true,
                  declaredType: 'string' as const,
                }
              : column,
          ),
        },
      ],
    };
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compile(encrypted));
    db.exec(
      `INSERT INTO catalogue_codes(id, release_id, code, title) VALUES ('c1', 'r1', 'A01', 'Encrypted local identity')`,
    );
    expect(search(db, 'identity')).toEqual(['c1']);
  });

  test('a schema that still carries ftsIndexes is refused', () => {
    const legacy = { ...SCHEMA.tables[0]!, ftsIndexes: [] };
    expect(() => compile({ version: 1, tables: [legacy] })).toThrow(
      'declares ftsIndexes; regenerate the schema',
    );
  });

  test('compile fails loudly for unsafe or unsupported definitions', () => {
    const table = SCHEMA.tables[0];
    if (table === undefined) throw new Error('fixture table missing');
    const projection = table.localProjections![0]!;
    const withProjection = (
      changes: Partial<NonNullable<typeof table.localProjections>[number]>,
    ) =>
      compile({
        version: 1,
        tables: [
          { ...table, localProjections: [{ ...projection, ...changes }] },
        ],
      });
    const invalid = (column?: string) =>
      expect.objectContaining({
        code: 'client.schema_invalid',
        details: {
          name: 'catalogue_codes_fts',
          ...(column === undefined ? {} : { column }),
        },
      });
    // A mix of sourced and app-filled columns.
    expect(() =>
      withProjection({
        columns: [
          { name: 'code', declaredType: 'string', source: 'code' },
          { name: 'title', declaredType: 'string' },
        ],
      }),
    ).toThrow(invalid('title'));
    const { fts: _, ...unindexed } = projection;
    expect(() =>
      compile({
        version: 1,
        tables: [{ ...table, localProjections: [unindexed] }],
      }),
    ).toThrow(invalid());
    expect(() =>
      withProjection({
        dependencies: [
          { table: 'catalogue_codes', column: 'id', sourceColumn: 'id' },
        ],
      }),
    ).toThrow(invalid());
    expect(() =>
      withProjection({
        columns: [{ name: 'code', declaredType: 'string', source: 'nope' }],
        fts: { tokenize: 'unicode61', columns: ['code'] },
      }),
    ).toThrow(invalid('code'));
    expect(() =>
      compile({
        version: 1,
        tables: [
          {
            ...table,
            columns: [
              ...table.columns,
              { name: 'rank_value', type: 'integer', nullable: true },
            ],
            localProjections: [
              {
                ...projection,
                columns: [
                  {
                    name: 'code',
                    declaredType: 'string',
                    source: 'rank_value',
                  },
                ],
                fts: { tokenize: 'unicode61', columns: ['code'] },
              },
            ],
          },
        ],
      }),
    ).toThrow(invalid('code'));
    expect(() =>
      withProjection({ fts: { tokenize: 'custom', columns: ['title'] } }),
    ).toThrow(invalid());
    expect(() => compileClientSchema(SCHEMA)).toThrow(
      expect.objectContaining({
        code: 'client.schema_invalid',
        details: { reason: 'projections_unavailable' },
      }),
    );
  });

  test('the app-filled operations refuse a built-in projection', () => {
    const db = new BunClientDatabase();
    try {
      const compiled = compile(SCHEMA);
      ensureLocalSchema(db, compiled);
      const store = compiled.projections!;
      const refused = expect.objectContaining({
        code: 'client.projection_invalid',
        details: { name: 'catalogue_codes_fts' },
      });
      expect(() => store.pending(db, 'catalogue_codes_fts', 1)).toThrow(
        refused,
      );
      expect(() => store.write(db, 'catalogue_codes_fts', 0, [])).toThrow(
        refused,
      );
      expect(() => store.invalidate(db, 'catalogue_codes_fts')).toThrow(
        refused,
      );
    } finally {
      db.close();
    }
  });
});
