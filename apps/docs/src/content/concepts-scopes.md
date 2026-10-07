# Scopes & authorization

Scopes decide, per user, which rows sync. You write them yourself: the decision runs in your backend next to your auth ([Authentication](/guide-auth/)), so it stays in agreement with the rest of your access control. This page is for developers who write the server's `resolveScopes` function and design a schema's scope patterns.

::meta{for="App developers and backend engineers" time="10 minutes" first="concepts-subscriptions" spec="3"}

:::terms
- **Scope pattern**: A declaration such as `list:{list_id}`: a prefix plus a column variable.
- **Scope key**: A pattern filled with a row's value, such as `list:groceries`.
- **Requested scopes**: The values a client's subscription asks for.
- **Allowed scopes**: The values `resolveScopes(actor)` grants to the actor.
- **Effective scopes**: Requested intersected with allowed; what actually syncs.
- **Revocation**: The server ending a subscription and the client purging its rows.
:::

:::figure{title="Three sets meet on every pull" note="Per subscription" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Requested · client</span>list_id = groceries, work, travel</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">Allowed · your resolveScopes</span>list_id = groceries, work</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Effective · intersection</span>list_id = groceries, work</div>
</div>

::caption[`travel` is requested and not allowed, so it drops out. The server filters pulls, deltas, and segments to the effective scopes.]
:::

## Scope patterns

Every synced table declares at least one scope pattern in the manifest, of the form `prefix:{variable}`. A todos table scoped by `list:{list_id}` says that a row belongs to the list named by its `list_id` column. The prefix plus the column value form a scope key (`list:groceries`, `list:team-42`). The server keeps an inverted index from scope key to commit, so pulls filter by scope without scanning ([SPEC §3.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#31-scope-patterns-and-stored-scopes)).

Every synced table needs a scope. Model shared data with an explicit scope column that every row carries.

## The three scope sets

On every pull, per subscription, the requested, allowed, and effective maps meet ([SPEC §3.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#32-requested-allowed-effective)).

| Set | Comes from | Meaning |
|---|---|---|
| Requested | the client's subscription | "I want these list ids." |
| Allowed | your `resolveScopes(actor)` | "This actor may see these list ids." `*` allows any value. |
| Effective | requested ∩ allowed | What syncs. |

Syncular intersects each requested variable on its own.

:::figure{title="What happens when access changes"}
<div class="d-cols-2">
<div class="node ok"><span class="t">Some values lost</span>The subscription stays active on the surviving values. Rows for lost values stop updating and stay readable locally.<br><span class="chip ok">Narrowed</span></div>
<div class="node bad"><span class="t">A variable loses every value</span>The server revokes the subscription. The client purges the now-unauthorized rows.<br><span class="chip bad">Revoked · rows purged</span></div>
</div>

::caption[Rows for lost values stay readable until revocation or until a fresh [bootstrap](/concepts-bootstrap/) applies the §5.6 first-page rule. To make the loss of one value purge its rows, give that value its own subscription with one exact scope value. [SPEC §3.3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#33-revocation-and-the-purge-contract) defines the purge contract.]
:::

## resolveScopes

A server has one resolver. The server calls it at most once per request and memoizes the result. It returns every scope value the actor holds, across all tables.

```ts title="src/server.ts"
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

Return `{ list_id: ['*'] }` to grant every value of a variable, as the [quickstart](/quickstart/) does for its single demo user. If the resolver throws, the server fences the request and no data leaks.

## Write-path authorization

The same resolver guards writes ([SPEC §3.4](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#34-write-path-authorization)) through two rules:

:::rule{title="Writes cannot re-home rows"}
The server authorizes a write against the row as currently stored, or against the pushed row for an insert, so a client cannot grant itself access by claiming a scope in the payload. Scope columns are immutable on update: a pushed change to `list_id` fails, and scope migration is server-emitted only.
:::

A client does not have to hold every row it may read. [Windowed sync](/concepts-windowing/) keeps a partial local copy by subscribing to a subset of the allowed values.

## Advanced: multiple variables and server lookups

### Variables are independent dimensions

The server checks each key in an allowed-scope map independently:

```ts
return {
  clinic_id: ['clinic-a', 'clinic-b'],
  appointment_id: ['appt-1', 'appt-2'],
};
```

This permits all four combinations of clinic and appointment. It does not mean only `(clinic-a, appt-1)` and `(clinic-b, appt-2)`. Syncular cannot infer a parent and child relation from the values or their order. For a child such as an appointment, choose one design:

1. Put both `clinic_id` and `appointment_id` patterns on every appointment-owned table and request both variables in every subscription. Keep the parent reference valid with a server-side validator.
2. Enumerate the exact appointment IDs the actor may access instead of granting a wildcard.
3. Resolve the relationship inside a server-authoritative command when it does not suit client synchronization.

A child wildcard can be safe under the first design:

```ts
return {
  clinic_id: ['clinic-a'],
  appointment_id: ['*'],
};
```

A row for `(clinic-a, appt-1)` passes. A row for `(clinic-b, appt-1)` fails because the table and subscription also carry the clinic fence. A later `patient_notes` table scoped only by `appointment_id` would make the same wildcard authorize notes for every appointment, so adding or changing a table's scope patterns is an authorization review.

Test isolation with at least two parents and representative child IDs. Prove that an in-parent row is readable and writable, that an out-of-parent row with an otherwise allowed child value is neither readable nor writable, and that revocation, realtime, segments, and future child-only projections keep that boundary.

### Scopes are not server search indexes

A new scope pattern changes the client authorization and named-query coverage contract. Do not add `workspace_id`, an external provider tenant ID, or an expiry bucket because an authoritative command needs to find rows by that value. The [storage lookup guide](/server-storage-reference/#advanced-row-lookups-for-trusted-server-code) compares four lookup shapes:

- one known row: the storage primary-key read;
- rows in a client delivery scope: the scope-index scan;
- an exact lookup over declared app columns: the trusted server-only relational-index scan;
- ordered, ranged, or derived work: an explicit server-only reverse projection, maintained atomically with the domain row.

The guide also shows a user-scoped key-grant table revoked by workspace without widening any client subscription.
