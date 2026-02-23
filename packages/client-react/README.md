# @syncular/client-react

React bindings for the Syncular client. Provides a typed `SyncProvider` and hooks like `useSyncQuery`, `useMutations`, and presence helpers.

## Install

```bash
npm install @syncular/client-react react
```

## Usage

```tsx
import { createSyncularReact } from '@syncular/client-react';

const { SyncProvider, useSyncQuery, useMutations } = createSyncularReact<MyDb>();
```

## Documentation

- React SDK: https://syncular.dev/docs/client-sdk/react
- Client setup: https://syncular.dev/docs/build/client-setup
- Presence: https://syncular.dev/docs/build/presence

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
