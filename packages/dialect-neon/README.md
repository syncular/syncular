# @syncular/dialect-neon

Neon serverless Postgres Kysely dialect (HTTP).

Useful for stateless serverless/edge environments. Pair with `@syncular/server-dialect-postgres` when running a Syncular server on Postgres.

## Install

```bash
npm install @syncular/dialect-neon
```

## Usage

```ts
import { createNeonDb } from '@syncular/dialect-neon';

const db = createNeonDb<MyDb>({ connectionString: process.env.DATABASE_URL! });
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects
- Server dialects: https://syncular.dev/docs/server/dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
