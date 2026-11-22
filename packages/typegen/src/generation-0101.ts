/**
 * The table generation formula typegen 0.101.0 and earlier emitted (§7.4.3).
 * Typegen 0.102.0 (51d22ac5) took declared indexes, FTS5 projections and the
 * migrations that only declare them out of the generation. A replica those
 * versions wrote still holds the old strings, so typegen recomputes them at
 * every earlier locked version for `equivalentGenerations` and for nothing
 * else. The lock does not record which typegen wrote a version, and it keeps
 * no past manifest, so typegen rebuilds each version with today's manifest; a
 * string a client keeps on must match the persisted one exactly, so a wrong
 * rebuild resets the table. Remove this module in a major release once apps
 * no longer ship pre-0.102 replicas.
 */
import { createHash } from 'node:crypto';
import { canonicalizeExtensions, type IrTable } from './ir';

/** The 0.101.0 generation of `table`; `migrations` are named by the 0.101.0
 * rule, which counts index and FTS5 statements. */
export function generation0101(
  table: IrTable,
  migrations: readonly string[],
): string {
  const fts = (table.localProjections ?? []).filter(
    (projection) => projection.columns[0]?.source !== undefined,
  );
  return createHash('sha256')
    .update(
      JSON.stringify({
        table: {
          name: table.name,
          primaryKey: table.primaryKey,
          columns: table.columns.map((column) => ({
            name: column.name,
            type: column.type,
            nullable: column.nullable,
            ...(column.crdtType !== undefined
              ? { crdtType: column.crdtType }
              : {}),
            ...(column.encrypted === true
              ? { encrypted: true, declaredType: column.declaredType }
              : {}),
            ...(column.serverOwned === true ? { serverOwned: true } : {}),
          })),
          scopes: table.scopes.map((scope) => ({ ...scope })),
          ...(table.references.length > 0
            ? {
                references: table.references.map((reference) => ({
                  ...reference,
                })),
              }
            : {}),
          ...(table.indexes.length > 0
            ? {
                indexes: table.indexes.map((index) => ({
                  name: index.name,
                  columns: index.columns,
                  unique: index.unique,
                })),
              }
            : {}),
          ...(fts.length > 0
            ? {
                ftsIndexes: fts.map((projection) => ({
                  name: projection.name,
                  columns: projection.columns.map((column) => column.source),
                  tokenize: projection.fts?.tokenize,
                })),
              }
            : {}),
          extensions: canonicalizeExtensions(table.extensions),
        },
        migrations,
      }),
      'utf8',
    )
    .digest('hex')
    .slice(0, 32);
}
