# syncular · Kotlin todo example

A terminal todo app over the [`SyncularClient`](../README.md) wrapper, proving
the Kotlin/FFM bindings drive a real app end-to-end against a real server. It is
a Gradle `application` module ([`:example`](build.gradle.kts)) depending on the
root wrapper project, mirroring the [Swift terminal demo](../../swift/example).

Commands (one per line, interactive or piped): `list`, `add <title>`,
`toggle <id>`, `sync`, `pending`, `quit`.

It talks to the [`examples/quickstart`](../../../examples/quickstart) server's
`notes` table — the same schema and server the quickstart's TS clients use. A
todo is a `notes` row: `body` carries the title, and done-state rides as a
leading `[x] ` / `[ ] ` marker (the quickstart schema has no `done` column and
this example is read-only, so completion is modeled in the body — an honest fit,
no schema fork).

## The integration, in ~30 lines

The whole syncular surface is [`TodoStore`](src/main/kotlin/dev/syncular/example/TodoStore.kt):
the constructor builds a `SyncularClient` (schema + `baseUrl`) and `subscribe`s
to the list; `todos()` is one `query` decoded through the generated typed
`Notes` row; `add`/`toggle` are `mutate`; `sync()` is `syncUntilIdle`. No
protocol logic — the native core owns all of it.

The schema is **generated, not hand-built**:
[`Syncular.generated.kt`](src/main/kotlin/dev/syncular/example/Syncular.generated.kt)
(`SyncularSchema.schema` + the `Notes` data class + the `ListNotes` subscription
helper) comes from [`syncular.json`](syncular.json) + [`migrations/`](migrations)
via `syncular generate` (regenerate with `bun packages/typegen/src/cli.ts
generate --manifest-dir bindings/kotlin/example` from the repo root).
`check.sh` runs `generate --check` (a byte-exact freshness gate, bun-only, so it
runs even without a JDK) before the JVM steps.

## Run it

Needs a JDK 21+ and Gradle (the wrapper's gate detect-and-skips without them —
see [`../README.md`](../README.md)) and `bun` for the quickstart server.

```sh
# 1. Build + vendor the native-transport dylib (ci-smoke.sh does this, or:)
cd rust && cargo build -p syncular-ffi --features native-transport
cp target/debug/libsyncular.* ../bindings/kotlin/vendor/

# 2. Start the quickstart server
cd examples/quickstart && bun run generate && PORT=8787 bun run server

# 3. Run the example (piped or interactive)
cd bindings/kotlin
printf 'add Buy milk\nsync\nlist\nquit\n' | \
  SYNCULAR_URL=http://localhost:8787 gradle -q :example:run
```

Set `SYNCULAR_URL` to point at a server (unset/empty → offline, writes still
queue); set `SYNCULAR_CLIENT_ID` for a stable identity across runs.

## CI proof

[`ci-smoke.sh`](ci-smoke.sh) is the full native-transport-to-real-server proof,
run by the `swift-kotlin-bindings` job in
[`.github/workflows/ci.yml`](../../../../.github/workflows/ci.yml): it builds the
native-transport dylib, starts the quickstart server, runs the example with
scripted stdin (`add` → `sync`), asserts the outbox drained, then has an
**independent** quickstart web-client sync and read the exact row back —
confirming it truly reached the server, not just the local outbox. That is the
prize the wrapper's offline hermetic `gradle test` can't give.
