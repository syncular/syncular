# UI Feedback & Audit

Visual audit of `console/`, `demo/`, and `docs/` conducted 2026-02-07.
Checked with Playwright MCP against live dev servers.

---

## Critical: Sync Topology Component

### 1. Hard-coded positions break with dynamic data

**File:** `packages/hero-ui/src/observable-universe/components/SyncTopologyPanel.tsx`
**File:** `packages/hero-ui/src/observable-universe/constants.ts`

The topology has a `NODE_POSITIONS` lookup table with predefined positions for `client-a` through `client-g`. When real clients connect (e.g. `client-sqlite-demo-user`, `client-pglite-demo-user`), none match the predefined keys, so **all clients fall through to `getDynamicPosition()`**. This works but has problems:

- **All dynamic clients land on the same side.** Because the demo/console clients all have `via: 'direct'`, they cluster on the left around the SERVER node using `getDynamicPosition('direct', ...)`. The RELAY node sits empty on the right with nobody connected to it, wasting half the SVG canvas.
- **The relay node always renders** even when zero relay clients exist. With 2 direct clients and 0 relay clients, the topology looks unbalanced -- a busy left side and an orphaned relay on the right with its BACKBONE connection animating to nothing.
- **Viewbox is fixed at `0 0 660 420`** regardless of client count. With 2 clients the diagram feels sparse; with 12+ clients the labels start to overlap.
- **Client labels truncate poorly.** `createDisplayId()` in `topology.ts` clips to 12 chars + `-N` suffix, producing IDs like `client-sqlit-1` that are neither readable nor meaningful. The SVG text nodes use `fontSize="8"` which becomes illegible at smaller viewport widths.
- **No transition/animation on client add/remove.** When clients come online or go offline in the console, nodes snap in/out with no entrance/exit animation, making the topology feel static rather than alive.

**Recommendations:**
- Hide the relay node entirely when there are zero relay clients.
- Recenter the layout dynamically: if only direct clients exist, center the SERVER node in the SVG and distribute clients around it in a full circle, not just a 180-degree arc.
- Add enter/exit transitions (fade + scale) when clients appear or disappear.
- Show full client IDs in a tooltip on hover rather than cramming truncated labels into tiny SVG text.
- Consider making the viewBox dimensions responsive to client count.

### 2. Topology adapter mapping issues

**File:** `console/src/lib/topology.ts`

- `inferType()` falls back to `'client'` for most real-world IDs. The hints (`ios`, `android`, `tablet`, `desktop`, etc.) rarely match production client IDs like `device-abc123`. The fallback type `'client'` has no special icon or visual treatment, making all nodes look identical.
- `inferStatus()` maps `idle` activity state to `'syncing'`, which is misleading. An idle client that's up-to-date (lag=0, realtime=false) shows as "syncing" because `isRealtimeConnected === false` triggers the syncing branch. This means **all polling clients appear as "syncing" even when fully caught up**.
- The "Polling clients" label in the Topology Health sidebar uses `topologySummary.direct` and "Realtime clients" uses `topologySummary.relay`, but these map to `connectionPath` (direct vs relay transport), not to polling vs realtime connection mode. A polling client going through a direct connection is labeled "Polling" correctly by coincidence, but a realtime client on a direct connection would also show as "Polling". The label semantics don't match the data semantics.

---

## Console App

### 3. Layout & spacing inconsistencies

**Pages affected:** All

- **Sidebar navigation** has no visual indicator for the active page other than the `[active]` link state. Should have a background highlight, left border accent, or bold weight to make the current page obvious.
- **Page header** (`PageHeader` component) has inconsistent bottom spacing relative to content. Dashboard has `gap-6` between header and KPI cards; Explorer has the filter bar immediately below; Settings has tabs. The rhythm between page title and first content block varies by ~8-16px across pages.
- **Card padding** differs between pages. `Overview.tsx` uses `CardContent className="pt-4"` for most cards but `pt-6` for the Recent Commits card. The TopologyCard has its own `p-8` padding. These should be consistent.
- The **time range selector buttons** on the Dashboard are raw `<button>` elements with inline Tailwind classes rather than using the shared `SegmentedControl` from `@syncular/hero-ui/forms`. This creates a visual inconsistency with the Settings page which uses `SegmentedControl` for similar controls (Time format toggle).

### 4. KPI cards grid

**File:** `console/src/pages/Overview.tsx:237`

- KPI cards use `grid-cols-2 md:grid-cols-5`. At medium breakpoints, 5 columns can feel cramped. The values (especially "Operations" with locale-formatted numbers) may overflow on narrow screens.
- The KPI card `meta` slot has inconsistent content types -- some are plain text (`"push"`, `"0 errors"`), some contain React elements (trending icon + percentage). The visual alignment of the meta row varies.

### 5. Charts render at -1 width

**Console warnings observed:**
```
The width(-1) and height(-1) of chart should be greater than 0
```

Recharts `ChartContainer` renders before its parent has a measured width. This happens on initial load and likely also on tab switches. The charts flash or render incorrectly before settling. Need either a `ResizeObserver` gate or a minimum width/height on the container.

### 6. Explorer page

- **Client ID column** shows `client-s...` and `client-p...` which is not useful. The truncation happens in the table cell, not at the data level, but the column is too narrow.
- **Filter buttons** ("All Events", "Push", "Pull") use different styling than the view mode buttons ("All", "Commits", "Events") even though they're in the same toolbar area. The filter buttons should share the same visual treatment.
- **Export / Prune / Clear** action buttons are right-aligned in the header with no visual grouping or separator between safe actions (Export) and destructive actions (Prune Old, Clear Events).

### 7. Clients page

- **Client cards** have `"Show details"` and `"Evict Client"` buttons at the bottom of each card. The Evict button is a destructive action that sits visually close to the details toggle with only a `Separator` between them. The destructive action should be more visually distinct (red text/border, or moved to a dropdown/overflow menu).
- **SyncLagBar** legend labels ("Synced (2)", "<10 behind (0)") use parenthetical counts. The colors in the bar and legend don't use the shared token system -- they use hardcoded Tailwind color classes (`bg-green-500`, `bg-yellow-500`, etc.) instead of `var(--sync-color-healthy)`, `var(--sync-color-syncing)`, etc.

### 8. System page

- **Sidebar tabs** ("Scopes", "Prune", "Compact", "Alerts") use buttons styled as a vertical nav, but they're not actual route-based tabs. The active state relies on local state, so refreshing the page always resets to "Scopes". This is inconsistent with the Settings page which uses real `Tabs` component from the UI package.
- **Scopes table** is sparse with only 4 rows and 3 columns. The table doesn't use the full width effectively -- the "CHUNK TTL" column shows "default" or "10m" with lots of whitespace.

### 9. Settings page

- **Connection state doesn't persist across page reload.** Navigating away from settings and back shows "Disconnected" momentarily before reconnecting. The URL/token persist (via localStorage) but the active connection drops and must be re-established.
- **Quick Connect URL section** still shows the old default URL (`http://localhost:3001/api`) in the generated URL even after connecting to a different server. It should reflect the current saved connection.
- **Preferences tab** - the `Switch` component and `SegmentedControl` have different vertical spacing patterns. The switch row has the label left-aligned with description below, while the segmented control has label above. These should follow the same field layout pattern.
- **API Keys tab** empty state ("No API keys yet") is just a plain paragraph with no visual container or call-to-action illustration. Compare to the topology empty state which uses a centered container with border.

---

## Demo App

### 10. Minimal UI package usage

The demo only imports `AppTopNavigation` and `SyncularBrand` from `@syncular/hero-ui`. All other UI (buttons, inputs, badges, cards, status indicators) is built with raw Tailwind classes. This creates significant visual drift:

- Demo buttons are plain `<button>` elements with custom Tailwind classes that don't match the `Button` component styling from `@syncular/hero-ui/primitives`.
- Status badges ("Synced", "Syncing", "Error", "Offline") in `SyncStatusBadge.tsx` use inline-styled colored dots that don't use the shared token colors.
- Form inputs (task text input, passphrase fields) have a completely different look-and-feel from the `Input` and `Field` components in the shared package.

### 11. Split-Screen Demo

- **Panel layout** is a simple 2-column grid (`grid-cols-2`). On smaller viewports it doesn't stack, causing horizontal cramping. Should be `grid-cols-1 md:grid-cols-2`.
- The **task list items** have many action buttons crowded together (checkbox, title button, Edit, Attach image, version badge, Delete) in a single row. On narrow panels, these wrap awkwardly.
- The **"How it works" section** below the panels uses a bare `<ul>` with default browser list styling, which feels unstyled compared to the rest of the dark-themed UI.

### 12. Large Catalog Demo

- The **"Seed to 1,000,000"** button and **"Force reseed"** / **"Clear"** buttons have no loading states despite triggering potentially long operations.
- The **stats cards** ("Server rows", "Local rows", "Snapshot chunks") use a custom card-like layout that doesn't match any shared component pattern.
- **Virtual list** has a custom scrollbar and window display (`"Window: 0-0 of 0"`) that could benefit from the shared `Table` component for consistency.

### 13. Key Share & Symmetric demos

- **Mnemonic word grid** uses a custom 4-column grid with numbered items. The styling (gray backgrounds, mono font) works but feels disconnected from the rest of the design system.
- **Passphrase input** + "Set Key" button layout has the button inside/adjacent to the input with custom styling that doesn't match `@syncular/hero-ui/forms` `Input` + `Button` patterns.
- The **"What to look for"** and **"How it works"** explanation sections use raw HTML elements (h3, ul, p, strong) without any shared wrapper, creating inconsistent typography and spacing with the rest of the UI.

### 14. Navigation bar

- The demo tab buttons in `AppTopNavigation` have no visual scroll indicator on mobile. With 5 tabs + "Console" link, the navigation overflows horizontally on small screens with no way to discover hidden tabs.
- "Coming Soon" tab renders nothing but also doesn't disable/gray out to signal it's placeholder.

---

## Docs Site

### 15. Landing page (Observable Universe)

- **Hydration error** on initial load: `Hydration failed because the server rendered HTML didn't match the client`. This is likely caused by the `useObservableUniverseSimulation` hook generating different random data on server vs client.
- **Missing favicon** -- 404 on `/favicon.ico`.
- The **commit stream** timestamps all show the same time (`22:48:52.219`) with different operations, which looks artificial. The simulation should stagger timestamps more convincingly.

### 16. Docs content pages

- The docs use **Fumadocs default theme** which has a light mode toggle. Toggling to light mode breaks the aesthetic since all `@syncular/hero-ui` components assume a dark theme (hardcoded dark colors like `#0c0c0c`, `#111111`, `#1e1e1e`). Either:
  - Remove the theme toggle and commit to dark-only, or
  - Add light-mode token values in `tokens.css`
- **Code blocks** in docs use Fumadocs' built-in syntax highlighting which has a different background/border treatment than the `syncular-code-frame` class from the shared tokens. Two different code block aesthetics exist on the same site.
- **Sidebar navigation** in docs uses Fumadocs default styling which doesn't use the syncular font tokens (`--sync-font-body`, `--sync-font-mono`). The sidebar feels like a different product from the landing page.

### 17. API reference pages

- The **"Send" button** for testing API endpoints shows `loading...` as button text for the server URL, suggesting the OpenAPI playground isn't properly configured or the base URL isn't resolving.
- The **Fumadocs OpenAPI** component emits a console warning: `the document "..."`. This suggests the OpenAPI spec reference isn't properly wired up.
- **Response code tabs** (200, 400, 401) and **language tabs** (cURL, JavaScript, Go, etc.) are rendered by Fumadocs with their default tab styling, which is visually distinct from the `Tabs` component in `@syncular/hero-ui`.

---

## Cross-App Consistency Issues

### 18. Typography inconsistency

| Surface | Font Family Used |
|---------|-----------------|
| Landing page (hero) | `var(--font-syne)` or fallback `Inter Tight` |
| Landing nav items | `var(--font-jetbrains-mono)` monospace, 11px uppercase |
| Console sidebar nav | System sans-serif, normal case |
| Console page headings | System sans-serif (inherits from Tailwind default) |
| Demo tab labels | `var(--font-jetbrains-mono)` monospace, 11px uppercase |
| Docs sidebar | Fumadocs default (system sans-serif) |
| Docs content | Fumadocs default (system sans-serif) |

The `--sync-font-display` and `--sync-font-body` tokens are defined in `tokens.css` but are only actually applied on the landing page. Console and demo pages inherit Tailwind's default `font-sans`, not the branded fonts. The monospace treatment (JetBrains Mono, uppercase, wide tracking) used in the landing nav and topology labels should be consistently applied to all metadata labels across apps.

### 19. Color token adoption

Several components use hardcoded hex values instead of CSS variables:

- `SyncTopologyPanel.tsx`: `#22c55e`, `#f59e0b`, `#ef4444`, `#8b5cf6`, `#3b82f6` -- all of which have equivalents in `tokens.css` (`--sync-color-healthy`, `--sync-color-syncing`, `--sync-color-offline`, `--sync-color-relay`, `--sync-color-flow`).
- `TopologyCard.tsx`: `bg-[#111111]`, `border-[#1e1e1e]` -- should use `var(--sync-color-panel)` and `var(--sync-color-border)`.
- `KpiCard` and `DangerActionCard` use hardcoded colors in their tone maps.
- Console `Overview.tsx` chart legends: `bg-[var(--color-chart-2)]` is inconsistent with using `var(--sync-color-*)` tokens elsewhere.

### 20. Border & surface hierarchy

- The landing page uses `border-[#1e1e1e]` consistently.
- Console `Card` component uses `border-border` (Tailwind variable).
- Both map to the same color, but the approach is inconsistent. Some components use hardcoded hex, others use CSS variables, others use Tailwind's semantic color names. Should standardize on one approach (preferably the CSS variables from `tokens.css`).

### 21. Spacing rhythm

Observed gap/padding values across pages:

| Location | Gap | Padding |
|----------|-----|---------|
| Dashboard KPI grid | `gap-4` | -- |
| Dashboard chart grid | `gap-4` | `pt-4` cards |
| Dashboard commits card | `gap-4` | `pt-6` (different!) |
| Explorer table | -- | default table padding |
| Clients card grid | `gap-4` | mixed |
| Settings sections | `gap-6` (via SectionCard) | internal varies |
| Demo panels | `gap-4` | custom per-panel |

The base spacing increment should be standardized. Currently it oscillates between `gap-4` (16px) and `gap-6` (24px) with card internal padding varying between `pt-4` and `pt-6`.

### 22. Empty states

Every empty state looks different:

- Dashboard "No commits yet": centered `text-muted-foreground` in a 100px container.
- Explorer with no results: not visible (always has data in demo).
- Clients with no clients: not visible.
- Topology empty: centered text in a `min-h-[280px]` bordered container.
- API Keys empty: plain `<p>` with no container.
- Live Activity empty: "Waiting for activity..." paragraph.

Should create a shared `EmptyState` component with consistent icon/message/action pattern.

---

## Summary Priority List

**P0 (Broken / Misleading):**
1. Topology relay node shows when no relay clients exist -- wastes space, confusing
2. `inferStatus()` marks all polling clients as "syncing" even when caught up
3. Topology Health sidebar mislabels direct/relay as polling/realtime
4. Recharts -1 width/height warnings causing flash on chart load
5. Docs hydration error from simulation hook

**P1 (Significant Visual Issues):**
6. Topology has no enter/exit animations for dynamic clients
7. Demo uses almost none of the shared UI components
8. Docs theme toggle breaks dark-only component assumptions
9. Typography tokens not applied outside landing page
10. Time range buttons should use SegmentedControl

**P2 (Polish & Consistency):**
11. Standardize card padding (pt-4 vs pt-6)
12. Standardize spacing rhythm (gap-4 vs gap-6)
13. Replace hardcoded hex colors with CSS variable tokens
14. Create shared EmptyState component
15. Improve client ID display (tooltip instead of truncation)
16. Consistent filter/toolbar button styling in Explorer
17. Mobile responsiveness for demo panels and nav tabs
18. Quick Connect URL should reflect actual saved connection
19. System page tabs should persist across page refresh (or use routes)
20. Destructive actions need more visual separation from safe actions
