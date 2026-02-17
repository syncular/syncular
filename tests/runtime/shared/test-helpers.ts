/**
 * Shared test assertion helpers for runtime conformance tests.
 * Used by browser and D1 entry points.
 */

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function jsonEqual(a: unknown, b: unknown, label: string): void {
  assert(JSON.stringify(a) === JSON.stringify(b), `${label} mismatch`);
}

export function bytesToArray(value: unknown): number[] {
  if (value instanceof Uint8Array) return Array.from(value);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  // Handle Buffer-like objects (e.g. miniflare D1 on Linux) or cross-realm ArrayBuffer
  if (
    typeof value === 'object' &&
    value !== null &&
    'byteLength' in value &&
    typeof (value as ArrayBufferLike).byteLength === 'number'
  ) {
    try {
      // Try wrapping as ArrayBuffer via structured clone
      const buf = new Uint8Array(value as ArrayBufferLike);
      return Array.from(buf);
    } catch {
      // Fall through
    }
  }
  // Last resort: if it's iterable with numeric values
  if (value && typeof value === 'object' && Symbol.iterator in value) {
    return Array.from(value as Iterable<number>);
  }
  return [];
}
