# RFC 0003: CLI Create Modes and Command Flows

Status: Draft  
Authors: Syncular maintainers  
Created: 2026-02-16  
Discussion: TBD

## Summary

Redesign scaffolding around two explicit commands:

1. **`syncular create`**: generate integration library scaffolds chosen via checklist (server, expo, electron, react, vanilla, proxy API, etc.), with dialect choice per selected target.
2. **`syncular create demo`**: generate a runnable TypeScript demo (Hono server + Vite React client + WA-SQLite) that works with one `dev` command.

Scaffolding is template-driven with two top-level template families:

- `packages/cli/templates/demo/**`
- `packages/cli/templates/libraries/**`

## Motivation

Current scaffolding UX did not match how users start projects:

- First-time users want either a **working demo now** or **library scaffolds for an existing app**.
- Asking `fullstack|client|server` first is too abstract and not task-oriented.
- Dialect coverage is incomplete vs documented package surface.

## Goals

- Provide a one-command local demo startup path.
- Provide configurable library scaffolding for existing architectures.
- Support interactive and non-interactive modes with identical resolution logic.
- Generate predictable project structure and scripts (migrate + typegen included).

## Non-Goals

- Framework-specific full app generators for every stack.
- Building replay/debug orchestration in this RFC.
- Backward compatibility guarantees (alpha velocity preferred).

## Command Model

Top-level commands:

- `syncular create`
- `syncular create demo`
- `syncular migrate status`
- `syncular migrate up`
- `syncular doctor`
- `syncular interactive`

Create behavior:

- `syncular create` in TTY: interactive libraries wizard.
- `syncular create --no-interactive ...`: strict flag-based execution for libraries generation.
- `syncular create demo`: direct demo scaffolding flow.

Compatibility alias (temporary):

- `syncular init` -> `syncular create`
- `syncular demo` -> `syncular create demo`
- `syncular create-demo` -> `syncular create demo`

## Create Modes

### Command: `syncular create demo`

Creates a runnable full demo:

- **Server**: Hono + Syncular server setup
- **Client**: Vite + React + `@syncular/dialect-wa-sqlite`
- **Language**: TypeScript end-to-end

Success criteria:

- User runs `bun dev` (or `npm run dev`) and immediately sees a working synced app.
- No extra manual file creation required.

Generated defaults include:

- runnable server entry
- runnable client entry
- sample synced table/handlers
- migration adapter wired to sample migrations
- root `dev` script orchestrating server + client

### Command: `syncular create`

Interactive flow:

1. Select targets via checklist (multi-select):
   - `server`
   - `react`
   - `vanilla`
   - `expo`
   - `react-native`
   - `electron`
   - `proxy-api`
2. For each selected target, choose compatible dialect(s).
3. Choose output dir + overwrite policy.
4. Confirm and generate.

Non-interactive flow:

- Must provide selected targets + required dialect flags.
- Fails with explicit missing/invalid compatibility messages.

## Dialect Policy

Dialect choices are constrained per target.

Client/runtime-local families (as applicable):

- `@syncular/dialect-wa-sqlite`
- `@syncular/dialect-pglite`
- `@syncular/dialect-bun-sqlite`
- `@syncular/dialect-better-sqlite3`
- `@syncular/dialect-sqlite3`
- `@syncular/dialect-electron-sqlite`
- `@syncular/dialect-expo-sqlite`
- `@syncular/dialect-react-native-nitro-sqlite`

Server/provider families:

- `@syncular/server-dialect-postgres`
- `@syncular/server-dialect-sqlite`
- `@syncular/dialect-neon`
- `@syncular/dialect-d1`
- `@syncular/dialect-libsql`

## Libraries Output Contract

`libraries` mode generates:

- `syncular.config.json`
- migration script (adapter)
- `package.json` scripts for migrate + typegen
- selected module entries, e.g.:
  - `src/syncular/server/index.ts`
  - `src/syncular/react/index.ts`
  - `src/syncular/vanilla/index.ts`
  - `src/syncular/expo/index.ts`
  - `src/syncular/electron/index.ts`
  - `src/syncular/proxy-api/index.ts`

Only selected modules are generated.

## Script Policy

Scaffolded scripts should be consistent across modes where relevant:

- `db:migrate:status`: `syncular migrate status --config syncular.config.json`
- `db:migrate`: `syncular migrate up --config syncular.config.json`
- `db:migrate:reset`: `syncular migrate up --config syncular.config.json --on-checksum-mismatch reset --yes`
- `db:typegen`: run generated typegen script (if typegen enabled)
- `db:prepare`: migrate + typegen (if both exist)

Demo command output additionally includes:

- `dev`: starts server + client in one command

## React vs Vanilla Policy

- `react` and `vanilla` are explicit targets in `libraries` mode.
- They can both be selected when useful.
- Their templates differ by API style:
  - `react`: provider/hooks-oriented setup
  - `vanilla`: imperative transport/engine setup

## Interactive vs Non-Interactive Contract

- Interactive and non-interactive libraries flows must call the same plan resolver.
- `syncular interactive` -> selecting `create` must launch the same libraries wizard used by direct `syncular create`.
- No alternate default behavior between entry points.

## Template Architecture

Required structure:

- `packages/cli/templates/demo/**`
- `packages/cli/templates/libraries/**`
- optional shared partials under `packages/cli/templates/_shared/**`

Generation engine:

- resolve input -> generation plan
- render templates (Eta) -> file writes
- apply overwrite policy (`skip` vs `force`)
- print created/updated/skipped summary

## Usefulness Review

| Command | Keep | Usefulness |
|---|---|---|
| `syncular create` | Yes | Primary library onboarding scaffold |
| `syncular create demo` | Yes | One-command runnable demo scaffold |
| `syncular migrate status` | Yes | Safe, CI-friendly migration visibility |
| `syncular migrate up` | Yes | Migration execution with guarded reset mode |
| `syncular doctor` | Yes | Local sanity checks |
| `syncular interactive` | Yes | Discoverability + guided command access |

## Rollout Plan

Phase 1:

- Add explicit `create` and `create demo` command split.
- Create two template families (`demo`, `libraries`).
- Ensure interactive parity from command palette.

Phase 2:

- Add checklist target selection for libraries mode.
- Add per-target dialect prompts and compatibility validation.
- Generate script set (`db:migrate*`, `db:typegen`, `db:prepare`).

Phase 3:

- Expand target templates (`expo`, `electron`, `proxy-api`, etc.) to full matrix.
- Add `create list` and `create validate`.
- Document CLI create flows in docs.

## Acceptance Criteria

- `syncular create` and `syncular create demo` are the explicit scaffolding commands.
- Demo mode produces a project runnable via one `dev` command.
- Libraries mode supports checklist selection + per-target dialect selection.
- Libraries mode always generates config + migration script + package scripts + selected `src/syncular/*` module entries.
- Interactive and non-interactive produce equivalent generation plans for the same inputs.

## Open Questions

- Should `demo` always be React+WA-SQLite first in v1, or allow optional demo variants?
- For `proxy-api`, should scaffolding include client helper only, server route only, or both by default?
- Should package manager commands auto-detect `bun`/`npm`/`pnpm`/`yarn` from lockfiles, or stay explicit and configurable?

## Decision

Use this RFC as the implementation baseline for CLI create redesign before adding more command surface.
