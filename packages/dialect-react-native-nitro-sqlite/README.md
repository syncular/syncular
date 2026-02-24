# @syncular/dialect-react-native-nitro-sqlite

React Native Nitro SQLite Kysely dialect.

## Install

```bash
npm install @syncular/dialect-react-native-nitro-sqlite
```

## Usage

```ts
import { open } from 'react-native-nitro-sqlite';
import { createDatabase } from '@syncular/core';
import { createNitroSqliteDialect } from '@syncular/dialect-react-native-nitro-sqlite';

const db = createDatabase<MyDb>({
  dialect: createNitroSqliteDialect({ name: 'app.db', open }),
  family: 'sqlite',
});
```

## Documentation

- Dialect selection: https://syncular.dev/docs/introduction/installation#client-database-dialects

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs may change between releases.
