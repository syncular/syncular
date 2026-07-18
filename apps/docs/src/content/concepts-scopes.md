# Scopes & authorization

Scopes are the authorization core, and you write them yourself. They decide,
per user, which rows sync, and the decision runs in **your** backend, next to
your auth, so it stays in agreement with the rest of your access control. This
is the one piece of syncular you always write yourself.

Normative detail lives in [SPEC.md §3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#3-scopes-and-authorization);
this page is the mental model.

## Scope patterns

Every synced table declares at least one **scope pattern** in the manifest,
of the form `prefix:{variable}`. A note table scoped by `list:{list_id}` says
"a row belongs to the list named by its `list_id` column." The prefix plus the
column value form a **scope key** — `list:welcome`, `list:team-42` — and the
server maintains an inverted index from scope key to commit, so pulls filter
by scope without scanning ([SPEC §3.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#31-scope-patterns-and-stored-scopes)).

There is no "global" table without a scope; model shared data with an explicit
scope column every row carries.

## The three scope sets

On every pull, per subscription, three maps meet
([SPEC §3.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#32-requested-allowed-effective)):

| Set | Comes from | Meaning |
|---|---|---|
| **Requested** | the client's subscription | "I want these list ids" |
| **Allowed** | your `resolveScopes(actor)` | "this actor may see these list ids" (`*` = any) |
| **Effective** | requested ∩ allowed | what actually syncs |

If the intersection loses a key the client asked for, the subscription is
**revoked**: syncular returns an error for the whole subscription instead of
delivering a smaller, unrequested subset. Revocation purges the
now-unauthorized rows from the local database ([SPEC §3.3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#33-revocation-and-the-purge-contract)).

## `resolveScopes`: the one function you write

One resolver per server, invoked at most once per request and memoized. It
returns every scope value the actor holds, across all tables:

```ts
const config: SyncServerConfig = {
  schema,
  storage,
  segments,
  resolveScopes: async ({ actorId }) => {
    const lists = await db.listsForUser(actorId); // your query
    return { list_id: lists.map((l) => l.id) };
  },
};
```

Return `{ list_id: ['*'] }` to grant every value of a variable (the quickstart
does this for its single demo user). If the resolver throws, syncular fences:
no data leaks on an authorization error.

## Multiple variables are not correlated tuples

Each key in an allowed-scope map is checked independently. For example:

```ts
return {
  workspace_id: ['workspace-a', 'workspace-b'],
  surgery_id: ['surgery-1', 'surgery-2'],
};
```

This permits rows whose two values form any of the four Cartesian
combinations. It does **not** mean only `(workspace-a, surgery-1)` and
`(workspace-b, surgery-2)`. Syncular cannot infer a parent/child relation from
the values or their ordering.

For a child such as a Surgery, choose one of these explicit designs:

1. Put both `workspace_id` and `surgery_id` scope patterns on every
   Surgery-owned table and request both variables in every subscription. Keep
   the parent reference valid with a server-side validator.
2. Enumerate the exact Surgery IDs the actor may access instead of granting a
   wildcard.
3. Resolve the relationship inside a server-authoritative command when it is
   not suitable for client synchronization.

A child wildcard can be safe in the first design:

```ts
return {
  workspace_id: ['workspace-a'],
  surgery_id: ['*'],
};
```

A row for `(workspace-a, surgery-1)` passes, while
`(workspace-b, surgery-1)` fails because the table and subscription also carry
the Workspace fence. But a future `surgery_notes` table scoped only by
`surgery_id` would make the same wildcard authorize notes for every Surgery.
Adding or changing a table's scope patterns is therefore an authorization
review, not merely a schema change.

Test isolation with at least two parents and representative child IDs. Prove
that an in-parent row is readable and writable, an out-of-parent row with an
otherwise allowed child value is neither readable nor writable, and revocation,
realtime, segments, and future child-only projections preserve that boundary.

## Write-path authorization

The same resolver guards writes ([SPEC §3.4](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#34-write-path-authorization)),
through two rules:

- A write is authorized against the row **as currently stored** (or, for an
  insert, the pushed row), so a client can't grant itself access by claiming
  a scope in the payload.
- **Scope columns are immutable on update.** A client cannot re-home a row
  into another scope by pushing a changed `list_id`; scope migration is
  server-emitted only. This closes the cross-scope-write hole.

## Windowed sync

A client does not have to hold *every* row it is authorized for. **Windowed
sync** lets a client keep a **partial local replica** (the hot projects, the
last few months) while the server keeps everything, with correct sync
semantics throughout. See [Windowed sync](/concepts-windowing/) for the
full model; the short version is that a window is a **set of scope values**,
and changing the window is a set difference on subscriptions: values that
enter fresh-bootstrap, values that leave are evicted from the local database.
Shipped in W1 ([SPEC §4.8](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#48-windowed-subscriptions)).
