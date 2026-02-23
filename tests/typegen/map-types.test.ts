import { describe, expect, it } from 'bun:test';
import type { ColumnInfo } from '@syncular/typegen';
import { resolveColumnType } from '@syncular/typegen';

function col(overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    table: 'test',
    column: 'col',
    sqlType: 'text',
    nullable: false,
    isPrimaryKey: false,
    hasDefault: false,
    dialect: 'sqlite',
    ...overrides,
  };
}

describe('SQLite type mapping', () => {
  const cases: Array<[string, string]> = [
    ['INTEGER', 'number'],
    ['INT', 'number'],
    ['TINYINT', 'number'],
    ['SMALLINT', 'number'],
    ['MEDIUMINT', 'number'],
    ['BIGINT', 'number'],
    ['UNSIGNED BIG INT', 'number'],
    ['INT2', 'number'],
    ['INT8', 'number'],
    ['REAL', 'number'],
    ['FLOAT', 'number'],
    ['DOUBLE', 'number'],
    ['DOUBLE PRECISION', 'number'],
    ['BLOB', 'Uint8Array'],
    ['BOOLEAN', 'number'],
    ['BOOL', 'number'],
    ['TEXT', 'string'],
    ['VARCHAR(255)', 'string'],
    ['CHAR(10)', 'string'],
    ['CLOB', 'string'],
    ['NVARCHAR(100)', 'string'],
    ['NUMERIC', 'string'],
    ['DECIMAL(10,2)', 'string'],
    ['DATE', 'string'],
    ['DATETIME', 'string'],
    ['TIMESTAMP', 'string'],
  ];

  for (const [sqlType, expected] of cases) {
    it(`maps ${sqlType} → ${expected}`, () => {
      const result = resolveColumnType(col({ sqlType, dialect: 'sqlite' }));
      expect(result.tsType).toBe(expected);
      expect(result.imports).toEqual([]);
    });
  }
});

describe('PostgreSQL type mapping', () => {
  const cases: Array<[string, string]> = [
    // Integer types
    ['int2', 'number'],
    ['int4', 'number'],
    ['integer', 'number'],
    ['smallint', 'number'],
    ['serial', 'number'],
    // 64-bit
    ['int8', 'string'],
    ['bigint', 'string'],
    ['bigserial', 'string'],
    // Float/numeric
    ['float4', 'number'],
    ['float8', 'number'],
    ['real', 'number'],
    ['double precision', 'number'],
    ['numeric', 'string'],
    ['decimal', 'string'],
    // Boolean
    ['bool', 'boolean'],
    ['boolean', 'boolean'],
    // JSON
    ['json', 'unknown'],
    ['jsonb', 'unknown'],
    // Date/time
    ['timestamp', 'string'],
    ['timestamptz', 'string'],
    ['timestamp with time zone', 'string'],
    ['timestamp without time zone', 'string'],
    ['date', 'string'],
    ['time', 'string'],
    ['timetz', 'string'],
    ['time with time zone', 'string'],
    ['time without time zone', 'string'],
    // Binary
    ['bytea', 'Uint8Array'],
    // Text
    ['uuid', 'string'],
    ['text', 'string'],
    ['varchar', 'string'],
    ['char', 'string'],
    ['citext', 'string'],
    ['character varying(255)', 'string'],
    ['character(10)', 'string'],
    ['varchar(100)', 'string'],
    // Interval
    ['interval', 'string'],
    // Network
    ['inet', 'string'],
    ['cidr', 'string'],
    ['macaddr', 'string'],
    // Geometric
    ['point', 'string'],
    ['line', 'string'],
    ['box', 'string'],
    ['path', 'string'],
    ['polygon', 'string'],
    ['circle', 'string'],
    // Range
    ['int4range', 'string'],
    ['int8range', 'string'],
    ['tsrange', 'string'],
    ['tstzrange', 'string'],
    ['daterange', 'string'],
    ['numrange', 'string'],
    // Full-text search
    ['tsvector', 'string'],
    ['tsquery', 'string'],
    // Other
    ['xml', 'string'],
    ['money', 'string'],
    ['bit', 'string'],
    ['varbit', 'string'],
    ['bit(8)', 'string'],
    ['bit varying(16)', 'string'],
  ];

  for (const [sqlType, expected] of cases) {
    it(`maps ${sqlType} → ${expected}`, () => {
      const result = resolveColumnType(col({ sqlType, dialect: 'postgres' }));
      expect(result.tsType).toBe(expected);
    });
  }

  it('maps array types', () => {
    expect(
      resolveColumnType(col({ sqlType: 'text[]', dialect: 'postgres' })).tsType
    ).toBe('string[]');
    expect(
      resolveColumnType(col({ sqlType: 'int4[]', dialect: 'postgres' })).tsType
    ).toBe('number[]');
    expect(
      resolveColumnType(col({ sqlType: 'jsonb[]', dialect: 'postgres' })).tsType
    ).toBe('unknown[]');
    expect(
      resolveColumnType(col({ sqlType: 'bool[]', dialect: 'postgres' })).tsType
    ).toBe('boolean[]');
  });
});

describe('nullable wrapping', () => {
  it('appends | null for nullable columns', () => {
    const result = resolveColumnType(
      col({ sqlType: 'TEXT', nullable: true, dialect: 'sqlite' })
    );
    expect(result.tsType).toBe('string | null');
  });

  it('does not append | null for non-nullable columns', () => {
    const result = resolveColumnType(
      col({ sqlType: 'TEXT', nullable: false, dialect: 'sqlite' })
    );
    expect(result.tsType).toBe('string');
  });

  it('wraps postgres boolean with | null', () => {
    const result = resolveColumnType(
      col({ sqlType: 'boolean', nullable: true, dialect: 'postgres' })
    );
    expect(result.tsType).toBe('boolean | null');
  });

  it('wraps postgres array with | null', () => {
    const result = resolveColumnType(
      col({ sqlType: 'text[]', nullable: true, dialect: 'postgres' })
    );
    expect(result.tsType).toBe('string[] | null');
  });
});

describe('type overrides', () => {
  it('accepts string override', () => {
    const result = resolveColumnType(col({ sqlType: 'TEXT' }), 'Date');
    expect(result.tsType).toBe('Date');
    expect(result.imports).toEqual([]);
  });

  it('accepts object override with import', () => {
    const result = resolveColumnType(col({ sqlType: 'TEXT' }), {
      type: 'TaskMeta',
      import: { name: 'TaskMeta', from: './task-types' },
    });
    expect(result.tsType).toBe('TaskMeta');
    expect(result.imports).toEqual([
      { name: 'TaskMeta', from: './task-types' },
    ]);
  });

  it('accepts object override without import', () => {
    const result = resolveColumnType(col({ sqlType: 'TEXT' }), {
      type: 'Record<string, number>',
    });
    expect(result.tsType).toBe('Record<string, number>');
    expect(result.imports).toEqual([]);
  });

  it('falls through to default when override is undefined', () => {
    const result = resolveColumnType(
      col({ sqlType: 'INTEGER', dialect: 'sqlite' })
    );
    expect(result.tsType).toBe('number');
  });

  it('wraps nullable override', () => {
    const result = resolveColumnType(col({ sqlType: 'TEXT', nullable: true }), {
      type: 'Date',
    });
    expect(result.tsType).toBe('Date | null');
  });
});
