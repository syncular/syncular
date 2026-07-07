# syncular-syql — VS Code support for `.syql`

Syntax highlighting for Syncular's `.syql` query files (the DSL tier of the
query surface — see `DESIGN-queries.md`). The container grammar (`query` /
`fragment` declarations, signatures with `?` optionals, `from+to?` groups and
`?: flag` annotations, the `orderBy` / `limit` / `variants` knobs, `@fragment`
refs, `if (…) { … }` guards) is highlighted natively; everything inside a
body is an **embedded SQL region** (`source.sql`), so your SQL theme applies.

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

Formatting: `syncular fmt` is the canonical formatter (one style, no
options); run it on save via a task, or `syncular fmt --check` in CI.
