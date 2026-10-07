# CLI reference

The `syncular` CLI ships in `@syncular/typegen`. It scaffolds a manifest,
generates the schema IR and typed code, locks migration history, formats
`.syql` files, and runs the `.syql` language server. This page is for
developers who need an exact command, option, or exit behavior.

::meta{for="App developers and CI authors" time="Reference" first="guide-schema" spec="2"}

:::terms
- **Manifest directory**: The directory that holds `syncular.json`. Every command takes it as `--manifest-dir`.
- **Migration lock**: `syncular.migrations.lock.json`, the committed baseline of deployed migration history.
- **Generated output**: A file `generate` writes. Each one carries the IR hash in its header.
:::

:::figure{title="What each command reads and writes" note="Run with bunx syncular" ticks}
<div class="d-cols-3">
<div class="node ok"><span class="t">init</span>Writes a starter manifest, migration, lock, and query</div>
<div class="node hot"><span class="t">generate</span>Reads migrations, manifest, lock, queries<br>Writes IR and every configured output</div>
<div class="node"><span class="t">migrations</span>baseline, check, or upgrade-lock<br>Reads and writes only the lock</div>
</div>
<div class="d-cols-2">
<div class="node"><span class="t">fmt</span>Rewrites <code>.syql</code> files in canonical form</div>
<div class="node cool"><span class="t">lsp</span>Serves diagnostics and navigation to an editor over stdio</div>
</div>

::caption[A failing command exits non-zero, so every command works as a CI gate.]
:::

Run the CLI with `bunx syncular`, or with the `syncular` bin from your package
manager. Every command takes `--manifest-dir <dir>`, the directory that holds
`syncular.json` (default: the current directory). An unknown argument prints the
usage text and exits non-zero. The workflow these commands serve is on
[Schema & typegen](/guide-schema/) and [Named queries](/tooling-queries/).

## `syncular init`

```sh title="terminal"
syncular init --manifest-dir .
```

Adds a starter `syncular.json`, `migrations/0001_initial/up.sql`,
`syncular.migrations.lock.json`, and `queries/notes-in-list.sql` to the manifest
directory. It refuses to overwrite any of these files. Run `syncular generate`
afterward to produce the schema and typed query modules. The installation
commands and file layout are on
[Add Syncular to an existing app](/add-to-existing-app/).

## `syncular generate`

```sh title="terminal"
syncular generate --manifest-dir .
```

Validates locked migration history, appends valid new migrations to the lock,
and writes the schema IR plus every configured output: the TypeScript schema
module, the Swift, Kotlin, and Dart schema modules, and the `.sql` and `.syql`
named queries for all configured targets. Commit the lock and all generated
outputs. It prints one `wrote <path>` line per file.

| Option | Meaning |
|---|---|
| `--manifest-dir <dir>` | The directory that holds `syncular.json`. Default `.`. |
| `--check` | Regenerate in memory and exit 1 unless every file on disk is byte-exactly fresh. Prints `generated output is up to date` on success. |
| `--watch` | Regenerate on change under the manifest directory, debounced by 50 ms. A bad intermediate state prints an error and keeps watching. |
| `--print <name>` | Print one named query's lowered, checked SQL (parameters, tables, variants) and exit. |

`--check` and `--watch` cannot be combined, and `--print` cannot combine with
either. `generate --check` is the CI gate: it catches missing generated changes
and any edit, removal, rename, reorder, type change, or nullability change in
deployed history.

### Manifest keys that select outputs

| Key | Output |
|---|---|
| `migrations` | Migration directory. Default `./migrations`. |
| `queries` | Named-query directory. Default `./queries`. Read only when an output requests a queries file. |
| `naming` | `"camel"` (default) or `"preserve"` for generated names. |
| `queryBackend` | `"auto"` (default), `"variants"`, or `"neutralize"`. Chooses the SYQL lowering; the public API and the rows stay the same. |
| `output.ir` | Schema IR path. Default `./syncular.ir.json`. |
| `output.module` | TypeScript schema module. Default `./syncular.generated.ts`. |
| `output.queryIr` | Analyzed QueryIR JSON. Its hash keys generated reactive descriptors. |
| `output.queries` | TypeScript named-queries file. |
| `output.swift`, `output.kotlin`, `output.dart` | Native schema modules, as a path or an object with `path` and `queriesPath`. |
| `output.rust` | Rust named queries: `{ "queriesPath", "clientCrate"? }`. |

The key-by-key contract is in the
[typegen README](https://github.com/syncular/syncular/blob/main/packages/typegen/README.md).

## `syncular migrations`

```sh title="terminal"
syncular migrations check --manifest-dir .
```

The lock has three subcommands:

| Subcommand | Meaning |
|---|---|
| `baseline` | Create the first lock from current history. Refuses to overwrite an existing lock. |
| `check` | Validate committed history without generating outputs, the faster history-only CI gate. Prints `migration history is locked and unchanged`. |
| `upgrade-lock` | Compact a validated format 1 lock to format 2. Review and commit the result. |

The lock workflow and the rules for editing deployed history are on
[Schema & typegen](/guide-schema/#lock-the-migration-history).

## `syncular fmt`

```sh title="terminal"
syncular fmt queries/search-todos.syql
syncular fmt --check
```

Formats `.syql` files in canonical form: one style, no options. Given no files,
it formats the manifest's queries directory recursively. `--check` exits 1 and
names each file that is not canonical, and it writes nothing. The formatter
preserves semantics and is idempotent. `fmt` accepts `.syql` files only and
fails on any other extension.

## `syncular lsp`

```sh title="terminal"
syncular lsp
```

Runs the `.syql` language server over stdio for editor tooling: diagnostics,
formatting, symbols, and hover, definition, and references for imported
predicates. The VS Code extension launches it automatically. Every stable
diagnostic code has one remediation instruction, which the server publishes as
`Diagnostic.data.remedy` ([SYQL](/syql/#generated-targets-and-tooling)).
