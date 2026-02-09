#!/usr/bin/env bun
/**
 * Enforce shared UI control usage.
 * App code should use @syncular/ui components instead of raw form controls.
 */

import { Glob } from 'bun';

const appRoots = ['console/src', 'demo/src', 'apps/docs/src'];
const rawControlPattern = /<(button|input|select|textarea)\b/g;
const allowMarker = 'shadcn-allow-native-controls';

interface Violation {
  file: string;
  line: number;
  tag: string;
}

const violations: Violation[] = [];

for (const root of appRoots) {
  const glob = new Glob(`${root}/**/*.tsx`);
  for await (const file of glob.scan('.')) {
    const source = await Bun.file(file).text();
    if (source.includes(allowMarker)) continue;

    let match: RegExpExecArray | null;
    while ((match = rawControlPattern.exec(source)) !== null) {
      const line = source.slice(0, match.index).split('\n').length;
      violations.push({
        file,
        line,
        tag: match[1],
      });
    }
  }
}

if (violations.length > 0) {
  console.error(
    'Raw control tags found. Use @syncular/ui components instead:\n'
  );
  for (const violation of violations) {
    console.error(`  - ${violation.file}:${violation.line} <${violation.tag}>`);
  }
  console.error(
    `\nIf a raw control is required, document it with '${allowMarker}' in that file.`
  );
  process.exit(1);
}

console.log('✓ No raw app-level control tags found');
