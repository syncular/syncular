# WP-36 Binding Example Clarity

Status: `[x]` accepted

## Goal

Make public docs clearer that feature pages describe Syncular capabilities, not
one default binding. Code examples should be labeled by host surface when they
are TypeScript/browser, Rust, native, React, or testkit specific.

## Scope

- Clarify the Features section convention.
- Label feature-page snippets that currently read like default JavaScript
  client examples.
- Clarify that top-level Testing documents the TypeScript/server/browser
  `@syncular/testkit`, while client testing also has Rust/native
  `syncular-testkit`.
- Keep binding implementation details in the Client section and link there from
  feature pages.

## Non-Scope

- Runtime API changes.
- Generated client API changes.
- Reorganizing the docs navigation again.

## Required Gates

- `git diff --check`
- Focused scan for unlabeled browser/testkit ambiguity in touched docs.
- Custom internal `/docs` link checker.
- `bun --cwd apps/docs types:check`
- `bun --cwd apps/docs build`

## Work Batches

### Batch 1: Feature And Testkit Labeling

- `[x]` Add binding-example policy text to the Features index.
- `[x]` Label app-contract and server-handler snippets in data modeling, local
  read models, CRDT fields, and field encryption.
- `[x]` Relabel Presence examples as binding examples and point native hosts to
  native lifecycle docs.
- `[x]` Add both TypeScript/browser and Rust examples to Undo / Redo.
- `[x]` Relabel Blob and Offline Auth Lease examples as host-specific examples
  instead of generic client defaults.
- `[x]` Add binding notes to Error Handling and Audit / History where examples
  intentionally use browser TypeScript or React UI code.
- `[x]` Clarify top-level Testing as TypeScript/server/browser testkit docs.
- `[x]` Clarify Client Testing as Rust/native testkit docs and link both
  directions.

## Accept / Reject Rule

Accept docs-only changes when they make binding ownership explicit without
inventing APIs or duplicating full binding guides into feature pages.

## Current Evidence

- User feedback: feature pages looked like JavaScript examples by default, and
  testkit docs looked Rust-only in one place despite TypeScript testkit docs
  existing elsewhere.
- Batch 1 keeps feature docs semantic-first and labels concrete snippets by
  binding.
- Gates passed:
  - `git diff --check`
  - focused ambiguous-heading/testkit wording scan
  - custom internal `/docs` link checker: checked `225` source files and `197`
    docs pages with no missing `/docs` links
  - work-package index checker: indexed `36` work packages
  - `bun --cwd apps/docs types:check`
  - `bun --cwd apps/docs build`
  - Local docs HTTP smoke returned `200` for changed feature, testing, and
    client routes.

## Next Action

WP-36 is complete unless more unlabeled binding examples are reported.
