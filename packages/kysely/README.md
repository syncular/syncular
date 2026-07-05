# @syncular/kysely — the typed read layer

syncular's local query API is string SQL by design (`client.query(sql,
params)`). This package is its **typed counterpart**: a [Kysely](https://kysely.dev)
dialect that runs your queries against any syncular host, typed by the
`Database` interface `@syncular/typegen` emits from your schema.

```ts
import { Kysely } from 'kysely';
import { SyncularDialect } from '@syncular/kysely';
import type { Database } from './syncular.generated';

const db = new Kysely<Database>({
  dialect: new SyncularDialect({ client }), // or createSyncularKysely<Database>(client)
});

const todos = await db
  .selectFrom('todos')
  .selectAll()
  .where('list_id', '=', 'demo')
  .orderBy('position')
  .execute(); // fully typed rows, no `any`
```

## The one rule: reads only

**Kysely is the typed READ layer. Writes stay on `client.mutate()`.**

A Kysely INSERT/UPDATE/DELETE would write the local mirror directly and
**bypass the sync outbox** ([SPEC §7.1](../../SPEC.md)), silently diverging
from the server. So the dialect's driver rejects any non-SELECT statement —
loudly, with `SyncularReadOnlyError` — and rejects transactions too (a
transaction here can only be an attempt to write). Do writes the syncular way:

```ts
client.mutate([{ table: 'todos', op: 'upsert', values: { … } }]);
```

## Works on every host

The dialect drives a host's `query(sql, params)` method — the one surface
**every** host exposes: the direct `SyncClient` (sync `query`), the worker
`SyncClientHandle` and multi-tab follower, and the `@syncular/tauri` /
`@syncular/react-native` bridges (all async `query`). It never reaches for
a `ClientDatabase`, so the handle hosts — which expose only `query`, not a
database — are first-class. Every read is `await`ed, so sync and async
`query` both work through one dialect.

## Not in the core bundle

This is a **separate package**, never a subpath of `@syncular/client`,
so Kysely (a real dependency) never enters the client-core bundle. The core's
size budget is untouched by construction — nothing the core ships imports
from here.

## React

`@syncular/react`'s `useTypedQuery(qb => qb.selectFrom('todos')…)` compiles
a query builder and re-runs it live, extracting its table dependencies from
the compiled query's AST automatically (`extractTables`). See the React
package README.
