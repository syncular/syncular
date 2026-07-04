/**
 * Named-query analysis (the sqlc/SQLDelight tier).
 *
 * A `queries/` dir next to migrations holds `.sql` files, ONE query per file.
 * The filename (kebab-case) becomes the query name (camelCase); SELECT-only —
 * writes stay `mutate()` (SPEC §7.1). Each query is type-checked BY SQLITE
 * ITSELF: we synthesize the schema's DDL from the IR (the reverse of the SQL
 * parser), build an in-memory `bun:sqlite` DB, and `prepare()` the query. That
 * validates syntax + every table/column reference for free, and yields the
 * result column names + their declared SQLite types (`declaredTypes` =
 * `sqlite3_column_decltype`).
 *
 * ## Typing fidelity (the honest boundary — what bun:sqlite actually exposes)
 *
 * bun:sqlite exposes, per prepared statement: `columnNames`, `declaredTypes`
 * (decltype, once executed once — we `.all()` against the empty DB), and
 * `paramsCount`. It does NOT expose column ORIGIN (table/column) nor param
 * NAMES nor NOT-NULL flags. So:
 *
 * - **Plain column ref** (`title`, `t.title`, `title AS x`): decltype is the
 *   origin column's exact declared type. We map it back through the SAME
 *   TYPE_MAP the migration parser uses → the exact IR column type. For
 *   NULLABILITY we resolve the ref against the IR ourselves (parse the SELECT
 *   list + FROM/JOIN, match `name`/`alias.name` to an IR table column) — an
 *   IR-exact non-nullable/nullable answer. This is the drift-kill: same type
 *   AND nullability as the schema, guaranteed by SQLite's own reference check.
 * - **Computed expression** (`count(*)`, `done + 1`, `:label AS l`): decltype
 *   is null. We fall back to a documented honest type from the raw column
 *   name/shape: aggregate/arith → nullable number, anything else → nullable
 *   string. Marked `nullable: true` always (an expression's nullability is not
 *   knowable from decltype). Callers who want an exact type give the column an
 *   alias whose ref is plain, or accept the honest fallback.
 *
 * ## Parameters
 *
 * Named `:name` placeholders. Types are inferred where the param compares
 * against a plain column ref (`WHERE list_id = :listId` / `col IN (:a, :b)`) —
 * the param takes that column's IR type. Ambiguous params (compared to an
 * expression, used only in a projection, etc.) require a
 * `-- param :name <type>` header comment; missing both is a generate-time
 * error listing the fix. bun:sqlite can't name params, so we parse `:name`
 * tokens from the SQL ourselves (first-occurrence order = positional order).
 *
 * ## The tables set (for useSyncQuery `{tables}` — exact invalidation)
 *
 * bun:sqlite exposes no authorizer and no statement table-list; EXPLAIN
 * opcodes are fragile. The honest mechanism: the FROM/JOIN table set we
 * already resolve for column typing, VALIDATED against the IR by the
 * SQLite prepare() (an unknown table would have thrown). Boundary: tables
 * referenced ONLY inside a subquery/`WHERE EXISTS (...)` are still captured
 * because we scan every `FROM`/`JOIN` identifier in the whole statement and
 * keep those that name an IR table; a table that appears under neither keyword
 * (impossible for a real reference) is not captured. Conservative + correct
 * for the query shapes this tier supports.
 */
import { TypegenError } from './errors';
import type { IrColumnType, IrDocument, IrTable } from './ir';

/** The SQL decltype keyword → §2.4 type map (mirrors sql.ts TYPE_MAP so a
 * plain column ref's decltype resolves to the exact IR type). */
const DECLTYPE_MAP: Readonly<Record<string, IrColumnType>> = {
  TEXT: 'string',
  INTEGER: 'integer',
  INT: 'integer',
  BIGINT: 'integer',
  SMALLINT: 'integer',
  REAL: 'float',
  FLOAT: 'float',
  DOUBLE: 'float',
  BOOLEAN: 'boolean',
  BOOL: 'boolean',
  JSON: 'json',
  JSONB: 'json',
  BLOB: 'bytes',
  BYTEA: 'bytes',
  BLOB_REF: 'blob_ref',
  BLOBREF: 'blob_ref',
  CRDT: 'crdt',
};

/** A param type is one of the §2.4 types (the columns params compare to). */
export type QueryParamType = IrColumnType;

export interface QueryParam {
  readonly name: string;
  readonly type: QueryParamType;
  /** How the type was resolved — for the docs/tests, not emitted. */
  readonly source: 'inferred' | 'comment';
}

export interface QueryColumn {
  readonly name: string;
  readonly type: IrColumnType;
  readonly nullable: boolean;
  /** `exact` = resolved to an IR column (plain ref); `fallback` = a computed
   * expression typed by the documented honest fallback. */
  readonly fidelity: 'exact' | 'fallback';
}

export interface AnalyzedQuery {
  /** camelCase function name (from the kebab filename). */
  readonly name: string;
  /** Source filename, e.g. `list-todos.sql`. */
  readonly file: string;
  /** The SQL as written (named `:params`), trimmed. */
  readonly sql: string;
  /** The SQL with `:name` rewritten to positional `?` (wrapper surface). */
  readonly positionalSql: string;
  /** Params in first-occurrence (positional) order. */
  readonly params: readonly QueryParam[];
  /** Result columns in SELECT order. */
  readonly columns: readonly QueryColumn[];
  /** IR tables this query reads (the useSyncQuery `{tables}` set), sorted. */
  readonly tables: readonly string[];
}

// -- filename → name ----------------------------------------------------------

const QUERY_FILE_RE = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.sql$/;

/** `list-todos.sql` → `listTodos`. Rejects non-kebab filenames loudly. */
export function queryNameFromFile(file: string): string {
  const match = QUERY_FILE_RE.exec(file);
  if (match === null || match[1] === undefined) {
    throw new TypegenError(
      file,
      `query filename must be lowercase kebab-case ending in .sql (e.g. list-todos.sql), got ${JSON.stringify(file)}`,
    );
  }
  const parts = match[1].split('-');
  return (
    parts[0] +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('')
  );
}

// -- lightweight SQL scanning -------------------------------------------------
//
// We do NOT re-implement SQLite's parser (that is what prepare() is for). We
// scan the text only for: header `-- param` comments, `:name` placeholders,
// FROM/JOIN table identifiers, and SELECT-column → source resolution. SQLite
// remains the authority on correctness.

interface CommentParam {
  readonly name: string;
  readonly type: IrColumnType;
}

const PARAM_COMMENT_RE =
  /^\s*--\s*param\s+:([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_]+)\s*$/;

const PARAM_TYPES = new Set<string>([
  'string',
  'integer',
  'float',
  'boolean',
  'json',
  'bytes',
  'blob_ref',
  'crdt',
]);

/** Parse `-- param :name <type>` header lines. They must precede the SQL. */
function parseCommentParams(file: string, raw: string): CommentParam[] {
  const out: CommentParam[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith('--')) break; // first non-comment line ends the header
    const match = PARAM_COMMENT_RE.exec(line);
    if (match === null) continue; // an ordinary comment, ignore
    const name = match[1] as string;
    const type = (match[2] as string).toLowerCase();
    if (!PARAM_TYPES.has(type)) {
      throw new TypegenError(
        file,
        `-- param :${name}: unknown type ${JSON.stringify(match[2])} (use one of ${[...PARAM_TYPES].join(', ')})`,
      );
    }
    out.push({ name, type: type as IrColumnType });
  }
  return out;
}

/** Strip `--` and block comments so identifier scans don't hit commented SQL,
 * and string literals so `':x'` inside a string isn't read as a param. */
function stripCommentsAndStrings(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (ch === "'") {
      const end = sql.indexOf("'", i + 1);
      i = end === -1 ? sql.length : end + 1;
      out += ' ';
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Distinct `:name` placeholders in first-occurrence order (dedup by name,
 * matching SQLite's paramsCount which counts distinct names). */
function scanParamNames(sql: string): string[] {
  const cleaned = stripCommentsAndStrings(sql);
  // `:name` but not `::` (Postgres cast) — our subset never has `::`.
  const re = /:([A-Za-z_][A-Za-z0-9_]*)/g;
  const seen: string[] = [];
  for (const m of cleaned.matchAll(re)) {
    const name = m[1] as string;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** Rewrite `:name` → positional `?` (repeats included) AND strip comments +
 * collapse whitespace, producing a clean single-line SQL string suitable for
 * embedding in a generated string literal. String literals are preserved
 * verbatim (their inner whitespace is not collapsed). */
function toPositionalSql(sql: string): string {
  const tokens: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      tokens.push(' ');
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      tokens.push(' ');
    } else if (ch === "'") {
      // Preserve string literals verbatim (including any '' escapes).
      let j = i + 1;
      let lit = "'";
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            lit += "''";
            j += 2;
          } else {
            lit += "'";
            j += 1;
            break;
          }
        } else {
          lit += sql[j];
          j += 1;
        }
      }
      tokens.push(lit);
      i = j;
    } else if (ch === ':' && next !== undefined && /[A-Za-z_]/.test(next)) {
      let end = i + 1;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end] as string)) {
        end += 1;
      }
      tokens.push('?');
      i = end;
    } else if (/\s/.test(ch)) {
      tokens.push(' ');
      i += 1;
    } else {
      tokens.push(ch);
      i += 1;
    }
  }
  // Collapse runs of the whitespace placeholders; trim.
  return tokens.join('').replace(/\s+/g, ' ').trim();
}

// -- FROM/JOIN table resolution ----------------------------------------------

interface TableRef {
  readonly table: string;
  /** Alias (or the table name when un-aliased). */
  readonly alias: string;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
// `FROM tbl [AS] a`, `JOIN tbl [AS] a`. We only need the referenced base
// tables that exist in the IR; SQLite has already proven every reference.
const TABLE_REF_RE = new RegExp(
  `\\b(?:FROM|JOIN)\\s+(${IDENT})(?:\\s+(?:AS\\s+)?(${IDENT}))?`,
  'gi',
);

const RESERVED_ALIAS = new Set([
  'on',
  'where',
  'group',
  'order',
  'inner',
  'left',
  'right',
  'outer',
  'join',
  'cross',
  'using',
  'limit',
  'having',
]);

function scanTableRefs(sql: string, ir: IrDocument): TableRef[] {
  const cleaned = stripCommentsAndStrings(sql);
  const known = new Map(ir.tables.map((t) => [t.name, t] as const));
  const refs: TableRef[] = [];
  for (const m of cleaned.matchAll(TABLE_REF_RE)) {
    const table = m[1] as string;
    if (!known.has(table)) continue; // e.g. FROM (subquery) — table is `(`; skip
    let alias = m[2];
    if (alias !== undefined && RESERVED_ALIAS.has(alias.toLowerCase())) {
      alias = undefined;
    }
    refs.push({ table, alias: alias ?? table });
  }
  return refs;
}

// -- SELECT column → source resolution ---------------------------------------
//
// For each result column bun gives us (name + decltype), we resolve its origin
// IR column so we can attach exact NULLABILITY (decltype carries type but not
// NOT NULL). We parse the SELECT list into items and, per item, try to find a
// plain column ref (`col`, `alias.col`) that names an IR column of one of the
// FROM/JOIN tables. When found, that IR column is the source (exact fidelity);
// otherwise it is a computed expression (fallback fidelity).

interface SelectItem {
  /** The raw expression text (before any `AS alias`). */
  readonly expr: string;
  /** The explicit `AS alias`, if any. */
  readonly alias: string | undefined;
}

/** Split a SELECT list on top-level commas (parens-aware). Returns null when
 * the query isn't a plain `SELECT … FROM …` we can split (e.g. `SELECT *`). */
function splitSelectList(sql: string): SelectItem[] | null {
  const cleaned = stripCommentsAndStrings(sql).replace(/\s+/g, ' ').trim();
  const m = /^SELECT\s+(?:DISTINCT\s+)?(.*?)\sFROM\s/i.exec(cleaned);
  if (m === null || m[1] === undefined) return null;
  const list = m[1];
  if (list.trim() === '*' || /(^|,|\.)\s*\*/.test(list)) return null; // SELECT * / t.*
  const items: SelectItem[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= list.length; i++) {
    const ch = list[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if ((ch === ',' && depth === 0) || i === list.length) {
      const raw = list.slice(start, i).trim();
      start = i + 1;
      if (raw.length === 0) continue;
      // `expr AS alias` or `expr alias` (trailing bare identifier). Only treat
      // a trailing word as an alias when the expr has more than that word.
      const asMatch = /^(.*?)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(raw);
      if (asMatch !== null) {
        items.push({ expr: (asMatch[1] as string).trim(), alias: asMatch[2] });
      } else {
        items.push({ expr: raw, alias: undefined });
      }
    }
  }
  return items;
}

const PLAIN_REF_RE = new RegExp(`^(?:(${IDENT})\\.)?(${IDENT})$`);

interface ResolvedSource {
  readonly column: IrTable['columns'][number];
}

/** Resolve a SELECT item's expression to an IR column, if it is a plain ref. */
function resolveSource(
  item: SelectItem,
  refs: readonly TableRef[],
  ir: IrDocument,
): ResolvedSource | null {
  const m = PLAIN_REF_RE.exec(item.expr);
  if (m === null) return null;
  const qualifier = m[1];
  const columnName = m[2] as string;
  const byName = new Map(ir.tables.map((t) => [t.name, t] as const));
  if (qualifier !== undefined) {
    const ref = refs.find((r) => r.alias === qualifier);
    if (ref === undefined) return null;
    const table = byName.get(ref.table);
    const col = table?.columns.find((c) => c.name === columnName);
    return col === undefined ? null : { column: col };
  }
  // Unqualified: search every FROM/JOIN table (SQLite already resolved
  // ambiguity; a single-table query is the common case).
  for (const ref of refs) {
    const table = byName.get(ref.table);
    const col = table?.columns.find((c) => c.name === columnName);
    if (col !== undefined) return { column: col };
  }
  return null;
}

// -- param type inference -----------------------------------------------------
//
// Infer a param's type from `col <op> :name` or `col IN (:name, …)` where `col`
// is a plain ref to an IR column. Equality/comparison/IN only — anything else
// needs the `-- param` comment (kept deliberately simple and honest).

function inferParamType(
  paramName: string,
  sql: string,
  refs: readonly TableRef[],
  ir: IrDocument,
): IrColumnType | null {
  const cleaned = stripCommentsAndStrings(sql);
  const byName = new Map(ir.tables.map((t) => [t.name, t] as const));
  const lookup = (
    qualifier: string | undefined,
    column: string,
  ): IrColumnType | null => {
    if (qualifier !== undefined) {
      const ref = refs.find((r) => r.alias === qualifier);
      const table = ref && byName.get(ref.table);
      return table?.columns.find((c) => c.name === column)?.type ?? null;
    }
    for (const ref of refs) {
      const table = byName.get(ref.table);
      const col = table?.columns.find((c) => c.name === column);
      if (col !== undefined) return col.type;
    }
    return null;
  };
  // `col = :name`, `col >= :name`, `col <> :name`, `col LIKE :name`, etc.
  const cmp = new RegExp(
    `(?:(${IDENT})\\.)?(${IDENT})\\s*(?:=|==|!=|<>|<=|>=|<|>|\\bLIKE\\b|\\bIS\\b)\\s*:${paramName}\\b`,
    'i',
  );
  const cmpM = cmp.exec(cleaned);
  if (cmpM !== null) {
    const t = lookup(cmpM[1], cmpM[2] as string);
    if (t !== null) return t;
  }
  // reversed: `:name = col`
  const rev = new RegExp(
    `:${paramName}\\b\\s*(?:=|==|!=|<>|<=|>=|<|>)\\s*(?:(${IDENT})\\.)?(${IDENT})`,
    'i',
  );
  const revM = rev.exec(cleaned);
  if (revM !== null) {
    const t = lookup(revM[1], revM[2] as string);
    if (t !== null) return t;
  }
  // `col IN (…, :name, …)` — find the nearest `col IN (` before the param.
  const inRe = new RegExp(
    `(?:(${IDENT})\\.)?(${IDENT})\\s+IN\\s*\\(([^)]*:${paramName}\\b[^)]*)\\)`,
    'i',
  );
  const inM = inRe.exec(cleaned);
  if (inM !== null) {
    const t = lookup(inM[1], inM[2] as string);
    if (t !== null) return t;
  }
  return null;
}

// -- fallback column typing (computed expressions) ----------------------------

const AGG_RE = /\b(count|sum|total|avg|min|max)\s*\(/i;

/** decltype-null column: the documented honest fallback. Aggregates and
 * arithmetic → nullable number; everything else → nullable string. */
function fallbackColumnType(expr: string): IrColumnType {
  if (AGG_RE.test(expr) || /[+\-*/]/.test(expr)) return 'float';
  return 'string';
}

// -- public API ---------------------------------------------------------------

export interface QueryDb {
  /** Prepare + return the result columns / declared types / param count.
   * Throws (with SQLite's message) when the SQL is invalid against the DDL. */
  analyze(sql: string): {
    columnNames: readonly string[];
    declaredTypes: readonly (string | null)[];
    paramsCount: number;
  };
}

/** Synthesize the schema DDL from the IR (the reverse of the migration
 * parser): a `CREATE TABLE` per IR table with each column's declared SQLite
 * type + NOT NULL, so `prepare()` validates references and decltype resolves.
 * This is exported so the generator can build one in-memory DB per run. */
export function synthesizeDdl(ir: IrDocument): string {
  const SQL_TYPE: Record<IrColumnType, string> = {
    string: 'TEXT',
    integer: 'INTEGER',
    float: 'REAL',
    boolean: 'BOOLEAN',
    json: 'JSON',
    bytes: 'BLOB',
    // blob_ref rides as TEXT; keep its distinct decltype so a plain ref types
    // back to blob_ref (DECLTYPE_MAP knows BLOB_REF).
    blob_ref: 'BLOB_REF',
    crdt: 'CRDT',
  };
  const lines: string[] = [];
  for (const table of ir.tables) {
    const cols = table.columns.map((c) => {
      const notNull = c.nullable ? '' : ' NOT NULL';
      const pk = c.name === table.primaryKey ? ' PRIMARY KEY' : '';
      return `  ${c.name} ${SQL_TYPE[c.type]}${pk}${notNull}`;
    });
    lines.push(`CREATE TABLE ${table.name} (\n${cols.join(',\n')}\n);`);
  }
  return lines.join('\n');
}

/** Analyze one query file's raw SQL against the IR + a prepared-DDL DB. */
export function analyzeQuery(
  file: string,
  raw: string,
  ir: IrDocument,
  db: QueryDb,
): AnalyzedQuery {
  const name = queryNameFromFile(file);
  const commentParams = parseCommentParams(file, raw);
  const sql = raw.trim();
  if (sql.length === 0) {
    throw new TypegenError(file, 'query file is empty');
  }

  // SELECT-only (the read tier). Reject the first keyword loudly otherwise.
  const firstKeyword = /^\s*([A-Za-z]+)/.exec(
    stripCommentsAndStrings(raw).trimStart(),
  )?.[1];
  if (firstKeyword === undefined || firstKeyword.toUpperCase() !== 'SELECT') {
    throw new TypegenError(
      file,
      `named queries are SELECT-only (the read tier); found ${JSON.stringify(firstKeyword ?? '')}. Writes go through mutate() (SPEC §7.1).`,
    );
  }
  // Reject `;`-separated multiple statements (prepare would silently take the
  // first, hiding the rest).
  const body = stripCommentsAndStrings(sql).replace(/;\s*$/, '');
  if (body.includes(';')) {
    throw new TypegenError(
      file,
      'a query file holds exactly one SELECT statement (found a `;` separating statements)',
    );
  }

  // Let SQLite validate + describe the query. Any bad reference throws here
  // with SQLite's own message (which names the offending table/column).
  let described: ReturnType<QueryDb['analyze']>;
  try {
    described = db.analyze(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypegenError(file, `SQL rejected by SQLite: ${message}`);
  }

  const refs = scanTableRefs(sql, ir);
  const tableSet = new Set(refs.map((r) => r.table));
  const tables = [...tableSet].sort();
  if (tables.length === 0) {
    throw new TypegenError(
      file,
      'query reads no synced table — every named query must read at least one IR table (for exact invalidation)',
    );
  }

  // Columns: pair bun's column names + decltypes with our source resolution.
  const items = splitSelectList(sql);
  const columns: QueryColumn[] = described.columnNames.map((colName, index) => {
    const decl = described.declaredTypes[index];
    const item = items?.[index];
    const source = item !== undefined ? resolveSource(item, refs, ir) : null;
    if (source !== null) {
      // Exact: IR column type + IR nullability. (decltype agrees; we prefer
      // the IR type so blob_ref/crdt/json semantic types survive.)
      return {
        name: colName,
        type: source.column.type,
        nullable: source.column.nullable,
        fidelity: 'exact',
      };
    }
    // Fallback: decltype affinity if present, else the expr-shape fallback.
    const mapped =
      decl !== null && decl !== undefined
        ? DECLTYPE_MAP[decl.toUpperCase()]
        : undefined;
    const type =
      mapped ?? (item !== undefined ? fallbackColumnType(item.expr) : 'string');
    return { name: colName, type, nullable: true, fidelity: 'fallback' };
  });

  // Params: names from the text (positional order), types from inference or
  // the `-- param` comment; every param must resolve.
  const paramNames = scanParamNames(sql);
  if (paramNames.length !== described.paramsCount) {
    // Defensive: our scan and SQLite disagree (shouldn't happen for the subset).
    throw new TypegenError(
      file,
      `internal: scanned ${paramNames.length} params (${paramNames.join(', ')}) but SQLite reports ${described.paramsCount}`,
    );
  }
  const commentByName = new Map(commentParams.map((p) => [p.name, p.type]));
  const params: QueryParam[] = paramNames.map((paramName) => {
    const commented = commentByName.get(paramName);
    if (commented !== undefined) {
      return { name: paramName, type: commented, source: 'comment' };
    }
    const inferred = inferParamType(paramName, sql, refs, ir);
    if (inferred !== null) {
      return { name: paramName, type: inferred, source: 'inferred' };
    }
    throw new TypegenError(
      file,
      `cannot infer a type for param :${paramName} (it is not compared to a plain column). Add a header comment: \`-- param :${paramName} <type>\` (one of ${[...PARAM_TYPES].join(', ')}).`,
    );
  });
  // A `-- param` comment naming a param the query does not use is a mistake.
  for (const cp of commentParams) {
    if (!paramNames.includes(cp.name)) {
      throw new TypegenError(
        file,
        `-- param :${cp.name} names a parameter the query does not use`,
      );
    }
  }

  return {
    name,
    file,
    sql,
    positionalSql: toPositionalSql(sql),
    params,
    columns,
    tables,
  };
}
