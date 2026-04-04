# @syncular/migrations

Versioned migration utilities for Syncular apps. Provides `defineMigrations()` and `runMigrations()` with migration tracking and deterministic checksum validation (plus an optional reset strategy for client DBs).

## Install

```bash
npm install @syncular/migrations
```

## Usage

```ts
import {
  createMigrationTrackingTableName,
  defineMigrations,
  runMigrations,
} from '@syncular/migrations';

export const migrations = defineMigrations({
  v1: {
    checksum: 'deterministic',
    up: async (db) => {
      await db.schema.createTable('tasks').addColumn('id', 'text').execute();
    },
    down: async (db) => {
      await db.schema.dropTable('tasks').ifExists().execute();
    },
  },
  v2: {
    checksum: 'deterministic',
    up: async (db) => {
      await db.schema
        .alterTable('tasks')
        .addColumn('done', 'integer')
        .execute();
    },
    down: async (db) => {
      await db.schema.alterTable('tasks').dropColumn('done').execute();
    },
  },
});

await runMigrations({
  db,
  migrations,
  trackingTable: createMigrationTrackingTableName(['my_app', 'client']),
});
```

Use `createMigrationTrackingTableName(...)` whenever you want a custom table.
It keeps names lowercase, predictable, and consistently suffixed with
`migration_state`.

Use `checksum: 'deterministic'` for migrations that can be replayed into a
scratch in-memory database. Syncular hashes the actual SQL trace emitted by the
migration instead of the JavaScript source, which avoids bundle/minifier drift.

Use `checksum: 'disabled'` for browser/service-worker or otherwise
runtime-specific migrations where Syncular cannot safely create the matching
scratch database. Disabled migrations still track version/application state, but
they skip checksum creation and mismatch checks.

## Documentation

- Schema migrations: https://syncular.dev/docs/build/migrations

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
