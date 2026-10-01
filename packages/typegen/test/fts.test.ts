/** FTS5 IR, generated-schema, and named-query coverage. */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  analyzeQuery,
  emitDartModule,
  emitKotlinModule,
  emitModule,
  emitSwiftModule,
  type IrDocument,
  makeQueryDb,
  serializeIr,
  synthesizeDdl,
} from '../src';

const IR: IrDocument = {
  irVersion: 1,
  schemaVersion: 1,
  schemaVersions: [{ version: 1, migrations: ['0001'] }],
  tables: [
    {
      name: 'catalogue_codes',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'release_id', type: 'string', nullable: false },
        { name: 'code', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ],
      scopes: [
        {
          pattern: 'release:{release_id}',
          variable: 'release_id',
          column: 'release_id',
        },
      ],
      references: [],
      indexes: [],
      ftsIndexes: [
        {
          name: 'catalogue_codes_fts',
          columns: ['code', 'title'],
          tokenize: 'unicode61 remove_diacritics 2',
        },
      ],
      extensions: {},
    },
  ],
  subscriptions: [],
  extensions: {},
};

describe('FTS5 typegen surface', () => {
  test('neutral IR and all generated client languages carry ftsIndexes', () => {
    expect(serializeIr(IR)).toContain('"ftsIndexes"');
    const outputs = [
      emitModule(IR, 'hash'),
      emitSwiftModule(IR, 'hash', 'CatalogueSchema'),
      emitKotlinModule(IR, 'hash', 'dev.syncular.catalogue', 'CatalogueSchema'),
      emitDartModule(IR, 'hash'),
    ];
    for (const output of outputs) {
      expect(output).toContain('ftsIndexes');
      expect(output).toContain('catalogue_codes_fts');
      expect(output).toContain('unicode61 remove_diacritics 2');
    }
  });

  test('prepare-time DDL models the private stable source identity', () => {
    const ddl = synthesizeDdl(IR);
    expect(ddl).toContain('_syncular_source_id UNINDEXED');
    expect(ddl).toContain(
      'CREATE TABLE _syncular_fts_catalogue_codes_fts (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL UNIQUE);',
    );
    expect(ddl).not.toContain("content='catalogue_codes'");
  });

  test('MATCH is typed string and invalidates through the owning synced table', () => {
    const { db, close } = makeQueryDb(IR);
    try {
      const query = analyzeQuery(
        'search-catalogue.sql',
        `SELECT c.id, c.code, c.title, bm25(catalogue_codes_fts) AS rank
         FROM catalogue_codes_fts
         JOIN catalogue_codes c ON c.id = catalogue_codes_fts._syncular_source_id
         WHERE catalogue_codes_fts MATCH :query
           AND c.release_id = :releaseId
         ORDER BY rank, c.code
         LIMIT 25`,
        IR,
        db,
      );
      expect(query.params).toEqual([
        {
          name: 'query',
          langName: 'query',
          type: 'string',
          source: 'inferred',
        },
        {
          name: 'releaseId',
          langName: 'releaseId',
          type: 'string',
          source: 'inferred',
        },
      ]);
      expect(query.tables).toEqual(['catalogue_codes']);
      expect(query.reactive.dependencies).toEqual([
        {
          table: 'catalogue_codes',
          scopes: [
            {
              table: 'catalogue_codes',
              variable: 'release_id',
              pattern: 'release:{release_id}',
              params: ['releaseId'],
            },
          ],
        },
      ]);
    } finally {
      close();
    }
  });

  const SEARCH = `SELECT catalogue_codes_fts._syncular_source_id, c.id, c.code,
      bm25(catalogue_codes_fts) AS rank
    FROM catalogue_codes_fts
    JOIN catalogue_codes c ON c.id = catalogue_codes_fts._syncular_source_id
    WHERE catalogue_codes_fts MATCH :query AND c.release_id = :releaseId
    ORDER BY rank, catalogue_codes_fts._syncular_source_id, c.id
    LIMIT 25`;

  /** Bytecode reads of the projection's `_syncular_source_id` (column 0): each
   * one makes FTS5 fetch the hit's content row. */
  const sourceIdReads = (sqlite: Database, sql: string): number => {
    const program = sqlite.query(`EXPLAIN ${sql}`).all() as {
      opcode: string;
      p1: number;
      p2: number;
    }[];
    const cursors = new Set(
      program.filter((op) => op.opcode === 'VOpen').map((op) => op.p1),
    );
    return program.filter(
      (op) => op.opcode === 'VColumn' && cursors.has(op.p1) && op.p2 === 0,
    ).length;
  };

  const seeded = (): Database => {
    const sqlite = new Database(':memory:');
    sqlite.run(synthesizeDdl(IR));
    for (let index = 0; index < 120; index += 1) {
      const n = (index * 37) % 120;
      const id = `code-${String(n).padStart(3, '0')}`;
      const title = `fracture ${n % 3 === 0 ? 'of the femur' : 'left'}`;
      sqlite.run(
        'INSERT INTO catalogue_codes (id, release_id, code, title) VALUES (?, ?, ?, ?)',
        [id, n % 4 === 0 ? 'r2' : 'r1', `S${n}`, title],
      );
      sqlite.run(
        'INSERT INTO _syncular_fts_catalogue_codes_fts (source_id) VALUES (?)',
        [id],
      );
      sqlite.run(
        'INSERT INTO catalogue_codes_fts (rowid, _syncular_source_id, code, title) VALUES ((SELECT id FROM _syncular_fts_catalogue_codes_fts WHERE source_id = ?), ?, ?, ?)',
        [id, id, `S${n}`, title],
      );
    }
    return sqlite;
  };

  test('emitted SQL reads the source id through the mapping table on the rowid', () => {
    const { db, close } = makeQueryDb(IR);
    const sqlite = seeded();
    try {
      const query = analyzeQuery('search.sql', SEARCH, IR, db);
      expect(query.sourceSql).toBe(SEARCH);
      expect(query.sql).toContain(
        'JOIN (SELECT id AS __syql_fts_rowid_1, source_id AS __syql_fts_source_1 FROM _syncular_fts_catalogue_codes_fts) AS __syql_fts_1 ON __syql_fts_1.__syql_fts_rowid_1 = catalogue_codes_fts.rowid',
      );
      expect(query.sql).not.toContain('._syncular_source_id');
      // The bare projected reference keeps its result name.
      expect(query.columns.map((column) => column.name)).toEqual([
        '_syncular_source_id',
        'id',
        'code',
        'rank',
      ]);
      expect(query.columns[0]).toMatchObject({
        type: 'string',
        nullable: false,
        fidelity: 'exact',
      });
      // Relation plans keep the authored relations only.
      expect(query.relations.map((relation) => relation.table)).toEqual([
        'catalogue_codes_fts',
        'catalogue_codes',
      ]);
      const authored = SEARCH.replaceAll(':query', "'fracture'").replaceAll(
        ':releaseId',
        "'r1'",
      );
      const emitted = query.sql
        .replaceAll(':query', "'fracture'")
        .replaceAll(':releaseId', "'r1'");
      expect(sourceIdReads(sqlite, authored)).toBeGreaterThan(0);
      expect(sourceIdReads(sqlite, emitted)).toBe(0);
      // Camel naming renames the result keys; values and order are identical.
      const values = (sql: string) =>
        (sqlite.query(sql).all() as Record<string, unknown>[]).map((row) =>
          Object.values(row),
        );
      const rows = values(emitted);
      expect(rows).toHaveLength(25);
      expect(rows).toEqual(values(authored));
      const plan = sqlite
        .query(`EXPLAIN QUERY PLAN ${emitted}`)
        .all()
        .map((row) => (row as { detail: string }).detail);
      expect(plan).toContain(
        'SEARCH _syncular_fts_catalogue_codes_fts USING INTEGER PRIMARY KEY (rowid=?)',
      );
    } finally {
      sqlite.close();
      close();
    }
  });

  test('lowers FTS relations on either side of an inner join and in a CTE', () => {
    const { db, close } = makeQueryDb(IR);
    const sqlite = seeded();
    try {
      for (const sql of [
        `SELECT c.id, catalogue_codes_fts._syncular_source_id AS hit
          FROM catalogue_codes c
          JOIN catalogue_codes_fts
            ON catalogue_codes_fts._syncular_source_id = c.id
              AND (c.code = 'S3' OR c.release_id = 'r1')
          WHERE catalogue_codes_fts MATCH 'femur'
          ORDER BY c.id`,
        `SELECT _syncular_source_id FROM catalogue_codes_fts
          WHERE catalogue_codes_fts MATCH 'femur'
          ORDER BY _syncular_source_id`,
        `WITH hits AS MATERIALIZED (
          SELECT catalogue_codes_fts._syncular_source_id,
            bm25(catalogue_codes_fts) AS score
          FROM catalogue_codes_fts WHERE catalogue_codes_fts MATCH 'fracture')
        SELECT hits._syncular_source_id, c.code FROM hits
        CROSS JOIN catalogue_codes c ON c.id = hits._syncular_source_id
        ORDER BY hits.score, hits._syncular_source_id, c.id LIMIT 10`,
      ]) {
        const query = analyzeQuery('lowered.sql', sql, IR, db, {
          naming: 'preserve',
          targets: ['ts'],
          backend: 'auto',
        });
        expect(sourceIdReads(sqlite, sql)).toBeGreaterThan(0);
        expect(sourceIdReads(sqlite, query.sql)).toBe(0);
        expect(sqlite.query(query.sql).all()).toEqual(sqlite.query(sql).all());
      }
      // A null-extended FTS relation keeps reading the projection.
      const outer = `SELECT c.id, catalogue_codes_fts._syncular_source_id AS hit
        FROM catalogue_codes c
        LEFT JOIN catalogue_codes_fts
          ON catalogue_codes_fts._syncular_source_id = c.id
        ORDER BY c.id`;
      expect(analyzeQuery('outer.sql', outer, IR, db).sql).not.toContain(
        '_syncular_fts_',
      );
    } finally {
      sqlite.close();
      close();
    }
  });

  test('the mapping table is not a queryable relation', () => {
    const { db, close } = makeQueryDb(IR);
    try {
      expect(() =>
        analyzeQuery(
          'mapping.sql',
          'SELECT m.source_id FROM _syncular_fts_catalogue_codes_fts m JOIN catalogue_codes c ON c.id = m.source_id',
          IR,
          db,
        ),
      ).toThrow('unresolved table relation');
    } finally {
      close();
    }
  });
});
