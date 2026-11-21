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
import {
  definedObject,
  type FencedRecord,
  type ScopeMap,
  type UnitScopes,
} from '@syncular/core';
import { localStateCorrupt } from './errors';
import type { CompiledClientSchema, CompiledClientTable } from './schema';
import type { WindowBase } from './window';
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
  /** §5.6 applied-segment record: segment id → rows applied at the unit's
   * current cursor and token. */
  readonly applied?: Readonly<Record<string, number>> | undefined;
  /** §7.4.3 restriction: the kept cursor and the tables to bootstrap. */
  readonly restrict?: Restriction | undefined;
}

export interface Restriction {
  readonly cursor: number;
  readonly tables: readonly string[];
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

/** §7.5 subset predicate: every unit variable is an entry variable, equal on it. */
export function subsetScopes(unit: UnitScopes, entry: UnitScopes): boolean {
  return Object.entries(unit).every(([k, v]) => entry[k] === v);
}

/**
 * §7.5 subset rule: the persisted units whose variables are a subset of the
 * entry's and whose values match it on them, or true when one of them is
 * complete for `table` and its echo restricts none of the entry's other
 * variables.
 */
export function coverageCandidates(
  units: readonly UnitRecord[],
  table: CompiledClientTable,
  base: WindowBase,
  value: string,
): UnitRecord[] | true {
  const entry: UnitScopes = { ...base.fixedScopes, [base.variable]: value };
  const found = units.filter(
    (unit) => covers(table, unit.scopes) && subsetScopes(unit.scopes, entry),
  );
  return (
    found.some((unit) => {
      const effective = owning(unit)
        ? pairScopes(unit.scopes, table.name, unit.echo)
        : undefined;
      return (
        effective !== undefined &&
        Object.keys(entry).every(
          (k) =>
            unit.scopes[k] !== undefined ||
            (effective[k]?.includes('*') ?? true),
        )
      );
    }) || found
  );
}

/** §3.3 row ownership: the pair scopes of every owner of `table` but one.
 * A bootstrapping unit owns the tables its current bootstrap seeded, and a
 * restricted one the tables outside its restriction. */
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
          (unit.seeded.includes(table.name) ||
            unit.restrict?.tables.includes(table.name) === false))) &&
      covers(table, unit.scopes)
        ? pairScopes(unit.scopes, table.name, unit.echo)
        : undefined;
    return scopes === undefined ? [] : [scopes];
  });
}

/** A unit row; every persisted field must have its stored type and shape,
 * otherwise the row is `sync.local_corrupt` (§7.5). */
export const unitStateCorrupt = () =>
  localStateCorrupt('persisted unit state is invalid');

function rowToRecord(row: Record<string, unknown>): UnitRecord {
  const json = (raw: unknown): unknown => {
    if (typeof raw !== 'string') throw unitStateCorrupt();
    try {
      return JSON.parse(raw);
    } catch {
      throw unitStateCorrupt();
    }
  };
  const isMap = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const isStrings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');
  const optionalText = (value: unknown) => {
    if (value !== null && typeof value !== 'string') throw unitStateCorrupt();
    return value ?? undefined;
  };
  const scopes = json(row.scopes);
  const seeded = json(row.seeded);
  const echo = row.echo === null ? undefined : json(row.echo);
  const applied = row.applied === null ? undefined : json(row.applied);
  const restrict = row.restriction === null ? undefined : json(row.restriction);
  const { id, status, cursor } = row;
  if (
    typeof id !== 'string' ||
    !isMap(scopes) ||
    !Object.values(scopes).every((value) => typeof value === 'string') ||
    (status !== 'active' && status !== 'revoked' && status !== 'failed') ||
    (cursor !== null && !Number.isInteger(cursor)) ||
    !isStrings(seeded) ||
    (applied !== undefined && !isMap(applied)) ||
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
    throw unitStateCorrupt();
  let restriction: UnitRecord['restrict'];
  if (restrict !== undefined) {
    if (
      !isMap(restrict) ||
      !Number.isInteger(restrict.cursor) ||
      !isStrings(restrict.tables)
    )
      throw unitStateCorrupt();
    restriction = {
      cursor: restrict.cursor as number,
      tables: restrict.tables,
    };
  }
  return definedObject({
    id,
    scopes: scopes as UnitScopes,
    explicit: row.explicit === 1,
    status,
    seeded,
    reasonCode: optionalText(row.reason_code),
    cursor: typeof cursor === 'number' ? cursor : undefined,
    bootstrapState: optionalText(row.bootstrap_state),
    echo: echo as FencedRecord[] | undefined,
    applied: applied as Record<string, number> | undefined,
    restrict: restriction,
  });
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

/** Insert or update in place: an update keeps the registration order. The
 * §5.6 applied-segment record ends when the cursor or the token changes. */
export function saveUnit(db: ClientDatabase, record: UnitRecord): void {
  db.exec(
    `INSERT INTO ${UNITS_TABLE}(id,scopes,explicit,status,reason_code,cursor,bootstrap_state,seeded,echo,restriction)VALUES(?,?,?,?,?,?,?,?,?,?)ON CONFLICT(id)DO UPDATE SET explicit=excluded.explicit,status=excluded.status,reason_code=excluded.reason_code,cursor=excluded.cursor,bootstrap_state=excluded.bootstrap_state,seeded=excluded.seeded,echo=excluded.echo,restriction=excluded.restriction,applied=iif((cursor,bootstrap_state)IS(excluded.cursor,excluded.bootstrap_state),applied,NULL)`,
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
      record.restrict === undefined ? null : JSON.stringify(record.restrict),
    ],
  );
}

/** §5.6: `rows` rows of `segmentId` applied at the unit's position. Runs
 * in the transaction that commits them. */
export function recordAppliedRows(
  db: ClientDatabase,
  id: string,
  segmentId: string,
  rows: number,
): void {
  db.exec(
    `UPDATE ${UNITS_TABLE} SET applied=json_patch(coalesce(applied,'{}'),?) WHERE id=?`,
    [JSON.stringify({ [segmentId]: rows }), id],
  );
}

export function deleteUnit(db: ClientDatabase, id: string): void {
  db.exec(`DELETE FROM ${UNITS_TABLE} WHERE id=?`, [id]);
}

/**
 * §7.4.3 reset, §2.1 log reset and local rebootstrap: keep the unit
 * registrations (the app's declared intent) and discard the synced state of
 * every unit outside `keep`, so the next round sends the list and
 * fresh-bootstraps those units. A bump (`restricts` given) keeps every echo
 * and restricts the units it names. The replica cursor survives only while a
 * kept unit is live. Caller owns the transaction.
 */
export function resetUnits(
  db: ClientDatabase,
  keep: readonly string[] = [],
  restricts?: ReadonlyMap<string, Restriction>,
): void {
  db.exec(
    `UPDATE ${UNITS_TABLE} SET status='active',reason_code=NULL,cursor=-1,bootstrap_state=NULL,seeded='[]',${restricts ? '' : 'echo=NULL,'}applied=NULL,restriction=NULL WHERE id NOT IN(${keep.map(() => '?').join(',')})`,
    [...keep],
  );
  for (const [id, restrict] of restricts ?? [])
    db.exec(`UPDATE ${UNITS_TABLE} SET restriction=? WHERE id=?`, [
      JSON.stringify(restrict),
      id,
    ]);
  db.exec(
    `DELETE FROM ${META_TABLE} WHERE key IN(?,?) OR key=? AND NOT EXISTS(SELECT 1 FROM ${UNITS_TABLE} WHERE cursor IS NULL)`,
    [ECHO_DIGEST_KEY, REGISTERED_DIGEST_KEY, REPLICA_CURSOR_KEY],
  );
}

/** §4.5: the replica cursor, `-1` while no unit is live. */
export function replicaCursor(db: ClientDatabase): number {
  return Number(getMeta(db, REPLICA_CURSOR_KEY) ?? -1);
}

type ScopeDeclarations = Record<
  string,
  Record<string, readonly [string, string]>
>;

/** §7.4.3 declaration evidence and table generations, persisted beside the
 * schema marker. */
export function saveUnitScopeSchema(
  db: ClientDatabase,
  schema: CompiledClientSchema,
): void {
  const declarations: ScopeDeclarations = {};
  const generations: Record<string, string> = {};
  for (const table of schema.tables.values()) {
    if (table.generation !== undefined)
      generations[table.name] = table.generation;
    declarations[table.name] = Object.fromEntries(
      [...table.scopeColumnByVariable].map(([variable, column]) => [
        variable,
        [table.scopePrefixByVariable.get(variable)!, column],
      ]),
    );
  }
  setMeta(db, 'subscriptionScopeSchema', JSON.stringify(declarations));
  setMeta(db, 'localTableGenerations', JSON.stringify(generations));
}

/**
 * Drop units that cover no table of the running schema, with their window
 * registry rows and pending evictions; never translate scopes. At a bump
 * (§7.4.3) a unit also needs every variable unchanged in prefix and column on
 * every table it covered before, and the bump keeps each table whose
 * generation is unchanged and each unit that covers only kept tables, before
 * and after. Runs before the reset rewrites the evidence.
 */
export function pruneUnknownUnits(
  db: ClientDatabase,
  schema: CompiledClientSchema,
  bump = false,
): {
  readonly tables: ReadonlySet<string>;
  readonly units: string[];
  readonly restricts: Map<string, Restriction>;
} {
  const stored = bump ? getMeta(db, 'subscriptionScopeSchema') : undefined;
  const previous =
    stored === undefined
      ? undefined
      : (JSON.parse(stored) as ScopeDeclarations);
  let generations: unknown = {};
  try {
    if (bump)
      generations = JSON.parse(getMeta(db, 'localTableGenerations') ?? '{}');
  } catch {
    generations = null;
  }
  if (
    typeof generations !== 'object' ||
    generations === null ||
    Array.isArray(generations) ||
    Object.values(generations).some((value) => typeof value !== 'string')
  )
    throw localStateCorrupt('invalid persisted table generations');
  const kept = new Set(
    [...schema.tables.values()]
      .filter(
        (table) =>
          table.generation !== undefined &&
          (generations as Record<string, unknown>)[table.name] ===
            table.generation,
      )
      .map((table) => table.name),
  );
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
  const units: string[] = [];
  const restricts = new Map<string, Restriction>();
  for (const unit of loadUnits(db)) {
    const covered = [...schema.tables.values()]
      .filter((table) => covers(table, unit.scopes))
      .map((table) => table.name);
    if (
      Object.entries(previous ?? {}).every(
        ([name, old]) =>
          kept.has(name) ||
          !Object.keys(unit.scopes).every((v) => old[v] !== undefined),
      ) &&
      covered.every((name) => kept.has(name))
    ) {
      units.push(unit.id);
      continue;
    }
    // §7.4.3 restriction: a live, post-bootstrap or restricted unit keeps its
    // rows of kept tables through its kept cursor and bootstraps the rest.
    const tables = covered
      .filter((name) => !kept.has(name) || unit.restrict?.tables.includes(name))
      .sort();
    const cursor =
      unit.restrict?.cursor ??
      (bootstrapping(unit) ? -1 : (unit.cursor ?? replicaCursor(db)));
    if (
      bump &&
      unit.status === 'active' &&
      cursor >= 0 &&
      tables.length > 0 &&
      tables.length < covered.length
    )
      restricts.set(unit.id, { cursor, tables });
  }
  return { tables: kept, units, restricts };
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
  if (
    typeof raw !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(raw) ||
    BigInt(raw) > MAX_U64
  ) {
    throw localStateCorrupt('persisted local revision is invalid');
  }
  return BigInt(raw);
}

/**
 * Increment the durable revision. The caller MUST own the same transaction as
 * the observer-visible writes represented by the corresponding change batch.
 */
export function bumpLocalRevision(db: ClientDatabase): LocalRevision {
  const current = getLocalRevision(db);
  if (current === MAX_U64) {
    throw localStateCorrupt('local revision exhausted u64');
  }
  const next = current + 1n;
  setMeta(db, LOCAL_REVISION_KEY, next.toString());
  return next;
}
