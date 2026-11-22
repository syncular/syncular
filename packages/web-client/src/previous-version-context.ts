/**
 * `@syncular/client/previous-version`: the opt-in RFC 0005 previous-version
 * context. A client created with `definePreviousVersionContext()` captures a
 * bounded typed copy of the pre-reset rows at a §7.4.3 schema reset and serves
 * `previousVersionSnapshot()` from it. Without this entry the capture, read and
 * audit code is not part of the client bundle.
 */
import { ClientSyncError, invalidRequest } from './errors';
import {
  buildPreviousVersionAudit,
  capturePreviousVersion,
  loadLocalSchemaDescriptor,
  PREVIOUS_VERSION_MAX_LIMIT,
  type PreviousVersionBudgets,
  type PreviousVersionContext,
  readPreviousVersionContainer,
  readPreviousVersionRows,
  storedPreviousVersionAudit,
  storedPreviousVersionRefusal,
  writePreviousVersionAudit,
  writePreviousVersionRefusal,
} from './previous-version';

export type {
  PreviousVersionBudgets,
  PreviousVersionContext,
} from './previous-version';

/**
 * Enable the previous-version context with RFC 0005 budgets (D2/A4/D7):
 * `maxBytes` 8 MiB, `maxRows` 20,000, `maxTables` 32, `maxRowBytes` 1 MiB and
 * `maxAgeMs` 24 h by default. Pass the result as
 * `SyncClientConfig.previousVersionContext`, or pass this function as
 * `startSyncWorker({ createPreviousVersionContext })`.
 */
export function definePreviousVersionContext(
  budgets: PreviousVersionBudgets = {},
): PreviousVersionContext {
  // The pre-0.103.2 `{ enabled: true }` switch is refused, never ignored.
  if ('enabled' in budgets)
    throw new ClientSyncError(
      'client.previous_version_unconfigured',
      'previousVersionContext takes budgets only; the entry itself enables it',
    );
  const bounded = (name: keyof PreviousVersionBudgets, fallback: number) => {
    const value = budgets[name];
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1)
      throw invalidRequest(
        `previousVersionContext.${name} must be a positive safe integer`,
      );
    return value;
  };
  return {
    capture: {
      maxBytes: bounded('maxBytes', 8 * 1024 * 1024),
      maxRows: bounded('maxRows', 20_000),
      maxTables: bounded('maxTables', 32),
      maxRowBytes: bounded('maxRowBytes', 1024 * 1024),
    },
    maxAgeMs: bounded('maxAgeMs', 24 * 60 * 60 * 1000),
    capturePreviousVersion,
    loadLocalSchemaDescriptor,
    readPreviousVersionContainer,
    // RFC 0005 D7: `limit` defaults to 50 and is capped at 200.
    readPreviousVersionRows: (container, table, rowIds, limit = 50) => {
      if (!Number.isFinite(limit) || limit < 1)
        throw invalidRequest(
          'previousVersionSnapshot limit must be a positive number',
        );
      return readPreviousVersionRows(
        container,
        table,
        rowIds,
        Math.min(PREVIOUS_VERSION_MAX_LIMIT, Math.trunc(limit)),
      );
    },
    buildPreviousVersionAudit,
    writePreviousVersionAudit,
    storedPreviousVersionAudit,
    writePreviousVersionRefusal,
    storedPreviousVersionRefusal,
  };
}
