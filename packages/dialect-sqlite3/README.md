# @syncular/dialect-sqlite3

node-sqlite3 Kysely dialect for Node.js.

## Install

```bash
npm install @syncular/dialect-sqlite3
```

## Usage

```ts
import { createDatabase } from '@syncular/core';
import { createSqlite3Dialect } from '@syncular/dialect-sqlite3';

const db = createDatabase<MyDb>({
  dialect: createSqlite3Dialect({ path: './app.sqlite' }),
  family: 'sqlite',
});
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
