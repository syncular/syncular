# syncular — logo

The mark is a still of the landing hero's live ASCII singularity
(`apps/docs/src/pages/index.astro`): a bright monospace accretion disk, an
amber event-horizon ring, and a dark singularity at the center. Same phosphor
palette as the site — amber `#ffb000` on void — with a light variant on
`#f4efe4`. Marks are rendered as coarse, big-pixel ASCII so they read even at
tab size.

## Assets in use

- `../apps/docs/public/favicon.svg` — the singularity, near-square crop.
  Linked from every page head (landing, docs layout, 404).
- `mark-dark.svg` / `mark-light.svg` — a detailed, text-free singularity mark
  for large placements. The dark variant is also published as
  `../apps/docs/public/brand-mark.svg`.
- `../apps/docs/public/social-card.png` — a 1200×630 raster of the detailed
  mark, centered in a crop-safe field for Open Graph and Twitter previews.
- `banner-dark.svg` / `banner-light.svg` — the wordmark lockup (mark +
  `SYNCULAR_`) retained as the static wordmark.
- `readme-animated-dark.svg` / `readme-animated-light.svg` — script-free,
  looping versions of the landing-page singularity used at the top of the repo
  `README.md`. The animation freezes to its fallback frame when the reader
  prefers reduced motion.

Both embed IBM Plex Mono (data-URI `@font-face`) so they render in the true
face wherever they appear standalone — a browser tab, a GitHub README.

## Regenerate

```
bun logo/gen-brand.mjs               # favicon, marks, social card, banners
```

`gen-logos.mjs` is the mark library (the singularity/wordmark generator) that
`gen-brand.mjs` builds on; run it directly to dump the full set of mark crops
for exploration:

```
bun logo/gen-logos.mjs out/          # 1-singularity … 5-ring, dark + light
```

Tune `horizonFrac` / `ringFrac` to change how much of the disk fills the
frame, `cols`/`rows`/`fs` for grain, and `labels` to place commit tags.
