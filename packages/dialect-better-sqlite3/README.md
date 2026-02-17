# @syncular/dialect-better-sqlite3

better-sqlite3 Kysely dialect for Node.js/Electron.

## Install

```bash
npm install @syncular/dialect-better-sqlite3
```

## Usage

```ts
import { createBetterSqlite3Db } from '@syncular/dialect-better-sqlite3';

const db = createBetterSqlite3Db<MyDb>({ path: './app.sqlite' });
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
