# @syncular/dialects

Kysely runtime dialects for Syncular, exposed as subpath exports. Each dialect
ships behind its own subpath so importing one never loads the drivers of the
others. Database drivers are optional peer dependencies — install only the
driver (and Kysely adapter, where noted) for the dialect you use.

## Install

```bash
npm install @syncular/dialects kysely
```

Then add the driver packages for your dialect (see each section below).

## better-sqlite3 (Node.js / Electron)

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

```ts
import { createDatabase } from '@syncular/core';
import { createBetterSqlite3Dialect } from '@syncular/dialects/better-sqlite3';

const db = createDatabase<MyDb>({
  dialect: createBetterSqlite3Dialect({ path: './app.sqlite' }),
  family: 'sqlite',
});
```

## Bun SQLite (Bun)

```bash
npm install kysely-bun-sqlite
```

```ts
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialects/bun-sqlite';

const db = createDatabase<MyDb>({
  dialect: createBunSqliteDialect({ path: './app.sqlite' }),
  family: 'sqlite',
});
```

## Cloudflare D1 (Workers)

Pair with `@syncular/server-dialect-sqlite` when running a Syncular server on a
SQLite-compatible backend.

```bash
npm install kysely-d1
npm install -D @cloudflare/workers-types
```

```ts
import { createDatabase } from '@syncular/core';
import { createD1Dialect } from '@syncular/dialects/d1';

const db = createDatabase<MyDb>({
  dialect: createD1Dialect(env.DB),
  family: 'sqlite',
});
```

## LibSQL / Turso (Node.js / Edge)

```bash
npm install libsql
```

```ts
import { createDatabase } from '@syncular/core';
import { createLibsqlDialect } from '@syncular/dialects/libsql';

const db = createDatabase<MyDb>({
  dialect: createLibsqlDialect({ url: './app.sqlite' }),
  family: 'sqlite',
});
```

## Neon serverless Postgres (Serverless / Edge)

Neon's HTTP driver for stateless serverless and edge environments. When you are
running a Syncular server on Neon-backed Postgres, pair it with
`createNeonServerDialect()` from `@syncular/server-dialect-postgres`.

```bash
npm install kysely-neon @neondatabase/serverless
```

```ts
import { createDatabase } from '@syncular/core';
import { createNeonDialect } from '@syncular/dialects/neon';

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

## PGlite (Browser / WASM Postgres)

```bash
npm install kysely-pglite-dialect @electric-sql/pglite
```

```ts
import { createDatabase } from '@syncular/core';
import { createPgliteDialect } from '@syncular/dialects/pglite';

const db = createDatabase<MyDb>({
  dialect: createPgliteDialect({ dataDir: 'idb://app' }),
  family: 'postgres',
});
```

## node-sqlite3 (Node.js)

```bash
npm install kysely-generic-sqlite sqlite3
```

```ts
import { createDatabase } from '@syncular/core';
import { createSqlite3Dialect } from '@syncular/dialects/sqlite3';

const db = createDatabase<MyDb>({
  dialect: createSqlite3Dialect({ path: './app.sqlite' }),
  family: 'sqlite',
});
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects
- Server dialects: https://syncular.dev/docs/server/dialects
- Cloudflare adapter: https://syncular.dev/docs/server/cloudflare-adapter

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
