# @syncular/server-dialect-sqlite

SQLite dialect for the Syncular server sync schema and query patterns (commit log, change log, scopes, snapshot chunks, console tables).

Commonly used for dev/test setups and for edge deployments that use a SQLite-compatible backend.

## Install

```bash
npm install @syncular/server-dialect-sqlite
```

## Usage

```ts
import { ensureSyncSchema } from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';

const dialect = createSqliteServerDialect();
await ensureSyncSchema(db, dialect);
```

## Documentation

- Dialects: https://syncular.dev/docs/server/dialects
- Server setup: https://syncular.dev/docs/build/server-setup

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
