# Visual style

The canonical implementation is `apps/docs/public/style.css`. Other Syncular
surfaces use the same colors, typography, and interaction rules.

## Colors

| Token | Value | Use |
| --- | --- | --- |
| `--void` | `#000000` | Page and sidebar background |
| `--panel` | `#0a0908` | Code blocks, table headings, and panels |
| `--ink` | `#f4efe4` | Primary text |
| `--dim` | `#9a948a` | Secondary text and labels |
| `--faint` | `#756f64` | Rules, captions, and tertiary text |
| `--border` | `rgba(154,148,138,0.35)` | Default borders |
| `--border-strong` | `rgba(154,148,138,0.6)` | Hover borders |
| `--amber` | `#ffb000` | Links, active states, and focus |

Use amber as the only accent. Attention states use amber text or an amber
background with black text.

## Typography

Use IBM Plex Mono with this fallback stack:

```css
'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace
```

Headings and interface labels use uppercase text with positive letter spacing.
Body text uses a `1.7` line height. Use the bundled fonts when the surface can
ship assets and the fallback stack for self-contained pages.

## Layout and interaction

- Use square corners, one-pixel borders, and flat backgrounds.
- Do not use shadows, gradients, or elevation effects.
- Use inverse-color hover states for links and buttons.
- Render keyboard focus with a visible amber outline.
- Stop decorative animation when `prefers-reduced-motion` is enabled.
- Collapse the documentation sidebar into a top bar below `860px`.
- Keep article content near `47rem` and landing content near `66rem`.

The documentation site stylesheet is authoritative when this summary and the
implementation differ.
