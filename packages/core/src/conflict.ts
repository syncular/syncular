/**
 * @syncular/core - Pure conflict detection and field-level merge utilities
 *
 * These are pure functions with no database dependencies.
 * Database-specific conflict detection (triggers, etc.) lives in @syncular/server.
 */

import type { MergeResult } from './types';

/**
 * Performs field-level merge between client changes and server state.
 *
 * Merge logic:
 * - If only client changed a field -> use client's value
 * - If only server changed a field -> keep server's value
 * - If both changed same field to different values -> true conflict
 *
 * @param baseRow - The row state when client started editing (from base_version)
 * @param serverRow - Current server row state
 * @param clientPayload - Client's intended changes
 * @returns MergeResult indicating if merge is possible and the result
 */
export function performFieldLevelMerge(
  baseRow: Record<string, unknown> | null,
  serverRow: Record<string, unknown>,
  clientPayload: Record<string, unknown>
): MergeResult {
  // If no base row (new insert), client payload wins entirely
  if (!baseRow) {
    return { canMerge: true, mergedPayload: clientPayload };
  }

  const conflictingFields: string[] = [];
  const mergedPayload: Record<string, unknown> = { ...serverRow };

  // Check each field in the client payload
  for (const [field, clientValue] of Object.entries(clientPayload)) {
    const baseValue = baseRow[field];
    const serverValue = serverRow[field];

    const clientChanged = !deepEqual(baseValue, clientValue);
    const serverChanged = !deepEqual(baseValue, serverValue);

    if (clientChanged && serverChanged) {
      // Both changed the same field
      if (!deepEqual(clientValue, serverValue)) {
        // Changed to different values - true conflict
        conflictingFields.push(field);
      }
      // If they changed to the same value, no conflict - use either
      mergedPayload[field] = clientValue;
    } else if (clientChanged) {
      // Only client changed - use client's value
      mergedPayload[field] = clientValue;
    }
    // If only server changed or neither changed, keep server value (already in mergedPayload)
  }

  if (conflictingFields.length > 0) {
    return { canMerge: false, conflictingFields };
  }

  return { canMerge: true, mergedPayload };
}

/**
 * Deep equality check for values (handles primitives, arrays, objects)
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;

  if (typeof a === 'object') {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((item, index) => deepEqual(item, b[index]));
    }

    if (Array.isArray(a) || Array.isArray(b)) return false;

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);

    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
  }

  return false;
}
