# @syncular/server-console

Serve the `@syncular/console` UI (Vite build output) from a Hono server.

This package is intended for Bun-based servers.

## Usage

Mount the UI in your Hono app:

```ts
import { Hono } from 'hono'
import { createConsoleUiMiddleware } from '@syncular/server-console'

const app = new Hono()

app.use(
  '/ops/console/*',
  createConsoleUiMiddleware({
    basePath: '/ops/console',
  })
)
```

## Notes

- The middleware serves static files from `distDir` and falls back to `index.html` for SPA routes.
- By default it injects `<base href>` into `index.html` responses based on `basePath`, so a single portable build can be mounted under any prefix.
- `distDir` defaults to the bundled `console-dist/` directory inside this package (generated at publish time via `prepack`).
