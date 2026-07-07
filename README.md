<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo/banner-dark.svg" />
    <img alt="syncular" src="logo/banner-light.svg" width="440" />
  </picture>
</p>

# syncular v2

Clean-tree rebuild of syncular's TypeScript surface around a written
protocol. Strategy, milestones, and the kill/merge gate live in
[`../REVISE.md`](../REVISE.md) — read that first. This file is the rules of
the tree.

## What this is

- Its **own workspace root**: own lockfile, **latest Bun** (no version pin —
  the old tree's 1.3.9 pin exists for a WASM worker bridge that v2 does not
  have), own biome/tsconfig. Root-repo gates ignore this directory; CI runs
  `.github/workflows/ci.yml` (renamed from v2.yml at the 2026-07-04 promotion).
- **Spec-first**: `SPEC.md` is normative; `spec/vectors/` are golden
  fixtures; implementations follow the spec, never the other way around.
- Target shape (matches the published 0.1.x consolidation, minus baggage):
  - `packages/core` — protocol codecs, shared types, vectors round-trip
  - `packages/server` — `handleSyncRequest(bytes, ctx)` + storage/auth
    interfaces; framework adapters as thin subpaths
  - `packages/client` — TS core on `@sqlite.org/sqlite-wasm`,
    worker-optional
  - `packages/conformance` — implementation-agnostic scenario runner
  - `packages/codegen` — schema IR + TS emitter (cargo-free)

## Rules (from REVISE.md, enforced in review)

1. **Never copy implementation files from `../packages` or `../rust`.**
   Contracts, scenario definitions, golden semantics, benchmark harnesses:
   yes. Implementation code: reference only, rewrite on purpose.
2. **Skeleton non-goals** until the gate passes: blobs, CRDT, encryption,
   auth leases, presence, console, native bindings, relay. Do not "while
   we're here" any of them.
3. **Test doctrine from day one**: loopback in-memory transport for
   integration scenarios; fault injection at the transport interface;
   readiness waits, never sleeps; real-socket tests few and quarantined.
4. **Tripwire**: two clients must be syncing through the TS server within
   ~2 weeks of agent-time, or work stops and REVISE.md's gate is evaluated
   early.

## Commands

```sh
cd v2
bun install
bun run check   # typecheck + lint + test
```
