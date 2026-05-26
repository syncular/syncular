# WP-44 Observable Universe Rust-First Copy

Status: `[x]` accepted

## Goal

Keep the public reusable Observable Universe landing surface aligned with the
current Rust-first product shape and docs information architecture.

## Scope

- Update hero, architecture, feature, install, topology, and footer copy to
  describe the Rust-owned SQLite runtime rather than the older generic
  offline-first/dialect story.
- Replace old `/docs/...` navigation defaults with current
  `docs.syncular.dev` Start/Learn/Clients/Server/Reference links.
- Reframe the runtime table around app host surfaces instead of old dialect
  choices.
- Keep the topology SVG sized from its viewBox instead of a fixed minimum
  height so the reusable panel can fit narrower host layouts.

## Non-Goals

- Do not change component APIs or the topology data model.
- Do not add protocol compatibility branches or legacy docs redirects.

## Evidence

- Baseline: WP-43 exact-version release rehearsal passed npm and Cargo dry-runs
  from a stamped temporary worktree.
- Verified the referenced docs pages exist under `apps/docs/content/docs`.
- `bunx biome check packages/ui/src/observable-universe/architecture-section.tsx packages/ui/src/observable-universe/code-section.tsx packages/ui/src/observable-universe/connected-clients-panel.tsx packages/ui/src/observable-universe/constants.ts packages/ui/src/observable-universe/explanation-section.tsx packages/ui/src/observable-universe/footer-bar.tsx packages/ui/src/observable-universe/hero-dashboard-section.tsx packages/ui/src/observable-universe/install-section.tsx packages/ui/src/observable-universe/observable-universe-header.tsx packages/ui/src/observable-universe/sync-topology-panel.tsx`
- `bun --cwd packages/ui tsgo`
- `bun --cwd packages/ui build`
- Temporary local browser preview of `ObservableUniverseLanding` at
  `http://127.0.0.1:5177/`:
  - DOM confirmed the Rust-owned hero, current docs navigation, current runtime
    table, and no browser console warnings/errors.
  - Desktop viewport `1280x720`: page `scrollWidth` equals viewport width.
  - Mobile viewport `390x844`: page `scrollWidth` equals viewport width after
    removing the topology SVG fixed minimum height.

## Decision

Accepted. The landing copy now leads with Rust-owned local state, generated
host APIs, current install commands, and the current public docs hierarchy. The
change keeps the reusable component API unchanged and preserves responsive
layout on mobile.
