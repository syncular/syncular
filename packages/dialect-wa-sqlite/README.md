# @syncular/dialect-wa-sqlite

wa-sqlite (WASM) Kysely dialect for browser SQLite, with helpers for creating a `Kysely` instance.

## Install

```bash
npm install @syncular/dialect-wa-sqlite
```

## Usage

```ts
import { createWaSqliteDb } from '@syncular/dialect-wa-sqlite';

const db = createWaSqliteDb<MyDb>({ fileName: 'app.sqlite' });
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
