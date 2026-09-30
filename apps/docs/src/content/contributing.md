# Contributing

Syncular is developed on [GitHub](https://github.com/syncular/syncular). Bug
reports with reproductions, protocol questions, and focused pull requests are
welcome.

## Ground rules

- Read [`AGENTS.md`](https://github.com/syncular/syncular/blob/main/AGENTS.md)
  first. It is the working agreement for maintainers, human contributors, and
  coding agents.
- Start wire-behavior changes in
  [`docs/SPEC.md`](https://github.com/syncular/syncular/blob/main/docs/SPEC.md).
  A semantics change needs both cores and a conformance catalog scenario.
- Run `bun run check`. It is the same typecheck, lint, unused-code, and test
  gate used by the pre-push hook and CI.
- Keep a contribution focused. Review every changed line and be prepared to
  explain the choices in it.

## Local Rust build caches

Run `bun run rust test` or `bun run rust clippy --all-targets -- -D warnings`
for the Rust core. These commands prune caches before invoking Cargo.
`bun run check:code`, native packaging, FFI smoke tests and the binding check
scripts also run cleanup. Direct `cargo` commands do not run this hook.

Cleanup requires Python 3 on macOS/Linux. It removes hashed Cargo
intermediates and incremental caches unused for 14 days. Above 8 GiB per
target folder, it removes older entries unused for at least 24 hours first.
It retains fresh artifacts, final binaries and exported native packages.
A Cargo profile lock held by another build skips cleanup for that target
folder. Windows builds retain their caches without automatic pruning.

Preview with `bun run rust:clean --dry-run`. Set `RUST_CACHE_MAX_GIB`,
`RUST_CACHE_MAX_AGE_DAYS` or `RUST_CACHE_MIN_AGE_HOURS` to change the policy.
A custom `CARGO_TARGET_DIR` must be absolute. The size limit is a pruning
target: recent and final outputs can exceed it until they become eligible.

## LLM assistance

Use them for whatever helps: tests, reproductions, benchmarks, tooling, docs,
production code. If a model drafted or rewrote something that's still in your
pull request, say so in the description. Routine completion and spelling
fixes don't need a note.

Read your own diff, run `bun run check`, and be ready to explain your changes
and how they fit the protocol. Pull requests, issues, and comments pasted
straight out of a model are closed without comment.

Syncular is built the same way; the [LLMs page](/llms/) has the whole story.
