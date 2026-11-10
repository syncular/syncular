import { expect, test } from 'bun:test';
import { openWasmDatabase } from '../src/wasm-database';

test('repeated statements bind fresh parameters and return fresh rows', async () => {
  const db = await openWasmDatabase();
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  for (let i = 1; i <= 3; i++) {
    db.exec('INSERT INTO t(id,v) VALUES(?,?)', [i, `v${i}`]);
  }
  for (let i = 1; i <= 3; i++) {
    expect(db.query('SELECT v FROM t WHERE id=?', [i])).toEqual([
      { v: `v${i}` },
    ]);
  }
  expect(db.query('SELECT COUNT(*) AS n FROM t')).toEqual([{ n: 3 }]);
  db.close();
});

test('a failed statement leaves its cached statement reusable', async () => {
  const db = await openWasmDatabase();
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  const insert = 'INSERT INTO t(id,v) VALUES(?,?)';
  expect(() => db.exec(insert, [1, null])).toThrow();
  db.exec(insert, [1, 'ok']);
  expect(db.query('SELECT v FROM t')).toEqual([{ v: 'ok' }]);
  db.close();
});

test('SQL without parameters may hold several statements', async () => {
  const db = await openWasmDatabase();
  db.exec('CREATE TABLE a(x); CREATE TABLE b(y); INSERT INTO b VALUES(2);');
  expect(db.query('SELECT y FROM b')).toEqual([{ y: 2 }]);
  expect(db.query('SELECT name FROM sqlite_master ORDER BY name')).toEqual([
    { name: 'a' },
    { name: 'b' },
  ]);
  db.close();
});

test('statements beyond the cache bound still run and re-prepare', async () => {
  const db = await openWasmDatabase();
  for (let i = 0; i < 300; i++) {
    expect(db.query(`SELECT ${i} AS n WHERE ?`, [1])).toEqual([{ n: i }]);
  }
  expect(db.query('SELECT 0 AS n WHERE ?', [1])).toEqual([{ n: 0 }]);
  db.close();
});
