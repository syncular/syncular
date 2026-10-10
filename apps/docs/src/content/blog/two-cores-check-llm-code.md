---
title: 'Model-Written Code Needs a Repository That Checks Itself'
description: Models write most of Syncular's code. That works because the repository can judge a change without me, through a normative spec, golden vectors, a 242-scenario conformance catalog run against two cores, performance budgets, and a gate that every finding feeds back into.
summary: What a repository needs before models can write its production code, and what slipped through anyway.
author: Benjamin Kniffler
publishedAt: '2026-10-07'
---

# Model-Written Code Needs a Repository That Checks Itself

Models write most of Syncular's code: production code in TypeScript and Rust,
tests, benchmarks, docs, and drafts of this post. The repository has about
1,650 commits since February 2026, and I am the only maintainer. I read every
diff, but reading is the weakest check I have. A model's mistake reads as well
as its correct code, and a reviewer judges a diff with the same context the
model had.

Model-driven development works on this project because the repository can
decide whether a change is correct without asking me. A model runs the checks,
reads the failures, and fixes its own work before I see it. When something
slips through, the fix includes a new check, so the same class of mistake
fails the gate next time. This post describes that setup, and two bugs that
showed where it is still thin.

## A written truth

[`SPEC.md`](https://github.com/syncular/syncular/blob/main/docs/SPEC.md) is
the normative wire protocol, and
[`SYQL.md`](https://github.com/syncular/syncular/blob/main/docs/SYQL.md)
defines the query language. When a core disagrees with the spec, the core is
wrong, or the spec changes in the same commit. A model told to make a client
follow §6.1 can check its result against the text.

The same model that wrote the code also reads the text, so prose alone checks
little. Three artifacts make the spec executable:

- Golden vectors: 78 files in `spec/vectors/` pin request, response, push,
  segment, realtime, and crypto encodings byte for byte, including invalid
  inputs a decoder must reject. The TypeScript codec and the Rust `ssp2` crate
  both run them.
- The conformance catalog: 242 scenarios that drive a client and a server
  through the byte-level transport. A test fails the build if any scenario
  lacks a reference to the spec section it checks, so every behavior the
  catalog asserts traces back to a sentence.
- A second core. The client core exists in TypeScript and in Rust, and CI runs
  the full catalog against both. A merge needs both pairings green.

## A second, independent reader

The Rust client was written from `SPEC.md` and the `ssp2` crate alone; the
TypeScript client source stayed closed during that work. Its first complete
version passed all 35 scenarios the catalog had at the time. Running both
codecs over the same inputs then found four disagreements that neither core's
own tests could see. TypeScript decoded a `json` column holding invalid JSON
without error, for example, and Rust accepted realtime cursor values between
2^53 and 2^63. Each one was resolved on the side the spec supports and pinned
with a new vector. The same build found four places where the spec was silent
and the TypeScript core had made a choice nobody wrote down; those answers are
now in `SPEC.md`.

The second core keeps finding disagreements as features land. A `float`
primary key rendered to different row ids in the two cores, because
ECMAScript's `Number.prototype.toString` switches to exponent notation at 1e21
and Rust's `f64::to_string` never does. Each core agreed with itself, so each
core's tests passed. `float` is now rejected as a primary key type at every
schema compile site, and SPEC §2.4 states the rule.

## Results that reproduce

A model that sees a test fail once and pass on rerun learns to rerun. The
checks therefore have to give the same answer every time.

The catalog injects transport faults (dropped requests, lost acks, duplicated
and reordered delivery, truncated bytes) from a random source seeded with the
scenario name. Tests contain no sleeps: they wait on explicit readiness
helpers such as `flushQuerySchedulers`. The conformance package enforces this
with a test that scans its own source for `setTimeout`, `setInterval`, and
`sleep(` and fails on any match.

One test lane retries once: the multi-tab suite, which hits a segfault in
Bun's native Worker and SQLite combination that reproduces without any
Syncular code. The root `package.json` records the reason next to the retry
and names the condition for removing it.

## One gate

`bun run check` is the gate for every change, run by the pre-push hook and by
CI. It runs the release version check, the TypeScript typecheck, oxlint and
oxfmt, knip, the test suites including the TypeScript conformance pairing, and
a Node runtime check of the client and server packages. CI adds the Rust
conformance pairing, benchmark budgets, a browser recovery lane, a Postgres
performance job, and the Tauri, Swift, Kotlin, React Native, and Flutter
binding gates whenever the Rust core changes.

knip fails the gate on unused files, exports, and dependencies. A model that
replaces a helper often leaves the old one in place, and knip is what removes
it.

Some checks have to run against the real artifact. The schema downgrade test
creates a detached `git worktree` of an earlier commit and opens a replica with
that build's client, because a simulated old client still runs the new boot
code and passes for the wrong reason.

## Performance budgets

A model optimizes for the check in front of it, and a correctness suite says
nothing about speed. A change can pass all 242 scenarios and still apply
bootstrap rows one at a time. The `bench-budgets` CI job runs `bun run
bench:ci` and fails the build when a measurement crosses its budget:

- bootstrap through the rows lane at 90,000 rows/s or more; the local record
  is about 263,000 rows/s at 100k rows, and a row-by-row apply measures about
  125,000 rows/s locally, well under the floor on a CI runner;
- bootstrap through the SQLite image lane at 600,000 rows/s or more; the local
  record is 46.5 ms warm for 100k rows, about 2.15 million rows/s;
- the image lane at least 5x the rows lane within the same run;
- realtime propagation p95 at 20 ms or less in-process, against a local 0.8 to
  1.2 ms, so a sleep or poll in the sync loop fails the build;
- the main-thread browser bundle at 166 KiB raw or less, and the total
  shipped payload with SQLite at 600 KiB gzip or less.

Shared CI runners are slower and noisier than my machine, so the absolute
floors sit about 3x below the local numbers. The ratio between the two
bootstrap lanes holds on any runner, because a slow runner slows both lanes.
Both budgets came out of a regression the old budget missed: an image import
that read every staged row back for overlay reconciliation ran at 0.7 to 0.8
million rows/s, and the floor was 300,000 rows/s. After the fix, the floor
went to 600,000 rows/s and the ratio budget was added; the regressed build
measures a ratio of 3.1 to 3.4x, so both budgets now fail it.

The bundle ceiling is an anti-bloat tripwire. Models add code more readily
than they remove it, and a feature that pushes the bundle past the ceiling
fails the gate until someone measures and attributes the growth. Raising the
ceiling follows a written rule (measure, attribute, re-pin at about 5%
headroom), and each raise is recorded in `bench/RESULTS.md`.

Where a performance property can be stated as a count, the test asserts the
count. The native client reconciles pending writes per table; the regression
test seeds a 100,000-row table the write never touches and asserts zero
deletes on it. The old full-table rebuild failed that test with 100,000
deletes, independent of how fast the machine was.

The full results, including the methodology and the raw samples behind each
median, are on the [benchmarks page](/benchmarks/).

## Closing the loop

The project's
[`AGENTS.md`](https://github.com/syncular/syncular/blob/main/AGENTS.md) is the
instruction file every coding agent reads, and it applies to human
contributors too. Its rules are the residue of past mistakes: no fallback
paths, errors with static codes, no timers in tests, no `as any`, no
single-use helpers, and a semantics change touches both cores and adds a
catalog scenario.

Every finding ends as an artifact the next change runs into:

- a codec disagreement becomes a golden vector;
- an unspecified choice becomes a spec sentence;
- a behavior bug becomes a catalog scenario with spec references;
- a performance regression becomes a budget or a counted assertion;
- a repeated model habit becomes a rule in `AGENTS.md`, and a test when the
  rule can be checked mechanically.

The last step matters most with models. A rule in `AGENTS.md` is a request. A
rule in the gate is a check the model runs on its own work.

## What slipped through

On October 6, Lars Behrenberg filed 14 issues
([#76](https://github.com/syncular/syncular/issues/76) to
[#89](https://github.com/syncular/syncular/issues/89)) from integrating
Syncular into a Tauri desktop app with a Cloudflare Workers and D1 backend.
Two of them describe what the setup above is meant to prevent.

[#76](https://github.com/syncular/syncular/issues/76): the Rust core discarded
errors while replaying pending writes on reopen
(`let _ = self.apply_outbox_op(op);`), and turned failed reads and value
decodes into "row absent" with `.ok()?`. A write stayed in the outbox while
the visible table lost it, and nothing reported the mismatch. `AGENTS.md`
forbids fallback paths, and this code shipped anyway: the rule existed only as
text, and no test injected a SQL failure during replay.

[#77](https://github.com/syncular/syncular/issues/77): an older app build that
opened a replica written by a newer build reset it, dropping tables and
discarding pending writes that did not fit the older schema. Both cores did
this, so the cross-core check agreed with itself. The catalog had no downgrade
scenario.

All 14 issues were closed about 15 hours after they were filed, through a
dependency-ordered stack of 16 pull requests. Each behavior fix changed both
cores, added regressions (for #76: replay faults from triggers, reads,
decodes, FTS, and savepoints), and passed both conformance pairings. Opening a
replica with an older schema now fails with `client.schema_downgrade` before
the client modifies anything.

Two cores catch places where implementations disagree. They miss mistakes both
implementations share, and those surface only through a scenario written from
the spec text or through a user. The catalog injects faults at the transport;
#76 shows that local storage needs the same treatment.

## What stays with me

The checks decide whether a change is correct. I decide what correct means:
what the spec says, which side of a disagreement wins, and whether a change
should exist at all. I still read every diff, and the reply I type most often
is "smaller".
