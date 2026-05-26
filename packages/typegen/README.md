# @syncular/typegen

Generate TypeScript database types from your migrations.

Supports SQLite and Postgres introspection with column-level codec type overrides via `codecs`.

It also includes build-time helpers for authoring the Rust-first Syncular app
contract and serializing it to the generated Rust-codegen handoff.

## Install

```bash
npm install @syncular/typegen
```

## Usage

```ts
import { codecs } from '@syncular/core';
import { generateTypes } from '@syncular/typegen';
import { migrations } from './migrations';

await generateTypes({
  migrations,
  output: './src/db.generated.ts',
  dialect: 'postgres',
  codecs: (col) => {
    if (col.table === 'events' && col.column === 'payload') {
      return codecs.stringJson({
        import: { name: 'EventPayload', from: './domain' },
      });
    }
    if (
      col.table === 'events' &&
      col.column === 'is_active' &&
      col.sqlType?.toLowerCase().includes('int')
    ) {
      return codecs.numberBoolean();
    }
    return undefined;
  },
});
```

## App Contract Authoring

```ts
import {
  defineSyncularClient,
  scope,
  syncedTable,
  writeSyncularCodegenJson,
  yjsText,
} from '@syncular/typegen';

export const app = defineSyncularClient({
  tables: {
    notes: syncedTable({
      table: 'notes',
      serverVersion: 'server_version',
      scopes: [
        scope('user_id', {
          column: 'owner_user_id',
          source: 'actorId',
        }),
      ],
      crdt: {
        content: yjsText({ stateColumn: 'content_yjs_state' }),
      },
    }),
  },
});

await writeSyncularCodegenJson(app, './generated/syncular.codegen.json');
```

For same-shape starter apps, scaffold the initial contract from existing
migrations and then edit the generated authoring/config when client and server
shapes diverge:

```ts
import {
  scaffoldSyncularClientContract,
  scope,
  writeSyncularCodegenJson,
} from '@syncular/typegen';
import { migrations } from './migrations';

const app = await scaffoldSyncularClientContract({
  migrations,
  scopes: {
    tasks: [scope('user_id', { source: 'actorId', required: true })],
  },
});

await writeSyncularCodegenJson(app, './generated/syncular.codegen.json');
```

For apps that keep the contract in a module, generate or check the
Rust-codegen handoff from the typed module:

```bash
npx syncular generate --manifest-dir .
npx syncular generate --manifest-dir . --check
```

This is a dev/build-time authoring layer. Generated Rust, Swift, Kotlin, JVM,
and browser clients consume generated artifacts, not the TypeScript authoring
module at runtime.

## Documentation

- Typegen (in migrations guide): https://syncular.dev/docs/features/migrations#type-generation-with-synculartypegen

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
