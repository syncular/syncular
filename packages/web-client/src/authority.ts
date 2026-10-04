import type { ClientDatabase, SqlRow, SqlValue } from './database';
import { ClientSyncError } from './errors';
import { listOutbox, listOutboxBeforeImages } from './outbox';
import { RETAINED_ROWS } from './failed-overlay';
import { getLocalRevision, getMeta, loadSubscriptions } from './state';
import { fromSqlValue, quoteIdent, SYNC_VERSION_COLUMN } from './schema';
import type { CompiledClientSchema, JsonRowValue } from './schema';

/** Frozen at client creation. Scope selectors use the schema's variables. */
export interface AuthorityReadDeclaration {
  readonly table: string;
  readonly columns: readonly string[];
  readonly scopes: Readonly<Record<string, readonly string[]>>;
}
export interface AuthoritySnapshot {
  readonly revision: bigint;
  readonly complete: boolean;
  readonly tables: readonly {
    readonly table: string;
    readonly rows: readonly {
      readonly values: SqlRow;
      readonly version: number;
      readonly hasLocalIntent: boolean;
    }[];
    /** Includes local-only creations; no intended values are disclosed. */
    readonly localIntentRowIds: readonly string[];
    readonly coverage: 'complete' | 'pending' | 'missing';
    readonly scopes: AuthorityReadDeclaration['scopes'];
    readonly persisted: readonly {
      readonly requestedScopes: AuthorityReadDeclaration['scopes'];
      readonly status: string;
      readonly cursor: number;
      readonly effectiveScopes: AuthorityReadDeclaration['scopes'] | null;
      readonly complete: boolean;
    }[];
  }[];
}

function validateAuthorityReads(
  schema: CompiledClientSchema,
  declarations: readonly AuthorityReadDeclaration[],
): void {
  if (!Array.isArray(declarations))
    throw new ClientSyncError(
      'client.authority_read_forbidden',
      'authorityReads must be a list',
    );
  const seen = new Set<string>();
  for (const read of declarations) {
    if (
      !read ||
      typeof read !== 'object' ||
      !Array.isArray(read.columns) ||
      !read.scopes ||
      typeof read.scopes !== 'object' ||
      Array.isArray(read.scopes)
    )
      throw new ClientSyncError(
        'client.authority_read_forbidden',
        'invalid authority declaration',
      );
    const table = schema.tables.get(read.table);
    const plain = (name: string) =>
      table?.columns.some(
        (c) =>
          c.name === name &&
          name !== 'authority_version' &&
          !name.startsWith('_sync') &&
          !c.encrypted &&
          ['string', 'integer', 'float', 'boolean', 'json'].includes(c.type),
      );
    if (
      Object.keys(read).sort().join() !== 'columns,scopes,table' ||
      !table ||
      seen.has(read.table) ||
      !read.columns.length ||
      new Set(read.columns).size !== read.columns.length ||
      !read.columns.includes(table.primaryKey) ||
      !read.columns.every(plain) ||
      !Object.keys(read.scopes).length ||
      !Object.entries(read.scopes).every(
        ([variable, values]) =>
          read.columns.includes(
            table.scopeColumnByVariable.get(variable) ?? '',
          ) &&
          plain(table.scopeColumnByVariable.get(variable) ?? '') &&
          Array.isArray(values) &&
          values.length > 0 &&
          values.every(
            (v) => typeof v === 'string' && v.length > 0 && v !== '*',
          ),
      )
    ) {
      throw new ClientSyncError(
        'client.authority_read_forbidden',
        'authority reads require declared tables, plain columns, a primary key and nonempty plain scope selectors',
      );
    }
    Object.freeze(read.columns);
    for (const values of Object.values(read.scopes)) Object.freeze(values);
    Object.freeze(read.scopes);
    Object.freeze(read);
    seen.add(read.table);
  }
}

/** Read accepted bases without restoring or replaying the visible projection. */
function readAuthoritySnapshot(
  db: ClientDatabase,
  schema: CompiledClientSchema,
  declarations: readonly AuthorityReadDeclaration[],
): AuthoritySnapshot {
  if (!declarations.length)
    throw new ClientSyncError(
      'client.authority_read_forbidden',
      'no authority reads were declared at client creation',
    );
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
    const subscriptions = loadSubscriptions(db);
    const tables = declarations.map((read) => {
      const table = schema.tables.get(read.table)!;
      const columns = [
        ...new Set([
          ...read.columns,
          ...Object.keys(read.scopes).map((v) =>
            table.scopeColumnByVariable.get(v)!,
          ),
        ]),
      ];
      const scalar = (
        column: string,
        value: SqlValue | JsonRowValue,
      ): string => {
        if (value === null || typeof value === 'object')
          throw new ClientSyncError(
            'sync.local_corrupt',
            'authority scalar is missing or invalid',
          );
        return String(
          fromSqlValue(table.columns[table.columnIndex.get(column)!]!, value),
        );
      };
      const matches = (values: Record<string, SqlValue | JsonRowValue>) =>
        Object.entries(read.scopes).every(([v, held]) => {
          const column = table.scopeColumnByVariable.get(v)!;
          return (
            values[column] !== null &&
            values[column] !== undefined &&
            held.includes(scalar(column, values[column]!))
          );
        });
      const bases = new Map<
        string,
        {
          values: Record<string, JsonRowValue | SqlValue> | null;
          version: number;
        }
      >();
      const intent = new Set<string>();
      const relevantIntent = new Set<string>();
      // FIFO before-images precede the earliest still-pending intent.
      for (const commit of listOutbox(db)) {
        const images = listOutboxBeforeImages(db, commit.clientCommitId);
        for (const [idx, op] of commit.operations.entries())
          if (op.table === read.table) {
            intent.add(op.rowId);
            if (op.values && matches(op.values)) relevantIntent.add(op.rowId);
            if (bases.has(op.rowId)) continue;
            const image = images.find((i) => i.opIndex === idx);
            if (
              !image ||
              (image.existed &&
                (image.values === undefined || image.syncVersion === undefined))
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
        `SELECT id,base,version,intent FROM ${RETAINED_ROWS} WHERE tbl=? ORDER BY commit_seq,at,commit_id,idx`,
        [read.table],
      )) {
        const id = String(row.id);
        if (row.base !== null && row.version === null)
          throw new ClientSyncError(
            'sync.local_corrupt',
            'authority base version is missing',
          );
        intent.add(id);
        if (row.intent !== null && matches(JSON.parse(String(row.intent))))
          relevantIntent.add(id);
        if (!retained.has(id))
          bases.set(id, {
            values: row.base === null ? null : JSON.parse(String(row.base)),
            version: Number(row.version ?? -1),
          });
        retained.add(id);
      }
      const visible = db.query(
        `SELECT ${columns.map(quoteIdent).join(',')},${SYNC_VERSION_COLUMN} FROM ${quoteIdent(read.table)}`,
      );
      for (const row of visible) {
        const id = scalar(table.primaryKey, row[table.primaryKey]!);
        if (!bases.has(id))
          bases.set(id, {
            values: row,
            version: Number(row[SYNC_VERSION_COLUMN]),
          });
      }
      const rows = [...bases]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .flatMap(([id, base]) => {
          if (
            !Number.isSafeInteger(base.version) ||
            base.version < -1 ||
            (base.values &&
              base.version >= 0 &&
              !read.columns.every((c) => Object.hasOwn(base.values!, c)))
          )
            throw new ClientSyncError(
              'sync.local_corrupt',
              'authority base evidence is incomplete',
            );
          if (!base.values || base.version < 0 || !matches(base.values))
            return [];
          return [
            {
              values: Object.fromEntries(
                read.columns.map((c) => [
                  c,
                  typeof base.values![c] === 'boolean'
                    ? base.values![c]
                      ? 1
                      : 0
                    : (base.values![c] ?? null),
                ]),
              ) as SqlRow,
              version: base.version,
              hasLocalIntent: intent.has(id),
            },
          ];
        });
      const persisted = subscriptions
        .filter((s) => s.table === read.table)
        .map((s) => {
          const effective = s.effectiveScopes;
          const complete =
            effective !== undefined &&
            Object.keys(effective).length === Object.keys(read.scopes).length &&
            s.status === 'active' &&
            s.cursor >= 0 &&
            s.bootstrapState === undefined &&
            s.params === undefined;
          return {
            requestedScopes: Object.fromEntries(
              Object.keys(read.scopes).map((v) => [v, s.scopes[v] ?? []]),
            ),
            status: s.status,
            cursor: s.cursor,
            effectiveScopes:
              effective === undefined
                ? null
                : Object.fromEntries(
                    Object.keys(read.scopes).map((v) => [
                      v,
                      effective[v] ?? [],
                    ]),
                  ),
            complete,
          };
        });
      const selectors = Object.entries(read.scopes);
      const covered = (at: number, candidates: typeof persisted): boolean =>
        at === selectors.length
          ? candidates.length > 0
          : selectors[at]![1].every((value) =>
              covered(
                at + 1,
                candidates.filter((p) =>
                  p.effectiveScopes?.[selectors[at]![0]]?.some(
                    (held) => held === value || held === '*',
                  ),
                ),
              ),
            );
      const coverage = covered(
        0,
        persisted.filter((p) => p.complete),
      )
        ? 'complete'
        : persisted.some(
              (p) =>
                p.status === 'active' &&
                selectors.every(([v, values]) =>
                  values.some((value) => p.requestedScopes[v]?.includes(value)),
                ),
            )
          ? 'pending'
          : 'missing';
      return {
        table: read.table,
        rows,
        localIntentRowIds: [...intent]
          .filter(
            (id) =>
              relevantIntent.has(id) ||
              rows.some(
                (row) =>
                  scalar(table.primaryKey, row.values[table.primaryKey]!) ===
                  id,
              ) ||
              visible.some(
                (row) =>
                  scalar(table.primaryKey, row[table.primaryKey]!) === id &&
                  matches(row),
              ),
          )
          .sort(),
        scopes: read.scopes,
        coverage,
        persisted,
      } as AuthoritySnapshot['tables'][number];
    });
    return {
      revision,
      complete: tables.every((t) => t.coverage === 'complete'),
      tables,
    };
  });
}

/** Opt-in policy module; ordinary clients ship no authority reader. */
export class AuthorityReadPolicy {
  readonly #declarations: readonly AuthorityReadDeclaration[];
  get declarations(): readonly AuthorityReadDeclaration[] {
    return this.#declarations;
  }
  constructor(declarations: readonly AuthorityReadDeclaration[]) {
    if (!Array.isArray(declarations))
      throw new ClientSyncError(
        'client.authority_read_forbidden',
        'authorityReads must be a list',
      );
    this.#declarations = structuredClone(declarations);
    for (const read of this.#declarations) {
      if (
        !read ||
        typeof read !== 'object' ||
        !Array.isArray(read.columns) ||
        !read.scopes ||
        typeof read.scopes !== 'object' ||
        Array.isArray(read.scopes)
      )
        throw new ClientSyncError(
          'client.authority_read_forbidden',
          'invalid authority declaration',
        );
      Object.freeze(read.columns);
      for (const values of Object.values(read.scopes)) Object.freeze(values);
      Object.freeze(read.scopes);
      Object.freeze(read);
    }
    Object.freeze(this.#declarations);
    Object.freeze(this);
  }
  /** @internal */
  validate(schema: CompiledClientSchema): void {
    validateAuthorityReads(schema, this.declarations);
    Object.freeze(this.declarations);
    Object.freeze(this);
  }
  /** @internal */
  snapshot(
    db: ClientDatabase,
    schema: CompiledClientSchema,
  ): AuthoritySnapshot {
    validateAuthorityReads(schema, this.declarations);
    return readAuthoritySnapshot(db, schema, this.declarations);
  }
}
/** Declare authority tables, plain columns and scope selectors at creation. */
export function defineAuthorityReads(
  declarations: readonly AuthorityReadDeclaration[],
): AuthorityReadPolicy {
  return new AuthorityReadPolicy(declarations);
}
