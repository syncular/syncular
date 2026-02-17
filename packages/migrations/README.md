# @syncular/migrations

Versioned migration utilities for Syncular apps. Provides `defineMigrations()` and `runMigrations()` with migration tracking and checksum validation (plus an optional reset strategy for client DBs).

## Install

```bash
npm install @syncular/migrations
```

## Usage

```ts
import { defineMigrations, runMigrations } from '@syncular/migrations';

export const migrations = defineMigrations({
  v1: async (db) => {
    await db.schema.createTable('tasks').addColumn('id', 'text').execute();
  },
  v2: async (db) => {
    await db.schema.alterTable('tasks').addColumn('done', 'integer').execute();
  },
});

await runMigrations({ db, migrations });
```

## Documentation

- Schema migrations: https://syncular.dev/docs/build/migrations

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
