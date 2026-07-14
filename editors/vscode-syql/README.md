# syncular-syql — VS Code support for `.syql`

Syntax highlighting for SYQL revision 1. The grammar covers `import`, `query`,
`sync query`, and `predicate` declarations; typed optional values, ranges, and
atomic records; SQL-position dynamic order and limit controls; normal predicate
calls; and `when`/`present` conjuncts. SQL remains embedded as `source.sql`, so
the active SQL theme still applies.

## Install (from the repo)

The extension is not published; load it as a local extension:

```sh
# symlink into your VS Code extensions dir
ln -s "$(pwd)/editors/vscode-syql" ~/.vscode/extensions/syncular-syql
```

…or open the folder and use `Developer: Install Extension from Location…`.

## Diagnostics

Generate-time checks are the source of truth. Wire them to save with a task
that runs:

```sh
syncular generate --check
```

The `syncular lsp` server provides compiler diagnostics, imported-predicate
navigation/references, hover, document symbols, and canonical formatting.
`syncular fmt --check` remains the CI-friendly formatting gate.
