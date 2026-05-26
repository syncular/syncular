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

## Generate

Run the app-facing generator from the umbrella package:

```bash
npx syncular codegen install
npx syncular generate --manifest-dir .
npx syncular generate --manifest-dir . --check
```

When `syncular.app.ts` is absent and `generated/syncular.codegen.json` does not
exist, the command initializes a starter config from migrations before
generating clients. `syncular generate` can also install the Rust generator on
demand when Cargo is available; `syncular codegen install` prewarms the same
tool cache explicitly.

## Documentation

- Quick start: https://syncular.dev/docs/start/quick-start
- CLI reference: https://syncular.dev/docs/reference/cli/generate

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
