/**
 * Windowed subscriptions (SPEC.md §4.8).
 *
 * A window is a partial local replica keyed by scope VALUES: the client
 * holds rows for a chosen set of units (one scope value each) of a window
 * BASE (a table + one scope variable + the fixed remainder of the scope
 * map). Windowing is a set-difference on §4 subscriptions — never a
 * mutation of one — so it needs zero wire or server changes.
 *
 * This module owns the registry bookkeeping and the deterministic
 * per-unit subscription-id derivation (§4.1 guidance). The eviction that
 * fuses with a shrink (E1–E4) lives on the client, which holds the DB
 * transaction and the invalidation choke point.
 */
import { canonicalScopeJson, type ScopeMap } from '@syncular/core';
import type { ClientDatabase } from './database';
import { ClientSyncError } from './errors';

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
    throw new ClientSyncError(
      'sync.invalid_request',
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
    throw new ClientSyncError(
      'sync.invalid_request',
      'last requires a supported unit, a count from 1 through 1200, and a UTC timestamp from 1970 through 9999',
    );
  }
  const date = new Date(nowMs);
  const current = date.getUTCFullYear() * 12 + date.getUTCMonth();
  if (current - (count - 1) < 1970 * 12) {
    throw new ClientSyncError(
      'sync.invalid_request',
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
 * A window base: one table, one variable whose values are the window
 * units, and any FIXED scopes every unit shares (other variables pinned
 * to a constant set). `params` is host-opaque, carried onto every unit's
 * subscription verbatim.
 */
export interface WindowBase {
  readonly table: string;
  /** The scope variable whose values are the window units. */
  readonly variable: string;
  /** Scopes shared by every unit (other variables), if any. */
  readonly fixedScopes?: Readonly<Record<string, readonly string[]>>;
  readonly params?: string;
}

/** A live unit in the registry: its value and the subscription it drives. */
export interface WindowUnit {
  readonly unit: string;
  readonly subId: string;
}

export interface RegisteredWindowUnit extends WindowUnit {
  readonly baseKey: string;
}

/**
 * A stable, server-opaque key for a window base — table + variable +
 * canonical fixed scopes. Two `setWindow` calls with the same base
 * address the same registry rows.
 */
export function windowBaseKey(base: WindowBase): string {
  const fixed = canonicalScopeJson(base.fixedScopes ?? {});
  return `${base.table}\0${base.variable}\0${fixed}`;
}

/** The full requested scope map for one unit (fixed scopes + the unit). */
export function unitScopes(base: WindowBase, unit: string): ScopeMap {
  const scopes: ScopeMap = {};
  for (const [variable, values] of Object.entries(base.fixedScopes ?? {})) {
    scopes[variable] = [...values];
  }
  scopes[base.variable] = [unit];
  return scopes;
}

/**
 * Deterministic per-unit subscription id (§4.1 guidance):
 * `w:<table>:<sha256(canonical scope map, §11.2)[0..16]>`. Ids are echoed
 * not interpreted by the server (§4.1), so the exact hash is pure client
 * convention; SHA-256 matches the SPEC's worked example.
 */
export async function deriveSubId(
  base: WindowBase,
  unit: string,
): Promise<string> {
  const canonical = canonicalScopeJson(unitScopes(base, unit));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  let hex = '';
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return `w:${base.table}:${hex.slice(0, 16)}`;
}

/** Live units for a base, ordered by unit value. */
export function loadWindowUnits(
  db: ClientDatabase,
  baseKey: string,
): WindowUnit[] {
  return db
    .query(
      'SELECT unit, sub_id FROM _syncular_windows WHERE base = ? ORDER BY unit ASC',
      [baseKey],
    )
    .map((row) => ({ unit: row.unit as string, subId: row.sub_id as string }));
}

/** Registry lookup used to emit exact completion changes for a sub id. */
export function getWindowUnitBySubId(
  db: ClientDatabase,
  subId: string,
): RegisteredWindowUnit | undefined {
  const row = db.query(
    `SELECT base, unit, sub_id FROM _syncular_windows
      WHERE sub_id = ? LIMIT 1`,
    [subId],
  )[0];
  return row === undefined
    ? undefined
    : {
        baseKey: row.base as string,
        unit: row.unit as string,
        subId: row.sub_id as string,
      };
}

export function insertWindowUnit(
  db: ClientDatabase,
  baseKey: string,
  unit: string,
  subId: string,
): void {
  db.exec(
    'INSERT OR REPLACE INTO _syncular_windows(base, unit, sub_id) VALUES (?, ?, ?)',
    [baseKey, unit, subId],
  );
}

export function deleteWindowUnit(
  db: ClientDatabase,
  baseKey: string,
  unit: string,
): void {
  db.exec('DELETE FROM _syncular_windows WHERE base = ? AND unit = ?', [
    baseKey,
    unit,
  ]);
}

/** Is a single scope value windowed-in for this base? (the oracle, I3) */
export function isUnitLive(
  db: ClientDatabase,
  baseKey: string,
  unit: string,
): boolean {
  return (
    db.query(
      'SELECT 1 FROM _syncular_windows WHERE base = ? AND unit = ? LIMIT 1',
      [baseKey, unit],
    ).length > 0
  );
}

// ---------------------------------------------------------------------------
// Deferred eviction (E1) — units that left the window with pinned rows
// ---------------------------------------------------------------------------

export interface PendingEviction {
  readonly subId: string;
  readonly table: string;
  readonly effective: ScopeMap;
}

export function savePendingEviction(
  db: ClientDatabase,
  subId: string,
  table: string,
  effective: ScopeMap,
): void {
  db.exec(
    `INSERT OR REPLACE INTO _syncular_window_pending_evict(sub_id, tbl, effective_scopes)
       VALUES (?, ?, ?)`,
    [subId, table, JSON.stringify(effective)],
  );
}

export function deletePendingEviction(db: ClientDatabase, subId: string): void {
  db.exec('DELETE FROM _syncular_window_pending_evict WHERE sub_id = ?', [
    subId,
  ]);
}

export function loadPendingEvictions(db: ClientDatabase): PendingEviction[] {
  return db
    .query(
      'SELECT sub_id, tbl, effective_scopes FROM _syncular_window_pending_evict',
    )
    .map((row) => ({
      subId: row.sub_id as string,
      table: row.tbl as string,
      effective: JSON.parse(row.effective_scopes as string) as ScopeMap,
    }));
}
