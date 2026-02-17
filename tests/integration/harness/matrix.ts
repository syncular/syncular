/**
 * Integration test matrix configuration
 *
 * Defines dialect combinations for parameterized testing.
 */

import type { MatrixCombination } from './types';

export const matrixCombinations: MatrixCombination[] = [
  {
    serverDialect: 'sqlite',
    clientDialect: 'bun-sqlite',
    name: 'sqlite + bun-sqlite',
  },
  {
    serverDialect: 'sqlite',
    clientDialect: 'pglite',
    name: 'sqlite + pglite',
  },
  {
    serverDialect: 'pglite',
    clientDialect: 'bun-sqlite',
    name: 'pglite + bun-sqlite',
  },
  {
    serverDialect: 'pglite',
    clientDialect: 'pglite',
    name: 'pglite + pglite',
  },
];

/**
 * Quick combinations for default test runs (2 combos).
 * Full matrix via MATRIX_FULL=true.
 */
export function getQuickCombinations(): MatrixCombination[] {
  return matrixCombinations.filter(
    (c) =>
      (c.serverDialect === 'sqlite' && c.clientDialect === 'bun-sqlite') ||
      (c.serverDialect === 'pglite' && c.clientDialect === 'pglite')
  );
}
