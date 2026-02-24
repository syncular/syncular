import type { Dialect } from 'kysely';

export type SqlFamily = 'sqlite' | 'postgres';

export interface SyncularDialectDescriptor<F extends SqlFamily = SqlFamily> {
  dialect: Dialect;
  family: F;
}
