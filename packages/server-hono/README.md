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

`createSyncRoutes` and `createSyncServer` accept a simple sync-route CORS allowlist:

```ts
const { syncRoutes } = createSyncServer({
  db,
  dialect,
  sync,
  routes: {
    cors: {
      allowedOrigins: ['https://app.example.com'],
    },
  },
});
```

Use `cors.resolveOrigin` only when you need dynamic policy logic.
When `routes.websocket.allowedOrigins` is unset, realtime websocket upgrades
inherit `routes.cors.allowedOrigins`.

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
