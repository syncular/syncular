/**
 * ID generation utilities
 */

/**
 * Generate a random UUID v4
 */
export function randomUUID(): string {
  // Use crypto.randomUUID if available (modern browsers, Node, Bun)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback implementation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Build a stable state id from meaningful segments.
 * Empty/undefined segments are ignored.
 */
export function buildStateId(
  ...segments: Array<string | null | undefined>
): string {
  const normalized = segments
    .map((segment) => segment?.trim())
    .filter((segment): segment is string => !!segment && segment.length > 0);

  if (normalized.length === 0) return 'default';
  return normalized.join(':');
}

/**
 * Create a deterministic fingerprint string for scope values.
 */
export function createScopeFingerprint(
  scopes: Record<string, string | string[]>
): string {
  const entries = Object.entries(scopes)
    .map(([key, value]) => {
      const encodedValues = (Array.isArray(value) ? [...value] : [value])
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .sort();

      return `${key}:${encodedValues.join('|')}`;
    })
    .sort();

  return entries.join(';');
}
