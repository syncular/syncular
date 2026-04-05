# @syncular/migrations

Versioned migration utilities for Syncular apps. Provides `defineMigrations()` and `runMigrations()` with migration tracking and optional generated checksum validation (plus an optional reset strategy for client DBs).

## Install

```bash
npm install @syncular/migrations
```

## Usage

```ts
import {
  createMigrationTrackingTableName,
  runMigrations,
} from '@syncular/migrations';
import { migrations } from './migrations';
import { migrationChecksums } from './migrations.checksums.generated';

await runMigrations({
  db,
  migrations,
  checksums: migrationChecksums,
  trackingTable: createMigrationTrackingTableName(['my_app', 'client']),
});
```

Define the migrations in a separate source module, for example:

```ts
// migrations.ts
import { defineMigrations } from '@syncular/migrations';

export const migrations = defineMigrations({
  v1: {
    up: async (db) => {
      await db.schema.createTable('tasks').addColumn('id', 'text').execute();
    },
    down: async (db) => {
      await db.schema.dropTable('tasks').ifExists().execute();
    },
  },
  v2: {
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
```

Use `createMigrationTrackingTableName(...)` whenever you want a custom table.
It keeps names lowercase, predictable, and consistently suffixed with
`migration_state`.

Use `checksum: 'deterministic'` for migrations that have a generated checksum
manifest. Generate that manifest with `@syncular/typegen`; `runMigrations`
compares the stored checksum against the generated SQL-trace checksum at
runtime.

Use `checksum: 'disabled'` for migrations that cannot be replayed safely during
build-time checksum generation. Disabled migrations still track
version/application state, but they skip checksum creation and mismatch checks.

## Documentation

- Schema migrations: https://syncular.dev/docs/build/migrations

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
