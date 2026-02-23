# @syncular/dialect-pglite

PGlite (WASM Postgres) Kysely dialect for running Postgres locally (in browser or other WASM environments).

## Install

```bash
npm install @syncular/dialect-pglite
```

## Usage

```ts
import { createPgliteDbAsync } from '@syncular/dialect-pglite';

const db = await createPgliteDbAsync<MyDb>({ dataDir: 'idb://app' });
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
