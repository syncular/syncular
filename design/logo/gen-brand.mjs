// Brand assets built from the coarse singularity: the site favicon and the
// README banners. Run from the repo root:  bun design/logo/gen-brand.mjs
// Fonts are embedded (data-URI @font-face) so the marks render in true IBM
// Plex Mono anywhere they are shown standalone — a browser tab, a GitHub README.
import { readFileSync, writeFileSync } from 'node:fs';
import { singularity, wordmark, toSvg, P, COARSE } from './gen-logos.mjs';

const b64 = (p) => readFileSync(p).toString('base64');
const f5 = b64('apps/docs/public/fonts/plex-mono-500.woff2');
const f7 = b64('apps/docs/public/fonts/plex-mono-700.woff2');
const fontCss =
  `@font-face{font-family:'IBM Plex Mono';font-weight:500;src:url(data:font/woff2;base64,${f5}) format('woff2')}` +
  `@font-face{font-family:'IBM Plex Mono';font-weight:700;src:url(data:font/woff2;base64,${f7}) format('woff2')}`;

// FAVICON — the coarse singularity, cropped near-square so it holds up in a tab.
const favSpec = singularity({
  cols: 17, rows: 10, fs: 32, horizonFrac: 0.34, ringFrac: 0.54, stars: false,
});
writeFileSync('apps/docs/public/favicon.svg', toSvg({ ...favSpec, round: true }, P.dark, 0.6, fontCss));

// README BANNERS — the wordmark lockup, dark + light, font embedded.
writeFileSync('design/logo/banner-dark.svg', wordmark(COARSE.wordmark, P.dark, fontCss));
writeFileSync('design/logo/banner-light.svg', wordmark(COARSE.wordmark, P.light, fontCss));

console.log('wrote favicon.svg + README banners');
