# create-syncular-app

Scaffold a local-first [Syncular](https://syncular.dev) app in one command:

```bash
bunx create-syncular-app my-app
# or
npm create syncular-app@latest my-app
pnpm create syncular-app my-app
```

Then:

```bash
cd my-app
bun install
bun dev
```

You get a minimal, working local-first todo app:

- SQL schema in `migrations/`, mapped to subscriptions/scopes in
  `syncular.app.ts`
- a committed, pre-generated TypeScript client (`src/generated/`) — no extra
  toolchain needed to run; regenerate with `npx syncular generate`
- a Hono sync server on Bun + SQLite (`src/server/sync-server.ts`)
- a React UI on `@syncular/client/react` with live queries and offline-queued
  mutations (`src/app.tsx`)

The scaffolded README explains the project layout and how to evolve the
schema.

## Links

- Documentation: https://syncular.dev/docs
- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
