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

## LLM assistance

Use them for whatever helps: tests, reproductions, benchmarks, tooling, docs,
production code. If a model drafted or rewrote something that's still in your
pull request, say so in the description. Routine completion and spelling
fixes don't need a note.

Read your own diff, run `bun run check`, and be ready to explain your changes
and how they fit the protocol. Pull requests, issues, and comments pasted
straight out of a model are closed without comment.

Syncular is built the same way; the [LLMs page](/llms/) has the whole story.
