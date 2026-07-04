/**
 * @syncular-v2/kysely — the typed READ layer for syncular local queries.
 *
 * Kysely is string-agnostic syncular's typed counterpart: a
 * schema-generated `Database` interface (from `@syncular-v2/typegen`) plus a
 * dialect that runs SELECTs against any syncular host through its
 * `query(sql, params)` surface. It is READ-ONLY by contract — writes stay on
 * `client.mutate()` for the outbox (SPEC §7.1). It ships as its own package
 * so Kysely never enters the client-core bundle.
 *
 * ```ts
 * import { Kysely } from 'kysely';
 * import { SyncularDialect } from '@syncular-v2/kysely';
 * import type { Database } from './syncular.generated'; // typegen `Database`
 *
 * const db = new Kysely<Database>({
 *   dialect: new SyncularDialect({ client }), // client: SyncClient | handle | …
 * });
 * const rows = await db.selectFrom('todos').selectAll()
 *   .where('list_id', '=', 'demo').execute();
 * ```
 *
 * For React, `@syncular-v2/react`'s `useTypedQuery` compiles a builder and
 * extracts its table dependencies automatically (see {@link extractTables}).
 */
export {
  SyncularDialect,
  type SyncularDialectConfig,
} from './dialect';
export type { SyncularQuerySurface } from './query-surface';
export { assertReadOnly, SyncularReadOnlyError } from './read-only';
export { extractTables } from './tables';

/**
 * Build a plain Kysely instance over a syncular host in one call — the common
 * case. `Database` is the typegen-emitted table→Row map. Equivalent to
 * `new Kysely({ dialect: new SyncularDialect({ client }) })`.
 */
import { Kysely } from 'kysely';
import { SyncularDialect } from './dialect';
import type { SyncularQuerySurface } from './query-surface';

export function createSyncularKysely<Database>(
  client: SyncularQuerySurface,
): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SyncularDialect({ client }) });
}
