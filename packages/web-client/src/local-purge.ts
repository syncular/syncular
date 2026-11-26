/**
 * Application-authorized local data purge.
 *
 * Syncular deliberately does not decide *why* a device lost access. The host
 * validates the signed/replayed server directive, gates the corresponding
 * subscriptions, and then hands this bounded plaintext-selector plan to the
 * local engine. The engine owns the atomic SQLite consequences: synced rows,
 * generated FTS projections, doomed optimistic commits, and blob references.
 */

import { invalidRequest, projectionUnknown } from './errors';
import type { CompiledClientSchema, CompiledClientTable } from './schema';

const MAX_TARGETS = 1024;
const MAX_SELECTORS_PER_TARGET = 8;
const MAX_VALUES_PER_SELECTOR = 128;
const MAX_ROUTING_VALUE_LENGTH = 256;
export const CODE_LIKE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function compareCodeLike(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** One AND-combined selector set. Targets are OR-combined. */
export type LocalDataPurgeTarget =
  | {
      readonly table: string;
      readonly selectors: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly projection: string };

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
  readonly projections: readonly string[];
  /** Stable JSON persisted beside the purge id for collision detection. */
  readonly canonicalPlan: string;
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
    throw invalidRequest('purgeId requires a 1–128 character routing ID');
  }
  if (input.targets.length === 0 || input.targets.length > MAX_TARGETS) {
    throw invalidRequest(`purge needs between 1 and ${MAX_TARGETS} targets`);
  }

  const deduplicated = new Map<string, CompiledLocalDataPurgeTarget>();
  const projectionNames = new Set<string>();
  for (const target of input.targets) {
    if ('projection' in target) {
      const name = target.projection;
      if (typeof name !== 'string' || Object.keys(target).length !== 1)
        throw invalidRequest('invalid projection purge target');
      (schema.projections ?? projectionUnknown(name)).require(name);
      projectionNames.add(name);
      continue;
    }
    const table = schema.tables.get(target.table);
    if (table === undefined) {
      throw invalidRequest('unknown purge table', false, {
        table: target.table,
      });
    }
    const entries = Object.entries(target.selectors);
    if (entries.length === 0 || entries.length > MAX_SELECTORS_PER_TARGET) {
      throw invalidRequest(
        `purge target needs between 1 and ${MAX_SELECTORS_PER_TARGET} selectors`,
        false,
        { table: target.table },
      );
    }
    const selectors: CompiledLocalDataPurgeSelector[] = entries
      .map(([columnName, rawValues]) => {
        const column = table.columns.find(
          (candidate) => candidate.name === columnName,
        );
        if (column === undefined) {
          throw invalidRequest('unknown purge column', false, {
            table: target.table,
            column: columnName,
          });
        }
        if (column.type !== 'string' || column.encrypted === true) {
          throw invalidRequest(
            'purge requires a plaintext string column',
            false,
            { table: target.table, column: columnName },
          );
        }
        if (
          rawValues.length === 0 ||
          rawValues.length > MAX_VALUES_PER_SELECTOR
        ) {
          throw invalidRequest(
            `purge selector needs 1 to ${MAX_VALUES_PER_SELECTOR} values`,
            false,
            { table: target.table, column: columnName },
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
            throw invalidRequest(
              `purge values require 1–${MAX_ROUTING_VALUE_LENGTH} character code-like identifiers`,
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

  const keys = [...deduplicated.keys()].sort();
  const targets = keys.map((key) => deduplicated.get(key)!);
  const projections = [...projectionNames].sort();
  const canonicalPlan = `[${[...keys, ...projections.map((projection) => JSON.stringify({ projection }))].join(',')}]`;
  return { purgeId: input.purgeId, targets, projections, canonicalPlan };
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
