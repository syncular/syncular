# Typed reads with Kysely

syncular's local query API is string SQL by design — `client.query(sql,
params)`. `@syncular/kysely` is its **typed counterpart**: a
[Kysely](https://kysely.dev) dialect that runs query-builder SELECTs against
any syncular host, typed end-to-end by the `Database` interface typegen
emits from your schema. This is the TypeScript **dynamic** read tier — for
queries whose shape is only known at runtime (user-driven filters, sort
toggles). For fixed queries, prefer [named queries](/tooling-queries/).

## Install

```sh
bun add @syncular/kysely kysely
```

`kysely` is a peer dependency. `@syncular/kysely` is a separate package,
never a subpath of `@syncular/client` — Kysely stays out of the client-core
bundle by construction.

## Set up

typegen already emits everything the dialect needs: your generated module
exports a `Database` interface (table name → row type) alongside `schema`
and the row types (see [Schema & typegen](/guide-schema/)).

```ts
import { Kysely } from 'kysely';
import { SyncularDialect } from '@syncular/kysely';
import type { Database } from './syncular.generated';

const db = new Kysely<Database>({
  dialect: new SyncularDialect({ client }),
});

const todos = await db
  .selectFrom('todos')
  .selectAll()
  .where('list_id', '=', 'demo')
  .orderBy('position')
  .execute(); // fully typed rows, no `any`
```

`createSyncularKysely<Database>(client)` is the same thing in one call.

## The one rule: reads only

**Kysely is the typed READ layer. Writes stay on `client.mutate()`.**

A Kysely INSERT, UPDATE, or DELETE would write the local mirror directly and
bypass the sync **outbox** — silently diverging from the server. So the
dialect's driver rejects any non-SELECT statement with a
`SyncularReadOnlyError`, and rejects transactions too (there is no write
path here, so a transaction can only be an attempt to write). The check runs
on the SQL string at the driver, so it also catches `sql`-tagged raw
fragments and compiled queries handed in directly. Do writes the syncular
way:

```ts
client.mutate([{ table: 'todos', op: 'upsert', values: { /* … */ } }]);
```

## Works on every host

The dialect drives a host's `query(sql, params)` method — the one surface
every host exposes:

- the direct `SyncClient` (browser or Bun; synchronous `query`)
- the worker `SyncClientHandle` and the multi-tab follower (async `query`)
- the `@syncular/tauri` and `@syncular/react-native` bridges (async `query`)

Every read is `await`ed, so sync and async hosts both work through the one
dialect. It never reaches for a `ClientDatabase`, so handle hosts — which
expose only `query`, not a database — are first-class.

## React: `useTypedQuery`

`@syncular/react` ships `useTypedQuery`: you write a query builder, the hook
compiles it, runs it live, and extracts its table-dependency set from the
compiled query's AST — so invalidation is exact, not a SQL-text heuristic.

```ts
import { useTypedQuery } from '@syncular/react/typed';
import type { Database } from './syncular.generated';

const { rows } = useTypedQuery<Database>(
  (db) => db.selectFrom('todos').select(['id', 'title']).where('list_id', '=', listId),
  [listId],
);
```

`@syncular/kysely` and `kysely` are optional peers of `@syncular/react` —
apps that only use `useSyncQuery` never pull Kysely in. See
[React](/platform-react/) for the full hook surface.

## TypeScript only

Kysely is a TypeScript library, so this tier exists only on TS hosts. On
Swift, Kotlin, and Dart, the typed read tier is [named queries](/tooling-queries/)
— the same generate-time type-checking, emitted as native functions.

## Where to go next

- [Named queries](/tooling-queries/) — the cross-platform typed read tier for fixed queries.
- [Schema & typegen](/guide-schema/) — where the `Database` interface comes from.
- [React](/platform-react/) — `useTypedQuery`, `useSyncQuery`, and live invalidation.
- [kysely package README](https://github.com/syncular/syncular/blob/main/packages/kysely/README.md) — the package contract.
