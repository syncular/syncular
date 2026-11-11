# Do's and Don'ts

Use this page before you design the sync layer of an app and again before you ship it. Each entry is one rule that integrators broke in a real deployment, the failure it caused, and where Syncular documents or fixes the cause. The page assumes [Subscriptions & the outbox](/concepts-subscriptions/) and [Scopes & authorization](/concepts-scopes/).

::meta{for="Developers integrating Syncular into a real app" time="Skim, then look up by area" first="concepts-subscriptions" spec="1.3 3.4 4.1 6.2 8.7"}

## Keep this page current

The page grows from integrator feedback. Add an entry once the failure is understood and its cause is either a design truth or an open gap. Keep the format: a rule in the heading, then why it fails (with a measured number when one exists), then where it is documented or fixed.

- Name the release that fixed a cause, so a reader on an older version sees why the rule exists.
- Mark an entry **Open** while Syncular has no fix and the host carries a workaround. Remove the mark when a release closes the gap, and delete the entry when no design truth remains.
- Anonymise examples ("an app with 40 tables and 6 campaigns"). Numbers come from a named measurement or a spec section.
- Describe behavior of the current release. Link to the page or SPEC section that owns the rule instead of restating it.

## Transport and rounds

### Do classify failures at a custom transport boundary

An arbitrary exception does not establish whether a network request or an
HTTP response failed. The client reports it as `sync.transport_failed` with
`causeKind: unknown` and excludes its raw cause. A custom transport that knows
the failure throws a `ClientSyncError` with a static message and a bounded
`causeKind`; an HTTP response can also carry its numeric `httpStatus`.
See [Browser transport failures](/platform-web-troubleshooting/#transport-failures).

### Don't run a round on a blocking transport while the UI has events pending

A transport that blocks its thread for the whole request freezes everything else on that thread. The Rust client's `Transport` is synchronous, and a host that answers it with a blocking request on the thread that also serves the UI handles no events while a round is on the wire. In one app (a Rust core in a browser worker), a reload with a fully populated replica showed its first screen after 0.97 to 1.69 s (4.2 s with `/sync` delayed by 3 s), against 0.2 s when no round was in the way. With a large replica and a slow link the wait grows to the length of a round.

Hold the first round until the UI has been quiet for a short interval (200 ms, capped at 1.5 s, worked). A transport that yields between request and response removes the cause. **Open:** the `Transport` trait has no asynchronous form.

See [The Transport trait](/platform-rust-specifics/#the-transport-trait).

### Don't read `SyncOutcome::Ok` as "synced"

The Rust client reports a server schema floor as a successful round: `SyncOutcome::Ok` with `report.schema_floor` set and `report.failed` empty. A host that tests `failed.is_empty()` shows "synced" while the client has stopped and nothing leaves the device. A flow that waits for pending commits to drain before an update waits forever.

Check `report.schema_floor` on every outcome and surface it as a blocked state with an action that updates the app. The TypeScript client reports the same condition as a typed `availability`. **Open:** the Rust client has no typed outcome for the floor.

See [Schema upgrades](/concepts-schema-upgrades/#what-triggers-the-reset).

### Don't let a wake-up trigger a full pull when a one-request round is enough

A wake-up carries no data and tells the client to pull, and `sync_until_idle` ends only after a round that finds nothing to do. In one app a user write made the server commit twice in a row: the first commit arrived as a delta, the second as a `catchup-required` wake-up, and the confirming round added about 0.8 s on a blocking transport, during which the next frame waited. `sync_until_idle` takes `max_rounds`; pass `Some(1)` for a wake-up and continue only when the report shows more work.

See [Realtime & the WebSocket-native loop](/concepts-realtime/#deltas-and-wake-ups).

## Units

### Do keep the unit count under the server limit

The server accepts at most 500 units in a request that carries the registration list (`limits.maxSubscriptionsPerRequest`). Past 500, every pull that sends the list fails with `sync.limit_exceeded` (HTTP 413, `details.limit`, `details.max`, `details.actual`), the client does not retry it, and that client stops syncing while clients under the limit keep working. A new or reinstalled client sends its list in its first round.

The limit counts units. A unit covers every table that declares its variables, so the number of tables does not count. A steady-state pull carries the replica cursor and a 32-byte digest of the list, and the server answers it with one live section, so a live unit whose rows did not change adds nothing to the round. A unit travels as one frame with its scope map only in a round whose list changed. The server's live scan reads one range of its scope index per unit ([SPEC §4.5](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#45-the-replica-cursor-and-the-live-section)).

Before wire version 4 a subscription covered one table, and every pull carried the complete list with one cursor per entry. One measured account with 6 campaigns and 7 rulesets sent 223 subscriptions per round: 33.8 KB in the request, 32 KB in the answer and about 0.4 ms of server time per subscription, whether or not a row changed. The same account registers 13 units in version 4.

Check the count before the limit does. `diagnosticsSnapshot().activeUnits` (`active_units` in the Rust snapshot) is the number of units the next list carries. Assert in the app's own tests that it stays under 500 with every unit of the heaviest fixture account open. A [window](/concepts-windowing/) bounds the number of values one variable contributes; it is the tool for data volume, when one account's rows do not fit on the device, and for a variable with an unbounded number of values, such as month buckets.

See [SPEC §4.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#41-units-and-the-registration-list).

### Do scope tables you want apart with their own variable

A unit covers every table that declares all of its variables, and it has no table list. An app that wants only some of those tables on a device gives them their own scope variable and registers units on that variable where it needs them.

See [Subscriptions & the outbox](/concepts-subscriptions/#a-unit).

### Do register units in one call

Each `subscribe` is a local transaction, and on OPFS a commit costs about 3 ms. Declaring 400 units one at a time costs about 1.2 s before the first round. `subscribeMany` (`subscribe_many` in Rust) writes them in one transaction and registers none of them when one entry is invalid.

See [Subscriptions & the outbox](/concepts-subscriptions/).

### Don't assume a new row starts at version 1

An insert starts the row's `server_version` one above the partition's delete floor: the highest version recorded by a delete whose row the commit left absent. A delete and a scope move advance the version like an upsert. Code that treats `server_version = 1` as "never edited" or compares versions across rows reads wrong values; compare a row's versions only with its own earlier versions.

See [Commits, cursors, idempotency](/concepts-commits/) and [SPEC §2.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#22-changes-rows-versions).

## Scopes and hidden data

### Don't hide information with a client-side filter

Everything a unit's effective scopes allow arrives in the device's SQLite database, which the user can read. A query that hides gamemaster notes or a draft from the UI hides nothing. Put hidden information in a scope the viewer does not hold, so the server never sends the rows.

See [Scopes & authorization](/concepts-scopes/).

### Do declare the scopes a write requires

The server authorizes a write against the stored row and, by default, requires every declared scope variable to be in the actor's allowed values. A row that carries campaign and user scopes cannot be changed by a campaign owner who holds only the campaign scope. Set `writeScopeVariables` on the server table when the campaign grant is intended to authorize writes independently of the user read scope. Every variable in that list must match.

Use a registered remote command when the operation requires authorization beyond a fixed set of scope variables. A `RemoteOperationResolver` binds the registry, the commit actor, and extra scopes for one call. Available since 0.34.0.

See [Independent read and write scopes](/concepts-scopes/#independent-read-and-write-scopes) and [Bind the registry per request](/guide-remote-operations/#bind-the-registry-per-request).

### Don't let a plain write create the scope it needs

The server resolves the actor's scopes before it applies a push, and the resolver does not see rows in the push. Creating a campaign (a new `campaign:{id}` value) or joining one by invite cannot be an ordinary write, because the actor does not hold the scope yet. Use a registered command that grants the new scope for that one call. One app first modelled this with a user-scoped link table and two commits, and moved to a single command once the resolver existed.

See [Remote server operations](/guide-remote-operations/).

### Don't expect the client to ask which scope values it may request

A client names concrete values, and a requested `'*'` fails. Nothing returns the list of values the account may request, so a newly signed-in device knows no campaign id. Give the account a row it already holds in a scope it has, which lists its memberships (the membership row can carry a second scope for the user), and derive units from that row. **Open:** a read of the effective allowed values per variable does not exist.

See [SPEC §3.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#32-requested-allowed-effective).

### Do refresh open sockets when membership changes

A session resolves its scopes when it registers. A host that changes an actor's membership calls the hub's `refreshScopes(partition, actorId?)`, or waits for each client's next round. The call fails closed: a session whose resolver throws loses every registration.

See [SPEC §8.7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#87-sync-rounds-over-the-socket).

### Don't make `resolveScopes` a chain of queries

The server resolves scopes once per request, on every socket connect, and on every registration refresh (SPEC §3.2). One app ran 5 to 8 queries one after another in its resolver. Behind Hyperdrive each query is a network round trip (8 to 10 ms from a Durable Object in one region to Neon), so the resolver set the floor for every round. Fold the lookups into one statement that returns one array per scope variable. The same holds for `authenticate`.

See [Scopes & authorization](/concepts-scopes/) and [SPEC §3.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#32-requested-allowed-effective).

## Writes and the outbox

### Don't write unchanged values

Applying an upsert increments the row's `server_version` and the `column_version` of every present column, appends a commit to the log, and fans it out (SPEC §6.2). Nothing compares the new value with the stored one, and the idempotency key identifies a retry of one commit and says nothing about equal content. A write that sets a value already set is a full write.

One app re-set a status on every start. The row got a new `updated_at` each time, which produced 14 commits per reload and about 600 needless commits and version bumps in production before the fix. Compare before you mutate, and keep the "already settled" fact in a synced or local row instead of in memory, so a restart does not forget it.

See [SPEC §6.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#62-conflict-detection) and [Commits, cursors, idempotency](/concepts-commits/).

### Do recreate a deleted row with `baseVersion = 0`

The server keeps a tombstone for every applied delete until the pruning horizon passes it, and an upsert without a `baseVersion` that meets the tombstone rejects with `sync.row_deleted` (SPEC §6.2). The rule also applies when the writing client issued the delete itself and its replica no longer holds the row. A server retains at least the newest 1,000 commits (SPEC §4.6), so on a quiet partition the tombstone can outlive the app's interest in it by months.

The rejection rolls back the whole commit: the round removes every optimistic row of that commit from the replica, and the server stores none of them. One app deleted a settings row by mistake and wrote it again in the same commit as imported records. Each attempt rejected, the imported records went with it, and the user found the setting reset after the next launch.

Write a row that the replica does not hold with `baseVersion: 0` (Rust: `base_version: Some(0)`); the explicit insert clears the tombstone. If another client created the row in the meantime, the insert returns `sync.version_conflict` and conflicts the whole commit, so put such inserts in a commit of their own when the other rows must not wait on that conflict.

See [Delete precedence](/concepts-conflicts/#delete-precedence).

### Do read `rejected` in every sync report

A rejected commit is an outcome of a successful round. `sync()` and `syncUntilIdle()` (Rust: `sync_until_idle`) resolve with a report, and `report.rejected` lists the client commit ids the server refused. The round has already rolled the commit back. A host that reads only the outcome kind keeps showing the rows from memory until a restart reads the replica. Look up each id with `commitOutcome(id)` (Rust: `commit_outcome(&id)`) for the code and the operations, and surface it.

See [Outbox & commit outcomes](/reference-outbox-outcomes/).

### Don't push a value you do not want stored

A validator accepts or rejects a push. It cannot transform or redact a value, so the stored row is the pushed row and the commit log keeps it. "Check an invite secret on push and never store it" has no direct form. Push a derived proof (a hash over a tag, the scope id, and the secret), store a hash of the proof on the server row, and blank the field on the client after use. The proof still sits in the log. **Open:** an ephemeral column does not exist.

See [SPEC §6.7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#67-write-validation-hooks).

### Don't match errors by message text

Errors carry stable codes, and the HTTP transport types its failures. `sync.transport_failed` carries `details.causeKind` (`network`, `timeout`). A host that matched `/Failed to fetch|ECONNREFUSED/` fell through to its generic error when the wording changed. Read `code` and `details`.

See [Troubleshooting](/troubleshooting/#error-code-index).

### Don't `JSON.stringify` values decoded from tagged integers

The TypeScript core decodes a tagged remote-operation integer (`{t: "integer"}`) to `bigint`, and `JSON.stringify` throws on a `bigint`. Convert at the boundary, or use a replacer.

See [Remote server operations](/guide-remote-operations/).

## Schema and migrations

### Don't carry rows between tables inside a schema bump

A table that leaves the schema is dropped, with its rows and scope index, in the bump's transaction, and its name cannot be reused. The bump runs under `LOCK TABLE sync_partitions IN EXCLUSIVE MODE`, so every push of every partition waits for it. Copying rows during the bump holds that lock for the length of the copy, and plain SQL into the new table skips the scope index, the payload, and the change log.

Create the successor table in one version. Write the rows into it as server-authoritative commits (through `host.serialized` and `contextFor`, so they reach the log and the clients). Retire the source table in a later version, after the counts match. A table cannot turn a required column nullable, gain or lose a scope variable, or drop a column in place, because existing rows keep the scopes they were written with. Every such change takes the same successor route. In one app, two consecutive bumps each moved rows into successor tables this way.

See [Retire tables and indexes](/guide-schema/#retire-tables-and-indexes).

### Don't remove a column or table that a pending commit may still reference

A client that updates keeps its outbox, wipes its tables, and replays the outbox re-encoded at send time. A commit that references a column or table the new schema lacks gets `sync.outbox_incompatible`, leaves the outbox, and its optimistic rows are undone. The user's offline work is lost. Add columns as trailing nullable, move readers and writers, and drop the old column in a later version, after old clients have updated or left the compatibility window.

See [Pending writes across the bump](/concepts-schema-upgrades/#pending-writes-across-the-bump) and [Serving a compatibility window](/concepts-schema-upgrades/#serving-a-compatibility-window).

### Do plan how an old client updates itself

A client below the server's schema floor stops: it pulls nothing and pushes nothing, and its outbox keeps its commits until the app updates and re-encodes them. One app shipped a client whose updater needed a file the new hosting layer no longer served, so the old build could neither sync nor update.

Before a bump that raises the floor, keep an update path that older builds can reach (a stable update endpoint, or a `schemaWindow` that keeps serving them), and show the blocked state with an action that works. Test the path with the previous build.

See [Serving a compatibility window](/concepts-schema-upgrades/#serving-a-compatibility-window).

### Don't point in-progress schema work at a shared database

A schema bump applied to a database becomes that database's history. A draft migration applied to a shared development database makes the next start fail with `sync.storage.stored_layout_mismatch` for everyone who uses it. Auto-migrate on save makes this immediate: the draft applies when the file is saved. Run draft schema work in a worktree with its own database and ports, give each test run a throwaway database, and merge after the shared database is backed up. A deployed migration is immutable. Fix it with a new migration.

See [Schema bumps](/guide-schema/#schema-bumps).

## Blobs and content addressing

### Don't change content that a version or a hash names

A content address names bytes. A published version that never changes lets every cache and registry trust the name. If a row was imported once and its source later changed without a version bump, the registry and the build hold different bytes under one name, and a hash conflict appears at the next import or publish.

Publish changed content as a new version. Before you switch traffic, compare what the registry holds with what the build contains, and repair a mismatch with an explicit compare-and-swap that you record. Never overwrite silently. The server applies the same rule to segments: bytes under an existing content address must be identical, and a mismatch fails loudly instead of overwriting.

See [SPEC §5.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#51-identity-integrity-caching) and [Blobs](/concepts-blobs/).

### Do reference a blob only after the upload is staged

`uploadBlob` stages the bytes and returns the `BlobRef`. The next round uploads the body before it pushes the commit that references it, and the server rejects a commit that references an absent blob with `blob.not_found`. Write the referencing row after `uploadBlob` resolves.

See [Blobs](/concepts-blobs/) and [SPEC §5.9.6](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#596-push-time-existence-check).

### Do size the inline segment limit for your row size

`inlineSegmentMaxBytes` defaults to 256 KiB. A page of 1000 rows of a log table can weigh 0.4 to 1.1 MB, and every such page becomes a `SEGMENT_REF` with its own object-store put on the server and its own download on the client: 245 to 340 ms per page, 1.4 s for four pages on staging. The TypeScript client and the Rust `HostTransport` run four downloads of a response at a time, ahead of the page being applied; a custom `Transport` that keeps the default `download_segments` fetches them in order. An app that raised the inline limit to 2 MiB had no segments in a cold start, at the cost of larger responses, which compression offsets (an app measured 6 to 8 times on rows segments).

See [Bootstrap & segments](/concepts-bootstrap/).

## Hosting: Workers, Durable Objects, Hyperdrive, Neon

### Do disable query caching on the Hyperdrive binding that Syncular reads

Hyperdrive caches SELECT results by default and a write does not invalidate them. The default cache can serve an older result for 60 s plus a 15 s revalidation window. A cached commit maximum below an accepted sequence fails with `sync.storage_stale_read` (the push stays committed). Pass a cache-disabled binding to `PostgresServerStorage`, `authenticate`, and scope resolution. Point the binding at the direct database hostname (for Neon, the one without `-pooler`), because Hyperdrive pools connections itself; both [Neon](https://neon.com/docs/guides/cloudflare-workers) and [Cloudflare](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/neon) tell you to clear the pooled option.

See [Read freshness](/server-storage-reference/#read-freshness) and [PostgreSQL behind Hyperdrive](/server-workers/#postgresql-behind-hyperdrive).

### Do give the Postgres fanout a direct Neon connection

`PostgresFanout` uses `LISTEN`, which needs a session-mode connection. Neon's pooled endpoint (the hostname with `-pooler`) runs PgBouncer in transaction mode and does not support it. Build the fanout connection from the direct hostname. Storage can keep the pooled one. A single server instance installs no fanout, and neither does a Durable Object host, where every commit of a partition goes through one object.

See [Neon](/server-storage-reference/#neon).

### Do run 0.39.2 or later when you run `PostgresFanout`

A listener that drops (a server restart, a failover, a Neon compute that suspended after 5 minutes without queries) misses every notification until it listens again. Before 0.39.2 the instance never learned of the gap, so sessions missed every cross-instance commit in it with no error. Since 0.39.2 each `LISTEN` after the first wakes all local sessions with `catchup-required`.

See [Multi-instance fanout](/server-storage-reference/#multi-instance-fanout).

### Don't commit outside the hub context

A commit made through `contextFor({ partition, actorId })` reaches the matching sockets as a delta. A commit made without it needs a wake-up, and a wake-up makes every socket of the partition pull. In one app with about 400 subscriptions per account on wire version 3, each server-written history commit woke every online client, and the app estimated the pull at about 15 statements and 50 KB each way per client. Run server-side commits, reaction drains, and imports through `host.serialized((contextFor) => ...)`. Available since 0.37.0.

See [Add the Durable Object](/server-workers/#add-the-durable-object).

### Don't wait for the partition queue from inside `host.serialized`

`host.serialized` runs its work on the partition FIFO, and so do pushes and the host's own `fetch` and `webSocketMessage`. Work that awaits one of those from inside `serialized` waits for a queue it blocks. Call the storage or `contextFor` directly from the work, and call `fetch` or `webSocketMessage` outside it.

See [Add the Durable Object](/server-workers/#add-the-durable-object).

### Don't register `operations` beside a `realtime` namespace in the Worker config

A Worker config that passes `operations` next to a `realtime` or `coordinator` namespace fails every `/operations` request, because the command would run outside the FIFO. Register `operations` in `RealtimeDOConfig`. The adapter then forwards `POST /operations` to the partition's object, where the command commits on the same FIFO as pushes.

See [Remote server operations](/guide-remote-operations/) and [Add the Durable Object](/server-workers/#add-the-durable-object).

### Do choose the partition boundary on purpose

Pushes inside one partition serialize on one FIFO and one `sync_partitions` lock, and a schema bump locks all partitions. One partition for every account makes every user's push wait for the pushes before it. Pulls without a `PUSH_COMMIT` run beside the FIFO since 0.37.0. Pick the tenant boundary that data never crosses and use scopes inside it. Accounts that share rows cannot sit in different partitions.

See [Partitions & multi-tenancy](/server-partitions/).

### Do count the round trips in your own hooks

Every statement behind Hyperdrive is a round trip (8 to 10 ms per statement from a Durable Object to Neon in the same region: 5 statements 42 to 51 ms, 44 statements 473 ms). Syncular's own paths shrank across 0.36 to 0.39: a pull's statements no longer grow with the table count (10 per quiet round), a ready database opens in 2 statements, and a push writes one statement per table. Your hooks (`authenticate`, `resolveScopes`, validators, commands) are the remaining cost. Hold one connection per request or Durable Object event, and send statements that can run together together.

See [Storage reference](/server-storage-reference/#postgres).

## Caching and service workers

### Don't cache private responses in a service worker or CDN

Blob and segment downloads answer `Cache-Control: private, max-age=0` with `Vary: Authorization`, and each authorizes per request. A cache keyed on the URL alone serves one user's authorized bytes to another, or serves bytes after a revocation. Keep `/sync`, `/operations`, `/blobs`, and segment downloads out of the worker's cache. Segment bytes are content-addressed and cacheable by path, and the authorization decision is never cacheable.

See [Segment stores](/server-storage-reference/#segment-stores) and [SPEC §1.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#11-endpoints).

### Don't let an SPA fallback answer HTML for paths that are not pages

A fallback that answers `index.html` for every unknown path hands HTML to clients that expect JavaScript, JSON, or an SSP2 envelope. `/sw.js` returning HTML means the browser never installs a service worker update. A missing hashed asset returning HTML fails the module import with a syntax error. Route the sync paths and your auth paths to the server first, answer 404 for missing assets and well-known files, and apply the fallback to navigations only.

See [SPEC §1.1](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#11-endpoints): `/sync` requires `application/vnd.syncular.sync.v2` and answers other content types with HTTP 415.

## Upgrades

### Do upgrade every `@syncular/*` package and `syncular-client` crate together

Syncular publishes every package and crate in lockstep, and the two cores are locked against each other by conformance scenarios. Pin exact versions and move npm packages, crates, and the Tauri plugin in one change. Read the release notes for regressions: 0.39.0 made the row statement of a PostgreSQL commit grow with the square of its rows (3,000 rows took 1,588 ms, a 72,016-change commit 320 s), and 0.39.1 fixed it.

See the [release notes](https://github.com/syncular/syncular/blob/main/docs/RELEASE-NOTES.md).

### Do remove host-side compression when you move to 0.39

Since 0.39.0 the adapter negotiates zstd or gzip for `/sync`, `/operations`, segments, and blob downloads, and the Workers handler declares `Content-Encoding: gzip` for the Durable Object's answer so that workerd encodes it once. A host wrapper that adds its own `Content-Encoding` on top sends gzip inside gzip. Before 0.39 the Workers handler left bodies uncompressed, so the wrapper had a reason to exist; delete it when you upgrade.

See [Transport compression](/server-workers/#transport-compression) and [SPEC §1.3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#13-transport-compression).

### Do remove a workaround when its fix ships

Hosts that carry patches or copies of Syncular code (a copied host class, a forked client, a hand-built segment store) keep them past the release that made them redundant, and the copy then misses later changes (a copied Durable Object host missed the 0.36 and 0.37 queue changes). After each upgrade, list your workarounds against the release notes and delete the ones the release closes. Report a gap you work around to the maintainers, with where, a repro, a suggested fix, and your workaround, so it gets a number and an owner.
