# Syncular (`@syncular`)

Offline-first sync for TypeScript apps: **local SQLite/PGlite on the client**, **Postgres on the server**, and a **commit-log** in between — built on [Kysely](https://kysely.dev).

## Status

> **Pre-stable (alpha).** Syncular is under active development and has **not** reached v1 yet. APIs, wire formats, and storage layouts **will** change and break without notice between releases. Do not use in production unless you are comfortable pinning versions and migrating manually.

## What Syncular is (in one minute)

- **Local-first**: your app queries a local database (instant UI, works offline).
- **Commit-log sync**: pushes are idempotent commits; pulls fetch commits you haven’t seen.
- **Scopes for auth & routing**: changes are tagged with scope values (stored with each change), and pulls filter by “requested ∩ allowed”.
- **Server-defined shapes**: clients subscribe by shape + scopes (not arbitrary client queries).
- **Typed end-to-end**: TypeScript + Kysely on both client and server.

## Try it locally (recommended)

```bash
bun install
bun --cwd demo dev
```

Open the demo UI at `http://localhost:5173`.

## Docs

```bash
bun --cwd apps/docs dev
```

## Repo checks

```bash
bun check:fix
bun test
```

## Packages

All packages are published to npm under the `@syncular` scope. Install individual packages (e.g. `@syncular/client`, `@syncular/server`) or the umbrella `syncular` package.

## License

MIT.
