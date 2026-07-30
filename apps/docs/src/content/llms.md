# LLMs

## Docs for language models

The entire documentation is available as one plain-text file at
[syncular.dev/llms.txt](https://syncular.dev/llms.txt). Point your agent or
editor assistant at it for answers about the protocol, the client APIs, and
the server surface. The repository root also carries
[`AGENTS.md`](https://github.com/syncular/syncular/blob/main/AGENTS.md), the
canonical instruction set for coding agents working on syncular itself.

## How syncular uses LLMs

LLM assistance is part of how syncular is developed. So far it has been used
mainly for writing tests and for iterating over technical concepts and
designs. Production code written with assistance goes through strict review
and iteration by the maintainer before it lands, and it meets the same bar as
hand-written code. The TypeScript and Rust cores both have to pass the
conformance catalog against the written protocol, and every change runs
through a gate of more than 1,200 tests.

## Contributing with LLMs

The same policy applies to contributions:

- LLM assistance is welcome for tests, reproductions, benchmarks, tooling,
  and other technical work.
- For production code, use it under strict review and iteration. You must
  understand and be able to defend every line you submit.
- Low-effort machine-generated pull requests, issues, and comments are closed
  without comment.

See [Contributing](/contributing/) for the general ground rules.
