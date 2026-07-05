/**
 * Runtime-agnostic behavioral contract for a `ClientDatabase` implementation.
 * Deliberately framework-free (plain assertions, no `bun:test`) so the SAME
 * checks run two ways:
 *
 *  - under bun, against the bun:sqlite adapter, from `node-database.test.ts`
 *    (proves the contract itself is correct and that the Node adapter is
 *    asked to satisfy exactly what the reference backend already does), and
 *  - under real Node, against the better-sqlite3 adapter, from
 *    `verify-node.mjs` (proves the Node adapter — which bun cannot dlopen,
 *    oven-sh/bun#4290 — mirrors bun semantics on the real native module).
 *
 * `runAdapterContract` throws on the first mismatch; a clean return is a pass.
 * `node:` builtins import identically under bun and Node ESM.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientDatabase, SqlValue } from '../../src/database';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`adapter-contract: ${message}`);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${message} — expected ${e}, got ${a}`);
}

/** Exercise every branch of the ClientDatabase surface. */
export function runAdapterContract(
  open: (path?: string) => ClientDatabase,
): void {
  const db = open();

  // --- exec / query round-trip, params, and result shape ---
  db.exec(
    'CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, f REAL, b BLOB, flag INTEGER)',
  );
  db.exec('INSERT INTO t (id, n, f, b, flag) VALUES (?, ?, ?, ?, ?)', [
    'a',
    42,
    1.5,
    new Uint8Array([1, 2, 3]),
    // booleans MUST be accepted and coerced to 0/1 (bun-adapter parity).
    true as unknown as SqlValue,
  ]);
  db.exec('INSERT INTO t (id, n, f, b, flag) VALUES (?, ?, ?, ?, ?)', [
    'z',
    null,
    null,
    null,
    false as unknown as SqlValue,
  ]);

  const rows = db.query('SELECT * FROM t ORDER BY id');
  eq(rows.length, 2, 'row count');
  eq(rows[0]?.id, 'a', 'text column');
  eq(rows[0]?.n, 42, 'integer column');
  eq(rows[0]?.f, 1.5, 'real column');
  eq(rows[0]?.flag, 1, 'boolean true coerced to 1');
  eq(rows[1]?.flag, 0, 'boolean false coerced to 0');

  // NULLs come back as JS null (not undefined).
  assert(rows[1]?.n === null, 'null integer is JS null');
  assert(rows[1]?.b === null, 'null blob is JS null');

  // BLOB comes back as a plain Uint8Array (not a Node Buffer pool view).
  const blob = rows[0]?.b;
  assert(blob instanceof Uint8Array, 'blob is a Uint8Array');
  assert(
    blob.constructor === Uint8Array,
    'blob is a plain Uint8Array, not a Buffer subclass',
  );
  eq([...blob], [1, 2, 3], 'blob bytes preserved');

  // Parameterized query.
  const one = db.query('SELECT id FROM t WHERE id = ?', ['a']);
  eq(one.length, 1, 'parameterized filter');

  // --- transaction: commit path ---
  db.transaction(() => {
    db.exec('INSERT INTO t (id) VALUES (?)', ['tx1']);
  });
  eq(db.query("SELECT id FROM t WHERE id = 'tx1'").length, 1, 'tx commit');

  // --- transaction: rollback on throw ---
  let threw = false;
  try {
    db.transaction(() => {
      db.exec('INSERT INTO t (id) VALUES (?)', ['tx2']);
      throw new Error('boom');
    });
  } catch {
    threw = true;
  }
  assert(threw, 'transaction rethrows');
  eq(db.query("SELECT id FROM t WHERE id = 'tx2'").length, 0, 'tx rollback');

  // --- nested transaction: inner failure rolls back only the inner scope ---
  db.transaction(() => {
    db.exec('INSERT INTO t (id) VALUES (?)', ['outer']);
    try {
      db.transaction(() => {
        db.exec('INSERT INTO t (id) VALUES (?)', ['inner']);
        throw new Error('inner boom');
      });
    } catch {
      /* swallow — outer must survive */
    }
  });
  eq(db.query("SELECT id FROM t WHERE id = 'outer'").length, 1, 'outer kept');
  eq(
    db.query("SELECT id FROM t WHERE id = 'inner'").length,
    0,
    'inner savepoint rolled back',
  );

  // --- withSqliteImage (§5.3): attach a snapshot db, read from it, detach ---
  const withImage = db.withSqliteImage;
  assert(typeof withImage === 'function', 'withSqliteImage present');
  const image = buildImage(open);
  db.exec('CREATE TABLE dest (id TEXT, v TEXT)');
  withImage.call(db, image, 'img', () => {
    db.exec('INSERT INTO dest (id, v) SELECT id, v FROM img.src');
  });
  const imported = db.query('SELECT id, v FROM dest ORDER BY id');
  eq(imported.length, 2, 'image import row count');
  eq(imported[0]?.v, 'one', 'image import value');
  // The alias is detached afterwards: querying it must fail.
  let detached = false;
  try {
    db.query('SELECT * FROM img.src');
  } catch {
    detached = true;
  }
  assert(detached, 'image alias detached after use');

  db.close();
}

/** Serialize a tiny source database to bytes for the image-import test. */
function buildImage(open: (path?: string) => ClientDatabase): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'syncular-contract-'));
  const path = join(dir, 'src.db');
  try {
    const src = open(path);
    src.exec('CREATE TABLE src (id TEXT, v TEXT)');
    src.exec("INSERT INTO src VALUES ('a', 'one'), ('b', 'two')");
    src.close();
    return new Uint8Array(readFileSync(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
