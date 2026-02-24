# @syncular/dialect-libsql

LibSQL/Turso Kysely dialect.

## Install

```bash
npm install @syncular/dialect-libsql
```

## Usage

```ts
import { createDatabase } from '@syncular/core';
import { createLibsqlDialect } from '@syncular/dialect-libsql';

const db = createDatabase<MyDb>({
  dialect: createLibsqlDialect({ url: './app.sqlite' }),
  family: 'sqlite',
});
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
