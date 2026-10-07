import { expect, test } from 'bun:test';
import { BunClientDatabase } from '../src/bun-database';
import { runTransaction } from '../src/database';
import { classifySqliteFailure, ClientSyncError } from '../src/errors';

test('SQLITE_BUSY and SQLITE_LOCKED primary and extended codes classify as retryable busy', () => {
  for (const errno of [5, 5 | (1 << 8), 6, 6 | (1 << 8)]) {
    const raw = Object.assign(new Error('database is locked'), {
      name: 'SQLiteError',
      errno,
    });
    const failure = classifySqliteFailure(raw);
    expect(failure.code).toBe('client.storage_busy');
    expect(failure.sqliteCode).toBe(errno);
    expect(failure.error).toBeInstanceOf(ClientSyncError);
    const error = failure.error;
    if (!(error instanceof ClientSyncError))
      throw new Error('expected a classified ClientSyncError');
    expect(error.code).toBe('client.storage_busy');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('local SQLite storage is busy');
    expect(error.details).toMatchObject({ sqliteCode: errno });
  }
  const unrelated = Object.assign(new Error('generic SQLite prose'), {
    name: 'SQLiteError',
    errno: 1,
  });
  const result = classifySqliteFailure(unrelated);
  expect(result.code).toBeUndefined();
  expect(result.error).toBe(unrelated);
});

for (const atCommit of [false, true]) {
  test(`SQLITE_FULL at ${atCommit ? 'commit' : 'step'} survives failed cleanup and a later transaction`, () => {
    const db = new BunClientDatabase();
    const state = { depth: 0 };
    const full = Object.assign(new Error('database or disk is full'), {
      name: 'SQLiteError',
      errno: 13,
    });
    let injected = false;
    const run = (sql: string) => {
      if (atCommit && !injected && sql === 'COMMIT') {
        injected = true;
        db.exec('ROLLBACK'); // SQLite's automatic transaction end.
        throw full;
      }
      db.exec(sql);
    };
    db.exec('CREATE TABLE imported (id INTEGER)');
    try {
      runTransaction(state, run, () => {
        db.exec('INSERT INTO imported VALUES (1)');
        if (!atCommit) {
          try {
            runTransaction(state, run, () => {
              db.exec('ROLLBACK');
              throw full;
            });
          } catch {
            /* The outer transaction must still fail. */
          }
        }
      });
      throw new Error('injected import unexpectedly succeeded');
    } catch (error) {
      expect(error).toBeInstanceOf(ClientSyncError);
      if (!(error instanceof ClientSyncError)) throw error;
      expect(error.code).toBe('client.storage_full');
      expect(error.cause).toBe(full);
      expect(error.details).toMatchObject({
        sqliteCode: 13,
        sqliteMessage: full.message,
        rollbackFailure: { sqliteCode: 1 },
      });
    }
    expect(state.depth).toBe(0);
    runTransaction(state, run, () =>
      db.exec('INSERT INTO imported VALUES (2)'),
    );
    expect(db.query('SELECT id FROM imported')).toEqual([{ id: 2 }]);
    db.close();
  });
}
