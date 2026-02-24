import { Kysely } from 'kysely';
import type { ColumnCodecSource } from './column-codecs';
import type { SqlFamily, SyncularDialectDescriptor } from './dialect';
import { createColumnCodecsPlugin } from './kysely-column-codecs';

export function createDatabase<T, F extends SqlFamily = SqlFamily>(
  options: SyncularDialectDescriptor<F> & {
    codecs?: ColumnCodecSource;
  }
) {
  const db = new Kysely<T>({
    dialect: options.dialect,
  });
  if (!options.codecs) return db;
  return db.withPlugin(
    createColumnCodecsPlugin({
      codecs: options.codecs,
      dialect: options.family,
    })
  );
}
