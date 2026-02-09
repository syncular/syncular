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
  return [];
}
