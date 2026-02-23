# @syncular/typegen

Generate TypeScript database types from your migrations.

Supports SQLite and Postgres introspection with column-level codec type overrides via `columnCodecs`.

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
  columnCodecs: (col) => {
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

## Documentation

- Typegen (in migrations guide): https://syncular.dev/docs/build/migrations#type-generation-with-synculartypegen

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
