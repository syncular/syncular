/**
 * Gate wiring: the whole conformance catalog runs against the reference
 * pairing (TS web client × TS server, reference codec) under `bun test`,
 * one test per scenario so CI reports names + spec refs individually.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CATALOG,
  type Pairing,
  referenceCodecDriver,
  runScenario,
  tsClientDriver,
  tsServerDriver,
} from '../src';

const pairing: Pairing = {
  server: tsServerDriver,
  client: tsClientDriver,
  codec: referenceCodecDriver,
};

describe('catalog integrity', () => {
  test('scenario names are unique and every scenario carries spec refs', () => {
    const names = new Set<string>();
    for (const scenario of CATALOG) {
      expect(names.has(scenario.name)).toBe(false);
      names.add(scenario.name);
      expect(scenario.specRefs.length).toBeGreaterThan(0);
    }
    expect(CATALOG.length).toBeGreaterThanOrEqual(20);
  });

  test('doctrine: no timers anywhere in the package (readiness waits, never sleeps)', () => {
    const root = join(import.meta.dir, '..');
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(path);
        } else if (entry.name.endsWith('.ts')) {
          const source = readFileSync(path, 'utf8');
          if (/setTimeout|setInterval|\bsleep\s*\(/.test(source)) {
            offenders.push(path);
          }
        }
      }
    };
    scan(root);
    // This file mentions the forbidden names inside the regex only.
    expect(offenders).toEqual([join(root, 'test', 'conformance.test.ts')]);
  });
});

describe('conformance: ts-web-client × ts-server', () => {
  for (const scenario of CATALOG) {
    const label = `${scenario.name} (${scenario.specRefs.join(' ')})`;
    test(label, async () => {
      const result = await runScenario(scenario, pairing);
      if (result.status === 'skipped') return;
      if (scenario.knownDiscrepancy !== undefined) {
        // The runner expects the failure; a pass means the marker is stale.
        expect(result.status).toBe('expected-fail');
        return;
      }
      expect(result.error ?? 'none').toBe('none');
      expect(result.status).toBe('pass');
    });
  }
});
