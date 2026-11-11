export const META_TABLE = '_syncular_meta';
import { PENDING_EVICTIONS } from './window';
import { WINDOWS_TABLE } from './window';
export const UNITS_TABLE = '_syncular_units';
/**
 * Durable unit state (SPEC.md §4.1): per unit its scope map, status, live
 * membership, catch-up cursor and opaque resume token (§4.7), the tables its
 * current bootstrap seeded (§5.6) and the last echo (§4.4) the §3.3 purge
 * contract is keyed on. The replica cursor, the echo digest and the
 * registration digest the server holds live in meta.
 */
import type { FencedRecord, ScopeMap, UnitScopes } from '@syncular/core';
import { ClientSyncError } from './errors';
import type { CompiledClientSchema, CompiledClientTable } from './schema';
import type { ClientDatabase } from './database';
import type { LocalRevision } from './invalidation';

export const LOCAL_REVISION_KEY = 'localRevision';
/** §4.5 replica cursor; absent means `-1`. */
export const REPLICA_CURSOR_KEY = 'replicaCursor';
/** Hex of the last pull `LIVE_END.echoDigest` (§4.2); absent means empty. */
export const ECHO_DIGEST_KEY = 'echoDigest';
/** Hex of the registration digest of the list the server stores (§4.1). */
export const REGISTERED_DIGEST_KEY = 'registrationDigest';
const MAX_U64 = 18_446_744_073_709_551_615n;

export type UnitStatus = 'active' | 'revoked' | 'failed';

export interface UnitRecord {
  /** §4.1: derived from the scope map. */
  readonly id: string;
  readonly scopes: UnitScopes;
  /** An explicit `subscribe` holds the unit; window bases hold it through
   * the window registry (§4.1 references). */
  readonly explicit: boolean;
  readonly status: UnitStatus;
  /** §10 code when not active, or `sync.cursor_expired` after a reset. */
  readonly reasonCode?: string | undefined;
  /** Absent while the unit is live (§4.5); otherwise `-1`, the pin, or the
   * post-bootstrap cursor `P`. */
  readonly cursor?: number | undefined;
  /** Opaque resume token from `SUB_END` (§4.7); present mid-bootstrap. */
  readonly bootstrapState?: string | undefined;
  /** Tables that received a segment in the current bootstrap (§5.6). */
  readonly seeded: readonly string[];
  /** The echo persisted at the last `SUB_END` (§4.4). */
  readonly echo?: readonly FencedRecord[] | undefined;
}

/** §4.1: a catching-up unit holding cursor `-1` or a resume token. */
export function bootstrapping(unit: UnitRecord): boolean {
  return (
    unit.cursor !== undefined &&
    (unit.cursor < 0 || unit.bootstrapState !== undefined)
  );
}

/** §3.3 row ownership: active, live or post-bootstrap, with an echo. */
export function owning(unit: UnitRecord): boolean {
  return (
    unit.status === 'active' && unit.echo !== undefined && !bootstrapping(unit)
  );
}

/** §4.1: the unit covers every table declaring all of its variables. */
export function covers(
  table: CompiledClientTable,
  scopes: UnitScopes,
): boolean {
  return Object.keys(scopes).every((variable) =>
    table.scopeColumnByVariable.has(variable),
  );
}

/**
 * §4.4: the effective scopes of the (unit, table) pair under `echo`: the
 * scope map as one-element lists plus the fenced lists. Undefined when the
 * fence revoked the pair.
 */
export function pairScopes(
  scopes: UnitScopes,
  table: string,
  echo: readonly FencedRecord[] | undefined,
): ScopeMap | undefined {
  const fenced = echo?.find((record) => record.table === table);
  if (fenced?.status === 'revoked') return undefined;
  const effective: ScopeMap = { ...fenced?.scopes };
  for (const [variable, value] of Object.entries(scopes))
    effective[variable] = [value];
  return effective;
}

/** §3.3 row ownership: the pair scopes of every owner of `table` but one.
 * A bootstrapping unit owns the tables its current bootstrap seeded. */
export function unitOwners(
  units: readonly UnitRecord[],
  table: CompiledClientTable,
  exceptId: string,
): ScopeMap[] {
  return units.flatMap((unit) => {
    const scopes =
      unit.id !== exceptId &&
      (owning(unit) ||
        (unit.status === 'active' &&
          unit.echo !== undefined &&
          unit.seeded.includes(table.name))) &&
      covers(table, unit.scopes)
        ? pairScopes(unit.scopes, table.name, unit.echo)
        : undefined;
    return scopes === undefined ? [] : [scopes];
  });
}

/** A unit row; every persisted field must have its stored type and shape,
 * otherwise the row is `sync.local_corrupt` (§7.5). */
function rowToRecord(row: Record<string, unknown>): UnitRecord {
  const corrupt = () =>
    new ClientSyncError(
      'sync.local_corrupt',
      'persisted unit state is invalid',
    );
  const json = (raw: unknown): unknown => {
    if (typeof raw !== 'string') throw corrupt();
    try {
      return JSON.parse(raw);
    } catch {
      throw corrupt();
    }
  };
  const isMap = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const isStrings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');
  const optionalText = (value: unknown) => {
    if (value !== null && typeof value !== 'string') throw corrupt();
    return value ?? undefined;
  };
  const scopes = json(row.scopes);
  const seeded = json(row.seeded);
  const echo = row.echo === null ? undefined : json(row.echo);
  const { id, status, cursor } = row;
  if (
    typeof id !== 'string' ||
    !isMap(scopes) ||
    !Object.values(scopes).every((value) => typeof value === 'string') ||
    (status !== 'active' && status !== 'revoked' && status !== 'failed') ||
    (cursor !== null && !Number.isInteger(cursor)) ||
    !isStrings(seeded) ||
    (echo !== undefined &&
      !(
        Array.isArray(echo) &&
        echo.every(
          (record) =>
            isMap(record) &&
            typeof record.table === 'string' &&
            (record.status === 'active' || record.status === 'revoked') &&
            isMap(record.scopes) &&
            Object.values(record.scopes).every(isStrings),
        )
      ))
  )
    throw corrupt();
  const record: { -readonly [K in keyof UnitRecord]: UnitRecord[K] } = {
    id,
    scopes: scopes as UnitScopes,
    explicit: row.explicit === 1,
    status,
    seeded,
  };
  const reasonCode = optionalText(row.reason_code);
  if (reasonCode !== undefined) record.reasonCode = reasonCode;
  if (typeof cursor === 'number') record.cursor = cursor;
  const bootstrapState = optionalText(row.bootstrap_state);
  if (bootstrapState !== undefined) record.bootstrapState = bootstrapState;
  if (echo !== undefined) record.echo = echo as FencedRecord[];
  return record;
}

/** Every unit in registration order (§4.1). */
export function loadUnits(db: ClientDatabase): UnitRecord[] {
  return db
    .query(`SELECT * FROM ${UNITS_TABLE} ORDER BY rowid ASC`)
    .map(rowToRecord);
}

export function getUnit(
  db: ClientDatabase,
  id: string,
): UnitRecord | undefined {
  const row = db.query(`SELECT * FROM ${UNITS_TABLE} WHERE id=?`, [id])[0];
  return row === undefined ? undefined : rowToRecord(row);
}

/** Insert or update in place: an update keeps the registration order. */
export function saveUnit(db: ClientDatabase, record: UnitRecord): void {
  db.exec(
    `INSERT INTO ${UNITS_TABLE}(id,scopes,explicit,status,reason_code,cursor,bootstrap_state,seeded,echo)VALUES(?,?,?,?,?,?,?,?,?)ON CONFLICT(id)DO UPDATE SET explicit=excluded.explicit,status=excluded.status,reason_code=excluded.reason_code,cursor=excluded.cursor,bootstrap_state=excluded.bootstrap_state,seeded=excluded.seeded,echo=excluded.echo`,
    [
      record.id,
      JSON.stringify(record.scopes),
      record.explicit ? 1 : 0,
      record.status,
      record.reasonCode ?? null,
      record.cursor ?? null,
      record.bootstrapState ?? null,
      JSON.stringify(record.seeded),
      record.echo === undefined ? null : JSON.stringify(record.echo),
    ],
  );
}

export function deleteUnit(db: ClientDatabase, id: string): void {
  db.exec(`DELETE FROM ${UNITS_TABLE} WHERE id=?`, [id]);
}

/**
 * §7.4.3 reset, §2.1 log reset and local rebootstrap: keep the unit
 * registrations (the app's declared intent) and discard every synced state,
 * so the next round sends the list and fresh-bootstraps every unit. Caller
 * owns the transaction.
 */
export function resetUnits(db: ClientDatabase): void {
  db.exec(
    `UPDATE ${UNITS_TABLE} SET status='active',reason_code=NULL,cursor=-1,bootstrap_state=NULL,seeded='[]',echo=NULL`,
  );
  db.exec(`DELETE FROM ${META_TABLE} WHERE key IN(?,?,?)`, [
    REPLICA_CURSOR_KEY,
    ECHO_DIGEST_KEY,
    REGISTERED_DIGEST_KEY,
  ]);
}

/** §4.5: the replica cursor, `-1` while no unit is live. */
export function replicaCursor(db: ClientDatabase): number {
  return Number(getMeta(db, REPLICA_CURSOR_KEY) ?? -1);
}

type ScopeDeclarations = Record<
  string,
  Record<string, readonly [string, string]>
>;

/** §7.4.3 declaration evidence, persisted beside the schema marker. */
export function saveUnitScopeSchema(
  db: ClientDatabase,
  schema: CompiledClientSchema,
): void {
  const declarations: ScopeDeclarations = {};
  for (const table of schema.tables.values()) {
    declarations[table.name] = Object.fromEntries(
      [...table.scopeColumnByVariable].map(([variable, column]) => [
        variable,
        [table.scopePrefixByVariable.get(variable)!, column],
      ]),
    );
  }
  setMeta(db, 'subscriptionScopeSchema', JSON.stringify(declarations));
}

/**
 * Drop units that cover no table of the running schema, with their window
 * registry rows and pending evictions; never translate scopes. At a bump
 * (§7.4.3) a unit also needs every variable unchanged in prefix and column on
 * every table it covered before.
 */
export function pruneUnknownUnits(
  db: ClientDatabase,
  schema: CompiledClientSchema,
  bump = false,
): void {
  const stored = bump ? getMeta(db, 'subscriptionScopeSchema') : undefined;
  const previous =
    stored === undefined
      ? undefined
      : (JSON.parse(stored) as ScopeDeclarations);
  // A table keeps the variables' meaning when each has the same prefix and
  // column as before. An old binary stored no declaration evidence; matching
  // names cannot prove unchanged meaning, so the app registers again.
  const unchanged = (name: string, variables: readonly string[]): boolean => {
    const old = previous?.[name];
    const table = schema.tables.get(name);
    return (
      old !== undefined &&
      table !== undefined &&
      variables.every(
        (variable) =>
          old[variable]?.[0] === table.scopePrefixByVariable.get(variable) &&
          old[variable]?.[1] === table.scopeColumnByVariable.get(variable),
      )
    );
  };
  const compatible = (scopes: UnitScopes): boolean => {
    const variables = Object.keys(scopes);
    if (![...schema.tables.values()].some((table) => covers(table, scopes)))
      return false;
    if (!bump) return true;
    if (previous === undefined) return false;
    return Object.entries(previous).every(
      ([name, old]) =>
        !variables.every((variable) => old[variable] !== undefined) ||
        unchanged(name, variables),
    );
  };
  const stale = new Set(
    loadUnits(db)
      .filter((unit) => !compatible(unit.scopes))
      .map((unit) => unit.id),
  );
  // A shrunk window's deferred eviction outlives its unit row and keeps its
  // per-table scopes. A table the schema no longer has cannot be evicted, and
  // at a bump a table whose scope declarations changed must not be evicted by
  // the outdated rule.
  for (const row of db.query(
    `SELECT unit_id,tbl,effective_scopes FROM ${PENDING_EVICTIONS}`,
  )) {
    const table = String(row.tbl);
    if (
      !schema.tables.has(table) ||
      (bump &&
        !unchanged(
          table,
          Object.keys(JSON.parse(String(row.effective_scopes)) as ScopeMap),
        ))
    )
      stale.add(String(row.unit_id));
  }
  for (const id of stale) {
    db.exec(`DELETE FROM ${WINDOWS_TABLE} WHERE sub_id=?`, [id]);
    db.exec(`DELETE FROM ${PENDING_EVICTIONS} WHERE unit_id=?`, [id]);
    deleteUnit(db, id);
  }
}

export function getMeta(db: ClientDatabase, key: string): string | undefined {
  const row = db.query(`SELECT value FROM ${META_TABLE} WHERE key=?`, [key])[0];
  return row === undefined ? undefined : (row.value as string);
}

export function setMeta(db: ClientDatabase, key: string, value: string): void {
  db.exec(`INSERT OR REPLACE INTO ${META_TABLE}(key,value)VALUES(?,?)`, [
    key,
    value,
  ]);
}

/** Read the durable client-local observer revision (SPEC §7.5). */
export function getLocalRevision(db: ClientDatabase): LocalRevision {
  const raw = getMeta(db, LOCAL_REVISION_KEY);
  if (raw === undefined) return 0n;
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new ClientSyncError(
      'sync.local_corrupt',
      'persisted local revision is invalid',
    );
  }
  const revision = BigInt(raw);
  if (revision > MAX_U64) {
    throw new ClientSyncError(
      'sync.local_corrupt',
      'persisted local revision is invalid',
    );
  }
  return revision;
}

/**
 * Increment the durable revision. The caller MUST own the same transaction as
 * the observer-visible writes represented by the corresponding change batch.
 */
export function bumpLocalRevision(db: ClientDatabase): LocalRevision {
  const current = getLocalRevision(db);
  if (current === MAX_U64) {
    throw new ClientSyncError(
      'sync.local_corrupt',
      'local revision exhausted u64',
    );
  }
  const next = current + 1n;
  setMeta(db, LOCAL_REVISION_KEY, next.toString());
  return next;
}
