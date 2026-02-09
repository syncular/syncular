# Syncular (`@syncular`)

Offline-first sync for TypeScript apps: **local SQLite/PGlite on the client**, **Postgres on the server**, and a **commit-log** in between — built on [Kysely](https://kysely.dev).

## Status

**Alpha.** Breaking changes are expected (no backward compatibility guarantees).

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

## Packaging note

This repo is the current source of truth. Most workspace packages are marked `private` today (not published to npm yet).

## License

MIT.
