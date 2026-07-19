import { expect, test } from 'bun:test';
import { SYNCULAR_VITE_OPTIMIZE_DEPS_EXCLUDE } from '../src/vite-config';

test('the Vite preset keeps the complete first-party worker graph out of optimizer chunks', () => {
  expect(SYNCULAR_VITE_OPTIMIZE_DEPS_EXCLUDE).toEqual([
    '@syncular/client',
    '@syncular/client/worker',
    '@syncular/core',
    '@syncular/crypto',
    '@syncular/react',
  ]);
  expect(new Set(SYNCULAR_VITE_OPTIMIZE_DEPS_EXCLUDE).size).toBe(
    SYNCULAR_VITE_OPTIMIZE_DEPS_EXCLUDE.length,
  );
});
