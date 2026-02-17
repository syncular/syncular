# RFC 0001: Replay Sessions with Virtual Timelines

Status: Draft  
Authors: Syncular maintainers  
Created: 2026-02-15  
Discussion: TBD

## Summary

Add a replay system for debugging that works with real clients without mutating the primary commit timeline.

Replay runs as an isolated session with a virtual timeline. Clients opt in to a replay session and pull from that session's cursor/window instead of the live head. Session advancement is broadcast as wake-up events over WebSocket, then clients pull replay data the same way they pull normal sync data.

Core constraint: replay must not write synthetic commits into the source partition's `sync_commits`/`sync_changes`.

## Motivation

Debugging sync issues often requires deterministic reproduction with real client behavior. Current tools (events, commits, console pages) help inspect but do not let teams step through a known history with controlled progression.

Appending "replay commits" to the live timeline is not acceptable because it pollutes production history and changes retention/pruning behavior.

## Goals

- Provide deterministic replay with real Syncular clients.
- Keep source commit history immutable during replay.
- Support session controls: create, start, pause, step, seek, stop.
- Support isolation via separate local DB and/or `stateId`.
- Preserve partition boundaries.
- Reuse existing client pull + WS wake-up semantics where possible.

## Non-Goals

- Replacing existing push/pull semantics for live sync.
- Allowing replay sessions to accept client mutations.
- Guaranteeing replay for ranges that have been pruned/compacted without extra seed data.

## Terminology

- Source partition: the real partition containing production commits.
- Replay session: server-side object defining replay range and cursor.
- Virtual timeline: session-scoped view of source commits gated by session cursor.
- Replay client: client configured to consume a replay session.

## Proposal

### 1. Replay Session Model

Introduce a replay session resource:

- `sessionId` (UUID)
- `sourcePartitionId` (string)
- `fromCommitSeq` (number)
- `toCommitSeq` (number | null)
- `cursor` (number)  
  Represents the highest source `commit_seq` currently visible in this session.
- `mode` (`paused` | `running` | `ended`)
- `tickStrategy` (`manual` | `interval`)
- `tickIntervalMs` (number | null)
- `createdBy` (console user id)
- `createdAt`, `updatedAt`, `expiresAt`
- `seed` metadata (see bootstrap section)

Sessions are ephemeral and TTL-bound.

### 2. Virtual Timeline Semantics

Given session `(from, to, cursor)`:

- Replay pull returns commits where:
  - `commit_seq > client_cursor`
  - `commit_seq <= cursor`
  - `commit_seq >= from`
  - If `to` set: `commit_seq <= to`
- Cursor changes only through session control operations.
- No source data is mutated.

### 3. Client Isolation

Replay must be isolated from live state. Two supported approaches:

- Preferred: separate local DB file for replay runs.
- Supported: shared DB with replay-specific `stateId` namespace (for example `replay:<sessionId>`).

Additional client isolation rules:

- Use a replay-specific `clientId`.
- Disable push/mutations in replay mode by default.
- Keep subscriptions explicit and session-scoped.

### 4. Partition Behavior

- Session is bound to one `sourcePartitionId`.
- Replay reads only from that partition.
- Replay WS scope-key routing remains partition-aware.
- No cross-partition replay in v1.

### 5. Bootstrap and Seeds

Replay from `fromCommitSeq = 0` is straightforward (empty baseline + commit playback).

Replay from `fromCommitSeq > 0` requires a baseline seed that represents state at `fromCommitSeq - 1`.

Session creation must enforce one of:

- `fromCommitSeq = 0`, or
- a valid seed checkpoint exists, or
- a seed can be materialized by an async replay worker before session becomes `ready`.

If neither condition is met, session creation fails with a clear error.

### 6. API Surface

Add console/admin endpoints:

- `POST /console/replay/sessions`
- `GET /console/replay/sessions/:id`
- `GET /console/replay/sessions`
- `POST /console/replay/sessions/:id/control`
- `DELETE /console/replay/sessions/:id`

Add replay sync endpoints (separate from live `/sync`):

- `POST /sync/replay/:sessionId`  
  Combined request; `push` is rejected, `pull` is allowed.
- `GET /sync/replay/:sessionId/realtime`  
  Wake-up channel for replay cursor advancements.

Reason for separate routes: avoids accidental mixing of live and replay semantics in existing handlers.

### 7. WebSocket Propagation

Replay WS events are session-scoped:

- `replay.tick` (cursor advanced)
- `replay.state` (paused/running/ended)
- `heartbeat`

Client behavior:

- On `replay.tick`, trigger pull for that replay session.
- Apply commits exactly as returned by replay pull.
- Never infer live sync state from replay socket events.

### 8. Server Invariants

Replay operations must not:

- insert rows into source partition `sync_commits`
- insert rows into source partition `sync_changes`
- call external-change synthetic commit flow for source partitions

Replay operations may:

- read from source sync tables
- write replay metadata/session tables
- write ephemeral seed/checkpoint artifacts

## Data Model Additions (Proposed)

Add tables (names tentative):

- `sync_replay_sessions`
- `sync_replay_clients` (optional: connection/activity tracking)
- `sync_replay_checkpoints` (optional: baseline seeds)

These tables are operational metadata and not part of the replicated user data model.

## CLI and Console UX

CLI:

- `syncular replay sessions create|list|show|delete`
- `syncular replay control start|pause|step|seek|stop`
- `syncular replay attach --session <id> [--state-id ...] [--db ...]`

Console:

- Session list with status and TTL.
- Timeline control panel (step/seek/play/pause).
- Connected replay clients panel.

## Security and Safety

- Replay endpoints require console/admin auth.
- Session ownership and ACL checks for controls.
- Explicit guard rails for destructive controls:
  - typed confirmation for `stop`/`delete` in interactive flows
- Rate limits on session count, tick rate, and connected replay clients.

## Interaction with Prune/Compaction

- Replay is only guaranteed for retained history.
- Session creation validates range availability.
- If history becomes unavailable mid-session, session transitions to `ended` with terminal reason.
- Optional checkpoints can reduce replay range requirements but do not eliminate retention constraints.

## Alternatives Considered

### A. Append replay commits to live timeline

Rejected. Pollutes commit history and breaks the core replay requirement.

### B. Use synthetic external-change commits for replay

Rejected. Forces re-bootstrap and does not preserve deterministic commit-by-commit progression.

### C. Offline-only local replay with no client integration

Not sufficient. Useful for tooling, but does not validate real client engine behavior.

## Rollout Plan

### Phase 1

- Replay sessions + virtual cursor.
- Manual step/pause/start controls.
- `fromCommitSeq = 0` support.
- Separate replay routes and replay WS.

### Phase 2

- Seed checkpoints for `fromCommitSeq > 0`.
- Seek support and interval playback.
- Console UI timeline controls.

### Phase 3

- Multi-client replay orchestration.
- Shareable replay session links/presets.

## Open Questions

- Seed generation strategy: background reconstruction vs persisted checkpoints.
- Whether replay should expose source `commit_seq` directly or map to session-local sequence numbers in responses.
- Retention policy for replay checkpoints and session metadata.
- Whether `stateId` alone is enough for all apps, or whether separate DB should be strongly enforced in tooling defaults.

## Acceptance Criteria

- Replay sessions can drive multiple clients deterministically without writing synthetic commits to source timelines.
- Replay mode works with existing pull/apply logic and WS wake-up behavior.
- Replay client state remains isolated from live client state.
- Operators can create, control, observe, and clean up sessions from CLI and console.
