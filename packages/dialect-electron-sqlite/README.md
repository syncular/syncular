# @syncular/dialect-electron-sqlite

Electron IPC SQLite Kysely dialect for renderer processes.

This dialect lets renderer code use a normal Kysely API while executing SQL in the Electron main process through a preload bridge.

## Install

```bash
npm install @syncular/dialect-electron-sqlite
```

## Usage

```ts
import { createDatabase } from '@syncular/core';
import { createElectronSqliteDialectFromWindow } from '@syncular/dialect-electron-sqlite';

// Uses window.electronAPI.sqlite by default (bridgeKey: "sqlite")
const db = createDatabase<MyDb>({
  dialect: createElectronSqliteDialectFromWindow(),
  family: 'sqlite',
});
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
