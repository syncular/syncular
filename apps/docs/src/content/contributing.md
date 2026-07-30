# Contributing

Syncular is developed on [GitHub](https://github.com/syncular/syncular). Bug
reports with reproductions, protocol questions, and focused pull requests are
welcome.

## Ground rules

- Read [`AGENTS.md`](https://github.com/syncular/syncular/blob/main/AGENTS.md)
  at the repository root. It is the canonical instruction set for both human
  and machine contributors: spec-first development, no fallback paths, no
  timers in tests, and cross-core parity between the TypeScript and Rust
  implementations.
- Wire-behavior changes start in
  [`docs/SPEC.md`](https://github.com/syncular/syncular/blob/main/docs/SPEC.md),
  and semantics changes require both cores plus a conformance catalog
  scenario.
- `bun run check` (typecheck + lint + tests) must pass; it is the same gate
  the pre-push hook and CI run.

## AI assistance

LLM assistance is welcome for tests, reproductions, benchmarks, tooling, and
other technical work. For production code, use it under strict review and
iteration: you must understand and be able to defend every line you submit,
and the diff must meet the same bar as hand-written code. Low-effort
machine-generated pull requests, issues, and comments are closed without
comment.

Syncular itself is developed under this policy — see [LLMs](/llms/) for how
LLMs are used in this project and for the plain-text docs bundle you can feed
your own agent.
