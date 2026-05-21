# @syncular/dialect-wa-sqlite

wa-sqlite browser dialect for the legacy JavaScript Syncular runtime and
runtime benchmarks.

Rust-owned SQLite browser work lives in `@syncular/client` under
`rust/bindings/browser`. Keep Rust client, WASM, and Kysely adapter code there;
this package stays focused on the wa-sqlite baseline.

## Install

```bash
npm install @syncular/dialect-wa-sqlite
```

## Usage

```ts
import { Kysely } from 'kysely';
import { createWaSqliteDialect } from '@syncular/dialect-wa-sqlite';

const db = new Kysely<Database>({
  dialect: createWaSqliteDialect({
    fileName: 'legacy-js.sqlite',
    preferOPFS: true,
  }),
});
```

This package intentionally does not export the Rust-owned SQLite client. Use
`@syncular/client` for the Rust rewrite.

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
