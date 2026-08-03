# LLMs

I use LLMs heavily, on syncular and on my other projects. Docs, tests,
benchmarks, design discussions, production code: all of it has had model
help, including this page. I'll keep updating it as the workflow changes.

I've also spent years deep in the offline-first rabbit hole, and most of
syncular's code, design, and trade-offs come from that experience and predate
LLMs. Back in 2019 I built [`debe`](https://github.com/bkniffler/debe), a
reactive offline-first datastore with CRDT sync, multi-master replication,
and adapters for SQLite, Postgres, and in-memory stores. It never shipped,
but building it showed me where the real work in a sync engine sits:
authorization, bootstrap, retention, recovery, debugging. Convergence was
maybe a fifth of it.

I kept coming back to the problem over the years, mostly through prototypes,
and before starting syncular I went through the current generation properly:
PowerSync, Zero, Electric, Replicache, Turso, LiveStore, and Jazz. I followed
a single offline write through each of them (a lost ack, access revoked while
writes are pending, a schema change in between) and wrote it up in
[Durable Offline Writes](/blog/offline-first-writes/). That study is where
syncular's shape comes from: local SQLite as the read model, writes through
an outbox, a server with the final say, explicit scopes, bootstrap and
retention as part of the protocol. The first implementations of all of that
are hand-written too.

The reason I'm comfortable letting models write production code here is how
the project is checked. The protocol is written down first
([`SPEC.md`](https://github.com/syncular/syncular/blob/main/docs/SPEC.md) is
normative), and golden vectors pin the wire format down to the byte. There
are two full implementations of the core, one in TypeScript and one in Rust,
and both have to pass the same conformance catalog. The Rust core exists for
the native platforms, but it's turned out to be the best defense I have
against confidently wrong code: a plausible shortcut rarely survives a second
implementation in another language.

The conformance harness also injects faults at the transport seam: dropped
requests, lost acks, duplicated and reordered delivery, truncated bytes. All
of it is deterministic (the one random value is seeded from the scenario
name), so every failure reproduces. Sleeps are banned in tests, and a
doctrine test greps the package to keep it that way. Beyond that there are
the package tests, the examples get smoke-tested in CI, and the benchmarks
are committed programs with the methodology written down.

Everything lands through the same `bun run check` gate, and I read every diff
before it goes in. The thing I type back most often is some version of
"smaller".

## Contributing with LLMs

Same rules for contributions. Use them for whatever helps: tests,
reproductions, benchmarks, tooling, docs, production code. If a model drafted
or rewrote something that's still in your pull request, say so in the
description; routine completion and spelling fixes don't need a note. Read
your own diff, run `bun run check`, and be ready to explain your changes.
Pull requests pasted straight out of a model are closed without comment. The
rest of the ground rules are in [Contributing](/contributing/).

## Docs for language models

The entire documentation is one plain-text file at
[syncular.dev/llms.txt](https://syncular.dev/llms.txt); point your agent or
editor assistant at it. The repository root also carries
[`AGENTS.md`](https://github.com/syncular/syncular/blob/main/AGENTS.md), the
instructions agents (and humans) follow when working on syncular itself.
