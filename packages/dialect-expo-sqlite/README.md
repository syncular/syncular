# @syncular/dialect-expo-sqlite

Expo SQLite Kysely dialect for React Native (expo-sqlite).

## Install

```bash
npm install @syncular/dialect-expo-sqlite
```

## Usage

```ts
import { openDatabaseSync } from 'expo-sqlite';
import { createDatabase } from '@syncular/core';
import { createExpoSqliteDialect } from '@syncular/dialect-expo-sqlite';

const db = createDatabase<MyDb>({
  dialect: createExpoSqliteDialect({ name: 'app.db', openDatabaseSync }),
  family: 'sqlite',
});
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
