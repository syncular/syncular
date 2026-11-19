import { expect, test } from 'bun:test';
import { BunClientDatabase } from '@syncular/client/bun';
import type { RowValue } from '@syncular/core';
import { applyRowsSegment } from '../src/apply';
import { drive } from './helpers';
import type { SqlValue } from '../src/database';
import { compileClientSchema, ensureLocalSchema } from '../src/schema';

/** Records the base and version of every retained-base write, and counts
 * every statement that writes the retained-rows journal. */
class JournalRecordingDatabase extends BunClientDatabase {
  readonly baseWrites: SqlValue[][] = [];
  journalWrites = 0;

  override exec(sql: string, params: readonly SqlValue[] = []): void {
    if (sql.startsWith('UPDATE _syncular_failed_rows SET base='))
      this.baseWrites.push(params.slice(0, 2));
    if (sql.includes('_syncular_failed_rows')) this.journalWrites += 1;
    super.exec(sql, params);
  }
}

const schema = compileClientSchema({
  version: 1,
  tables: [
    {
      name: 'items',
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'code', type: 'string', nullable: false },
      ],
      indexes: [],
    },
    {
      name: 'coded',
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'code', type: 'string', nullable: false },
      ],
      indexes: [
        { name: 'coded_code', columns: ['project_id', 'code'], unique: true },
      ],
    },
  ],
});

function setup(): JournalRecordingDatabase {
  const db = new JournalRecordingDatabase();
  ensureLocalSchema(db, schema);
  return db;
}

function retain(
  db: JournalRecordingDatabase,
  table: string,
  id: string,
  code: string,
): void {
  db.exec(
    `INSERT INTO _syncular_failed_rows(commit_id,idx,tbl,id,at,op,intent,base,version)VALUES(?,0,?,?,0,'{}',?,NULL,NULL)`,
    [`failed-${id}`, table, id, JSON.stringify({ id, project_id: 'p1', code })],
  );
}

async function apply(
  db: JournalRecordingDatabase,
  table: string,
  rows: readonly (readonly RowValue[])[],
  version = 3,
): Promise<void> {
  db.baseWrites.length = 0;
  db.journalWrites = 0;
  const compiled = schema.tables.get(table)!;
  await drive(
    applyRowsSegment(
      db,
      schema,
      compiled,
      {
        table,
        schemaVersion: 1,
        columns: compiled.columns,
        blocks: [rows.map((values) => ({ serverVersion: version, values }))],
      },
      {
        clearFirst: false,
        effective: { project_id: ['p1'] },
        owners: () => [],
      },
    ),
  );
}

const rows = [
  ['a', 'p1', 'A'],
  ['b', 'p1', 'B'],
  ['c', 'p1', 'C'],
] as const;

test('a rows block writes the base of its retained row only', async () => {
  const db = setup();
  retain(db, 'items', 'b', 'local');
  await apply(db, 'items', rows);
  expect(db.baseWrites).toEqual([
    [JSON.stringify({ id: 'b', project_id: 'p1', code: 'B' }), 3],
  ]);
  expect(
    db.query('SELECT base,version FROM _syncular_failed_rows WHERE id=?', [
      'b',
    ]),
  ).toEqual([
    {
      base: JSON.stringify({ id: 'b', project_id: 'p1', code: 'B' }),
      version: 3,
    },
  ]);
  db.close();
});

test('a rows block without retained rows writes nothing to the journal', async () => {
  const db = setup();
  await apply(db, 'items', rows);
  expect(db.baseWrites).toEqual([]);
  expect(db.journalWrites).toBe(0);
  expect(db.query('SELECT count(*) AS n FROM items')).toEqual([{ n: 3 }]);
  db.close();
});

test('a unique collision with a row that has no retained row is recorded without a base write', async () => {
  const db = setup();
  retain(db, 'coded', 'local-1', 'B');
  await apply(db, 'coded', rows);
  // The block refreshes the retained intent's conflicts once.
  expect(db.baseWrites).toEqual([]);
  expect(db.journalWrites).toBe(1);
  expect(
    JSON.parse(
      String(
        db.query(
          'SELECT unique_conflicts FROM _syncular_failed_rows WHERE id=?',
          ['local-1'],
        )[0]!.unique_conflicts,
      ),
    ),
  ).toEqual([
    {
      index: 'coded_code',
      columns: ['project_id', 'code'],
      rowId: 'b',
      serverRow: { id: 'b', project_id: 'p1', code: 'B' },
      serverVersion: 3,
    },
  ]);
  // The next block moves the key off the intent: the conflict clears.
  await apply(db, 'coded', [['b', 'p1', 'B2']], 4);
  expect(
    db.query('SELECT unique_conflicts FROM _syncular_failed_rows WHERE id=?', [
      'local-1',
    ]),
  ).toEqual([{ unique_conflicts: null }]);
  db.close();
});
