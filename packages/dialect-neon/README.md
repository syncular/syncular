# @syncular/dialect-neon

Neon serverless Postgres Kysely dialect (HTTP).

Useful for stateless serverless and edge environments.

This package is the Kysely runtime dialect. When you are running a Syncular
server on Neon-backed Postgres, pair it with `createNeonServerDialect()` from
`@syncular/server-dialect-postgres` (or `syncular/server-dialect-neon`).

## Install

```bash
npm install @syncular/dialect-neon
```

## Usage

```ts
import { createDatabase } from '@syncular/core';
import { createNeonDialect } from '@syncular/dialect-neon';

const db = createDatabase<MyDb>({
  dialect: createNeonDialect({ connectionString: process.env.DATABASE_URL! }),
  family: 'postgres',
});
```

### Server pairing

```ts
import { ensureSyncSchema } from '@syncular/server';
import { createNeonServerDialect } from '@syncular/server-dialect-postgres';

await ensureSyncSchema(db, createNeonServerDialect());
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects
- Server dialects: https://syncular.dev/docs/server/dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
