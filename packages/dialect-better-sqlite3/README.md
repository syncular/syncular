# @syncular/dialect-better-sqlite3

better-sqlite3 Kysely dialect for Node.js/Electron.

## Install

```bash
npm install @syncular/dialect-better-sqlite3
```

## Usage

```ts
import { createDatabase } from '@syncular/core';
import { createBetterSqlite3Dialect } from '@syncular/dialect-better-sqlite3';

const db = createDatabase<MyDb>({
  dialect: createBetterSqlite3Dialect({ path: './app.sqlite' }),
  family: 'sqlite',
});
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
