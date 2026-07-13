# The Syncular design system

The teletype theme: a transmission printout that documents a sync engine.
One monospace face, one amber accent, sharp corners, dark always. The
canonical implementation is the site stylesheet at
`apps/docs/public/style.css`; every other Syncular surface (the admin
console, future devtools) derives from the tokens and conventions below.

## Palette

Dark only. There is no theme toggle and no light variant.

| Token         | Value                      | Role                                                    |
| ------------- | -------------------------- | ------------------------------------------------------- |
| `--void`      | `#000000`                  | Page background, sidebar background                     |
| `--panel`     | `#0a0908`                  | Lifted surface: code blocks, table heads, inline code   |
| `--ink`       | `#f4efe4`                  | Primary text (warm paper white)                         |
| `--dim`       | `#9a948a`                  | Secondary text: ledes, nav links, captions, counts      |
| `--faint`     | `#756f64`                  | Tertiary text: section labels, rules, corner ticks      |
| `--border`    | `rgba(154,148,138,0.35)`   | The universal 1px border                                |
| `--border-strong` | `rgba(154,148,138,0.6)` | Hover-elevated border                                   |
| `--amber`     | `#ffb000`                  | THE accent — links, keywords, cursors, active states    |

Amber is the only accent. There is no separate success/warning/error
palette: "ok" status renders in amber, muted status in `--dim`, and
attention states use inverse video (amber fill, black text). Text
selection is the same inverse: `::selection { background: var(--amber);
color: #000 }`.

Syntax highlighting (Shiki `css-variables` theme, wired in
`apps/docs/astro.config.mjs`) uses a phosphor-terminal family:

| Token     | Value     | Role                          |
| --------- | --------- | ----------------------------- |
| `--tok-c` | `#756f64` | comments (italic)             |
| `--tok-k` | `#ffb000` | keywords                      |
| `--tok-s` | `#a9bf6e` | strings (muted green)         |
| `--tok-n` | `#6fb3c0` | constants/numbers (muted cyan)|
| `--tok-t` | `#e3d3a2` | functions, inline-code text   |

## Typography

Everything is monospace — body, headings, UI chrome, code. The face is
self-hosted IBM Plex Mono with the system-mono fallback stack:

```
'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace
```

Weights 400 (body), 700 (headings, strong, brand); 400 italic for
emphasis and comments. Fonts live in `apps/docs/public/fonts/*.woff2`
with `font-display: swap`. Surfaces that ship as a single self-contained
file (the admin console page) use the fallback stack alone — the system
mono face carries the theme fine without a webfont dependency.

Conventions:

- **Headings are UPPERCASE with positive letter-spacing.** Labels and
  kickers track widest (`0.08–0.18em`), headings `0.02–0.05em`, body `0`.
  The brand wordmark `SYNCULAR` tracks `0.18em`.
- Base is `16px`, body line-height `1.7`, article body `0.92rem`,
  block code `0.84rem`, table heads and kickers `0.68–0.72rem`.
- `strong` brightens to `--ink`; `em` dims to `--dim` italic.
- Glyph accents mark structure: page `h1` ends in an amber `.`,
  `h3` opens with amber `» `, list bullets are amber `* `, sidebar
  section labels open with faint `── `, the active nav item gets an
  amber `▸`.

## Layout

- **Sharp corners everywhere.** `border-radius` is never used; the one
  rounded rectangle in the project is the favicon tile.
- **Every box is `1px solid var(--border)`** — cards, tables, code,
  inputs, buttons. Hover elevates to `--border-strong` or `--amber`.
  Blockquotes add a `3px solid var(--amber)` left bar.
- No shadows, no gradients, no elevation tricks — depth comes from
  `--panel` versus `--void` and from borders.
- Content widths: docs article `47rem`, landing wrap `66rem`, sidebar
  `17rem` (`--sidebar-w`). Section rhythm sits around `1.6rem` vertical
  margins; cells pad `0.5rem 0.7rem`; buttons pad `0.55rem 1.2rem`.
- Single-column collapse at `860px`; the sidebar becomes a top bar.

## Signature elements

The chrome that makes a surface read as Syncular:

- **Blinking cursor** — the brand renders as `SYNCULAR_` with the
  underscore blinking (`steps(1)`, `1.1s`). Honor
  `prefers-reduced-motion` by stopping the blink.
- **Inverse-video hover** — links and buttons fill solid on hover:
  amber fill + black text for accent elements, ink fill + black text
  for neutral ones. This replaces underline-on-hover, color shifts,
  and every other hover idiom.
- **Bracketed labels** — buttons and chips read `[ QUICKSTART — 5 MIN ]`,
  `[ TS ]`, `[ PAUSE ]`. Chips wrap dim text in faint brackets via
  `::before`/`::after` and turn amber on hover.
- **`$` shell prompts** in install blocks, with the `$` and `#` comments
  in `--dim`.
- **ASCII rules** — section dividers are literal `='.repeat(160)` /
  `-'.repeat(160)` strings in `--faint`, clipped with
  `overflow: hidden`.
- **Statusbar strips** — `SYNC: NOMINAL · OUTBOX: 0 · LINK: WS/OK` at
  `0.68rem`, tracked `0.08em`, values in amber.
- **Corner ticks** — cards draw faint `+` glyphs at opposite corners
  (blueprint style) instead of any radius or shadow.
- **Printout captions** — `SECTION 01` kickers, `FIG. 1 —` captions,
  and the footer sign-off `END OF TRANSMISSION ■` (amber square).
- **ASCII art** — box-drawing diagrams for architecture, and the
  landing hero's live ASCII accretion-disk simulation (the only
  client-side script on the site).
- **Tables** — collapsed borders, `--panel` header row, UPPERCASE dim
  `th` at `0.72rem`, top-aligned cells, horizontal scroll on mobile.

## Applying it to a new surface

The checklist for any new Syncular-branded surface:

1. Monospace everything; IBM Plex Mono where assets can ship, the
   fallback stack where they can't.
2. Copy the palette tokens verbatim; amber stays the single accent.
3. UPPERCASE + letter-spacing for every heading and label.
4. `1px solid var(--border)` boxes, zero radius, zero shadows.
5. Inverse-video hover and selection.
6. Bracketed `[ LABELS ]` on interactive chrome; glyph accents
   (`»`, `*`, `──`, `▸`, `■`) for structure.
7. Dark always.
