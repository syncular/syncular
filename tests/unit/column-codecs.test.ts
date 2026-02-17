import { describe, expect, it } from 'bun:test';
import {
  applyCodecsFromDbRow,
  applyCodecsToDbRow,
  codecs,
  toTableColumnCodecs,
} from '@syncular/core';

describe('column codecs', () => {
  it('selects table-scoped codecs from a resolver', () => {
    const tasksCodecs = toTableColumnCodecs(
      'tasks',
      (col) => {
        if (col.table !== 'tasks') return undefined;
        if (col.column === 'enabled') return codecs.numberBoolean();
        if (col.column === 'metadata') {
          return codecs.stringJson<{ tag: string }>();
        }
        return undefined;
      },
      ['enabled', 'metadata', 'ignored']
    );
    expect(Object.keys(tasksCodecs).sort()).toEqual(['enabled', 'metadata']);
  });

  it('passes sqlType into codec resolver', () => {
    const seen: Array<{ column: string; sqlType?: string }> = [];
    toTableColumnCodecs(
      'tasks',
      (col) => {
        seen.push({ column: col.column, sqlType: col.sqlType });
        return undefined;
      },
      ['enabled', 'metadata'],
      {
        sqlTypes: {
          enabled: 'INTEGER',
          metadata: 'TEXT',
        },
      }
    );

    expect(seen).toEqual([
      { column: 'enabled', sqlType: 'INTEGER' },
      { column: 'metadata', sqlType: 'TEXT' },
    ]);
  });

  it('round-trips numberBoolean and stringJson through row helpers', () => {
    const tableCodecs = toTableColumnCodecs(
      'tasks',
      (col) => {
        if (col.table !== 'tasks') return undefined;
        if (col.column === 'enabled') return codecs.numberBoolean();
        if (col.column === 'metadata') {
          return codecs.stringJson<{ tags: string[] }>();
        }
        return undefined;
      },
      ['enabled', 'metadata']
    );

    const appRow = {
      id: 't1',
      enabled: true,
      metadata: { tags: ['alpha', 'beta'] },
    };

    const dbRow = applyCodecsToDbRow(appRow, tableCodecs, 'sqlite');
    expect(dbRow).toEqual({
      id: 't1',
      enabled: 1,
      metadata: '{"tags":["alpha","beta"]}',
    });

    const hydrated = applyCodecsFromDbRow(dbRow, tableCodecs, 'sqlite');
    expect(hydrated).toEqual(appRow);
  });

  it('uses postgres dialect overrides for numberBoolean', () => {
    const tableCodecs = toTableColumnCodecs(
      'tasks',
      (col) => {
        if (col.table === 'tasks' && col.column === 'enabled') {
          return codecs.numberBoolean();
        }
        return undefined;
      },
      ['enabled'],
      { dialect: 'postgres' }
    );

    const dbRow = applyCodecsToDbRow(
      { id: 't1', enabled: true },
      tableCodecs,
      'postgres'
    );
    expect(dbRow).toEqual({ id: 't1', enabled: true });

    const hydrated = applyCodecsFromDbRow(
      { id: 't1', enabled: true },
      tableCodecs,
      'postgres'
    );
    expect(hydrated).toEqual({ id: 't1', enabled: true });
  });

  it('parses sqlite boolean string and numeric variants', () => {
    const tableCodecs = toTableColumnCodecs(
      'tasks',
      (col) => {
        if (col.table === 'tasks' && col.column === 'enabled') {
          return codecs.numberBoolean();
        }
        return undefined;
      },
      ['enabled'],
      { dialect: 'sqlite' }
    );

    const one = applyCodecsFromDbRow({ enabled: '1.0' }, tableCodecs, 'sqlite');
    expect(one.enabled).toBe(true);

    const zero = applyCodecsFromDbRow(
      { enabled: '0.0' },
      tableCodecs,
      'sqlite'
    );
    expect(zero.enabled).toBe(false);

    const t = applyCodecsFromDbRow({ enabled: 't' }, tableCodecs, 'sqlite');
    expect(t.enabled).toBe(true);

    const f = applyCodecsFromDbRow({ enabled: 'f' }, tableCodecs, 'sqlite');
    expect(f.enabled).toBe(false);
  });
});
