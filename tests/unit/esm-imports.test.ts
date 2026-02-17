import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixEsmImportsInDirectory } from '../../config/lib/esm-imports';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'syncular-esm-fix-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('fixEsmImportsInDirectory', () => {
  it('rewrites extensionless and directory imports to .js paths', () => {
    const dir = createTempDir();
    const distDir = path.join(dir, 'dist');
    const nestedDir = path.join(distDir, 'nested');

    mkdirSync(nestedDir, { recursive: true });

    writeFileSync(
      path.join(distDir, 'index.js'),
      `export * from './utils';
import './polyfills';
const dynamic = await import('./dynamic');
export * from './nested';
void dynamic;
`
    );
    writeFileSync(path.join(distDir, 'utils.js'), 'export const value = 1;\n');
    writeFileSync(path.join(distDir, 'polyfills.js'), 'export {};\n');
    writeFileSync(path.join(distDir, 'dynamic.js'), 'export default 1;\n');
    writeFileSync(
      path.join(nestedDir, 'index.js'),
      'export const nested = 1;\n'
    );

    fixEsmImportsInDirectory(distDir);

    const rewritten = readFileSync(path.join(distDir, 'index.js'), 'utf8');
    expect(rewritten.includes(`from './utils.js'`)).toBe(true);
    expect(rewritten.includes(`import './polyfills.js'`)).toBe(true);
    expect(rewritten.includes(`import('./dynamic.js')`)).toBe(true);
    expect(rewritten.includes(`from './nested/index.js'`)).toBe(true);
  });

  it('throws when a relative specifier cannot be resolved', () => {
    const dir = createTempDir();
    const distDir = path.join(dir, 'dist');

    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      path.join(distDir, 'index.js'),
      `export * from './missing';\n`
    );

    expect(() => fixEsmImportsInDirectory(distDir)).toThrow(
      'Unable to resolve relative ESM specifiers'
    );
  });
});
