/** Node runs its adapter through `verify-node.mjs`; Bun runs its adapter here. */
import { expect, test } from 'bun:test';
import { openSqliteDatabase } from '@syncular/client/sqlite';
import { openBunDatabase } from '../src/bun-database';
import type { ClientDatabase } from '../src/database';
import { runAdapterContract } from './node-database/adapter-contract';

test('the automatic SQLite factory selects Bun', () => {
  const factory: (path?: string) => ClientDatabase = openSqliteDatabase;
  expect(typeof factory).toBe('function');
  const database = openSqliteDatabase();
  expect(database).toBeDefined();
  database.close();
});

test('the shared adapter contract passes on bun:sqlite', () => {
  expect(() => runAdapterContract(openBunDatabase)).not.toThrow();
});
