# WP-44 Observable Universe Rust-First Copy

Status: `[x]` accepted

## Goal

Keep the public reusable Observable Universe landing surface aligned with the
current Rust-first product shape and docs information architecture.

## Scope

- Update hero, architecture, feature, install, and footer copy to describe the
  Rust-owned SQLite runtime rather than the older generic offline-first/dialect
  story.
- Replace old `/docs/...` navigation defaults with current
  `docs.syncular.dev` Start/Learn/Clients/Server/Reference links.
- Reframe the runtime table around app host surfaces instead of old dialect
  choices.

## Non-Goals

- Do not change component APIs or visual layout.
- Do not add protocol compatibility branches or legacy docs redirects.

## Evidence

- Baseline: WP-43 exact-version release rehearsal passed npm and Cargo dry-runs
  from a stamped temporary worktree.
- Verified the referenced docs pages exist under `apps/docs/content/docs`.
- `bunx biome check packages/ui/src/observable-universe/architecture-section.tsx packages/ui/src/observable-universe/code-section.tsx packages/ui/src/observable-universe/connected-clients-panel.tsx packages/ui/src/observable-universe/constants.ts packages/ui/src/observable-universe/explanation-section.tsx packages/ui/src/observable-universe/footer-bar.tsx packages/ui/src/observable-universe/hero-dashboard-section.tsx packages/ui/src/observable-universe/install-section.tsx packages/ui/src/observable-universe/observable-universe-header.tsx`
- `bun --cwd packages/ui tsgo`
- `bun --cwd packages/ui build`

## Decision

Accepted. The landing copy now leads with Rust-owned local state, generated
host APIs, current install commands, and the current public docs hierarchy. The
change stays copy/link-only and keeps the reusable component API unchanged.
