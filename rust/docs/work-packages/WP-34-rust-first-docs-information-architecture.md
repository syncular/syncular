# WP-34 Rust-First Docs Information Architecture

Status: `[ ]` planned

## Goal

Restructure the public docs around the Rust-first product shape:

- one canonical Syncular client runtime with multiple host bindings;
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

## Proposed Top-Level Navigation

```text
Start
Learn
Client
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

### Client

Purpose: canonical Rust-first client runtime and host bindings.

Binding pages live here as subpages, not as separate root-level products:

- Overview
- Generate App Client
- Browser TypeScript
- React
- React Native / Expo
- Tauri / Electron
- Rust
- Swift
- Kotlin / Android
- JVM
- Local-Only Apps
- Lifecycle And Realtime
- Blobs
- CRDT / Yjs
- Encryption
- Packaging

Binding page template:

```text
When to use it
Install
Generate client
Open client
Query
Mutate
Subscribe / live queries
Realtime / lifecycle
Blobs / CRDT / encryption support
Testing
Packaging notes
```

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

Purpose: app-facing testkit and conformance workflows.

Candidate pages:

- Overview
- Quick Start
- Rust Testkit
- Stateful App Test Server
- Browser / WASM Tests
- Native Binding Tests
- Fault Injection
- Multi-Client Realtime
- Offline Reconnect
- Release Smoke

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
  `Start`, `Learn`, `Client`, `Server`, `Features`, `Testing`, `Operate`,
  `Reference`.
- Binding-specific docs are under `Client`, not separate root-level sections.
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
rg -n 'legacy JavaScript client|pure TypeScript client dialect|client dialect|dialect-wa-sqlite|transport-ws|./syncular.codegen.json|--out ./syncular.codegen.json' apps/docs/content/docs README.md packages/typegen
```

Expected result for both scans: no active public guidance hits. Historical
mentions inside roadmap/work-package/reference planning docs are allowed only
when clearly historical.

## Work Batches

### Batch 1: Navigation Skeleton

- Create the new top-level folders/meta files.
- Move only landing/index pages first.
- Add or update `meta.json` so docs navigation renders the intended shape.
- Keep old content bodies mostly intact.
- Run docs typecheck/build.

### Batch 2: Client Section

- Rename/move current `rust-client` content to `client`.
- Split binding pages into Browser TypeScript, React, React Native/Expo,
  Tauri/Electron, Rust, Swift, Kotlin/Android, and JVM where content exists.
- Add placeholder pages only when they route to concrete existing docs or
  explicitly state the current supported path.
- Ensure shared client features link to `Features`, not duplicated deeply in
  every binding page.

### Batch 3: Server Section

- Move server setup/reference implementation content into `Server`.
- Keep generated HTTP API details under `Reference`.
- Make table handlers, scopes/auth, realtime bridge, blobs, Cloudflare, service
  worker server, and external changes discoverable from one server landing page.

### Batch 4: Features Section

- Move product-capability guides out of the overloaded `Build` area.
- Add feature landing pages for blobs, CRDT/Yjs, encryption, presence, conflict
  resolution, offline auth leases, local read models, undo/redo, audit/history,
  and performance patterns.
- Keep each page cross-platform and link to binding-specific details where
  needed.

### Batch 5: Link Cleanup And Redirect Decision

- Run stale-link scans.
- Decide whether to keep any temporary docs redirects.
- If redirects are kept, record them in `COMPATIBILITY_REGISTER.md`; otherwise
  delete old public routes cleanly.
- Run full docs build.

## Accept / Reject Rule

Keep changes when they reduce navigation ambiguity and pass docs gates. Revert
or split any batch that turns into a broad content rewrite without first
establishing the new IA skeleton.

## Current Evidence

- Existing public docs build passes after prior cleanup:
  `bun --cwd apps/docs types:check` and `bun --cwd apps/docs build`.
- Current top-level docs still expose `Build` and `Rust Client` as separate
  root sections, which no longer matches the product model.
- Recent link cleanup removed known stale links to deleted Build pages, but the
  IA still deserves a deliberate restructure rather than incremental patching.

## Next Action

Start Batch 1: implement the new navigation skeleton with minimal content moves,
then run the docs gates before deeper rewrites.
