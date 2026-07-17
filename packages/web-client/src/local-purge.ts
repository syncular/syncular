/**
 * Application-authorized local data purge.
 *
 * Syncular deliberately does not decide *why* a device lost access. The host
 * validates the signed/replayed server directive, gates the corresponding
 * subscriptions, and then hands this bounded plaintext-selector plan to the
 * local engine. The engine owns the atomic SQLite consequences: synced rows,
 * generated FTS projections, doomed optimistic commits, and blob references.
 */

import { ClientSyncError } from './errors';
import type { CompiledClientSchema, CompiledClientTable } from './schema';

const MAX_TARGETS = 64;
const MAX_SELECTORS_PER_TARGET = 8;
const MAX_VALUES_PER_SELECTOR = 128;
const MAX_ROUTING_VALUE_LENGTH = 256;
const CODE_LIKE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function compareCodeLike(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** One AND-combined selector set. Targets are OR-combined. */
export interface LocalDataPurgeTarget {
  readonly table: string;
  readonly selectors: Readonly<Record<string, readonly string[]>>;
}

/** A durable idempotency key plus one or more exact local routing targets. */
export interface LocalDataPurgeInput {
  readonly purgeId: string;
  readonly targets: readonly LocalDataPurgeTarget[];
}

/** Counts only; row ids and selector values never leave the local engine. */
export interface LocalDataPurgeResult {
  readonly alreadyApplied: boolean;
  readonly purgedRows: number;
  readonly droppedCommits: number;
}

export interface CompiledLocalDataPurgeSelector {
  readonly column: string;
  readonly values: readonly string[];
}

export interface CompiledLocalDataPurgeTarget {
  readonly table: CompiledClientTable;
  readonly selectors: readonly CompiledLocalDataPurgeSelector[];
}

export interface CompiledLocalDataPurge {
  readonly purgeId: string;
  readonly targets: readonly CompiledLocalDataPurgeTarget[];
  /** Stable JSON persisted beside the purge id for collision detection. */
  readonly canonicalPlan: string;
}

function invalid(message: string): never {
  throw new ClientSyncError('sync.invalid_request', message);
}

/** Validate and canonicalize before any transaction is entered. */
export function compileLocalDataPurge(
  schema: CompiledClientSchema,
  input: LocalDataPurgeInput,
): CompiledLocalDataPurge {
  if (
    input.purgeId.length === 0 ||
    input.purgeId.length > 128 ||
    !CODE_LIKE_VALUE.test(input.purgeId)
  ) {
    invalid(
      'local purge purgeId must be a 1–128 character code-like identifier',
    );
  }
  if (input.targets.length === 0 || input.targets.length > MAX_TARGETS) {
    invalid(`local purge needs between 1 and ${MAX_TARGETS} targets`);
  }

  const deduplicated = new Map<string, CompiledLocalDataPurgeTarget>();
  for (const target of input.targets) {
    const table = schema.tables.get(target.table);
    if (table === undefined) {
      invalid(
        `local purge names unknown table ${JSON.stringify(target.table)}`,
      );
    }
    const entries = Object.entries(target.selectors);
    if (entries.length === 0 || entries.length > MAX_SELECTORS_PER_TARGET) {
      invalid(
        `local purge target ${JSON.stringify(target.table)} needs between 1 and ${MAX_SELECTORS_PER_TARGET} selectors`,
      );
    }
    const selectors: CompiledLocalDataPurgeSelector[] = entries
      .map(([columnName, rawValues]) => {
        const column = table.columns.find(
          (candidate) => candidate.name === columnName,
        );
        if (column === undefined) {
          invalid(
            `local purge target ${JSON.stringify(target.table)} names unknown column ${JSON.stringify(columnName)}`,
          );
        }
        if (column.type !== 'string' || column.encrypted === true) {
          invalid(
            `local purge selector ${JSON.stringify(target.table)}.${JSON.stringify(columnName)} must be a plaintext string column`,
          );
        }
        if (
          rawValues.length === 0 ||
          rawValues.length > MAX_VALUES_PER_SELECTOR
        ) {
          invalid(
            `local purge selector ${JSON.stringify(target.table)}.${JSON.stringify(columnName)} needs between 1 and ${MAX_VALUES_PER_SELECTOR} values`,
          );
        }
        const values = [...new Set(rawValues)];
        for (const value of values) {
          if (
            typeof value !== 'string' ||
            value.length === 0 ||
            value.length > MAX_ROUTING_VALUE_LENGTH ||
            !CODE_LIKE_VALUE.test(value)
          ) {
            invalid(
              `local purge selector values must be 1–${MAX_ROUTING_VALUE_LENGTH} character code-like identifiers`,
            );
          }
        }
        values.sort();
        return { column: columnName, values };
      })
      .sort((a, b) => compareCodeLike(a.column, b.column));
    const canonicalTarget = {
      table: table.name,
      selectors: Object.fromEntries(
        selectors.map((selector) => [selector.column, selector.values]),
      ),
    };
    deduplicated.set(JSON.stringify(canonicalTarget), { table, selectors });
  }

  const targets = [...deduplicated.entries()]
    .sort(([a], [b]) => compareCodeLike(a, b))
    .map(([, target]) => target);
  const canonicalPlan = JSON.stringify(
    targets.map((target) => ({
      table: target.table.name,
      selectors: Object.fromEntries(
        target.selectors.map((selector) => [selector.column, selector.values]),
      ),
    })),
  );
  return { purgeId: input.purgeId, targets, canonicalPlan };
}

/** Exact AND match for one target; targets themselves are OR-combined. */
export function localDataPurgeTargetMatches(
  target: CompiledLocalDataPurgeTarget,
  values: Readonly<Record<string, unknown>>,
): boolean {
  return target.selectors.every((selector) => {
    const value = values[selector.column];
    return typeof value === 'string' && selector.values.includes(value);
  });
}

export function localDataPurgeMetaKey(purgeId: string): string {
  return `localPurge:${purgeId}`;
}
