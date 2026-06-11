# syncular

CLI for Syncular app code generation. The `syncular` package ships only the
`syncular` command; all runtime libraries live in the scoped `@syncular/*`
packages (for example `@syncular/client`, `@syncular/server`,
`@syncular/react`).

## Usage

Run the app-facing generator with your package runner — no install required:

```bash
npx syncular codegen install
npx syncular generate --manifest-dir .
npx syncular generate --manifest-dir . --check
```

`syncular generate` refreshes `generated/syncular.codegen.json` from
`syncular.app.ts` (via `syncular-typegen`) and then runs the Rust
`syncular-codegen` binary to generate language clients.

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
