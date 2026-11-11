export const PENDING_EVICTIONS = '_syncular_pending_evictions';
export const WINDOWS_TABLE = '_syncular_windows';
/**
 * Windows (SPEC.md §4.8).
 *
 * A window is a partial local replica keyed by scope VALUES: the client
 * holds the units of a chosen set of values of a window BASE (one scope
 * variable plus fixed values). Windowing is a set difference on §4.1 units,
 * never a mutation of one, so it needs no wire or server change.
 *
 * This module owns the registry bookkeeping. The eviction that fuses with a
 * shrink (E1–E4) lives on the client, which holds the DB transaction and the
 * invalidation choke point.
 */
import {
  canonicalUnitJson,
  type ScopeMap,
  type UnitScopes,
} from '@syncular/core';
import type { ClientDatabase } from './database';
import { invalidRequest } from './errors';

export type TimeBucketUnit = 'month';

const MAX_TIME_BUCKET_MS = 253_402_300_799_999;

function monthBucket(year: number, month: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`;
}

/** Derive the immutable UTC scope value stored when a row is created. */
export function creationTimeBucket(
  createdAtMs: number,
  unit: TimeBucketUnit,
): string {
  if (
    unit !== 'month' ||
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0 ||
    createdAtMs > MAX_TIME_BUCKET_MS
  ) {
    throw invalidRequest(
      'creationTimeBucket requires a supported unit and a UTC timestamp from 1970 through 9999',
    );
  }
  const date = new Date(createdAtMs);
  return monthBucket(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

/** Return a rolling UTC month window ordered from oldest to newest. */
export function last(
  count: number,
  unit: TimeBucketUnit,
  nowMs = Date.now(),
): string[] {
  if (
    unit !== 'month' ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 1_200 ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    nowMs > MAX_TIME_BUCKET_MS
  ) {
    throw invalidRequest(
      'last requires a supported unit, a count from 1 through 1200, and a UTC timestamp from 1970 through 9999',
    );
  }
  const date = new Date(nowMs);
  const current = date.getUTCFullYear() * 12 + date.getUTCMonth();
  if (current - (count - 1) < 1970 * 12) {
    throw invalidRequest(
      'last requires every returned UTC month to fall from 1970 through 9999',
    );
  }
  const units: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const value = current - offset;
    units.push(monthBucket(Math.floor(value / 12), (value % 12) + 1));
  }
  return units;
}

/**
 * A window base (§4.8): the selected scope variable plus the fixed scope
 * values every unit of its family shares. A base names no table: each unit
 * covers every table declaring its variables (§4.1).
 */
export interface WindowBase {
  /** The scope variable whose values are the window units. */
  readonly variable: string;
  /** One value per other variable, shared by every unit. */
  readonly fixedScopes?: UnitScopes;
}

/** A stable key for a window base: variable + canonical fixed scopes. */
export function windowBaseKey(base: WindowBase): string {
  return `${base.variable}\0${canonicalUnitJson(base.fixedScopes ?? {})}`;
}

/** The unit of one window value: the fixed scopes plus the value. */
export function windowUnitScopes(base: WindowBase, value: string): UnitScopes {
  return { ...base.fixedScopes, [base.variable]: value };
}

/** Registry rows for a base, ordered by value: value → unit id. */
export function loadWindowUnits(
  db: ClientDatabase,
  baseKey: string,
): { readonly value: string; readonly unitId: string }[] {
  return db
    .query(
      `SELECT unit,sub_id FROM ${WINDOWS_TABLE} WHERE base=? ORDER BY unit`,
      [baseKey],
    )
    .map((row) => ({
      value: row.unit as string,
      unitId: row.sub_id as string,
    }));
}

/** Every window registry row that references a unit (§4.1 references). */
export function windowRefs(
  db: ClientDatabase,
  unitId: string,
): { readonly baseKey: string; readonly value: string }[] {
  return db
    .query(`SELECT base,unit FROM ${WINDOWS_TABLE} WHERE sub_id=?`, [unitId])
    .map((row) => ({
      baseKey: row.base as string,
      value: row.unit as string,
    }));
}

// ---------------------------------------------------------------------------
// Deferred eviction (E1): per-table scopes of units that left with rows left
// ---------------------------------------------------------------------------

export interface PendingEviction {
  readonly unitId: string;
  readonly table: string;
  readonly effective: ScopeMap;
}

export function savePendingEviction(
  db: ClientDatabase,
  entry: PendingEviction,
): void {
  db.exec(
    `INSERT OR REPLACE INTO ${PENDING_EVICTIONS}(unit_id,tbl,effective_scopes)VALUES(?,?,?)`,
    [entry.unitId, entry.table, JSON.stringify(entry.effective)],
  );
}

export function deletePendingEviction(
  db: ClientDatabase,
  unitId: string,
  table?: string,
): void {
  db.exec(
    `DELETE FROM ${PENDING_EVICTIONS} WHERE unit_id=?${table === undefined ? '' : ' AND tbl=?'}`,
    table === undefined ? [unitId] : [unitId, table],
  );
}

export function loadPendingEvictions(db: ClientDatabase): PendingEviction[] {
  return db
    .query(`SELECT unit_id,tbl,effective_scopes FROM ${PENDING_EVICTIONS}`)
    .map((row) => ({
      unitId: row.unit_id as string,
      table: row.tbl as string,
      effective: JSON.parse(row.effective_scopes as string) as ScopeMap,
    }));
}
