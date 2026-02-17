# @syncular/relay

Edge relay server for Syncular.

A relay acts as a local sync server for nearby clients and forwards commits to a main server when online. Useful for intermittent connectivity (branch offices, field devices, edge deployments).

## Install

```bash
npm install @syncular/relay
```

## Usage

```ts
import { createRelayServer } from '@syncular/relay';

const relay = createRelayServer({
  db,
  dialect,
  mainServerTransport,
  mainServerClientId: 'relay-1',
  mainServerActorId: 'relay-service',
  tables: ['tasks'],
  scopes: { project_id: 'acme' },
  handlers,
});

await relay.start();
```

## Documentation

- Relay guide: https://syncular.dev/docs/build/relay

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
