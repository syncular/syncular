---
title: 'Two Cores, One Spec: Checking Code a Model Wrote'
description: Models write much of Syncular's production code. A normative spec, golden vectors, and a second client core in Rust held to the same conformance catalog catch the mistakes that diff review misses, and this post shows the ones they caught.
summary: How a second implementation, built from the spec alone, catches model-written code that reads correctly and is wrong.
author: Benjamin Kniffler
publishedAt: '2026-10-07'
---

# Two Cores, One Spec: Checking Code a Model Wrote

Models write a large share of Syncular's code: production code, tests,
benchmarks, docs, and drafts of this post. The repository has about 1,650
commits since February 2026, and most of them had model help. I read every
diff before it lands, and the reply I type most often is "smaller".

Reading diffs catches code that looks wrong. The expensive model mistakes look
right: the code is consistent with itself, the tests the model wrote pass, and
the reasoning in the commit message holds up. A reviewer judges the diff
against the same context the model had, so a wrong assumption shared by both
goes through. What catches those mistakes in Syncular is a second
implementation of the same protocol that never saw the first one's source.

## The setup

Syncular's design predates the models. I built
[debe](https://github.com/bkniffler/debe), an offline-first datastore with CRDT
sync, in 2019, and the study in
[Durable Offline Writes](/blog/offline-first-writes/) is where Syncular's shape
comes from. What the models changed is how much code one person can produce,
and therefore how much code needs checking that one person did not type.

The check has four parts:

- [`SPEC.md`](https://github.com/syncular/syncular/blob/main/docs/SPEC.md):
  the normative protocol. When the spec and a core disagree, the core is wrong
  or the spec gets amended in the same commit.
- Golden vectors: 78 files in `spec/vectors/` that pin request, response,
  push, segment, realtime, and crypto encodings byte for byte, including
  invalid inputs a decoder must reject.
- Two client cores: one in TypeScript, one in Rust. The Rust core exists for
  the native platforms (Swift, Kotlin, Flutter, React Native, Tauri).
- One conformance catalog: 242 scenarios, each citing the spec sections it
  tests. CI runs the catalog against the TypeScript client and the Rust client,
  both against the TypeScript server, and a merge needs both pairings green.

The catalog injects faults at the transport seam: dropped requests, lost acks,
duplicated and reordered delivery, truncated bytes. The only random value is
seeded from the scenario name, so every failure reproduces on the next run.
The [specifications and conformance reference](/reference/#protocol--conformance)
describes how the catalog and vectors are enforced.

## The clean-room build

The Rust client was written by a model from `SPEC.md` and the Rust wire crate
alone. The TypeScript client source was never opened during that work. The
first complete version was about 2,100 lines, and it passed all 35 scenarios
the catalog had at the time, with no skipped scenarios and no recorded
discrepancies.

Running both codecs over the same inputs found four places where the
TypeScript and Rust implementations disagreed, each one invisible to the tests
of either core alone:

- A `json` column that held invalid JSON decoded without error in TypeScript.
  The spec says it must fail. TypeScript was fixed.
- The realtime wake message carries `requiresPull`. Rust accepted `false`; the
  spec requires the literal `true`. Rust was fixed.
- Realtime numeric fields must be integers within ±(2^53 − 1). TypeScript
  checked `isFinite`, which accepts fractional cursors, and Rust accepted
  values between 2^53 and 2^63. Both were tightened.
- The TypeScript encoder refused to emit an unknown frame under a registered
  type, and the Rust encoder did not. Rust gained the same assertion.

Each fix shipped with a golden vector, so a third implementation fails on the
same input. The same build surfaced four gaps in the spec itself, such as when
a client counts as having synced at least once. Those were places where the TypeScript core had made a choice
nobody wrote down; the second reader had to ask, and the answers went into
`SPEC.md`.

## What the second core caught later

The catalog keeps finding disagreements as features land. Two examples:

**Float primary keys.** A row id is a string, so every core has to render a
primary key to the same string. For a `float` key they did not. ECMAScript's
`Number.prototype.toString` switches to exponent notation at 1e21 and below
1e-6; Rust's `f64::to_string` never does. Local lookups compared
`CAST(key AS TEXT)`, so the bundled SQLite version also decided which rows a
row id reached: under SQLite 3.53, a stored `1.0` did not match the row id
`"1"`. Each core's own tests passed, because each core agreed with itself.
`float` is now rejected as a primary key type at every schema compile site,
and SPEC §2.4 states the rule.

**An unresolvable encryption key.** When a client cannot resolve the key for
an encrypted column, TypeScript recorded a durable `client.encrypt_failed`
rejection for that commit at the push seam. Rust returned an error at
authoring time and sent the push with no payload. Both choices are defensible
in isolation; the catalog scenario that pinned key resolution exposed the
disagreement, and Rust now records the same rejection.

Both bugs are edges a model fills in with a reasonable default, and a reviewer
reading one core's diff has no second default to compare it against.

## Rules written against model habits

The project's [`AGENTS.md`](https://github.com/syncular/syncular/blob/main/AGENTS.md)
is the instruction file every coding agent reads. Most of its rules exist
because a model did the opposite more than once.

- No fallback paths. Asked to make a failing case pass, a model wraps it in a
  `try` and returns a default. Syncular wants a loud error with a static code
  such as `sync.outbox_incompatible`, with dynamic values in structured
  details.
- No timers in tests. A flaky test invites a `sleep`. The conformance package
  has a test that scans its own source for `setTimeout`, `setInterval`, and
  `sleep(` and fails on any match; tests wait on explicit readiness helpers.
- No `as any` or `as unknown`. A cast silences the type checker where the
  underlying type is wrong.
- No single-use helpers, wrappers, or constants. Models add indirection by
  default, and each layer is more code to read in review.
- A semantics change touches both cores and adds a catalog scenario. A
  TypeScript-only change fails the Rust pairing in CI, so the rule enforces
  itself.

Rules that a test can check are tests. The rest depend on review.

## What this does not cover

The server has one implementation, in TypeScript. Server behavior is checked
by the catalog's assertions and the package tests; no second server checks the
first.

Two cores can share a mistake. In the same encryption work, a patch that
leaves the key id column out falls back to the key id stored on the row. The
spec says an absent column and a present `NULL` are different things, and both
cores treated a present `NULL` as absent: TypeScript tested for `null` or
`undefined`, Rust tested for an empty slot. The catalog passed in both
pairings. The bug surfaced while writing the key-resolution scenario against
the spec text. Agreement between cores is evidence about the code; only the
spec and the scenarios written from it are evidence about the behavior.

Two cores cost time. Every semantics change is written twice, tested twice,
and argued over once in the spec. For Syncular the cost lands on the protocol,
where a disagreement between client and server corrupts someone's data on a
device I cannot reach.

## Applying this elsewhere

Most projects do not need two implementations of everything. The method
carries over to the part of a system where a plausible mistake is expensive:
write the contract down, pin its encodings with fixtures, and have a model
implement it a second time from the contract alone, in a separate session
without access to the first implementation. Then run both against the same
inputs, and turn each disagreement into a fixture or a spec sentence.
