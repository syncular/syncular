import type { ColumnType } from '@syncular/core';
import type { ClientDatabase, SqlRow, SqlValue } from './database';
import {
  classifySqliteFailure,
  ClientSyncError,
  invalidRequest,
} from './errors';
import { listOutbox, listOutboxBeforeImages } from './outbox';
import { RETAINED_ROWS } from './failed-overlay';
import {
  coverageCandidates,
  getLocalRevision,
  getMeta,
  loadUnits,
} from './state';
import { quoteIdent, SYNC_VERSION_COLUMN } from './schema';
import type { CompiledClientSchema, JsonRowValue } from './schema';
import type { WindowBase } from './window';

type AuthorityParamType = 'string' | 'integer' | 'float' | 'boolean' | 'json';

/** §5.11 generated authority query declaration (SYQL.md §13.3), data only. */
export interface AuthorityQuery {
  readonly name: string;
  /** Positional SQL in its authored form, `?` placeholders. */
  readonly sql: string;
  /** The parameter name of each `?`, in order. */
  readonly bind: readonly string[];
  readonly params: readonly {
    readonly name: string;
    readonly type: AuthorityParamType;
    readonly nullable: boolean;
  }[];
  /** One entry per read table; `units` and fixed scope values name params. */
  readonly coverage: readonly {
    readonly table: string;
    readonly variable: string;
    readonly units: readonly string[];
    readonly fixedScopes?: Readonly<Record<string, string>>;
  }[];
  /** Table → sorted columns the statement reads. */
  readonly reads: Readonly<Record<string, readonly string[]>>;
  readonly resultColumns: readonly {
    readonly name: string;
    readonly type: ColumnType;
    readonly nullable: boolean;
  }[];
}

export interface AuthorityReadRequest {
  readonly query: string;
  readonly params: Readonly<
    Record<string, string | number | bigint | boolean | null>
  >;
}

export interface AuthorityReadResult {
  readonly revision: bigint;
  readonly results: readonly {
    readonly query: string;
    readonly rows: readonly SqlRow[];
    readonly coverage: readonly {
      readonly table: string;
      readonly base: WindowBase;
      readonly unit: string;
      readonly state: 'complete' | 'pending' | 'missing' | 'revoked';
    }[];
    /** Every coverage entry is complete; rows are evidence only then. */
    readonly complete: boolean;
  }[];
}

const refuse = (
  query: unknown,
  reason: 'shape' | 'column' | 'param',
  table?: string,
  column?: string,
) =>
  new ClientSyncError(
    'client.authority_read_forbidden',
    'authority query declaration refused',
    false,
    {
      query,
      reason,
      ...(table === undefined ? {} : { table }),
      ...(column === undefined ? {} : { column }),
    },
  );

const object = (
  value: unknown,
  keys: string,
): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (keys === '' || Object.keys(value).sort().join() === keys);

const strings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

const freeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Opt-in policy module; ordinary clients ship no authority reader. */
export class AuthorityReadPolicy {
  readonly declarations: readonly AuthorityQuery[];
  readonly #queries = new Map<string, AuthorityQuery>();

  constructor(queries: readonly AuthorityQuery[]) {
    if (!Array.isArray(queries)) throw refuse(null, 'shape');
    for (const query of queries) {
      // Checked as data: a declaration crosses postMessage and IPC.
      const raw: unknown = query;
      const name = object(raw, '') ? raw['name'] : undefined;
      if (
        !object(raw, 'bind,coverage,name,params,reads,resultColumns,sql') ||
        typeof name !== 'string' ||
        this.#queries.has(name) ||
        typeof query.sql !== 'string' ||
        !Array.isArray(query.params) ||
        !query.params.every(
          (p: unknown) =>
            object(p, 'name,nullable,type') &&
            typeof p.name === 'string' &&
            typeof p.type === 'string' &&
            typeof p.nullable === 'boolean',
        )
      )
        throw refuse(name ?? null, 'shape');
      const params = new Set(
        query.params.map((p: AuthorityQuery['params'][number]) => p.name),
      );
      const param = (p: unknown) => typeof p === 'string' && params.has(p);
      if (
        params.size !== query.params.length ||
        !strings(query.bind) ||
        !query.bind.every(param) ||
        query.sql.replace(/'[^']*'/g, '').split('?').length - 1 !==
          query.bind.length ||
        !Array.isArray(query.coverage) ||
        !query.coverage.every(
          (entry: unknown) =>
            object(entry, '') &&
            Object.keys(entry).every((k) =>
              ['table', 'variable', 'units', 'fixedScopes'].includes(k),
            ) &&
            typeof entry.table === 'string' &&
            typeof entry.variable === 'string' &&
            strings(entry.units) &&
            entry.units.every(param) &&
            (entry.fixedScopes === undefined ||
              (object(entry.fixedScopes, '') &&
                Object.values(entry.fixedScopes).every(param))),
        ) ||
        !object(query.reads, '') ||
        !Object.values(query.reads).every(strings) ||
        !Array.isArray(query.resultColumns) ||
        !query.resultColumns.every(
          (c: unknown) =>
            object(c, 'name,nullable,type') &&
            typeof c.name === 'string' &&
            typeof c.type === 'string' &&
            typeof c.nullable === 'boolean',
        )
      )
        throw refuse(name, 'shape');
      if (
        !query.params.every((p: AuthorityQuery['params'][number]) =>
          ['string', 'integer', 'float', 'boolean', 'json'].includes(p.type),
        )
      )
        throw refuse(name, 'param');
      this.#queries.set(name, query);
    }
    this.declarations = freeze(structuredClone(queries));
    for (const query of this.declarations) this.#queries.set(query.name, query);
    Object.freeze(this);
  }

  /** @internal Check coverage and read sets against the client schema. */
  validate(schema: CompiledClientSchema): void {
    for (const query of this.declarations) {
      for (const entry of query.coverage) {
        const table = schema.tables.get(entry.table);
        if (
          !table ||
          ![entry.variable, ...Object.keys(entry.fixedScopes ?? {})].every(
            (v) => table.scopeColumnByVariable.has(v),
          )
        )
          throw refuse(query.name, 'shape', entry.table);
      }
      for (const [name, columns] of Object.entries(query.reads)) {
        const table = name.startsWith('_syncular_')
          ? undefined
          : schema.tables.get(name);
        if (!table) throw refuse(query.name, 'column', name);
        for (const column of columns)
          if (
            column !== SYNC_VERSION_COLUMN &&
            !table.columns.some(
              (c) =>
                c.name === column &&
                !column.startsWith('_sync') &&
                !c.encrypted &&
                ['string', 'integer', 'float', 'boolean', 'json'].includes(
                  c.type,
                ),
            )
          )
            throw refuse(query.name, 'column', name, column);
      }
    }
  }

  /** @internal Run requests over accepted bases in one read transaction. */
  read(
    db: ClientDatabase,
    schema: CompiledClientSchema,
    requests: readonly AuthorityReadRequest[],
  ): AuthorityReadResult {
    if (
      !Array.isArray(requests) ||
      !requests.every(
        (r) =>
          object(r, 'params,query') &&
          typeof r.query === 'string' &&
          object(r.params, ''),
      )
    )
      throw new ClientSyncError(
        'client.authority_read_forbidden',
        'authority read denied',
      );
    const runs = requests.map(({ query: name, params }) => {
      const query = this.#queries.get(name);
      if (!query)
        throw new ClientSyncError(
          'client.authority_query_unknown',
          'authority query is not declared',
          false,
          { query: name },
        );
      const bad = (param: string) =>
        invalidRequest(
          'authority query parameter is missing, extra or mistyped',
          false,
          { query: name, param },
        );
      for (const key of Object.keys(params))
        if (!query.params.some((p) => p.name === key)) throw bad(key);
      for (const { name: param, type, nullable } of query.params) {
        const v = Object.hasOwn(params, param) ? params[param] : undefined;
        if (
          !(v === null
            ? nullable
            : type === 'string'
              ? typeof v === 'string'
              : type === 'integer'
                ? Number.isSafeInteger(v) ||
                  (typeof v === 'bigint' && BigInt.asIntN(64, v) === v)
                : type === 'float'
                  ? Number.isFinite(v)
                  : type === 'boolean'
                    ? typeof v === 'boolean'
                    : typeof v === 'string' &&
                      (() => {
                        try {
                          JSON.parse(v);
                          return true;
                        } catch {
                          return false;
                        }
                      })())
        )
          throw bad(param);
      }
      const scope = (param: string) => {
        const v = params[param];
        if (
          typeof v !== 'string' &&
          !Number.isSafeInteger(v) &&
          typeof v !== 'bigint'
        )
          throw bad(param);
        return String(v);
      };
      return {
        query,
        binds: query.bind.map((p): SqlValue => {
          const v = params[p] ?? null;
          return typeof v === 'boolean' ? (v ? 1 : 0) : v;
        }),
        coverage: query.coverage.flatMap((entry) => {
          const base: WindowBase = {
            variable: entry.variable,
            ...(Object.keys(entry.fixedScopes ?? {}).length > 0 && {
              fixedScopes: Object.fromEntries(
                Object.entries(entry.fixedScopes ?? {}).map(([v, p]) => [
                  v,
                  scope(p),
                ]),
              ),
            }),
          };
          return entry.units.map((p) => ({
            table: entry.table,
            base,
            unit: scope(p),
          }));
        }),
      };
    });
    try {
      return db.transaction(() => {
        const raw = getMeta(db, 'localRevision');
        if (
          raw === undefined ||
          !/^(0|[1-9][0-9]*)$/.test(raw) ||
          BigInt(raw) > 18446744073709551615n
        )
          throw new ClientSyncError(
            'sync.local_corrupt',
            'authority revision is missing or invalid',
          );
        const revision = getLocalRevision(db);
        const units = loadUnits(db);
        const outbox = listOutbox(db);
        // Per table: row id → its accepted base, for every row with intent.
        const intent = new Map<
          string,
          Map<
            string,
            {
              values: Readonly<Record<string, JsonRowValue>> | null;
              version: number;
            }
          >
        >();
        const basesOf = (name: string) => {
          let bases = intent.get(name);
          if (bases) return bases;
          intent.set(name, (bases = new Map()));
          // FIFO before-images precede the earliest still-pending intent.
          for (const commit of outbox) {
            const images = listOutboxBeforeImages(db, commit.clientCommitId);
            for (const [idx, op] of commit.operations.entries()) {
              if (op.table !== name || bases.has(op.rowId)) continue;
              const image = images.find((i) => i.opIndex === idx);
              if (
                !image ||
                (image.existed &&
                  (image.values === undefined ||
                    image.syncVersion === undefined))
              )
                throw new ClientSyncError(
                  'sync.local_corrupt',
                  'authority intent before-image is missing',
                );
              bases.set(op.rowId, {
                values: image.values ?? null,
                version: image.syncVersion ?? -1,
              });
            }
          }
          // A retained/ACK base precedes pending edits stacked over that intent.
          const retained = new Set<string>();
          for (const row of db.query(
            `SELECT id,base,version FROM ${RETAINED_ROWS} WHERE tbl=? ORDER BY commit_seq,at,commit_id,idx`,
            [name],
          )) {
            const id = String(row.id);
            if (row.base !== null && row.version === null)
              throw new ClientSyncError(
                'sync.local_corrupt',
                'authority base version is missing',
              );
            if (!retained.has(id))
              bases.set(id, {
                values: row.base === null ? null : JSON.parse(String(row.base)),
                version: Number(row.version ?? -1),
              });
            retained.add(id);
          }
          return bases;
        };
        return {
          revision,
          results: runs.map(({ query, binds, coverage }) => {
            const shadows: string[] = [];
            const shadowBinds: SqlValue[] = [];
            for (const name of Object.keys(query.reads).sort()) {
              const bases = basesOf(name);
              if (!bases.size) continue;
              const pk = schema.tables.get(name)!.primaryKey;
              const columns = [
                pk,
                ...query.reads[name]!.filter(
                  (c) => c !== pk && c !== SYNC_VERSION_COLUMN,
                ),
                SYNC_VERSION_COLUMN,
              ];
              const ids = [...bases.keys()].sort();
              shadows.push(
                `${quoteIdent(name)} AS (SELECT ${columns.map(quoteIdent).join(',')} FROM main.${quoteIdent(name)} WHERE CAST(${quoteIdent(pk)} AS TEXT) NOT IN (SELECT value FROM json_each(?)) UNION ALL SELECT ${columns.map((_, i) => `json_extract(value,'$[${i}]')`).join(',')} FROM json_each(?))`,
              );
              shadowBinds.push(
                JSON.stringify(ids),
                JSON.stringify(
                  ids.flatMap((id) => {
                    const { values, version } = bases.get(id)!;
                    if (
                      !Number.isSafeInteger(version) ||
                      version < -1 ||
                      (values &&
                        version >= 0 &&
                        !columns.every(
                          (c) =>
                            c === SYNC_VERSION_COLUMN ||
                            Object.hasOwn(values, c),
                        ))
                    )
                      throw new ClientSyncError(
                        'sync.local_corrupt',
                        'authority base evidence is incomplete',
                      );
                    return values && version >= 0
                      ? [
                          columns.map((c) =>
                            c === SYNC_VERSION_COLUMN
                              ? version
                              : typeof values[c] === 'boolean'
                                ? values[c]
                                  ? 1
                                  : 0
                                : values[c],
                          ),
                        ]
                      : [];
                  }),
                ),
              );
            }
            const authored = /^\s*WITH\s+(RECURSIVE\s+)?/i.exec(query.sql);
            const result = coverage.map((entry) => {
              const found = coverageCandidates(
                units,
                schema.tables.get(entry.table)!,
                entry.base,
                entry.unit,
              );
              return {
                ...entry,
                state:
                  found === true
                    ? ('complete' as const)
                    : !found.length
                      ? ('missing' as const)
                      : found.some((unit) => unit.status !== 'active')
                        ? ('revoked' as const)
                        : ('pending' as const),
              };
            });
            return {
              query: query.name,
              rows: db.queryReadOnly(
                !shadows.length
                  ? query.sql
                  : authored
                    ? `WITH ${authored[1] ? 'RECURSIVE ' : ''}${shadows.join(',')}, ${query.sql.slice(authored[0].length)}`
                    : `WITH ${shadows.join(',')} ${query.sql}`,
                [...shadowBinds, ...binds],
              ),
              coverage: result,
              complete: result.every((entry) => entry.state === 'complete'),
            };
          }),
        };
      });
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new ClientSyncError(
          'sync.local_corrupt',
          'authority persisted evidence is invalid',
        );
      throw classifySqliteFailure(error).error;
    }
  }
}

/** Declare the generated authority queries a client may run, at creation. */
export function defineAuthorityReads(
  queries: readonly AuthorityQuery[],
): AuthorityReadPolicy {
  return new AuthorityReadPolicy(queries);
}
