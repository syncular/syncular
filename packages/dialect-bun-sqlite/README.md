# @syncular/dialect-bun-sqlite

Bun SQLite Kysely dialect for Syncular clients and scripts.

## Install

```bash
npm install @syncular/dialect-bun-sqlite
```

## Usage

```ts
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';

const db = createBunSqliteDb<MyDb>({ path: './app.sqlite' });
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
