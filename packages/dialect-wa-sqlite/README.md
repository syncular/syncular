# @syncular/dialect-wa-sqlite

wa-sqlite (WASM) Kysely dialect for browser SQLite.

## Install

```bash
npm install @syncular/dialect-wa-sqlite
```

## Usage

```ts
import { createDatabase } from '@syncular/core';
import { createWaSqliteDialect } from '@syncular/dialect-wa-sqlite';

const db = createDatabase<MyDb>({
  dialect: createWaSqliteDialect({ fileName: 'app.sqlite' }),
  family: 'sqlite',
});
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
