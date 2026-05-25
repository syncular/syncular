# WP-34 Rust-First Docs Information Architecture

Status: `[x]` implemented, clients-root follow-up completed

## Goal

Restructure the public docs around the Rust-first product shape:

- language-first application docs for JavaScript and Rust;
- server-authoritative sync as a separate implementation surface;
- cross-platform features documented once, then linked from binding pages;
- exact APIs and generated surfaces kept in reference pages.

The docs should make it hard to accidentally build against old JavaScript-client
assumptions, old client dialect choices, or a hand-authored low-level codegen
file.

## Current Problem

The current top-level docs shape is still influenced by the pre-Rust client:

```text
Get Started
Concepts
Build
Rust Client
Testing
Operate
Reference
```

This creates several problems:

- `Rust Client` sounds like a language-specific appendix, even though it is now
  the canonical client runtime and binding family.
- `Build` still looks like the primary implementation section, but many
  current client instructions live under `Rust Client`.
- Binding-specific guidance for browser TypeScript, React, React Native/Expo,
  Tauri/Electron, Rust, Swift, Kotlin/Android, and JVM is not represented as a
  clear product matrix.
- Feature docs such as blobs, CRDT/Yjs, encryption, presence, undo/redo,
  offline auth leases, conflicts, and local read models are scattered across
  concepts, build, rust-client, and operate pages.
- Some current docs still need cleanup from the old JS-client shape, even after
  recent link and generated-handoff fixes.

## Current Top-Level Navigation

```text
Start
Learn
Clients
Server
Features
Testing
Operate
Reference
```

### Start

Purpose: orient, install, and evaluate quickly.

Candidate pages:

- Overview
- Quick Start
- Installation
- Choose Your App Shape
- Good Fit / Not Fit
- Comparison

### Learn

Purpose: stable mental model, not implementation instructions.

Candidate pages:

- How Sync Works
- Local Replica And Outbox
- Commits
- Scopes
- Subscriptions
- Bootstrap / First Sync
- Realtime And Recovery
- Conflicts
- Schema Evolution
- Glossary

### Clients

Purpose: group language/runtime client docs under one public root instead of
making every binding a top-level docs section.

Pages:

- Overview
- JavaScript
  - Overview
  - Quick Start
  - Generated Client
  - Querying
  - Mutations
  - Live Updates
  - Runtime
  - Realtime And Presence
  - CRDT Fields
  - Blobs And Encryption
  - Testing
  - Browser
  - React
  - React Native / Expo
  - Tauri
  - Electron
- Rust
  - Overview
  - Quick Start
  - Generated Client
  - Querying
  - Mutations
  - Live Updates
  - Runtime
  - Realtime And Presence
  - CRDT Fields
  - Blobs And Encryption
  - Testing
  - Packaging

### JavaScript

Purpose: application docs for TypeScript/JavaScript hosts.

Pages:

- Overview
- Quick Start
- Generated Client
- Querying
- Mutations
- Live Updates
- Runtime
- Realtime And Presence
- CRDT Fields
- Blobs And Encryption
- Testing
- Browser
- React
- React Native / Expo
- Tauri
- Electron

### Rust

Purpose: application docs for Rust and the Rust-owned runtime.

Pages:

- Overview
- Quick Start
- Generated Client
- Querying
- Mutations
- Live Updates
- Runtime
- Realtime And Presence
- CRDT Fields
- Blobs And Encryption
- Testing
- Packaging

### Server

Purpose: authoritative sync server implementation.

Candidate pages:

- Overview
- Setup With Hono
- Table Handlers
- Scopes And Auth
- Snapshot / Pull
- Apply Operations / Push
- Realtime WebSocket
- Blobs
- CRDT Server Plugin
- Audit APIs
- Cloudflare
- Service Worker Server
- External Changes
- Server Dialects

### Features

Purpose: product capabilities independent of binding.

Candidate pages:

- Data Modeling
- Migrations
- Offline Auth Leases
- Conflict Resolution
- Undo / Redo
- Audit And History
- File / Blob Sync
- CRDT Fields
- Field Encryption
- Presence
- Local Read Models
- Performance Patterns

### Testing

Purpose: language-neutral entrypoint that routes to JavaScript testkit, Rust
testkit, and shared conformance workflows.

Pages:

- Overview
- Conformance
- Testing Strategy

### Operate

Purpose: production operations.

Candidate pages:

- Overview
- Deployment
- Observability
- Performance
- Troubleshooting
- Console
  - Connect And Auth
  - Fleet
  - Stream Investigation
  - Row Investigation
  - Operations
  - Storage
  - API Keys
  - Incident Playbooks

### Reference

Purpose: exact APIs and package details.

Candidate pages:

- Client APIs
- Generated Client APIs
- Native Bindings
- Server APIs
- HTTP API
- Error Taxonomy
- Runtime Limits
- Package Matrix

## Scope

- Redesign docs navigation and folder layout around the proposed IA.
- Move existing pages into the new sections with minimal content edits first.
- Rewrite top-level landing pages so they describe the new structure.
- Split binding-specific client pages where needed.
- Preserve current docs content where it is still correct, but remove stale
  links and old JS-client phrasing from public guidance.
- Keep API-generated pages grouped under `Reference`.
- Keep historical planning docs under `rust/docs/reference` unchanged unless
  they are linked from public docs.

## Non-Scope

- Changing runtime or package APIs.
- Rewriting every feature guide in one pass.
- Reintroducing old JavaScript client docs or client dialect guidance.
- Maintaining compatibility redirects unless the docs build requires a
  controlled transition. Prefer moving current docs cleanly.
- Performance benchmarking. This WP is docs/navigation only.

## Acceptance Criteria

- Top-level docs nav matches the Rust-first product model:
  `Start`, `Learn`, `Clients`, `Server`, `Features`, `Testing`, `Operate`,
  `Reference`.
- Binding-specific docs are under `Clients`, not separate root-level sections.
- `Rust Client` no longer appears as a top-level docs section name.
- `Build` is removed as a top-level implementation bucket or reduced to a
  temporary redirect/landing page if the docs framework requires it.
- Current public docs do not link to removed pages such as old client setup,
  table-handler guide, old auth/realtime/blob/encryption pages, or nonexistent
  runtime pages.
- Public docs do not present old client dialect packages as the recommended
  Syncular client storage path.
- Public docs describe `generated/syncular.codegen.json` as a generated
  handoff, not a hand-authored app config.
- Docs typecheck and full docs build pass.

## Required Gates

- `bun --cwd apps/docs types:check`
- `bun --cwd apps/docs build`
- `git diff --check`
- Focused stale-link scan:

```bash
rg -n '/docs/build/(client-setup|table-handlers|auth|offline-auth|realtime|presence|blob-storage|encryption|yjs|runtimes/(web|expo|bun-node))' apps/docs/content/docs -g '*.mdx'
```

- Focused old-client scan:

```bash
rg -n 'legacy JavaScript client|pure TypeScript client dialect|client dialect|dialect-wa-sqlite|transport-ws|\\./syncular.codegen.json|--out \\./syncular.codegen.json' apps/docs/content/docs README.md packages/typegen
```

Expected result for both scans: no active public guidance hits. Historical
mentions inside roadmap/work-package/reference planning docs are allowed only
when clearly historical.

## Work Batches

### Batch 1: Navigation Skeleton

- `[x]` Create the new top-level folders/meta files.
- `[x]` Move the obvious current docs into the new root sections:
  `start`, `learn`, `client`, `server`, `features`, `testing`, `operate`,
  and `reference`.
- `[x]` Remove the old `build`, `concepts`, `introduction`, and
  `rust-client` public section roots from navigation and content paths.
- `[x]` Add or update `meta.json` so docs navigation renders the intended
  shape.
- `[x]` Keep content bodies mostly intact except for route/link cleanup and
  new section landing pages.
- `[x]` Run docs typecheck/build.

### Batch 2: Client Section

- `[x]` Rename/move current `rust-client` content to `client`.
- `[x]` Split binding pages into Browser TypeScript, React, React Native/Expo,
  Tauri/Electron, Rust, Swift, Kotlin/Android, and JVM.
- `[x]` Keep `Native Lifecycle` as the shared worker/event/realtime/presence
  model instead of making it the only native binding page.
- `[x]` Remove client-side references to removed public routes and old
  compatibility/alias wording in the touched pages.
- `[x]` Add concrete current-path pages only; no compatibility redirects or
  deprecated client dialect recommendations.
- `[x]` Run docs gates and browser-smoke all new binding pages.

### Batch 3: Server Section

- `[x]` Move server setup/reference implementation content into `Server`.
- `[x]` Keep generated HTTP API details under `Reference`.
- `[x]` Make table handlers, scopes/auth, realtime bridge, blobs, Cloudflare, service
  worker server, and external changes discoverable from one server landing page.
- `[x]` Add implementation pages for table handlers, scopes/auth,
  snapshot/pull, apply/push, realtime WebSocket, and blobs.
- `[x]` Update server setup examples to the current
  `createSyncServer({ sync: { handlers, authenticate } })` shape.
- `[x]` Keep exact handler, adapter, and HTTP option details under Reference
  and route implementation links to Server guides.

### Batch 4: Features Section

- `[x]` Move product-capability guides out of the overloaded `Build` area.
- `[x]` Add feature landing pages for blobs, CRDT/Yjs, encryption, presence, conflict
  resolution, offline auth leases, local read models, undo/redo, audit/history,
  and performance patterns.
- `[x]` Keep each page cross-platform and link to binding-specific details where
  needed.
- `[x]` Update feature recipes so they point at the cross-platform feature
  pages before binding-specific details.

### Batch 5: Link Cleanup And Redirect Decision

- `[x]` Run stale-link scans.
- `[x]` Decide whether to keep any temporary docs redirects.
- `[x]` If redirects are kept, record them in `COMPATIBILITY_REGISTER.md`; otherwise
  delete old public routes cleanly.
- `[x]` Run full docs build.

### Batch 6: Clients Root And Rust Depth Follow-Up

- `[x]` Move JavaScript and Rust under a shared `/docs/clients` root.
- `[x]` Remove JavaScript/Rust as top-level nav roots.
- `[x]` Add a clients landing page that routes by app language/runtime.
- `[x]` Expand Rust from a small overview set into dedicated pages for
  generated code, querying, mutations, conflicts/live queries, events,
  realtime/presence, CRDT fields, blobs/encryption, testing, and packaging.
- `[x]` Expand Rust testing into a real subsection matching the JavaScript
  testing shape.
- `[x]` Update public links from `/docs/javascript` and `/docs/rust` to
  `/docs/clients/javascript` and `/docs/clients/rust`.

### Batch 7: Client Chapter Parity

Problem found after Batch 6 review: JavaScript and Rust were grouped under
`Clients`, but their internal navigation still used different concepts. Rust
had conceptual API pages such as `Querying`; JavaScript mostly had host pages.
JavaScript exposed `Testing`; Rust exposed `Rust Testing`. This made the docs
feel arbitrary and forced readers to infer whether a topic was absent or merely
named differently.

Shared rule for language client sections:

```text
Overview
Core API
  Quick Start
  Generated Client
  Querying
  Mutations
  Live Updates
Runtime Features
  Runtime
  Realtime And Presence
  CRDT Fields
  Blobs And Encryption
Testing / Delivery
  Testing
  language-specific delivery or host pages
```

Language-specific pages are allowed only after the shared conceptual spine:

- JavaScript host integrations: Browser, React, React Native / Expo, Tauri,
  Electron.
- Rust delivery: Packaging.

Acceptance criteria:

- `[x]` JavaScript and Rust use the same labels for shared client concepts.
- `[x]` JavaScript has a `Querying` page if Rust has one.
- `[x]` Rust and JavaScript both expose `Testing`, not language-prefixed
  sidebar labels.
- `[x]` Redundant Rust-only aggregate pages are removed from the public
  client nav when they duplicate the shared pages.
- `[x]` All old links are updated to the new shared chapter paths.
- `[x]` Docs typecheck/build pass.

## Accept / Reject Rule

Keep changes when they reduce navigation ambiguity and pass docs gates. Revert
or split any batch that turns into a broad content rewrite without first
establishing the new IA skeleton.

## Current Evidence

- Batch 1 docs skeleton passes:
  - `git diff --check`
  - focused stale Build-route scan
  - focused old-client scan
  - `bun --cwd apps/docs types:check`
  - `bun --cwd apps/docs build`
- Batch 2 client binding split passes:
  - `git diff --check`
  - old moved-route scan across docs/README/typegen
  - focused old-client scan
  - `bun --cwd apps/docs types:check`
  - `bun --cwd apps/docs build`
  - Superseded by Batch 6 clients-root routing.
- The public docs top-level navigation now uses:
  `Start`, `Learn`, `Clients`, `Server`, `Features`, `Testing`, `Operate`,
  and `Reference`.
- `Build` and `Rust Client` are no longer public root sections. Current docs
  were moved into the new section folders instead of preserving compatibility
  routes.
- Batch 3 server section passes:
  - `git diff --check`
  - focused stale Build-route scan
  - old moved-route scan across docs/README/typegen
  - focused old-client scan
  - `bun --cwd apps/docs types:check`
  - `bun --cwd apps/docs build`
  - Browser smoke for `/docs/server`, `/docs/server/setup-with-hono`,
    `/docs/server/table-handlers`, `/docs/server/scopes-and-auth`,
    `/docs/server/snapshot-pull`, `/docs/server/apply-push`,
    `/docs/server/realtime-websocket`, and `/docs/server/blobs`.
- Batch 4 feature section passes:
  - `git diff --check`
  - old moved-route scan across docs/README/typegen
  - focused old-client scan
  - `bun --cwd apps/docs types:check`
  - `bun --cwd apps/docs build`
  - Browser smoke for `/docs/features`, `/docs/features/blobs`,
    `/docs/features/crdt-fields`, `/docs/features/field-encryption`,
    `/docs/features/presence`, `/docs/features/conflict-resolution`,
    `/docs/features/offline-auth-leases`, `/docs/features/undo-redo`,
    `/docs/features/local-read-models`, and
    `/docs/features/performance-patterns`.
- Batch 5 final cleanup passes:
  - Custom internal `/docs` link checker: checked `254` source files and
    `197` docs pages with no missing `/docs` links.
  - Removed-route scan for old `Build`, `Concepts`, `Introduction`,
    `Rust Client`, demo, blob, and rust-plan paths returned no hits.
  - Focused old-client scan returned no hits for legacy JavaScript client,
    client dialect, removed transport/package names, or hand-authored
    `syncular.codegen.json` guidance.
  - Redirect scan found only the canonical root `/` to `/docs` redirect and
    the docs markdown LLM rewrite; no old public route redirects are retained,
    so `COMPATIBILITY_REGISTER.md` did not need a docs-redirect exception.
  - `git diff --check`
  - `bun --cwd apps/docs types:check`
  - `bun --cwd apps/docs build`
  - Browser smoke for `/docs`, `/docs/start`, `/docs/learn`,
    `/docs/clients`, `/docs/server`, `/docs/features`, `/docs/testing`,
    `/docs/operate`, and `/docs/reference`.
- Batch 6 clients-root follow-up passes:
  - stale old language route scan returned no public docs hits for
    `/docs/javascript`, `/docs/rust`, or `/docs/client`.
  - `bun --cwd apps/docs types:check`
  - `bun --cwd apps/docs build`
  - Build output includes `/docs/clients`.
- Batch 7 client chapter parity passes:
  - JavaScript and Rust now share the same visible conceptual spine:
    `Quick Start`, `Generated Client`, `Querying`, `Mutations`,
    `Live Updates`, `Runtime`, `Realtime And Presence`, `CRDT Fields`,
    `Blobs And Encryption`, and `Testing`.
  - JavaScript-specific host pages are grouped under `Host Integrations`.
  - Rust-specific packaging is grouped under `Delivery`.
  - Removed redundant public Rust routes:
    `/docs/clients/rust/client-sdk`,
    `/docs/clients/rust/native-runtime`,
    `/docs/clients/rust/event-streams`, and
    `/docs/clients/rust/conflicts-live-queries`.
  - Old route scan returned no active public docs links for removed Rust client
    pages or old `/docs/javascript`, `/docs/rust`, `/docs/client` roots.
  - `git diff --check`
  - `bun --cwd apps/docs types:check`
  - `bun --cwd apps/docs build`
  - Local route smoke:
    `/docs/clients/javascript/querying`,
    `/docs/clients/javascript/testing`,
    `/docs/clients/rust/querying`,
    `/docs/clients/rust/testing`,
    `/docs/clients/rust/runtime`, and
    `/docs/clients/rust/live-updates` all return `200`.

## Next Action

WP-34 is complete with the client chapter parity follow-up. Return to the
roadmap order and pick the next non-accepted work package before making further
docs or runtime changes.
