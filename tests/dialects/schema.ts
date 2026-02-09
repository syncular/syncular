import type { Kysely } from 'kysely';
import type { DialectConformanceDb } from './conformance-db';

export type ConformanceDialectKind = 'sqlite' | 'postgres';

export async function createConformanceSchema(
  db: Kysely<DialectConformanceDb>,
  kind: ConformanceDialectKind
): Promise<void> {
  const bigintType = kind === 'postgres' ? 'bigint' : 'integer';
  const boolType = kind === 'postgres' ? 'boolean' : 'text';
  const jsonType = kind === 'postgres' ? 'jsonb' : 'text';
  const dateType = kind === 'postgres' ? 'timestamptz' : 'text';
  const bytesType = kind === 'postgres' ? 'bytea' : 'blob';

  await db.schema
    .createTable('dialect_conformance')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('n_int', 'integer', (col) => col.notNull())
    .addColumn('n_bigint', bigintType, (col) => col.notNull())
    .addColumn('bigint_text', 'text', (col) => col.notNull())
    .addColumn('t_text', 'text', (col) => col.notNull())
    .addColumn('u_unique', 'text', (col) => col.notNull())
    .addColumn('b_bool', boolType, (col) => col.notNull())
    .addColumn('j_json', jsonType, (col) => col.notNull())
    .addColumn('j_large', jsonType, (col) => col.notNull())
    .addColumn('d_date', dateType, (col) => col.notNull())
    .addColumn('bytes', bytesType, (col) => col.notNull())
    .addColumn('nullable_text', 'text')
    .addColumn('nullable_int', 'integer')
    .addColumn('nullable_bigint', bigintType)
    .addColumn('nullable_bool', boolType)
    .addColumn('nullable_bytes', bytesType)
    .addColumn('nullable_json', jsonType)
    .addColumn('nullable_date', dateType)
    .execute();

  await db.schema
    .createIndex('dialect_conformance_n_int_idx')
    .ifNotExists()
    .on('dialect_conformance')
    .column('n_int')
    .execute();

  await db.schema
    .createIndex('dialect_conformance_u_unique_idx')
    .ifNotExists()
    .on('dialect_conformance')
    .column('u_unique')
    .unique()
    .execute();
}
