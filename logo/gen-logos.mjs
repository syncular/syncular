// syncular logos v3 — still frames of the ACTUAL landing hero simulation.
// Same math as apps/docs/src/pages/index.astro; same color split:
//   disk brightness-ramp chars = ink (white)      -> #hole layer
//   event-horizon ring @ # *   = amber            -> #hole-glow layer
//   commit labels + heads      = amber
//   stars                      = faint
import { mkdirSync, writeFileSync } from 'node:fs';

const RAMP = ' .,:;+*#@';
const hash = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export const P = {
  dark:  { bg: '#000000', ink: '#f4efe4', dim: '#9a948a', faint: '#5f5a50', amber: '#ffb000', amberDim: '#c98400' },
  light: { bg: '#f4efe4', ink: '#1a160f', dim: '#6b6459', faint: '#a49c8d', amber: '#b26a00', amberDim: '#8a5200' },
};

const esc = (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c);
const fontDefs = (fontCss) => (fontCss ? `<defs><style>${fontCss}</style></defs>` : '');

// Render a cell grid to an SVG. cells:[{cx,cy,ch,cls}] px centers.
// Pass fontCss (an @font-face rule) to embed IBM Plex Mono for standalone use
// (favicon, README) where the platform monospace can't be relied on.
export function toSvg(
  { cols, rows, fs, cells, round = true },
  t,
  pad = 1.0,
  fontCss = '',
  title = 'syncular ASCII singularity mark',
) {
  const cw = fs * 0.6, ch = fs * 1.05;
  const w = cols * cw, h = rows * ch;
  const P2 = fs * pad;
  const spans = cells
    .map((c) => `<tspan x="${c.cx.toFixed(1)}" y="${c.cy.toFixed(1)}" fill="${t[c.cls]}">${esc(c.ch)}</tspan>`)
    .join('');
  const bgRx = round ? Math.min(w, h) * 0.14 + P2 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${(-P2).toFixed(1)} ${(-P2).toFixed(1)} ${(w + 2 * P2).toFixed(1)} ${(h + 2 * P2).toFixed(1)}" role="img" aria-labelledby="syncular-mark-title">
<title id="syncular-mark-title">${title}</title>
${fontDefs(fontCss)}<rect x="${(-P2).toFixed(1)}" y="${(-P2).toFixed(1)}" width="${(w + 2 * P2).toFixed(1)}" height="${(h + 2 * P2).toFixed(1)}" rx="${bgRx.toFixed(1)}" fill="${t.bg}"/>
<text font-family="'IBM Plex Mono','SFMono-Regular',ui-monospace,Menlo,Consolas,monospace" font-size="${fs}" font-weight="700" text-anchor="middle" dominant-baseline="central">${spans}</text>
</svg>`;
}

// Core generator — a frozen frame of the singularity.
// Radii are fractions of the vertical half-height so every crop is well-formed.
export function singularity({
  cols,
  rows,
  fs,
  horizonFrac = 0.28,
  ringFrac = 0.4,
  t0 = 0.9,
  labels = [],
  stars = true,
  aspect = 0.5,
  radialFrequency = 1.15,
}) {
  const CX = (cols - 1) / 2, CY = (rows - 1) / 2;
  const cw = fs * 0.6, ch = fs * 1.05;
  const cells = [];
  const rDisk = CY - 0.5;
  const rHorizon = rDisk * horizonFrac, rRing = rDisk * ringFrac;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const dx = (x - CX) * aspect, dy = y - CY;
      const rr = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      const px = x * cw + cw / 2, py = y * ch + ch / 2;
      if (rr < rHorizon) {
        // event horizon — empty darkness
      } else if (rr < rRing) {
        const p = 0.5 + 0.5 * Math.sin(a * 3 - t0 * 3.6 + rr);
        cells.push({ cx: px, cy: py, ch: p > 0.66 ? '@' : p > 0.33 ? '#' : '*', cls: 'amber' });
      } else if (rr < rDisk) {
        const band = (rr - rRing) / (rDisk - rRing);
        let b = (0.5 + 0.5 * Math.sin(2 * a - rr * radialFrequency + t0 * 2.4)) * (1 - band * 0.8);
        b += 0.32 * Math.cos(a - t0 * 0.9) * (1 - band);
        b += (hash(x, y) - 0.5) * 0.16;
        const idx = Math.max(0, Math.min(8, Math.floor(b * 9)));
        if (idx === 0) continue;
        const cls = idx >= 4 ? 'ink' : idx >= 2 ? 'dim' : 'faint';
        cells.push({ cx: px, cy: py, ch: RAMP[idx], cls });
      } else if (stars) {
        const hh = hash(x * 3.1, y * 7.7);
        if (hh > 0.965) cells.push({ cx: px, cy: py, ch: hh > 0.99 ? '+' : '.', cls: 'faint' });
      }
    }
  }
  // commit labels: amber '@' head + text spiralling on the disk
  for (const { col, row, text } of labels) {
    const px = col * cw + cw / 2, py = row * ch + ch / 2;
    // clear any disk char under the head
    for (let i = 0; i < text.length + 2; i++) {
      const cxp = (col + i) * cw + cw / 2;
      const idx = cells.findIndex((c) => Math.abs(c.cx - cxp) < cw * 0.4 && Math.abs(c.cy - py) < ch * 0.4);
      if (idx >= 0) cells.splice(idx, 1);
    }
    cells.push({ cx: px, cy: py, ch: '@', cls: 'amber' });
    for (let i = 0; i < text.length; i++) {
      cells.push({ cx: (col + 2 + i) * cw + cw / 2, cy: py, ch: text[i], cls: 'amberDim' });
    }
  }
  return { cols, rows, fs, cells };
}

// Wordmark: a compact singularity at left + SYNCULAR_ set in IBM Plex Mono.
export function wordmark(spec, t, fontCss = '') {
  const s = singularity(spec);
  const cw = spec.fs * 0.6, ch = spec.fs * 1.05;
  const markW = spec.cols * cw, markH = spec.rows * ch;
  const pad = spec.fs * 0.9;
  const gap = spec.fs * 1.4;
  const wordFs = markH * 0.62;
  const wordAdv = wordFs * 0.6;              // Plex Mono advance
  const word = 'SYNCULAR';
  const tx = pad + markW + gap;
  const baseline = pad + markH / 2;
  const totalW = tx + wordAdv * (word.length + 1) + pad;
  const totalH = markH + pad * 2;
  const spans = s.cells
    .map((c) => `<tspan x="${(pad + c.cx).toFixed(1)}" y="${(pad + c.cy).toFixed(1)}" fill="${t[c.cls]}">${esc(c.ch)}</tspan>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW.toFixed(1)} ${totalH.toFixed(1)}" role="img" aria-labelledby="syncular-wordmark-title">
<title id="syncular-wordmark-title">syncular</title>
${fontDefs(fontCss)}<rect width="${totalW.toFixed(1)}" height="${totalH.toFixed(1)}" rx="${(totalH * 0.16).toFixed(1)}" fill="${t.bg}"/>
<text font-family="'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace" font-size="${spec.fs}" font-weight="500" text-anchor="middle" dominant-baseline="central">${spans}</text>
<text x="${tx.toFixed(1)}" y="${baseline.toFixed(1)}" font-family="'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace" font-size="${wordFs.toFixed(1)}" font-weight="700" letter-spacing="1.5" dominant-baseline="central" fill="${t.ink}">${word}<tspan fill="${t.amber}">_</tspan></text>
</svg>`;
}

// Shared coarse specs — exported so brand assets (favicon, README banner)
// stay in lockstep with the gallery marks.
export const COARSE = {
  wordmark: { cols: 13, rows: 9, fs: 26, horizonFrac: 0.36, ringFrac: 0.56, stars: false },
};

// A higher-resolution, text-free mark for places where the pictogram has room
// to breathe (social previews, press kits, app splash screens). Its geometry
// deliberately follows the landing hero more closely than the coarse favicon.
export const DETAILED_MARK = {
  cols: 69,
  rows: 35,
  fs: 18,
  horizonFrac: 0.27,
  ringFrac: 0.38,
  stars: true,
  aspect: 0.55,
  radialFrequency: 1.35,
};

// Run directly (not imported) → write the gallery marks.
if (import.meta.main) {
  const OUT = process.argv[2] ?? 'svg3';
  mkdirSync(OUT, { recursive: true });
  const write = (name, spec, pad, round) => {
    for (const theme of ['dark', 'light']) {
      writeFileSync(`${OUT}/${name}-${theme}.svg`, toSvg({ ...spec, round }, P[theme], pad));
    }
  };

  // COARSE / "big-pixel" variant — fewer, larger cells so the ASCII reads loud.

  // 1. PRIMARY — full singularity, chunky grid
  write('1-singularity', singularity({
    cols: 27, rows: 18, fs: 24, horizonFrac: 0.3, ringFrac: 0.46,
    labels: [{ col: 17, row: 5, text: 'c45' }],
  }), 1.1, true);

  // 2. CORE — event-horizon crop, favicon / app-icon scale
  write('2-core', singularity({
    cols: 15, rows: 11, fs: 32, horizonFrac: 0.36, ringFrac: 0.56, stars: false,
  }), 0.9, true);

  // 3. DISC — wider crop, one commit infalling
  write('3-disc', singularity({
    cols: 36, rows: 17, fs: 20, horizonFrac: 0.26, ringFrac: 0.4,
    labels: [{ col: 24, row: 4, text: 'c46' }],
  }), 1.1, true);

  // 4. WORDMARK — compact chunky mark + SYNCULAR_
  for (const theme of ['dark', 'light']) {
    writeFileSync(`${OUT}/4-wordmark-${theme}.svg`, wordmark(COARSE.wordmark, P[theme]));
  }

  // 5. RING — minimal favicon: amber horizon ring + dark hole, a whisper of swirl
  write('5-ring', singularity({
    cols: 11, rows: 8, fs: 36, horizonFrac: 0.42, ringFrac: 0.68, stars: false,
  }), 0.85, true);

  console.log('wrote singularity marks to', OUT);
}
