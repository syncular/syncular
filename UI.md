# UI System Program Plan

Last updated: February 7, 2026
Owner: UI Platform / App Teams

## Program Goal
Create a single reusable UI system in `@syncular/hero-ui` and use it across:
- `docs/` (landing + documentation pages)
- `console/`
- `demo/`

Technology direction:
- Base UI primitives + Tailwind styling
- Charts use shadcn chart patterns (owned components) on top of Recharts
- No app-local primitive duplication
- Shared tokens, typography, spacing, motion, and component patterns

## Non-Negotiables
- New reusable UI goes into `packages/hero-ui` first.
- Apps import UI from `@syncular/hero-ui`, not local primitive copies.
- Accessibility behavior is provided by Base UI wrappers in `@syncular/hero-ui`.
- Chart infrastructure is shared in `@syncular/hero-ui/charts` (no new app-local chart wrappers).
- We follow shadcn chart composition patterns, but the implementation is owned in-repo.
- Breaking changes are acceptable (alpha), but migration steps must be staged and explicit.

## Current State
- `@syncular/hero-ui` exists and includes `observable-universe` landing components.
- `docs/` home already consumes `@syncular/hero-ui/observable-universe`.
- `console/` now imports shared primitives from `@syncular/hero-ui/primitives` (local primitive files are pending cleanup/removal).
- `console/` and `demo/` now share a common top navigation shell from `@syncular/hero-ui`.
- `demo/` still uses local ad-hoc UI patterns for most page content and panels.
- Docs content pages are still mostly default Fumadocs visual treatment.

## Scope Baseline (Audit)
- `console/src/components/hero-ui/*` still exists locally; only `chart.tsx` + chart consumers are active, but the full local UI folder still needs cleanup.
- `console/src/pages/Settings.tsx` has dense layout and mixed interaction patterns that do not match the new UI language.
- `console` does not yet reuse the topology visualization from `@syncular/hero-ui/observable-universe`.
- `demo/src/components/*` still has broad ad-hoc UI (cards/forms/buttons/badges/dialog substitutes), with repeated patterns across task, key-share, symmetric, and catalog demos.
- `docs/src/app/docs/*` and MDX rendering are still on default Fumadocs styling and are not yet aligned to the new design system.
- `docs/src/components/hero-ui/*` appears to be local duplicate UI wrappers and should be removed or moved into shared UI if needed.
- Cross-app form controls are inconsistent (`input`, `select`, toggles, inline button groups, native confirm dialogs).

### Progress Snapshot
- Phase 1 foundations are implemented:
  - Base UI installed in `@syncular/hero-ui`.
  - Initial shared primitives exported from `@syncular/hero-ui/primitives`.
  - Shared token stylesheet available at `@syncular/hero-ui/styles/tokens.css`.
  - Tokens wired into `docs`, `console`, and `demo`.
- Phase 2 primitive cutover is in progress:
  - `console` pages/components now import primitives from `@syncular/hero-ui/primitives`.
  - Local `console` chart wrapper remains app-local for now and is tracked for later extraction.
  - Shared top navigation (`AppTopNavigation`) now powers docs landing nav, console chrome nav, and demo tab/nav bar.
- Batch 1 (platform + charts) started:
  - New shared `@syncular/hero-ui/forms` primitives added.
  - New shared `@syncular/hero-ui/charts` (shadcn chart patterns + Recharts) added.
  - `console/src/components/charts/*` now imports from `@syncular/hero-ui/charts`.
- Batch 2 (console foundations) now in progress:
  - New shared `@syncular/hero-ui/console` components added (`PageHeader`, `SectionCard`, `KpiCard`, `DangerActionCard`, `TopologyCard`).
  - `SyncTopologyPanel` upgraded to support dynamic client IDs/positions (required for live console data).
  - `console/src/pages/Settings.tsx` rebuilt on shared forms + shared console components.
  - `console/src/pages/Overview.tsx` now includes live topology via an adapter from console API types to `@syncular/hero-ui` topology types.
  - App-local duplicate primitive folders removed from `console/src/components/hero-ui/*` and `docs/src/components/hero-ui/*`.
  - New guardrail check added: `scripts/check-no-local-ui-duplicates.ts`, wired into `bun check` and `bun check:fix`.
- Batch 3 (real topology + desktop shell) started:
  - `/console/clients` API now returns runtime-backed topology fields (`connectionMode`, `isRealtimeConnected`, `realtimeConnectionCount`, `activityState`, `lagCommitCount`, and latest request metadata).
  - `createSyncServer` now passes the sync `WebSocketConnectionManager` into console routes so connection state is sourced from live server state.
  - End-to-end transport telemetry now flows as `direct|relay` from transports (`@syncular/transport-http`, `@syncular/transport-ws`) into sync request events and realtime connections.
  - Console client/event APIs now expose `connectionPath` and `transportPath`, and shared topology adapters consume those fields directly.
  - Console chrome migrated from fixed-width top-nav layout to a desktop app shell (persistent sidebar + full-width workspace).
  - Shared form primitives were restyled for desktop density (labels, controls, segmented controls, switches/checkboxes).

## Target Architecture (`packages/hero-ui`)
- `src/tokens/*`
  - colors, typography, spacing, radii, shadows, motion
- `src/primitives/*`
  - Base UI wrappers: button, input, dialog, tooltip, tabs, table, pagination, etc.
- `src/forms/*`
  - field wrappers and controls: label, helper text, errors, checkbox, select, switch, textarea, radio group, segmented control
- `src/patterns/*`
  - reusable app blocks: metric cards, activity feed, lag bars, panel headers, code blocks
- `src/charts/*`
  - shadcn-style chart composition on top of Recharts (`ChartContainer`, `ChartTooltipContent`, chart theme bridge, legends, axis defaults)
- `src/sync-observability/*`
  - topology graph + clients/stream panels + adapters for app data
- `src/docs/*`
  - docs-only reusable shells and MDX visual components
- `src/console/*`
  - console page shells and reusable console sections
- `src/demo/*`
  - demo shells and shared interactive components
- `src/observable-universe/*`
  - existing landing/hero topology system

## Workstreams

### Workstream A: Foundations (UI Platform)
1. Add Base UI dependency in `packages/hero-ui`.
2. Build wrapper primitives with stable APIs.
3. Create shared token layer and global utility classes.
4. Add package exports and versioned migration notes.

Deliverables:
- `@syncular/hero-ui/primitives`
- shared tokens + base stylesheet
- `@syncular/hero-ui/charts` using shadcn chart patterns

### Workstream B: Docs Styling (Landing + Content)
This is the new required track.

#### B1. Docs Theme Alignment
- Align docs pages to new visual language (not only homepage):
  - typography scale
  - panel borders/backgrounds
  - code blocks
  - callouts
  - table styles
  - navigation chrome
- Apply through shared tokens and docs wrappers, not ad-hoc per page CSS.

Primary integration points:
- `docs/src/app/docs/layout.tsx`
- `docs/src/app/docs/[[...slug]]/page.tsx`
- `docs/src/mdx-components.tsx`
- `docs/src/app/global.css`
- `docs/src/components/openapi/*`

#### B2. Shared Docs Components in `@syncular/hero-ui`
Create reusable docs-focused components:
- `DocsSectionHeader`
- `DocsCallout`
- `DocsCodeFrame`
- `DocsDataTable`
- `DocsCardGrid`
- `DocsPageChrome`

Then map these through `mdx-components.tsx` where possible.

#### B3. API Doc Surface Unification
- Restyle generated/API pages to same tokenized system.
- Ensure OpenAPI pages match docs typography and panel aesthetics.

#### B4. Content QA Pass
- Verify heading rhythm and spacing on representative pages:
  - intro
  - guides
  - sdk
  - api
- Fix visual outliers and spacing regressions.

Deliverables:
- Docs content pages visually consistent with new system.
- Shared docs components in `@syncular/hero-ui`.

### Workstream C: Console Migration
#### C1. Primitive Cutover
- Replace imports from `@/components/hero-ui` -> `@syncular/hero-ui`.
- Keep behavior identical first.

Key files:
- `console/src/pages/Overview.tsx`
- `console/src/pages/Clients.tsx`
- `console/src/pages/System.tsx`
- `console/src/routes/__root.tsx`
- `console/src/components/StatsCard.tsx`
- `console/src/components/LiveActivityFeed.tsx`
- `console/src/components/SyncLagBar.tsx`

#### C2. Pattern Extraction
Move repeated console pieces into `@syncular/hero-ui/patterns` + `@syncular/hero-ui/console`:
- stats card
- live feed list item
- sync lag visualizations
- console shell header/nav blocks
- filter bars
- detail drawers/dialogs
- table-toolbar composition
- time-range segmented controls

#### C2a. Settings Overhaul (explicit)
- Rebuild Settings into reusable form sections and cards:
  - connection form
  - API key management table + dialogs
  - preferences controls
- Introduce shared components:
  - `FormSection`
  - `FieldGroup`
  - `InlineOptionGroup`
  - `DangerActionCard`
  - `SecretKeyReveal`
- Remove layout drift and ensure consistent spacing/rhythm with dashboard pages.

#### C3. Visual Alignment
- Apply observable-universe style language to console:
  - dark neutral surfaces
  - mono metadata labels
  - panel hierarchy and motion treatment

#### C4. Topology Integration
- Add a live topology module to console overview/system pages using shared topology components:
  - reuse `SyncTopologyPanel` visuals
  - add adapter from console client/stats types to topology types
  - support direct vs relay lanes, online/syncing/offline states, lag highlighting
- Introduce a shared `TopologyCard` in `@syncular/hero-ui/console`.

#### C5. Desktop UX Rework (Linear-like)
- Replace fixed-width page framing with workspace-first full-width content grids.
- Introduce a shared desktop page scaffold in `@syncular/hero-ui/console`:
  - left nav rail
  - page command/action bar
  - section split layout (primary + inspector)
- Standardize panel density, border contrast, and metadata typography for data-heavy use.
- Promote keyboard-first actions and clear focus states for all primary controls.

#### C6. Desktop Form System
- Consolidate all form usage to shared `@syncular/hero-ui/forms` controls and field wrappers.
- Introduce desktop form layout primitives:
  - two-column label/control rows
  - compact helper/error rows
  - section-level action bars
- Apply form system first to `Settings`, then to `System` maintenance/actions, then demo control panels.
- Remove remaining app-local input/select/toggle styling overrides after migration.

Deliverables:
- no local primitive library in console
- console visually aligned with docs system
- settings page rebuilt on shared form primitives
- topology visible and reusable in console

### Workstream D: Demo Migration
1. Replace demo tabs/buttons/cards/badges/panels with shared primitives.
2. Migrate common blocks to shared patterns where useful.
3. Keep business/domain demo logic local.

Target files (initial):
- `demo/src/components/App.tsx`
- `demo/src/components/SyncPanel.tsx`
- `demo/src/components/TaskList.tsx`

Deliverables:
- reduced UI drift between demo, console, docs
- shared panel shell for all demo variants
- unified task form/list/controls primitives
- consistent status badges and action bars

### Workstream E: Quality + Guardrails
1. Add lint/check to detect local primitive duplication in app packages.
2. Add visual regression coverage for shared components.
3. Add PR checklist item for `@syncular/hero-ui` reuse.
4. Define deprecation/removal plan for old app-local UI files.

Deliverables:
- regression protection and policy enforcement

### Workstream F: Cleanup + Deletion Pass
1. Remove unused app-local UI wrappers once migrated:
  - `console/src/components/hero-ui/*` (retain or migrate chart wrapper first)
  - `docs/src/components/hero-ui/*` (after docs migration)
2. Remove obsolete app-specific utility classes that duplicate shared tokens.
3. Remove no-longer-needed direct dependencies from app packages when wrappers are fully shared.

Deliverables:
- clean app trees with shared UI as source of truth
- reduced maintenance surface

### Workstream G: Chart System Standardization (shadcn patterns)
1. Extract `console/src/components/hero-ui/chart.tsx` into `@syncular/hero-ui/charts`.
2. Keep shadcn chart structure and API shape (`ChartContainer`, `ChartTooltip`, `ChartTooltipContent`).
3. Centralize chart color tokens and chart-specific utility classes in shared UI.
4. Migrate `console/src/components/charts/*` to shared chart primitives.
5. Add at least one demo chart consumer to validate cross-app reuse.

Deliverables:
- no app-local chart wrapper in console
- single shared chart system usable by console/demo/docs

## Detailed Migration Backlog

### Package UI Foundations (new)
1. Add primitives:
   - `Checkbox`, `Switch`, `Select`, `Textarea`, `Label`, `Field`, `RadioGroup`, `SegmentedControl`.
2. Add chart system:
   - move `console/src/components/hero-ui/chart.tsx` into `@syncular/hero-ui/charts`.
   - preserve shadcn chart composition patterns and exported API.
   - expose chart tokens and tooltip/legend variants.
3. Add layout patterns:
   - `AppPage`, `AppHeader`, `Panel`, `PanelHeader`, `EmptyState`, `KpiCard`, `FilterToolbar`.
4. Add sync observability patterns:
   - `TopologyCard`, `ClientStatusList`, `CommitStreamList`, `SyncHealthStrip`.

### Console Migration (file-level target map)
1. `console/src/pages/Overview.tsx`
   - migrate KPI/cards/charts/live feed to shared `@syncular/hero-ui/console` patterns.
   - add topology panel alongside activity blocks.
2. `console/src/pages/Settings.tsx`
   - rebuild with shared `@syncular/hero-ui/forms` + `@syncular/hero-ui/console` form sections.
3. `console/src/pages/Clients.tsx`
   - extract client card/list row patterns to shared UI.
4. `console/src/pages/Explorer.tsx`
   - move filter toolbar, event timeline row, and detail dialog patterns into shared package.
5. `console/src/pages/System.tsx`
   - move sidebar tabs, maintenance cards, alert threshold forms into reusable patterns.
6. `console/src/components/charts/*`
   - point to shared chart wrappers from `@syncular/hero-ui/charts`.
7. `console/src/components/hero-ui/*`
   - delete after chart migration completion.

### Demo Migration (file-level target map)
1. Shared shell and panel primitives:
   - `demo/src/components/SyncPanel.tsx`
   - `demo/src/components/KeySharePanel.tsx`
   - `demo/src/components/SymmetricPanel.tsx`
2. Shared task/list/forms:
   - `demo/src/components/TaskList.tsx`
   - `demo/src/components/SharedTaskList.tsx`
   - `demo/src/components/PatientNoteList.tsx`
3. Shared status/controls:
   - `demo/src/components/SyncControls.tsx`
   - `demo/src/components/SyncStatusBadge.tsx`
   - `demo/src/components/ConflictList.tsx`
4. Demo pages:
   - `demo/src/components/LargeCatalogDemo.tsx`
   - `demo/src/components/KeyShareDemo.tsx`
   - `demo/src/components/SymmetricDemo.tsx`
   - `demo/src/components/SplitScreenDemo.tsx`
5. Convert inline `confirm` flows to shared dialog patterns.

### Docs Migration (file-level target map)
1. Docs chrome and typography:
   - `docs/src/app/docs/layout.tsx`
   - `docs/src/app/global.css`
   - `docs/src/lib/layout.shared.tsx`
2. Docs page rendering wrappers:
   - `docs/src/app/docs/[[...slug]]/page.tsx`
   - `docs/src/mdx-components.tsx`
3. API page styling:
   - `docs/src/components/openapi/api-page.tsx`
4. Cleanup:
   - remove `docs/src/components/hero-ui/*` if no longer needed.

## Phase Gates (strict)
1. Gate 1: Shared forms + charts exist in `@syncular/hero-ui`.
2. Gate 2: Console Settings rebuilt and adopted.
3. Gate 3: Console topology integrated and live.
4. Gate 4: Demo core panels + task flows migrated.
5. Gate 5: Docs content pages tokenized and restyled.
6. Gate 6: App-local duplicate UI folders deleted.
7. Gate 7: Chart system unified on `@syncular/hero-ui/charts` with shadcn patterns.

## Acceptance Criteria by Area
- Console:
  - no local primitives except explicitly approved exceptions.
  - settings page matches spacing/typography/panel style from new system.
  - topology visible with live data states.
- Demo:
  - no ad-hoc gray/blue utility-driven form controls for shared interactions.
  - shared task/list/status controls use `@syncular/hero-ui`.
- Docs:
  - content docs and API docs visually match landing direction.
  - MDX elements map to shared docs components.
- Platform:
  - Tailwind source scanning includes `packages/hero-ui/src` in all consuming apps.
  - CI guardrails block new local primitive duplication.

## Phased Timeline

### Phase 0: Program Setup (0.5-1 day)
- Finalize package boundaries and naming
- Define token naming standard
- Confirm Base UI wrapper conventions

### Phase 1: Foundation Build (1-2 days)
- Complete Workstream A
- Publish first internal `@syncular/hero-ui` primitive set

### Phase 2: Docs Theme Pass (2-4 days)
- Complete Workstream B
- Includes docs content pages, not just landing

### Phase 3: Console Cutover + Styling (3-5 days)
- Complete Workstream C

### Phase 4: Demo Convergence (2-3 days)
- Complete Workstream D

### Phase 5: Guardrails + Cleanup (1-2 days)
- Complete Workstream E
- Remove deprecated local primitives

## Definition of Done
- `docs/`, `console/`, and `demo` consume shared UI primitives from `@syncular/hero-ui`.
- Docs content pages and landing follow one coherent design language.
- Console and docs share tokenized visual system and typography.
- Old app-local primitive libraries are removed or clearly deprecated.
- Accessibility behavior is routed through Base UI wrappers.

## Risks and Mitigations
- Risk: console page-level assumptions break during primitive swap.
  - Mitigation: wrapper API parity layer and staged replacement.
- Risk: docs generated/OpenAPI pages diverge from custom docs pages.
  - Mitigation: include API page restyle in Workstream B3.
- Risk: migration stalls after homepage work.
  - Mitigation: phase gates require docs content completion before console polish signoff.

## Immediate Next Steps
1. Replace remaining heuristic topology mapping in console views with `connectionPath`/`transportPath`-driven UI indicators and legend copy.
2. Extract reusable desktop page scaffold primitives into `@syncular/hero-ui/console` and migrate `Explorer`, `Clients`, `System`.
3. Apply desktop form layout primitives across `System` and demo panels after `Settings`.
4. Migrate demo panel shells and status controls to shared components.
5. Start docs content restyle via shared MDX component mapping and docs page chrome wrappers.
6. Keep duplicate-UI guardrail green and remove any newly introduced local component drift.

## Execution Plan (Batches)
### Batch 1: UI Platform + Charts
1. Implement shared form primitives in `@syncular/hero-ui/forms`.
2. Stand up `@syncular/hero-ui/charts` with shadcn chart patterns + Recharts.
3. Migrate `console/src/components/charts/*` to shared chart wrappers.
4. Keep behavior parity and verify `console` build/runtime.

### Batch 2: Console Core UX
1. Rebuild `console/src/pages/Settings.tsx` using shared forms/patterns.
2. Add live topology card to `console/src/pages/Overview.tsx` via shared topology adapter.
3. Extract reusable console blocks (KPI, filters, timeline, maintenance cards) into `@syncular/hero-ui/console`.

### Batch 3: Demo Surfaces
1. Migrate panel shells and status controls (`SyncPanel`, `KeySharePanel`, `SymmetricPanel`, `SyncControls`, `SyncStatusBadge`).
2. Migrate task/list forms (`TaskList`, `SharedTaskList`, `PatientNoteList`) to shared form primitives.
3. Replace native confirm/inline ad-hoc actions with shared dialog patterns.

### Batch 4: Docs Content + API
1. Add docs chrome wrappers and MDX component mapping to shared docs components.
2. Restyle API page surface to match the same design system.
3. Validate representative docs sections (intro/guides/sdk/api).

### Batch 5: Cleanup + Guardrails
1. Delete app-local duplicate UI folders after parity:
   - `console/src/components/hero-ui/*` (post chart extraction)
   - `docs/src/components/hero-ui/*` (post docs migration)
2. Add CI/lint guardrails to prevent re-introduction of local primitives/charts.

## Maintenance Rule
Update this file whenever:
- scope changes,
- sequencing changes,
- a workstream is completed,
- ownership changes.
