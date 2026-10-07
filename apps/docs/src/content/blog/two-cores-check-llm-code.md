---
title: 'Why a Second Implementation Is the Best Check on LLM-Written Code'
description: How Syncular lets models write production code, and why a written protocol, golden vectors, and two cores held to one conformance catalog catch the mistakes that review misses.
author: Benjamin Kniffler
publishedAt: '2026-10-07'
---

# Why a Second Implementation Is the Best Check on LLM-Written Code

I use LLMs heavily, on Syncular and on my other projects. Docs, tests, benchmarks, design discussions, production code: all of it has had model help, including this post. I'll keep updating the workflow as it changes.

I've also spent years deep in the offline-first rabbit hole, and most of Syncular's code, design, and trade-offs come from that experience and predate LLMs. Back in 2019 I built [`debe`](https://github.com/bkniffler/debe), a reactive offline-first datastore with CRDT sync, multi-master replication, and adapters for SQLite, Postgres, and in-memory stores. It never shipped, but building it showed me where the real work in a sync engine sits: authorization, bootstrap, retention, recovery, debugging. Convergence was maybe a fifth of it.

I kept coming back to the problem over the years, mostly through prototypes, and before starting Syncular I went through the current generation properly: PowerSync, Zero, Electric, Replicache, Turso, LiveStore, and Jazz. I followed a single offline write through each of them (a lost ack, access revoked while writes are pending, a schema change in between) and wrote it up in [Durable Offline Writes](/blog/offline-first-writes/). That study is where Syncular's shape comes from: local SQLite as the read model, writes through an outbox, a server with the final say, explicit scopes, bootstrap and retention as part of the protocol. The first implementations of all of that are hand-written too.

## Why I let models write production code

The reason I'm comfortable with it is how the project is checked. The protocol is written down first ([`SPEC.md`](https://github.com/syncular/syncular/blob/main/docs/SPEC.md) is normative), and golden vectors pin the wire format down to the byte. There are two full implementations of the core, one in TypeScript and one in Rust, and both have to pass the same conformance catalog. The Rust core exists for the native platforms, but it has turned out to be the best defense I have against confidently wrong code: a plausible shortcut rarely survives a second implementation in another language.

The conformance harness also injects faults at the transport seam: dropped requests, lost acks, duplicated and reordered delivery, truncated bytes. All of it is deterministic (the one random value is seeded from the scenario name), so every failure reproduces. Sleeps are banned in tests, and a doctrine test greps the package to keep it that way. Beyond that there are the package tests, the examples get smoke-tested in CI, and the benchmarks are committed programs with the methodology written down. The [specifications and conformance reference](/reference/#protocol--conformance) describes the catalog and how it is enforced.

Everything lands through the same `bun run check` gate, and I read every diff before it goes in. The thing I type back most often is some version of "smaller".
