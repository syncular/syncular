# @syncular/server-dialect-postgres

PostgreSQL dialect for the Syncular server sync schema and query patterns (commit log, change log, scopes, snapshot chunks, console tables).

Use this when your server is backed by Postgres.
For Neon-backed runtimes, use `createNeonServerDialect()` to make that intent
explicit in your server code while keeping the same sync SQL behavior.

## Install

```bash
npm install @syncular/server-dialect-postgres
```

## Usage

```ts
import { ensureSyncSchema } from '@syncular/server';
import {
  createNeonServerDialect,
  createPostgresServerDialect,
} from '@syncular/server-dialect-postgres';

const dialect = createPostgresServerDialect();
await ensureSyncSchema(db, dialect);

const neonDialect = createNeonServerDialect();
await ensureSyncSchema(neonDb, neonDialect);
```

## Documentation

- Dialects: https://syncular.dev/docs/server/dialects
- Server setup: https://syncular.dev/docs/build/server-setup

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
