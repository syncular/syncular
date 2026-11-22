import { parseJsonDocument } from '@syncular/core';
import type { ClientDatabase, SqlValue } from './database';
import { ClientSyncError, invalidRequest, projectionUnknown } from './errors';
import { ChangeEmitter } from './invalidation';
import {
  localColumnType,
  quoteIdent,
  tableExists,
  type ClientSchema,
  type CompiledClientSchema,
  type CompiledClientTable,
} from './schema';

export interface ClientLocalProjectionSpec {
  readonly name: string;
  readonly generation: string;
  readonly columns: readonly {
    readonly name: string;
    readonly declaredType: 'string' | 'integer' | 'real' | 'boolean' | 'json';
    readonly source?: string;
  }[];
  readonly fts?: {
    readonly tokenize: string;
    readonly columns: readonly string[];
  };
  readonly dependencies?: readonly {
    readonly table: string;
    readonly column: string;
    readonly sourceColumn: string;
  }[];
}

export interface ProjectionPending {
  readonly epoch: number;
  readonly entries: readonly { sourceId: string; token: number }[];
}

export interface ProjectionInput {
  readonly sourceId: string;
  readonly token: number;
  readonly values: Readonly<Record<string, unknown>> | null;
}

export interface ProjectionWriteResult {
  readonly written: readonly string[];
  readonly stale: readonly string[];
}

export interface ProjectionPendingEvent {
  readonly type: 'projectionPending';
  readonly name: string;
}

export interface ProjectionStore {
  onPending(listener: (event: ProjectionPendingEvent) => void): () => void;
  pendingEvents(db: ClientDatabase): (() => void) | undefined;
  require(name: string): void;
  detach(db: ClientDatabase, kept?: ReadonlySet<string>): ReadonlySet<string>;
  open(db: ClientDatabase): void;
  pending(db: ClientDatabase, name: string, limit: number): ProjectionPending;
  write(
    db: ClientDatabase,
    name: string,
    epoch: number,
    rows: readonly ProjectionInput[],
  ): ProjectionWriteResult;
  invalidate(
    db: ClientDatabase,
    name: string,
    sourceIds?: readonly string[],
  ): number;
  changes(batch: {
    hasTable(name: string): boolean;
    table(name: string): void;
  }): void;
}

type Projection = {
  readonly spec: ClientLocalProjectionSpec;
  readonly source: CompiledClientTable;
  /** Every column names a source column: the source triggers fill it. */
  readonly builtin: boolean;
};

export function compileLocalProjections(
  input: ClientSchema,
  tables: CompiledClientSchema['tables'],
  names: ReadonlySet<string>,
): ProjectionStore {
  const projections = new Map<string, Projection>();
  for (const table of input.tables) {
    for (const spec of table.localProjections ?? []) {
      if (projections.has(spec.name)) invalidDeclaration(spec.name);
      projections.set(spec.name, {
        spec,
        source: tables.get(table.name)!,
        builtin:
          Array.isArray(spec.columns) &&
          spec.columns.some((column) => column.source !== undefined),
      });
    }
  }
  validateProjections(tables, projections, names);
  const pending = new ChangeEmitter<ProjectionPendingEvent>();

  return {
    onPending: (listener) => pending.on(listener),
    pendingEvents: (db) => {
      if (!projections.size) return;
      const events = db.query(
        `SELECT r.name FROM ${REGISTRY} AS r WHERE r.token>r.reported AND EXISTS(SELECT 1 FROM ${PENDING} p WHERE p.name=r.name AND p.token>r.reported) ORDER BY r.name`,
      );
      db.exec(`UPDATE ${REGISTRY} SET reported=token WHERE token>reported`);
      if (events.length)
        return () =>
          queueMicrotask(() => {
            for (const { name } of events)
              pending.emit({ type: 'projectionPending', name: String(name) });
          });
      return undefined;
    },
    require: (name) => {
      requireProjection(projections, name);
    },
    detach: (db, kept) => detachProjections(db, projections, kept),
    open: (db) => openProjections(db, projections),
    pending: (db, name, limit) => {
      requireProjection(projections, name);
      return db.transaction(() => projectionPending(db, name, limit));
    },
    write: (db, name, epoch, rows) =>
      writeProjection(db, requireProjection(projections, name), epoch, rows),
    invalidate: (db, name, ids) =>
      invalidateProjection(db, requireProjection(projections, name), ids),
    changes: (batch) => {
      for (const [name, { spec, source }] of projections) {
        if (
          batch.hasTable(source.name) ||
          spec.dependencies?.some((dep) => batch.hasTable(dep.table))
        )
          batch.table(name);
      }
    },
  };
}

function invalidDeclaration(name: string, column?: string): never {
  throw new ClientSyncError(
    'client.schema_invalid',
    'invalid local projection declaration',
    false,
    { name, ...(column === undefined ? {} : { column }) },
  );
}

const REGISTRY = '_syncular_local_projections';
const PENDING = '_syncular_projection_pending';

const COLUMN_TYPES = {
  string: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  boolean: 'INTEGER',
  json: 'TEXT',
} as const;

const ALLOWED_FTS_TOKENIZERS = new Set([
  'unicode61',
  'unicode61 remove_diacritics 0',
  'unicode61 remove_diacritics 1',
  'unicode61 remove_diacritics 2',
  'porter unicode61',
  'trigram',
]);

function validateProjections(
  tables: CompiledClientSchema['tables'],
  projections: ReadonlyMap<string, Projection>,
  objectNames: ReadonlySet<string>,
): void {
  const names = new Set([...objectNames].map((name) => name.toLowerCase()));
  for (const [name, { spec, source, builtin }] of projections) {
    const identifier = (value: string) =>
      /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value) &&
      !/^(?:_sync|sync_|sqlite_)/i.test(value);
    if (
      !identifier(name) ||
      names.has(name.toLowerCase()) ||
      typeof spec.generation !== 'string' ||
      spec.generation === '' ||
      !Array.isArray(spec.columns) ||
      !spec.columns.length ||
      (spec.dependencies !== undefined && !Array.isArray(spec.dependencies)) ||
      (builtin && (!spec.fts || spec.dependencies?.length)) ||
      (spec.fts !== undefined &&
        (!spec.fts ||
          !ALLOWED_FTS_TOKENIZERS.has(spec.fts.tokenize) ||
          !Array.isArray(spec.fts.columns) ||
          !spec.fts.columns.length ||
          new Set(spec.fts.columns).size !== spec.fts.columns.length ||
          !spec.fts.columns.every((field) =>
            spec.columns.some(
              (col) => col.name === field && col.declaredType === 'string',
            ),
          )))
    )
      invalidDeclaration(name);
    names.add(name.toLowerCase());
    const columns = new Set(
      spec.fts ? ['rank', 'rowid', name.toLowerCase()] : [],
    );
    for (const column of spec.columns) {
      const lower = column.name.toLowerCase();
      // A mix of sourced and unsourced columns fails on the first unsourced one.
      const sourceColumn =
        source.columns[source.columnIndex.get(column.source ?? '') ?? -1];
      if (
        !identifier(column.name) ||
        columns.has(lower) ||
        (builtin
          ? column.declaredType !== 'string' ||
            !sourceColumn ||
            localColumnType(sourceColumn) !== 'string'
          : column.source !== undefined) ||
        'nullable' in column ||
        !Object.hasOwn(COLUMN_TYPES, column.declaredType)
      )
        invalidDeclaration(name, column.name);
      columns.add(lower);
    }
    for (const dependency of spec.dependencies ?? []) {
      const dep = tables.get(dependency.table);
      const match = dep?.columns.find((col) => col.name === dependency.column);
      const local = source.columns.find(
        (col) => col.name === dependency.sourceColumn,
      );
      if (
        !match ||
        !local ||
        match.encrypted ||
        local.encrypted ||
        (dependency.sourceColumn !== source.primaryKey &&
          !source.indexes.some(
            (index) => index.columns[0] === dependency.sourceColumn,
          ))
      ) {
        invalidDeclaration(name, dependency.sourceColumn);
      }
    }
  }
}

/** Keep projection relations intact through generic schema reset discovery. */
function detachProjections(
  db: ClientDatabase,
  projections: ReadonlyMap<string, Projection>,
  kept?: ReadonlySet<string>,
): Set<string> {
  const names = new Set<string>();
  if (!tableExists(db, REGISTRY)) return names;
  for (const { name } of db.query(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB '_syncular_project_*'",
  ))
    db.exec(`DROP TRIGGER ${quoteIdent(String(name))}`);
  for (const row of db.query(
    `SELECT name,generation,fts FROM ${REGISTRY} WHERE generation IS NOT NULL`,
  )) {
    const name = String(row.name);
    const projection = projections.get(name);
    if (
      projection &&
      projection.spec.generation === row.generation &&
      (!kept ||
        (kept.has(projection.source.name) &&
          projection.spec.dependencies?.every((dep) => kept.has(dep.table)) !==
            false))
    ) {
      names.add(name);
      if (row.fts)
        for (const suffix of ['data', 'idx', 'docsize', 'config'])
          names.add(`${name}_${suffix}`);
    } else {
      db.exec(`DROP TABLE ${quoteIdent(name)}`);
      if (row.fts) {
        db.exec(`DROP TABLE ${quoteIdent(`_syncular_fts_${name}`)}`);
        db.exec(`DROP TABLE ${quoteIdent(`_syncular_projection_${name}`)}`);
      }
      db.exec(`DELETE FROM ${PENDING} WHERE name=?`, [name]);
      db.exec(
        `UPDATE ${REGISTRY} SET generation=NULL,epoch=epoch+1 WHERE name=?`,
        [name],
      );
    }
  }
  return names;
}

function openProjections(
  db: ClientDatabase,
  projections: ReadonlyMap<string, Projection>,
): void {
  if (!projections.size) return;
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${REGISTRY}(name TEXT PRIMARY KEY, generation TEXT, fts INTEGER NOT NULL, epoch INTEGER NOT NULL CHECK(epoch<=9007199254740991), token INTEGER NOT NULL DEFAULT 0 CHECK(token<=9007199254740991), reported INTEGER NOT NULL DEFAULT 0)`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${PENDING}(name TEXT NOT NULL, source_id TEXT NOT NULL, token INTEGER, PRIMARY KEY(name,source_id)) WITHOUT ROWID`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS _syncular_projection_tokens ON ${PENDING}(name,token) WHERE token IS NOT NULL`,
  );
  for (const [name, projection] of projections) {
    const { spec, source, builtin } = projection;
    const sql = projectionSql(projection);
    const columns = spec.columns
      .map((col) => `${quoteIdent(col.name)} ${COLUMN_TYPES[col.declaredType]}`)
      .join(', ');
    // Releases before 0.102 kept built-in FTS in a contentful table under the
    // projection name, filled by triggers named after it. The first open with
    // the projection implementation drops them once; the count comparison
    // below rebuilds from the source rows.
    if (
      builtin &&
      !db.query(`SELECT 1 FROM ${REGISTRY} WHERE name=?`, [name]).length
    ) {
      for (const suffix of ['bi', 'ai', 'ad', 'au', 'bu'])
        db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(`${name}_${suffix}`)}`);
      db.exec(`DROP TABLE IF EXISTS ${sql.relation}`);
      db.exec(`DROP TABLE IF EXISTS ${sql.identity}`);
    }
    if (spec.fts) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${sql.content}(rowid INTEGER PRIMARY KEY,"_syncular_source_id" TEXT NOT NULL,${columns})`,
      );
      const indexed = spec.fts.columns;
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${sql.relation} USING fts5("_syncular_source_id" UNINDEXED,${spec.columns
          .map(
            (column) =>
              quoteIdent(column.name) +
              (indexed.includes(column.name) ? '' : ' UNINDEXED'),
          )
          .join(
            ',',
          )},tokenize='${spec.fts.tokenize}',content='_syncular_projection_${name}')`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${sql.identity}(id INTEGER PRIMARY KEY,source_id TEXT NOT NULL UNIQUE)`,
      );
      const count = `(SELECT count(*) FROM ${sql.content})`;
      if (
        db.query(
          `SELECT ${count}!=(SELECT count(*) FROM ${sql.identity}) OR ${count}!=(SELECT count(*) FROM ${quoteIdent(`${name}_docsize`)})${builtin ? ` OR ${count}!=(SELECT count(*) FROM ${quoteIdent(source.name)})` : ''} AS damaged`,
        )[0]?.damaged
      ) {
        if (builtin) {
          db.exec(`DELETE FROM ${sql.content}`);
          db.exec(
            `INSERT INTO ${sql.content}(${sql.fields}) SELECT ${sql.sourceId},${spec.columns.map((column) => `s.${quoteIdent(column.source!)}`).join(',')} FROM ${sql.from}`,
          );
        }
        db.exec(`DELETE FROM ${sql.identity}`);
        db.exec(
          `INSERT INTO ${sql.identity}(id,source_id) SELECT rowid,"_syncular_source_id" FROM ${sql.content}`,
        );
        db.exec(
          `INSERT INTO ${sql.relation}(${sql.relation}) VALUES ('rebuild')`,
        );
      }
    } else {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${sql.relation}("_syncular_source_id" TEXT NOT NULL PRIMARY KEY,${columns}) WITHOUT ROWID`,
      );
    }
    const [high, low] = crypto.getRandomValues(new Uint32Array(2));
    const epoch = (high! & 0xfffff) * 0x1_0000_0000 + low!;
    db.exec(
      `INSERT INTO ${REGISTRY}(name,generation,fts,epoch) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET generation=excluded.generation,fts=excluded.fts`,
      [name, spec.generation, Number(!!spec.fts), epoch],
    );
    if (builtin) {
      // The source triggers fill the projection from the source row in the
      // statement that writes it. A clean insert has no projection entry, so
      // the BEFORE guards clear only rows a REPLACE displaces through the
      // primary key or a unique index; SQLite does not reliably fire the
      // delete trigger for a displaced row. A guard runs before SQLite
      // resolves the conflict, so an OR IGNORE insert or a conditional
      // upsert that keeps the held row would lose its entry (SPEC "Built-in
      // FTS5 projections"); Syncular's mirror writes never issue one.
      const newId = `CAST(new.${sql.pk} AS TEXT)`;
      const clear = (id: string) => sql.clear(`SELECT ${id}`);
      const displaced = source.indexes
        .filter((index) => index.unique)
        .map(
          (index) =>
            `SELECT ${sql.sourceId} FROM ${sql.from} WHERE ${index.columns.map((column) => `s.${quoteIdent(column)}=new.${quoteIdent(column)}`).join(' AND ')} AND s.${sql.pk}!=new.${sql.pk}`,
        );
      const insert = [
        `INSERT INTO ${sql.identity}(source_id) VALUES (${newId})`,
        `INSERT INTO ${sql.content}(rowid,${sql.fields}) VALUES (last_insert_rowid(),${newId},${spec.columns.map((column) => `new.${quoteIdent(column.source!)}`).join(',')})`,
        `INSERT INTO ${sql.relation}(rowid,${sql.fields}) SELECT rowid,${sql.fields} FROM ${sql.content} WHERE rowid=last_insert_rowid()`,
      ];
      const oldId = `CAST(old.${sql.pk} AS TEXT)`;
      const triggers: [string, string, string[], string[]][] = [
        [
          'bi',
          'BEFORE INSERT',
          [
            `EXISTS(SELECT 1 FROM ${sql.from} WHERE s.${sql.pk}=new.${sql.pk})`,
            ...displaced.map((select) => `EXISTS(${select})`),
          ],
          [...clear(newId), ...displaced.flatMap(sql.clear)],
        ],
        ['ai', 'AFTER INSERT', [], insert],
        ['ad', 'AFTER DELETE', [], clear(oldId)],
        [
          'au',
          'AFTER UPDATE',
          [],
          [...clear(oldId), ...clear(newId), ...insert],
        ],
      ];
      if (displaced.length)
        triggers.push([
          'bu',
          'BEFORE UPDATE',
          displaced.map((select) => `EXISTS(${select})`),
          displaced.flatMap(sql.clear),
        ]);
      for (const [suffix, timing, when, body] of triggers)
        db.exec(
          `CREATE TRIGGER ${quoteIdent(`_syncular_project_${name}_${suffix}`)} ${timing} ON ${quoteIdent(source.name)}${when.length ? ` WHEN ${when.join(' OR ')}` : ''} BEGIN ${body.join(';')}; END`,
        );
      continue;
    }
    for (const statement of sql.pending(
      `NOT EXISTS(SELECT 1 FROM ${sql.identity} WHERE ${sql.identityId}=${sql.sourceId}) AND NOT EXISTS(SELECT 1 FROM ${PENDING} WHERE name=${sql.name} AND source_id=${sql.sourceId})`,
    ))
      db.exec(statement);

    const dependencies = new Map<
      string,
      NonNullable<ClientLocalProjectionSpec['dependencies']>[number][]
    >();
    for (const dependency of spec.dependencies ?? []) {
      const list = dependencies.get(dependency.table) ?? [];
      list.push(dependency);
      dependencies.set(dependency.table, list);
    }
    if (!dependencies.has(source.name)) dependencies.set(source.name, []);
    const tables = [...dependencies].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const [index, [table, columns]] of tables.entries()) {
      for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        const sides =
          event === 'INSERT'
            ? ['new']
            : event === 'DELETE'
              ? ['old']
              : ['old', 'new'];
        const conditions = columns.flatMap((dep) =>
          sides.map((side) => {
            const left = `s.${quoteIdent(dep.sourceColumn)}`;
            const right = `${side}.${quoteIdent(dep.column)}`;
            // Run the indexed lookup with the source affinity and compare the
            // stored values as well. The native mirror has no column affinity.
            return `(${left}=+${right} AND +${left}=+${right})`;
          }),
        );
        const statements: string[] = [];
        if (table === source.name) {
          if (event !== 'INSERT') {
            const oldId = `SELECT CAST(old.${sql.pk} AS TEXT)`;
            statements.push(
              ...sql.clear(oldId),
              `DELETE FROM ${PENDING} WHERE name=${sql.name} AND source_id IN (${oldId})`,
            );
          }
          if (event !== 'DELETE') conditions.push(`s.${sql.pk}=new.${sql.pk}`);
        }
        if (conditions.length > 0) {
          const where = conditions.join(' OR ');
          statements.push(...sql.clear(sql.ids(where)), ...sql.pending(where));
        }
        db.exec(
          `CREATE TRIGGER ${quoteIdent(`_syncular_project_${name}_${index}_${event}`)} AFTER ${event} ON ${quoteIdent(table)} BEGIN ${statements.join(';')}; END`,
        );
      }
    }
  }
}

function projectionSql({ spec, source }: Projection) {
  const name = `'${spec.name}'`;
  const relation = quoteIdent(spec.name);
  const pk = quoteIdent(source.primaryKey);
  const from = `${quoteIdent(source.name)} AS s`;
  const sourceId = `CAST(s.${pk} AS TEXT)`;
  const identity = spec.fts
    ? quoteIdent(`_syncular_fts_${spec.name}`)
    : relation;
  const content = spec.fts
    ? quoteIdent(`_syncular_projection_${spec.name}`)
    : relation;
  const fields = [
    '"_syncular_source_id"',
    ...spec.columns.map((column) => quoteIdent(column.name)),
  ].join(',');
  const identityId = spec.fts ? 'source_id' : '"_syncular_source_id"';
  const ids = (where: string) =>
    `SELECT ${sourceId} FROM ${from} WHERE ${where}`;
  return {
    name,
    relation,
    pk,
    sourceId,
    from,
    identity,
    identityId,
    content,
    fields,
    ids,
    clear: (select: string) => {
      const affected = `rowid IN (SELECT id FROM ${identity} WHERE source_id IN (${select}))`;
      return [
        ...(spec.fts
          ? [
              `INSERT INTO ${relation}(${relation},rowid,${fields}) SELECT 'delete',rowid,${fields} FROM ${content} WHERE ${affected}`,
              `DELETE FROM ${content} WHERE ${affected}`,
            ]
          : []),
        `DELETE FROM ${identity} WHERE ${identityId} IN (${select})`,
      ];
    },
    pending: (where: string): [string, string] => [
      `INSERT INTO ${PENDING}(name,source_id,token) SELECT ${name},${sourceId},p.token+row_number() OVER () FROM ${from},${REGISTRY} AS p WHERE p.name=${name} AND (${where}) ON CONFLICT(name,source_id) DO UPDATE SET token=excluded.token`,
      `UPDATE ${REGISTRY} SET token=token+changes() WHERE name=${name}`,
    ],
  };
}

function requireProjection(
  projections: ReadonlyMap<string, Projection>,
  name: string,
): Projection {
  const projection = projections.get(name) ?? projectionUnknown(name);
  if (projection.builtin)
    throw new ClientSyncError(
      'client.projection_invalid',
      'a built-in local projection fills from its source rows',
      false,
      { name },
    );
  return projection;
}

function projectionPending(
  db: ClientDatabase,
  name: string,
  limit: number,
): ProjectionPending {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw invalidRequest('projection limit must be a nonnegative safe integer');
  const epoch = Number(
    db.query(`SELECT epoch FROM ${REGISTRY} WHERE name=?`, [name])[0]!.epoch,
  );
  const entries = db.query(
    `SELECT source_id,token FROM ${PENDING} WHERE name=? AND token IS NOT NULL ORDER BY source_id LIMIT ?`,
    [name, limit],
  );
  return {
    epoch,
    entries: entries.map((row) => ({
      sourceId: String(row.source_id),
      token: Number(row.token),
    })),
  };
}

function writeProjection(
  db: ClientDatabase,
  projection: Projection,
  epoch: number,
  rows: readonly ProjectionInput[],
): ProjectionWriteResult {
  if (!Number.isSafeInteger(epoch) || !Array.isArray(rows))
    throw invalidRequest('invalid projection write');
  const { name, columns, fts } = projection.spec;
  const { relation, identity, content, fields } = projectionSql(projection);
  const current = Number(
    db.query(`SELECT epoch FROM ${REGISTRY} WHERE name=?`, [name])[0]!.epoch,
  );
  const written: string[] = [];
  const stale: string[] = [];
  const binds = columns.map(() => '?').join(',');
  for (const row of rows) {
    if (
      !row ||
      typeof row.sourceId !== 'string' ||
      !Number.isSafeInteger(row.token) ||
      (row.values !== null &&
        (typeof row.values !== 'object' || Array.isArray(row.values)))
    )
      throw invalidRequest('invalid projection rows');
    const { sourceId, token, values } = row;
    const fail = (column: string): never => {
      throw new ClientSyncError(
        'client.projection_invalid',
        'invalid local projection value',
        false,
        { name, column },
      );
    };
    if (values !== null)
      for (const column of Object.keys(values)) {
        if (!columns.some((col) => col.name === column)) fail(column);
      }
    const cells =
      values === null
        ? null
        : columns.map((column): SqlValue => {
            const value = Object.hasOwn(values, column.name)
              ? values[column.name]
              : null;
            if (value === null) return null;
            switch (column.declaredType) {
              case 'string':
                if (typeof value === 'string' && !/\p{Cs}/u.test(value))
                  return value;
                break;
              case 'integer':
                if (typeof value === 'number' && Number.isSafeInteger(value))
                  return value;
                break;
              case 'real':
                if (typeof value === 'number' && Number.isFinite(value))
                  return value;
                break;
              case 'boolean':
                if (typeof value === 'boolean') return Number(value);
                break;
              case 'json':
                if (typeof value === 'string') {
                  try {
                    parseJsonDocument(value, 'projection value');
                    return value;
                  } catch {
                    return fail(column.name);
                  }
                }
                break;
            }
            return fail(column.name);
          });
    if (
      epoch !== current ||
      !db.query(
        `SELECT 1 FROM ${PENDING} WHERE name=? AND source_id=? AND token=?`,
        [name, sourceId, token],
      ).length
    ) {
      stale.push(sourceId);
      continue;
    }
    if (cells === null) {
      db.exec(`UPDATE ${PENDING} SET token=NULL WHERE name=? AND source_id=?`, [
        name,
        sourceId,
      ]);
    } else {
      if (fts) {
        db.exec(`INSERT INTO ${identity}(source_id) VALUES (?)`, [sourceId]);
        db.exec(
          `INSERT INTO ${content}(rowid,${fields}) VALUES (last_insert_rowid(),?,${binds})`,
          [sourceId, ...cells],
        );
        db.exec(
          `INSERT INTO ${relation}(rowid,${fields}) SELECT rowid,${fields} FROM ${content} WHERE rowid=last_insert_rowid()`,
        );
      } else {
        db.exec(`INSERT INTO ${relation}(${fields}) VALUES (?,${binds})`, [
          sourceId,
          ...cells,
        ]);
      }
      db.exec(`DELETE FROM ${PENDING} WHERE name=? AND source_id=?`, [
        name,
        sourceId,
      ]);
    }
    written.push(sourceId);
  }
  return { written, stale };
}

function invalidateProjection(
  db: ClientDatabase,
  projection: Projection,
  sourceIds?: readonly string[],
): number {
  if (
    sourceIds !== undefined &&
    (!Array.isArray(sourceIds) ||
      sourceIds.some((id) => typeof id !== 'string'))
  )
    throw invalidRequest('projection source IDs must be strings');
  const sql = projectionSql(projection);
  const where =
    sourceIds === undefined
      ? '1'
      : `${sql.sourceId} IN (SELECT value FROM json_each(?))`;
  const params =
    sourceIds === undefined ? undefined : [JSON.stringify(sourceIds)];
  const [mark, bump] = sql.pending(where);
  if (sourceIds === undefined) {
    if (projection.spec.fts) {
      db.exec(
        `INSERT INTO ${sql.relation}(${sql.relation}) VALUES ('delete-all')`,
      );
      db.exec(`DELETE FROM ${sql.content}`);
    }
    db.exec(`DELETE FROM ${sql.identity}`);
  } else {
    for (const statement of sql.clear(sql.ids(where)))
      db.exec(statement, params);
  }
  const purged = Number(db.query('SELECT changes() AS purged')[0]?.purged);
  db.exec(mark, params);
  db.exec(bump);
  db.exec(`UPDATE ${REGISTRY} SET epoch=epoch+1 WHERE name=?`, [
    projection.spec.name,
  ]);
  return purged;
}
