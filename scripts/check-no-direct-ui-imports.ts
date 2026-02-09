#!/usr/bin/env bun
/**
 * Enforce app-level UI imports through @syncular/ui only.
 * Apps should not import raw HeroUI or Base UI packages directly.
 */

import { Glob } from 'bun';

const appRoots = ['console/src', 'demo/src', 'apps/docs/src'];
const forbiddenPatterns = [
  {
    label: '@heroui/react',
    regex: /from\s+['"]@heroui\/react['"]/g,
  },
  {
    label: '@base-ui/react',
    regex: /from\s+['"]@base-ui\/react(?:\/[^'"]*)?['"]/g,
  },
];

interface Violation {
  file: string;
  line: number;
  source: string;
}

const violations: Violation[] = [];

for (const root of appRoots) {
  const glob = new Glob(`${root}/**/*.{ts,tsx,js,jsx}`);
  for await (const file of glob.scan('.')) {
    const source = await Bun.file(file).text();

    for (const pattern of forbiddenPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(source)) !== null) {
        const line = source.slice(0, match.index).split('\n').length;
        violations.push({
          file,
          line,
          source: pattern.label,
        });
      }

      pattern.regex.lastIndex = 0;
    }
  }
}

if (violations.length > 0) {
  console.error(
    'Direct UI library imports found in app code. Import from @syncular/ui instead:\n'
  );

  for (const violation of violations) {
    console.error(
      `  - ${violation.file}:${violation.line} (${violation.source})`
    );
  }

  process.exit(1);
}

console.log('✓ No direct HeroUI/Base UI imports found in app code');
