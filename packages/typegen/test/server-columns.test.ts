/**
 * §6.7 typegen: `serverColumns` marks columns `serverOwned` in the IR and in
 * every emitter's embedded schema; the generate-time refusals fire; the TS
 * insert and update shapes omit the column while the row shape keeps it.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildIr,
  emitDartModule,
  emitKotlinModule,
  emitModule,
  emitSwiftModule,
  irHash,
  type Manifest,
  type MigrationInput,
  parseManifest,
  serializeIr,
  serializeSchema,
  TypegenError,
} from '../src';

const MIGRATIONS: MigrationInput[] = [
  {
    name: '0001_initial',
    sql: `CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      body TEXT NOT NULL,
      stamped_at INTEGER,
      doc CRDT,
      secret TEXT
    )`,
  },
];

function manifest(
  serverColumns: unknown,
  encryptedColumns: string[] = [],
): Manifest {
  return parseManifest({
    manifestVersion: 1,
    schemaVersions: [{ version: 1, through: '0001_initial' }],
    tables: [
      {
        name: 'notes',
        scopes: ['project:{project_id}'],
        serverColumns,
        encryptedColumns,
      },
    ],
  });
}

function failure(fn: () => unknown): TypegenError {
  try {
    fn();
  } catch (caught) {
    expect(caught).toBeInstanceOf(TypegenError);
    return caught as TypegenError;
  }
  throw new Error('expected a TypegenError');
}

describe('§6.7 serverColumns', () => {
  test('marks the column serverOwned in the IR and nothing else', () => {
    const ir = buildIr(manifest(['stamped_at']), MIGRATIONS);
    const columns = ir.tables[0]?.columns ?? [];
    expect(columns.find((c) => c.name === 'stamped_at')?.serverOwned).toBe(
      true,
    );
    expect(columns.filter((c) => c.serverOwned !== undefined)).toHaveLength(1);
    expect(serializeIr(ir)).toContain('"serverOwned": true');
  });

  test('no serverColumns leaves the IR byte-identical', () => {
    const ir = buildIr(manifest(undefined), MIGRATIONS);
    expect(serializeIr(ir)).not.toContain('serverOwned');
    expect(serializeSchema(ir)).not.toContain('serverOwned');
  });

  test('every emitter embeds the marker', () => {
    const ir = buildIr(manifest(['stamped_at']), MIGRATIONS);
    const hash = irHash(serializeIr(ir));
    expect(serializeSchema(ir)).toContain('"serverOwned": true');
    expect(emitModule(ir, hash)).toContain('"serverOwned": true');
    expect(emitKotlinModule(ir, hash, 'app.generated', 'Schema')).toContain(
      'serverOwned',
    );
    expect(emitSwiftModule(ir, hash, 'Schema')).toContain('serverOwned');
    expect(emitDartModule(ir, hash)).toContain('serverOwned');
  });

  test('the row type keeps the column; insert and update omit it', () => {
    const ir = buildIr(manifest(['stamped_at']), MIGRATIONS);
    const module = emitModule(ir, irHash(serializeIr(ir)));
    const block = (name: string): string => {
      const start = module.indexOf(`export interface ${name} {`);
      return module.slice(start, module.indexOf('\n}', start));
    };
    expect(block('NotesRow')).toContain('stampedAt: number | null;');
    expect(block('NotesInsert')).not.toContain('stampedAt');
    expect(block('NotesUpdate')).not.toContain('stampedAt');
    expect(block('NotesInsert')).toContain('body: string;');
  });

  test('refusals carry stable codes and structured details', () => {
    const cases: [unknown, string[], string][] = [
      [['nope'], [], 'typegen.server_column_unknown'],
      [['id'], [], 'typegen.server_column_primary_key'],
      [['body'], [], 'typegen.server_column_not_null'],
      [['project_id'], [], 'typegen.server_column_not_null'],
      [['doc'], [], 'typegen.server_column_crdt'],
      [['secret'], ['secret'], 'typegen.server_column_encrypted'],
    ];
    for (const [columns, encrypted, code] of cases) {
      const error = failure(() =>
        buildIr(manifest(columns, encrypted), MIGRATIONS),
      );
      expect(error.code).toBe(code);
      expect(error.details).toEqual({
        table: 'notes',
        column: (columns as string[])[0],
      });
    }
  });

  test('manifest validation: array of strings, no duplicates', () => {
    expect(failure(() => manifest('stamped_at')).message).toMatch(
      /serverColumns must be an array/,
    );
    expect(failure(() => manifest([1])).message).toMatch(/serverColumns\[0\]/);
    expect(failure(() => manifest(['a', 'a'])).message).toMatch(
      /duplicate serverColumns entry "a"/,
    );
  });
});
