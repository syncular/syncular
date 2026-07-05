/**
 * §5.11 typegen: `encryptedColumns` flips the wire type to `bytes` and
 * records `encrypted` + `declaredType` in the IR; the hard generate-time
 * errors (encrypted scope/crdt/pk/unknown column) fire.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildIr,
  type Manifest,
  type MigrationInput,
  parseManifest,
  TypegenError,
} from '../src';

const MIGRATIONS: MigrationInput[] = [
  {
    name: '0001_initial',
    sql: `CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      body TEXT NOT NULL,
      amount INTEGER,
      doc CRDT
    )`,
  },
];

function manifest(encryptedColumns: string[]): Manifest {
  return parseManifest({
    manifestVersion: 1,
    schemaVersions: [{ version: 1, through: '0001_initial' }],
    tables: [
      {
        name: 'notes',
        scopes: ['project:{project_id}'],
        encryptedColumns,
      },
    ],
  });
}

function expectFail(fn: () => unknown, pattern: RegExp): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TypegenError);
  expect((error as TypegenError).message).toMatch(pattern);
}

describe('§5.11 encryptedColumns → IR', () => {
  test('flips wire type to bytes, records encrypted + declaredType', () => {
    const ir = buildIr(manifest(['body', 'amount']), MIGRATIONS);
    const notes = ir.tables.find((t) => t.name === 'notes');
    const body = notes?.columns.find((c) => c.name === 'body');
    const amount = notes?.columns.find((c) => c.name === 'amount');
    expect(body?.type).toBe('bytes');
    expect(body?.encrypted).toBe(true);
    expect(body?.declaredType).toBe('string');
    expect(amount?.type).toBe('bytes');
    expect(amount?.encrypted).toBe(true);
    expect(amount?.declaredType).toBe('integer');
    // a non-encrypted column is untouched
    const project = notes?.columns.find((c) => c.name === 'project_id');
    expect(project?.type).toBe('string');
    expect(project?.encrypted).toBeUndefined();
  });

  test('no encryptedColumns ⇒ byte-identical IR (no metadata)', () => {
    const ir = buildIr(manifest([]), MIGRATIONS);
    const body = ir.tables[0]?.columns.find((c) => c.name === 'body');
    expect(body?.type).toBe('string');
    expect(body?.encrypted).toBeUndefined();
    expect(body?.declaredType).toBeUndefined();
  });

  test('hard error: unknown column', () => {
    expectFail(
      () => buildIr(manifest(['nope']), MIGRATIONS),
      /encryptedColumns names unknown column "nope"/,
    );
  });

  test('hard error: encrypted primary key', () => {
    expectFail(
      () => buildIr(manifest(['id']), MIGRATIONS),
      /primary key "id" cannot be encrypted/,
    );
  });

  test('hard error: encrypted scope column', () => {
    expectFail(
      () => buildIr(manifest(['project_id']), MIGRATIONS),
      /scope column "project_id" cannot be encrypted/,
    );
  });

  test('hard error: encrypted crdt column', () => {
    expectFail(
      () => buildIr(manifest(['doc']), MIGRATIONS),
      /crdt column "doc" cannot be encrypted/,
    );
  });
});
