# syncular

Umbrella package that exposes the `@syncular/*` packages under a single import namespace.

The root `syncular` import re-exports `@syncular/core`. Runtime-specific
helpers use explicit subpaths.

If you prefer, you can write imports like `syncular/client` instead of
`@syncular/client`. Both are supported.

For plugins and runtime-specific helpers, use explicit umbrella subpaths. Examples:

- `syncular`
- `syncular/client`
- `syncular/react`
- `syncular/dialect-neon`
- `syncular/server-dialect-postgres`

## Install

```bash
npm install syncular
```

## Documentation

- Quick start: https://syncular.dev/docs/introduction/quick-start
- Installation: https://syncular.dev/docs/introduction/installation

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
