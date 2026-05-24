# WP-35 Rust-First Public Docs API Cleanup

Status: `[x]` accepted

## Goal

Clean up public docs that still show pre-Rust client APIs after the navigation
rewrite. The docs should consistently teach the generated app contract,
Rust-owned SQLite runtime, generated subscriptions, generated mutations, and
current React/browser lifecycle surface.

## Scope

- Remove public examples that still use `defineClientSync`, `sync.addHandler`,
  hand-created client sync tables, old `SyncProvider` props, or browser client
  dialect selection.
- Keep server-side dialect guidance where it describes server storage, not
  client runtime storage.
- Replace old client migration guidance with the generated SQL-migration and
  app-contract flow.
- Keep changes docs-only unless a stale docs example exposes a concrete product
  API mismatch that must be fixed separately.

## Non-Scope

- Runtime API changes.
- Compatibility redirects.
- Performance benchmark changes.
- External CLI implementation changes in the separate CLI repository.

## Required Gates

- `git diff --check`
- Focused old public client API scan:

```bash
rg -n 'defineClientSync|sync\\.addHandler|createSyncularDatabase\\(|SyncProvider\\s*$|db=\\{db\\}|transport=\\{transport\\}|identity=\\{|migrate=\\{|onMigrationError|wa-sqlite|WA-SQLite|--react-dialect|--vanilla-dialect|--electron-dialect|client dialect' apps/docs/content/docs -g '*.mdx'
```

- `bun --cwd apps/docs types:check`
- `bun --cwd apps/docs build`
- Browser smoke for the touched docs pages.

## Work Batches

### Batch 1: Public API Examples

- `[x]` Update subscriptions docs to use generated app contracts,
  `createSyncularAppDatabase`, generated subscription helpers, and
  `setSubscriptions`.
- `[x]` Update performance docs to use Rust-owned SQLite, generated local
  schema/indexes, client `config.pull`, `lifecycle.pollIntervalMs`, and
  generated mutations.
- `[x]` Update error-handling docs to use diagnostics, managed client status,
  and React hooks over the current provider shape.
- `[x]` Update migration docs to the Rust-first SQL migration, app-contract,
  codegen, and version-aware server handler flow.
- `[x]` Update CLI reference pages so generated client targets no longer expose
  old browser/client dialect flags.
- `[x]` Update remaining reference snippets that use old client provider props.
- `[x]` Update `packages/client/README.md` follow-up examples that still
  mentioned removed inline websocket applies, used the wrong generated
  database subscription method, or mixed managed-client shortcuts into
  generated-database realtime examples.

## Accept / Reject Rule

Accept docs-only cleanup when the focused scan is clean, docs gates pass, and
the examples are grounded in current package APIs. Revert any example that
would require inventing a runtime API not present in this repo.

## Current Evidence

- Initial audit found stale public examples in:
  - `learn/subscriptions.mdx`
  - `learn/conflict-resolution.mdx`
  - `learn/glossary.mdx`
  - `features/audit-and-history.mdx`
  - `features/migrations.mdx`
  - `features/error-handling.mdx`
  - `operate/performance.mdx`
  - `operate/troubleshooting.mdx`
  - `reference/cli/index.mdx`
  - `reference/cli/create.mdx`
  - `reference/server/subscription-registry.mdx`
- Batch 1 passes:
  - `git diff --check`
  - focused old public client API scan returned no hits for
    `defineClientSync`, `sync.addHandler`, hand-created client sync schema,
    old `SyncProvider` props, old client dialect flags, or removed plugin
    examples.
  - adjacent conflict/plugin scan returned no hits for old
    `resolveConflict(...)`, public `.upsert(...)`, `mutations.commit`,
    request lifecycle plugin hooks, or incrementing-version plugin guidance.
  - Custom internal `/docs` link checker: checked `225` source files and
    `197` docs pages with no missing `/docs` links.
  - `bun --cwd apps/docs types:check`
  - `bun --cwd apps/docs build`
  - Browser smoke for `/docs/learn/subscriptions`,
    `/docs/learn/conflict-resolution`, `/docs/learn/glossary`,
    `/docs/features/audit-and-history`, `/docs/features/error-handling`,
    `/docs/features/migrations`, `/docs/operate/performance`,
    `/docs/operate/troubleshooting`, `/docs/reference/cli`,
    `/docs/reference/cli/create`,
    `/docs/reference/server/subscription-registry`, and
    `/docs/start/installation`.
  - Follow-up package README scan found and fixed two `@syncular/client`
    README mismatches outside the docs app: removed inline websocket apply
    wording, corrected `syncular.client.setSubscriptions()` on generated
    database examples, and moved generated-database presence/event examples to
    `syncular.client.*` instead of managed-client shortcuts.

## Next Action

WP-35 is complete. Return to the roadmap before opening another docs cleanup
batch.
