# @syncular/server-hono

Hono adapter for `@syncular/server`. Provides push/pull routes, WebSocket wake-ups and presence, blob routes, console API routes, and OpenAPI support.

## Install

```bash
npm install @syncular/server-hono hono
```

If you want to serve the Console UI with `mountConsoleUi`, also install:

```bash
npm install @syncular/console
```

## Documentation

- Hono adapter: https://syncular.dev/docs/server/hono-adapter
- API reference: https://syncular.dev/docs/api
- Operations & console: https://syncular.dev/docs/build/operations

## Sync CORS

`createSyncRoutes` and `createSyncServer` accept a simple Hono-style sync CORS config.
The common case is just an origin string:

```ts
const { syncRoutes } = createSyncServer({
  db,
  dialect,
  sync,
  routes: {
    cors: 'https://app.example.com',
  },
});
```

Or use an object when you need extra exposed/allowed headers:

```ts
const { syncRoutes } = createSyncServer({
  db,
  dialect,
  sync,
  routes: {
    cors: {
      origin: ['https://app.example.com'],
      allowHeaders: ['x-custom-header'],
    },
  },
});
```

Use a function origin only when you need dynamic policy logic.
When `routes.websocket.allowedOrigins` is unset, realtime websocket upgrades
inherit static `routes.cors` origins automatically.

## OpenAPI and Scalar

Serve a generated OpenAPI document:

```ts
import { Hono } from 'hono';
import { createOpenAPIHandler } from '@syncular/server-hono';

const app = new Hono();
app.get('/openapi.json', createOpenAPIHandler(app, { title: 'Syncular API' }));
```

Or mount both the OpenAPI document and a Scalar reference page:

```ts
import { Hono } from 'hono';
import { createOpenAPIDocsRoutes } from '@syncular/server-hono';

const app = new Hono();
app.route('/', createOpenAPIDocsRoutes(app, { title: 'Syncular API' }));
```

That serves:
- `/openapi.json`
- `/spec`

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
