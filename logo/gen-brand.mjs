// Brand assets built from the coarse singularity: the site favicon and the
// README banners. Run from the repo root:  bun logo/gen-brand.mjs
// Fonts are embedded (data-URI @font-face) so the marks render in true IBM
// Plex Mono anywhere they are shown standalone — a browser tab, a GitHub README.
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import {
  singularity,
  wordmark,
  toSvg,
  P,
  COARSE,
  DETAILED_MARK,
  animatedWordmark,
} from './gen-logos.mjs';

const b64 = (p) => readFileSync(p).toString('base64');
const f5 = b64('apps/docs/public/fonts/plex-mono-500.woff2');
const f7 = b64('apps/docs/public/fonts/plex-mono-700.woff2');
const fontCss =
  `@font-face{font-family:'IBM Plex Mono';font-weight:500;src:url(data:font/woff2;base64,${f5}) format('woff2')}` +
  `@font-face{font-family:'IBM Plex Mono';font-weight:700;src:url(data:font/woff2;base64,${f7}) format('woff2')}`;

// FAVICON — the site mark: a dashed amber horizon ring, an ink ring and an amber core on
// the void color. Strokes are heavier than the header drawing so it holds up
// at 16 px.
const favSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" role="img" aria-labelledby="syncular-mark-title"><title id="syncular-mark-title">syncular mark</title><rect width="22" height="22" rx="4.5" fill="#000"/><circle cx="11" cy="11" r="9" fill="none" stroke="#ffb000" stroke-width="1.5" stroke-dasharray="2.6 2.1"/><circle cx="11" cy="11" r="5.2" fill="none" stroke="#f4efe4" stroke-width="1.7"/><circle cx="11" cy="11" r="2.4" fill="#ffb000"/></svg>
`;
writeFileSync('apps/docs/public/favicon.svg', favSvg);

// DETAILED MARK — no wordmark, more of the landing-page singularity. The dark
// variant is also public so brand consumers can use the exact social mark.
const detailedMark = singularity(DETAILED_MARK);
const markDark = toSvg({ ...detailedMark, round: true }, P.dark, 0.85, fontCss);
const markLight = toSvg(
  { ...detailedMark, round: true },
  P.light,
  0.85,
  fontCss,
);
writeFileSync('logo/mark-dark.svg', markDark);
writeFileSync('logo/mark-light.svg', markLight);
writeFileSync('apps/docs/public/brand-mark.svg', markDark);

// SOCIAL PREVIEW — PNG is intentional: social crawlers do not consistently
// accept SVG. Keep the mark centered so wide and square crops both preserve it.
await sharp(Buffer.from(favSvg), { density: 1200 })
  .resize(520, 520)
  .flatten({ background: P.dark.bg })
  .extend({
    top: 55,
    bottom: 55,
    left: 340,
    right: 340,
    background: P.dark.bg,
  })
  .png({ compressionLevel: 9 })
  .toFile('apps/docs/public/social-card.png');

// APP ICONS — PNG for iOS home screens and the web manifest. The favicon
// mark is drawn on the void color with 12% padding so launchers can mask it.
for (const [file, size] of [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
]) {
  const inner = Math.round(size * 0.8);
  const mark = await sharp(Buffer.from(favSvg), { density: 1200 })
    .resize(inner, inner, { fit: 'contain', background: P.dark.bg })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: P.dark.bg },
  })
    .composite([{ input: mark, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(`apps/docs/public/${file}`);
}

// README BANNERS — the wordmark lockup, dark + light, font embedded.
writeFileSync(
  'logo/banner-dark.svg',
  wordmark(COARSE.wordmark, P.dark, fontCss),
);
writeFileSync(
  'logo/banner-light.svg',
  wordmark(COARSE.wordmark, P.light, fontCss),
);

// README HERO — a script-free loop sampled from the live landing simulation.
// Dark/light assets let GitHub's <picture> follow the reader's color scheme.
writeFileSync(
  'logo/readme-animated-dark.svg',
  animatedWordmark({}, P.dark, fontCss),
);
writeFileSync(
  'logo/readme-animated-light.svg',
  animatedWordmark({}, P.light, fontCss),
);

console.log(
  'wrote favicon.svg + app icons + detailed marks + social-card.png + static and animated README banners',
);
