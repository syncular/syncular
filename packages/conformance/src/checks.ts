/**
 * Assertion primitives for scenario scripts. Runner-owned (independent of
 * any test framework) so the catalog can execute anywhere and report
 * structured per-scenario results.
 */

export class ConformanceCheckError extends Error {
  override readonly name = 'ConformanceCheckError';
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Uint8Array) return `bytes(${v.length})`;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const record = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(record).sort()) sorted[k] = record[k];
      return sorted;
    }
    return v;
  });
}

export function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ConformanceCheckError(message);
}

export function checkEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  const a = stable(actual);
  const e = stable(expected);
  if (a !== e) {
    throw new ConformanceCheckError(
      `${message}\n  expected: ${e}\n  actual:   ${a}`,
    );
  }
}

export function checkBytesEqual(
  actual: Uint8Array,
  expected: Uint8Array,
  message: string,
): void {
  if (actual.length !== expected.length) {
    throw new ConformanceCheckError(
      `${message}: length ${actual.length} != ${expected.length}`,
    );
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new ConformanceCheckError(
        `${message}: bytes differ at offset ${i} (0x${actual[i]?.toString(16)} != 0x${expected[i]?.toString(16)})`,
      );
    }
  }
}
