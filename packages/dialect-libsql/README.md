# @syncular/dialect-libsql

LibSQL/Turso Kysely dialect.

## Install

```bash
npm install @syncular/dialect-libsql
```

## Usage

```ts
import { createLibsqlDb } from '@syncular/dialect-libsql';

const db = createLibsqlDb<MyDb>({ url: './app.sqlite' });
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
