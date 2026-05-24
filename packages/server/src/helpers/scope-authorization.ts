import type { ScopeValues, StoredScopes } from '@syncular/core';

function scopeValueAllows(
  allowed: ScopeValues[string] | undefined,
  rowValue: string
): boolean {
  if (allowed === undefined) return false;
  const allowedValues = Array.isArray(allowed) ? allowed : [allowed];
  return allowedValues.includes('*') || allowedValues.includes(rowValue);
}

export function rowScopesAllowed(args: {
  rowScopes: StoredScopes;
  allowedScopes: ScopeValues;
  requiredScopeKeys: readonly string[];
}): boolean {
  for (const key of args.requiredScopeKeys) {
    const rowValue = args.rowScopes[key];
    if (typeof rowValue !== 'string' || rowValue.length === 0) {
      return false;
    }
    if (!scopeValueAllows(args.allowedScopes[key], rowValue)) {
      return false;
    }
  }
  return true;
}
