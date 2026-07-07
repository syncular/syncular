/**
 * I4 (DESIGN-queries.md): the `sql` tagged template. The invariant under
 * test is structural: interpolated values can only become `?` binds; text
 * can only enter via the literal template, an allowlisted `sql.ident`, or
 * a deliberate `sql.raw`.
 */
import { describe, expect, test } from 'bun:test';
import { sql } from '@syncular/client';

describe('sql tag', () => {
  test('values become positional binds, never text', () => {
    const q = sql`SELECT * FROM t WHERE a = ${1} AND b = ${"'; DROP TABLE t; --"}`;
    expect(q.text).toBe('SELECT * FROM t WHERE a = ? AND b = ?');
    expect(q.params).toEqual([1, "'; DROP TABLE t; --"]);
  });

  test('fragments compose and their params keep order', () => {
    const status: string | null = 'open';
    const filter = status ? sql`AND status = ${status}` : sql.empty;
    const q = sql`SELECT * FROM t WHERE list = ${'inbox'} ${filter} LIMIT ${10}`;
    expect(q.text).toBe(
      'SELECT * FROM t WHERE list = ? AND status = ? LIMIT ?',
    );
    expect(q.params).toEqual(['inbox', 'open', 10]);
  });

  test('sql.empty composes to nothing', () => {
    const q = sql`SELECT 1 ${sql.empty}`;
    expect(q.text).toBe('SELECT 1 ');
    expect(q.params).toEqual([]);
  });

  test('arrays expand to a bind list (IN)', () => {
    const q = sql`SELECT * FROM t WHERE id IN (${['a', 'b', 'c']})`;
    expect(q.text).toBe('SELECT * FROM t WHERE id IN (?, ?, ?)');
    expect(q.params).toEqual(['a', 'b', 'c']);
  });

  test('an empty array yields a never-matching IN', () => {
    const q = sql`SELECT * FROM t WHERE id IN (${[]})`;
    expect(q.text).toBe('SELECT * FROM t WHERE id IN (SELECT NULL WHERE 0)');
    expect(q.params).toEqual([]);
  });

  test('ident requires the allowlist and a plain shape', () => {
    expect(sql.ident('created_at', ['created_at', 'title']).text).toBe(
      '"created_at"',
    );
    expect(() => sql.ident('evil', ['created_at'])).toThrow(RangeError);
    expect(
      () => sql.ident('a"b', ['a"b']), // allowlisted but not a plain identifier
    ).toThrow(RangeError);
  });

  test('undefined and objects are call-site bugs, loudly', () => {
    // @ts-expect-error — undefined is not a bindable value
    expect(() => sql`SELECT ${undefined}`).toThrow(TypeError);
    // @ts-expect-error — objects are not bindable values
    expect(() => sql`SELECT ${{ a: 1 }}`).toThrow(TypeError);
    expect(
      () => sql`SELECT * FROM t WHERE id IN (${[{ a: 1 }] as never})`,
    ).toThrow(TypeError);
  });

  test('raw is verbatim (and therefore on the caller)', () => {
    const q = sql`SELECT 1 ${sql.raw('ORDER BY 1 DESC')}`;
    expect(q.text).toBe('SELECT 1 ORDER BY 1 DESC');
  });

  test('null and Uint8Array bind as values', () => {
    const bytes = new Uint8Array([1, 2]);
    const q = sql`SELECT ${null}, ${bytes}`;
    expect(q.text).toBe('SELECT ?, ?');
    expect(q.params).toEqual([null, bytes]);
  });
});
