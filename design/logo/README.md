# syncular — logo

The mark is a still of the landing hero's live ASCII singularity
(`apps/docs/src/pages/index.astro`): a bright monospace accretion disk, an
amber event-horizon ring, and a dark singularity at the center. Same phosphor
palette as the site — amber `#ffb000` on void — with a light variant on
`#f4efe4`. Marks are rendered as coarse, big-pixel ASCII so they read even at
tab size.

## Assets in use

- `../../apps/docs/public/favicon.svg` — the singularity, near-square crop.
  Linked from every page head (landing, docs layout, 404).
- `banner-dark.svg` / `banner-light.svg` — the wordmark lockup (mark +
  `SYNCULAR_`) shown at the top of the repo `README.md` via a `<picture>`
  that swaps on `prefers-color-scheme`.

Both embed IBM Plex Mono (data-URI `@font-face`) so they render in the true
face wherever they appear standalone — a browser tab, a GitHub README.

## Regenerate

```
bun design/logo/gen-brand.mjs        # favicon.svg + both banners
```

`gen-logos.mjs` is the mark library (the singularity/wordmark generator) that
`gen-brand.mjs` builds on; run it directly to dump the full set of mark crops
for exploration:

```
bun design/logo/gen-logos.mjs out/   # 1-singularity … 5-ring, dark + light
```

Tune `horizonFrac` / `ringFrac` to change how much of the disk fills the
frame, `cols`/`rows`/`fs` for grain, and `labels` to place commit tags.
