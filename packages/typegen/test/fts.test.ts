/** RFC 0005 IR, generated-schema, and named-query coverage. */
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

describe('RFC 0005 typegen surface', () => {
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
});
