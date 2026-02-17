/**
 * @syncular/typegen - Type mapping
 *
 * Maps SQL types to TypeScript types for each dialect,
 * with support for column codec type overrides.
 */

import type { ColumnInfo, TypegenDialect, TypeOverride } from './types';

export interface ResolvedType {
  tsType: string;
  imports: Array<{ name: string; from: string }>;
}

function mapSqliteType(sqlType: string): string {
  const upper = sqlType.toUpperCase();

  if (upper.includes('INT')) return 'number';
  if (
    upper.includes('REAL') ||
    upper.includes('FLOAT') ||
    upper.includes('DOUBLE')
  )
    return 'number';
  if (upper.includes('BLOB')) return 'Uint8Array';
  if (upper.includes('BOOL')) return 'number';
  // TEXT, VARCHAR, CHAR, etc.
  return 'string';
}

function mapPostgresType(sqlType: string): string {
  const lower = sqlType.toLowerCase().replace(/\s+/g, ' ').trim();

  // Array types — strip trailing [] and map the element type
  if (lower.endsWith('[]')) {
    const element = mapPostgresType(lower.slice(0, -2));
    return `${element}[]`;
  }

  // Integer types
  if (
    lower === 'int2' ||
    lower === 'int4' ||
    lower === 'integer' ||
    lower === 'smallint' ||
    lower === 'serial'
  )
    return 'number';

  // 64-bit integers — not safe in JS
  if (lower === 'int8' || lower === 'bigint' || lower === 'bigserial')
    return 'string';

  // Floating-point / numeric
  if (
    lower === 'float4' ||
    lower === 'float8' ||
    lower === 'real' ||
    lower === 'double precision'
  )
    return 'number';

  // Exact numeric types are string by default to match common pg driver behavior.
  if (lower === 'numeric' || lower === 'decimal') return 'string';

  // Boolean
  if (lower === 'bool' || lower === 'boolean') return 'boolean';

  // JSON
  if (lower === 'json' || lower === 'jsonb') return 'unknown';

  // Date/time
  if (
    lower === 'timestamp' ||
    lower === 'timestamptz' ||
    lower === 'timestamp with time zone' ||
    lower === 'timestamp without time zone' ||
    lower === 'date' ||
    lower === 'time' ||
    lower === 'timetz' ||
    lower === 'time with time zone' ||
    lower === 'time without time zone'
  )
    return 'string';

  // Binary
  if (lower === 'bytea') return 'Uint8Array';

  // Text types
  if (
    lower === 'uuid' ||
    lower === 'text' ||
    lower === 'varchar' ||
    lower === 'char' ||
    lower === 'citext' ||
    lower.startsWith('character varying') ||
    lower.startsWith('character(') ||
    lower.startsWith('varchar(') ||
    lower.startsWith('char(')
  )
    return 'string';

  // Interval
  if (lower === 'interval') return 'string';

  // Network types
  if (lower === 'inet' || lower === 'cidr' || lower === 'macaddr')
    return 'string';

  // Geometric types
  if (
    lower === 'point' ||
    lower === 'line' ||
    lower === 'box' ||
    lower === 'path' ||
    lower === 'polygon' ||
    lower === 'circle' ||
    lower === 'lseg'
  )
    return 'string';

  // Range types
  if (
    lower === 'int4range' ||
    lower === 'int8range' ||
    lower === 'tsrange' ||
    lower === 'tstzrange' ||
    lower === 'daterange' ||
    lower === 'numrange'
  )
    return 'string';

  // Full-text search
  if (lower === 'tsvector' || lower === 'tsquery') return 'string';

  // Other
  if (lower === 'xml') return 'string';
  if (lower === 'money') return 'string';
  if (
    lower === 'bit' ||
    lower === 'varbit' ||
    lower.startsWith('bit(') ||
    lower.startsWith('bit varying')
  )
    return 'string';

  return 'string';
}

function defaultMapper(dialect: TypegenDialect): (sqlType: string) => string {
  return dialect === 'postgres' ? mapPostgresType : mapSqliteType;
}

/**
 * Resolve the TypeScript type for a column, applying an optional override
 * first and falling back to the default dialect mapping.
 */
export function resolveColumnType(
  col: ColumnInfo,
  override?: TypeOverride
): ResolvedType {
  const imports: Array<{ name: string; from: string }> = [];

  if (override !== undefined) {
    if (typeof override === 'string') {
      const baseType = override;
      return {
        tsType: col.nullable ? `${baseType} | null` : baseType,
        imports,
      };
    }
    if (override.import) {
      imports.push(override.import);
    }
    const baseType = override.type;
    return {
      tsType: col.nullable ? `${baseType} | null` : baseType,
      imports,
    };
  }

  // Default mapping
  const mapper = defaultMapper(col.dialect);
  const baseType = mapper(col.sqlType);
  return {
    tsType: col.nullable ? `${baseType} | null` : baseType,
    imports,
  };
}
