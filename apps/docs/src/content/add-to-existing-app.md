# Add Syncular to an existing app

This page is for developers who already have an app with a `package.json` and want the Syncular CLI, a starter schema, and a generated schema module in it. You finish with `src/syncular.generated.ts`, the one `schema` object that your server and clients share.

::meta{for="Developers adding sync to an app that already exists" time="5 minutes" first="quickstart"}

:::terms
- **Manifest**: `syncular.json`, which names the synced tables, their scopes, and the schema versions.
- **Migration lock**: `syncular.migrations.lock.json`, which locks deployed migration history against edits.
- **Typegen**: The CLI in `@syncular/typegen` that turns migrations into typed code.
:::

:::figure{title="What typegen reads and writes" note="Inputs are committed, outputs are generated" ticks}
<div class="d-row">
<div class="node hot"><span class="t">Inputs</span>syncular.json<br>migrations/*/up.sql<br>migration lock<br>queries/*.sql</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">syncular generate</span>Checks locked history, lowers named queries</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Outputs</span>syncular.ir.json<br>src/syncular.generated.ts<br>src/syncular.queries.ts</div>
</div>

::caption[Typegen reads SQL files only. It does not inspect or import an existing database.]
:::

## Steps

:::::steps
::::step{title="Install the CLI" time="1 min"}
Run this in the directory that holds your app's `package.json`:

```sh title="terminal"
bun add --dev @syncular/typegen
```

::checkpoint[`bunx syncular --help` lists the commands.]
::::

::::step{title="Create the schema inputs" time="1 min"}
:::tabs
```sh label="Starter schema" title="terminal"
bunx syncular init --manifest-dir .
```
```sh label="Your own tables" title="terminal"
# Write syncular.json and migrations/0001_initial/up.sql yourself
# (see Schema & typegen), then lock the history:
bunx syncular migrations baseline --manifest-dir .
```
:::

`init` writes four files and refuses to overwrite any of them. If `syncular.json` already exists, skip `init`.

| File | Contents |
|---|---|
| `syncular.json` | The synced tables, scopes, schema versions, and output paths. |
| `migrations/0001_initial/up.sql` | A starter `notes` table with `id`, `list_id`, `body`, and `updated_at_ms`. |
| `syncular.migrations.lock.json` | The lock on the initial migration. |
| `queries/notes-in-list.sql` | A typed read of the notes in one list. |

For your own tables, author the manifest and migrations as described in [Schema & typegen](/guide-schema/#the-committed-schema-inputs). `baseline` creates the first lock from the current history and refuses to overwrite an existing one.

::checkpoint[`syncular.json` and `syncular.migrations.lock.json` exist in the app root.]
::::

::::step{title="Generate the schema module" time="30 s"}
```sh title="terminal"
bunx syncular generate --manifest-dir .
```

Typegen writes `syncular.ir.json`, `src/syncular.generated.ts`, and `src/syncular.queries.ts`. The `output.module` field in `syncular.json` sets the schema module's path.

::checkpoint[`src/syncular.generated.ts` exports `schema`.]
::::

::::step{title="Import the schema" time="1 min"}
```ts title="src/sync.ts"
import { schema } from './syncular.generated';
```

Pass `schema` to `createSyncClientHandle`, `createTauriSyncClient`, or `SyncClient`, and pass the same object to the sync server config. Generate the module before the app starts. Commit the manifest, migrations, lock, and generated outputs.

::checkpoint[The import typechecks in your app.]
::::
:::::

## Evolving the schema

The starter has a lock already. Extend it with new migrations and [schema versions](/guide-schema/#schema-bumps); a deployed migration is immutable. Run `bunx syncular generate --check` in CI to fail on stale generated files or edited history. The next step for each platform is its guide: [Web](/platform-web/), [Swift](/platform-swift/), [Kotlin](/platform-kotlin/), [Flutter](/platform-flutter/), [React Native](/platform-react-native/), [Tauri](/platform-tauri/), or [Rust](/platform-rust/).
