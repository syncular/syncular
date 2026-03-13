# @syncular/server-dialect-postgres

PostgreSQL dialect for the Syncular server sync schema and query patterns
(commit log, change log, scopes, snapshot chunks, console tables).

Use this when your server is backed by Postgres.

If your runtime is backed by Neon, use `createNeonServerDialect()`. It runs the
same sync SQL behavior, but makes the intended server/runtime pairing explicit in
code and docs.

## Install

```bash
npm install @syncular/server-dialect-postgres
```

## Usage

### Postgres server

```ts
import { ensureSyncSchema } from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';

const dialect = createPostgresServerDialect();
await ensureSyncSchema(db, dialect);
```

### Neon-backed server

```ts
import { ensureSyncSchema } from '@syncular/server';
import { createNeonServerDialect } from '@syncular/server-dialect-postgres';

const dialect = createNeonServerDialect();
await ensureSyncSchema(db, dialect);
```

### Neon-backed server with umbrella imports

```ts
import { ensureSyncSchema } from 'syncular/server';
import { createNeonServerDialect } from 'syncular/server-dialect-neon';

const dialect = createNeonServerDialect();
await ensureSyncSchema(db, dialect);
```

## Documentation

- Dialects: https://syncular.dev/docs/server/dialects
- Server setup: https://syncular.dev/docs/build/server-setup

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
