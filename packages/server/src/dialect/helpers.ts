/**
 * @syncular/server - Shared dialect helpers
 *
 * Pure helper functions used by all server sync dialect implementations.
 */

import type { StoredScopes } from '@syncular/core';

export function coerceNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint')
    return Number.isFinite(Number(value)) ? Number(value) : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function coerceIsoString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function parseScopes(value: unknown): StoredScopes {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    const result: StoredScopes = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') {
        result[k] = v;
      }
    }
    return result;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        const result: StoredScopes = {};
        for (const [k, v] of Object.entries(
          parsed as Record<string, unknown>
        )) {
          if (typeof v === 'string') {
            result[k] = v;
          }
        }
        return result;
      }
    } catch {
      // ignore
    }
  }
  return {};
}
