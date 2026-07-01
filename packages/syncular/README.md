# syncular

CLI for Syncular app code generation, schema readiness, and production ops
checks. The `syncular` package ships only the `syncular` command; all runtime
libraries live in the scoped `@syncular/*` packages (for example
`@syncular/client`, `@syncular/server`, `@syncular/client/react`).

## Usage

Run the app-facing generator with your package runner — no install required:

```bash
npx syncular codegen install
npx syncular generate --manifest-dir .
npx syncular generate --manifest-dir . --check
npx syncular schema check --json
npx syncular ops check --json
```

`syncular generate` refreshes `generated/syncular.codegen.json` from
`syncular.app.ts` (via `syncular-typegen`) and then runs the Rust
`syncular-codegen` binary to generate language clients.

When `syncular.app.ts` is absent and `generated/syncular.codegen.json` does not
exist, the command initializes a starter config from migrations before
generating clients. `syncular generate` can also install the Rust generator on
demand when Cargo is available; `syncular codegen install` prewarms the same
tool cache explicitly.

`syncular schema check --json` verifies generated config, migrations, and
generated client/server schema versions before deploy. `syncular ops check
--json` validates the production runbook evidence file for restore drills,
blob consistency, credential rotation, rate-limit review status, log/event
retention, and offline support-window sizing.

## Documentation

- Quick start: https://syncular.dev/docs/start/quick-start
- CLI reference: https://syncular.dev/docs/reference/cli

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
