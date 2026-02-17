# @syncular/dialect-sqlite3

node-sqlite3 Kysely dialect for Node.js.

## Install

```bash
npm install @syncular/dialect-sqlite3
```

## Usage

```ts
import { createSqlite3Db } from '@syncular/dialect-sqlite3';

const db = createSqlite3Db<MyDb>({ path: './app.sqlite' });
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
