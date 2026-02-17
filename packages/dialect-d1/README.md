# @syncular/dialect-d1

Cloudflare D1 Kysely dialect.

Pair with `@syncular/server-dialect-sqlite` when running a Syncular server on a SQLite-compatible backend.

## Install

```bash
npm install @syncular/dialect-d1
```

## Usage

```ts
import { createD1Db } from '@syncular/dialect-d1';

const db = createD1Db<MyDb>(env.DB);
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects
- Cloudflare adapter: https://syncular.dev/docs/server/cloudflare-adapter

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
