# CLI reference

The `syncular` CLI ships in `@syncular/typegen`. Run it with `bunx syncular`
(or the `syncular` bin from your package manager). Every command takes
`--manifest-dir <dir>`, the directory holding `syncular.json` (default: the
current directory). A failing command exits non-zero, so every command works
as a CI gate.

## `syncular init`

Scaffolds a starter `syncular.json` plus `migrations/0001_initial` into the
manifest directory. `bun create syncular-app` runs a superset of this; `init`
serves existing projects adopting syncular.

## `syncular generate`

Validates locked migration history, appends valid new migrations to the
lock, and writes the schema IR plus every configured output: the TypeScript
schema module, Swift/Kotlin/Dart schema modules, and `.sql`/`.syql` named
queries for all configured targets. Commit the lock and all generated
outputs.

| Option | Meaning |
|---|---|
| `--check` | Fail unless generated files are byte-exactly fresh |
| `--watch` | Regenerate on file change |
| `--print <name>` | Print one named query's lowered, checked SQL (params, tables, knob variants) and exit |

`generate --check` is the CI gate: it catches missing generated changes and
any edit, removal, rename, reorder, type change, or nullability change in
deployed history.

## `syncular migrations`

The immutable-history lock (`syncular.migrations.lock.json`) has three
subcommands:

| Subcommand | Meaning |
|---|---|
| `baseline` | Create the first lock from current history; refuses overwrite |
| `check` | Validate committed history without generating outputs (the faster history-only CI gate) |
| `upgrade-lock` | Explicitly compact a validated format-1 lock to format 2 |

The lock workflow and the rules for editing deployed history are in
[Schema & typegen](/guide-schema/).

## `syncular fmt`

Formats `.syql` files canonically: one style, no options. Given no files, it
formats the manifest's queries directory recursively. `--check` fails unless
every file is already canonical. The formatter is semantic-preserving and
idempotent.

## `syncular lsp`

Runs the `.syql` language server over stdio for editor tooling: diagnostics,
formatting, symbols, and hover/definition/references for imported
predicates. The VS Code extension launches it automatically.

## Where to go next

- [Schema & typegen](/guide-schema/): the manifest, migrations, and lock the
  CLI operates on.
- [Named queries](/tooling-queries/): the `.sql`/`.syql` surface `generate`
  and `fmt` build.
