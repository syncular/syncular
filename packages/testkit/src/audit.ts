import { isDeepStrictEqual } from 'node:util';

export interface RedactedAuditChange {
  redaction?: {
    payload?: unknown;
    reason?: unknown;
  };
  rowJson?: unknown;
  scopes?: unknown;
  [key: string]: unknown;
}

export interface RedactedAuditDebugExport {
  commits?: Array<{
    changes?: RedactedAuditChange[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export function assertAuditChangeRedacted(
  change: RedactedAuditChange,
  message = 'Expected audit change to be redacted'
): void {
  if ('rowJson' in change) {
    throw new Error(`${message}: rowJson must be omitted`);
  }
  if ('scopes' in change) {
    throw new Error(`${message}: raw scopes must be omitted`);
  }
  if (
    !isDeepStrictEqual(change.redaction, {
      payload: 'omitted',
      reason: 'audit_redacted_by_default',
    })
  ) {
    throw new Error(`${message}: missing canonical redaction marker`);
  }
}

export function assertAuditJsonExcludes(
  value: unknown,
  forbiddenNeedles: readonly string[],
  message = 'Audit JSON leaked forbidden content'
): void {
  const serialized = JSON.stringify(value);
  for (const needle of forbiddenNeedles) {
    if (!needle) continue;
    if (serialized.includes(needle)) {
      throw new Error(`${message}: ${needle}`);
    }
  }
}

export function assertAuditDebugExportRedacted(
  value: RedactedAuditDebugExport,
  forbiddenNeedles: readonly string[] = [],
  message = 'Expected audit debug export to be redacted'
): void {
  for (const commit of value.commits ?? []) {
    for (const change of commit.changes ?? []) {
      assertAuditChangeRedacted(change, message);
    }
  }
  assertAuditJsonExcludes(value, forbiddenNeedles, message);
}

export async function readJsonResponse<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function readTextResponse(response: Response): Promise<string> {
  return await response.text();
}
