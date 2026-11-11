/**
 * Named-query analysis (the sqlc/SQLDelight tier).
 *
 * A `queries/` dir next to migrations is walked RECURSIVELY for `.sql` files;
 * folders are pure organization. A statement's default name is its path
 * relative to the queries root — segments + filename, joined and camelCased
 * (`billing/invoices/list.sql` → `billingInvoicesList`; a flat `list-todos.sql`
 * → `listTodos`, unchanged). A `-- name: ident` marker in a statement's leading
 * comment block overrides the FULL name verbatim. A file may hold MULTIPLE
 * statements (split on top-level `;`); a single-statement file may omit
 * `-- name:` (path-derived), a multi-statement file requires it on EVERY
 * statement. SELECT-only — writes stay `mutate()` (SPEC §7.1). Each query is
 * type-checked BY SQLITE
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
 *   list + FROM/JOIN, match `name`/`alias.name` to an IR table column), then
 *   lift it when an outer join can synthesize NULL for that relation. This is
 *   the drift-kill: schema nullability plus SQL join null-extension, with
 *   SQLite still proving every reference.
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
 * ## The tables set (for useRawSql `{tables}` — exact invalidation)
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
import { isSyqlTrivia, lexSyqlSqlSource, type SyqlToken } from './syql-lexer';
import type { IrColumn, IrColumnType, IrDocument, IrTable } from './ir';
import { findProjection, lowerProjection } from './lower';
import {
  buildNamingMap,
  type NamingMode,
  type NamingTarget,
  validateQueryIdentifier,
} from './naming';

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

/** Local client protocol column; query-only and never part of schema IR. */
const SYNC_VERSION_COLUMN = '_sync_version';
/** Stable private identity shared by every declared local FTS5 projection. */
const FTS_SOURCE_ID_COLUMN = '_syncular_source_id';

/** A param type is one of the §2.4 types (the columns params compare to). */
export type QueryParamType = IrColumnType;

export interface QueryParam {
  /** SQL-truth `:name` (as authored). */
  readonly name: string;
  /** Language-facing name (§5 naming map; equals `name` under "preserve"). */
  readonly langName: string;
  readonly type: QueryParamType;
  /** How the type was resolved — for the docs/tests, not emitted. */
  readonly source: 'inferred' | 'comment';
}

export interface QueryColumn {
  /** SQL-truth result name (pre-lowering, as authored). */
  readonly name: string;
  /** Language-facing name — the RUNTIME result key after §5 projection
   * lowering (equals `name` under "preserve"). */
  readonly langName: string;
  readonly type: IrColumnType;
  readonly nullable: boolean;
  /** `exact` = resolved to an IR column (plain ref); `fallback` = a computed
   * expression typed by its `CAST` or `count()` (SYQL §14.1). */
  readonly fidelity: 'exact' | 'fallback';
  /** Proven physical origin for reactive row identity and diagnostics. */
  readonly origin?: { readonly table: string; readonly column: string };
}

export interface QueryScopeBinding {
  readonly table: string;
  readonly variable: string;
  readonly pattern: string;
  readonly params: readonly string[];
}

export interface QueryCoverageBinding {
  readonly table: string;
  readonly variable: string;
  readonly units: readonly string[];
  readonly fixedScopes: readonly {
    readonly variable: string;
    readonly params: readonly string[];
  }[];
}

/** The window bases (SPEC §4.8) a query's coverage needs, for generated
 * descriptors. A base names no table, so tables proven by the same base share
 * one entry; a fixed scope bound to several params yields one base per value
 * combination, since a base holds one value per fixed variable. Ordered by
 * code point of the JSON so emitted metadata is byte-identical across
 * locales. */
export function windowBases(coverage: readonly QueryCoverageBinding[]): {
  readonly variable: string;
  readonly units: readonly string[];
  readonly fixedScopes: readonly { variable: string; param: string }[];
}[] {
  const bases = coverage.flatMap((entry) => {
    let combinations: { variable: string; param: string }[][] = [[]];
    for (const scope of entry.fixedScopes) {
      combinations = combinations.flatMap((combination) =>
        scope.params.map((param) => [
          ...combination,
          { variable: scope.variable, param },
        ]),
      );
    }
    return combinations.map((fixedScopes) => ({
      variable: entry.variable,
      units: entry.units,
      fixedScopes,
    }));
  });
  return [...new Map(bases.map((base) => [JSON.stringify(base), base]))]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, base]) => base);
}

export interface QueryReactiveMetadata {
  readonly dependencies: readonly {
    readonly table: string;
    readonly scopes: readonly QueryScopeBinding[];
  }[];
  readonly coverage: readonly QueryCoverageBinding[];
  /** Language-facing projection fields forming a proven unique row key. */
  readonly rowKey?: readonly string[];
}

/** §7/§8 backend selection: neutralization, always-variants, or
 * the small-N heuristic (`auto`: enumerate at ≤ 2 optional groups). */
export type QueryBackend = 'neutralize' | 'variants' | 'auto';

/** Naming/backend options threaded from the manifest into query analysis. */
export interface QueryNamingOptions {
  readonly naming: NamingMode;
  /** Emitter targets this run generates — keyword hazards are only real on
   * targets that exist. */
  readonly targets: readonly NamingTarget[];
  /** `.syql` conditional-lowering policy (default `auto`). */
  readonly backend?: QueryBackend;
  /** Compiler-reserved physical binds. They retain their exact names and do
   * not participate in public target-language keyword/private-name checks. */
  readonly internalParams?: readonly string[];
}

const DEFAULT_NAMING: QueryNamingOptions = { naming: 'camel', targets: ['ts'] };

/** SYQL public inputs. These are deliberately separate from SQL binds: groups
 * and compiler-generated parameters have distinct public/runtime shapes. */
export type QuerySyqlPublicInput =
  | {
      readonly kind: 'value';
      readonly name: string;
      readonly langName: string;
      readonly type: QueryParamType;
      readonly nullable: boolean;
      readonly required: boolean;
      readonly default?: false;
    }
  | {
      readonly kind: 'group';
      readonly name: string;
      readonly langName: string;
      readonly members: readonly {
        readonly name: string;
        readonly langName: string;
        readonly type: QueryParamType;
        readonly nullable: boolean;
      }[];
    }
  | {
      readonly kind: 'sort';
      readonly name: string;
      readonly langName: string;
      readonly defaultProfile: string;
      readonly profiles: readonly {
        readonly name: string;
        readonly langName: string;
      }[];
    }
  | {
      readonly kind: 'limit';
      readonly name: string;
      readonly langName: string;
      readonly defaultSize: number;
      readonly maxSize: number;
    };

/** One distinct SQLite bind in a physical revision-1 statement. */
export type QuerySyqlPlanBind =
  | {
      readonly kind: 'value';
      readonly name: string;
      readonly type: QueryParamType;
      readonly input: string;
    }
  | {
      readonly kind: 'group-member';
      readonly name: string;
      readonly type: QueryParamType;
      readonly input: string;
      readonly member: string;
    }
  | {
      readonly kind: 'condition-active';
      readonly name: string;
      readonly type: 'boolean';
      readonly condition: number;
      readonly controls: readonly string[];
    }
  | {
      readonly kind: 'limit';
      readonly name: string;
      readonly type: 'integer';
      readonly input: string;
    };

/** One SQLite-checked statement selected by sort profile and, for the
 * enumerated backend, the activation bitmask. */
export interface QuerySyqlStatement {
  readonly sortProfile?: string;
  readonly activationMask?: number;
  readonly sql: string;
  readonly positionalSql: string;
  readonly binds: readonly QuerySyqlPlanBind[];
  readonly relations: readonly QueryRelation[];
}

/** The target-neutral physical plan every emitter must implement exactly. */
export interface QuerySyqlExecutionPlan {
  readonly backend: Exclude<QueryBackend, 'auto'>;
  /** One bit per conditional activation control, in declaration order. */
  readonly activationControls: readonly string[];
  readonly conditions: readonly {
    readonly controls: readonly string[];
    /** Present only for neutralized plans. */
    readonly bind?: string;
  }[];
  readonly statements: readonly QuerySyqlStatement[];
}

export interface QuerySyqlMetadata {
  readonly revision: 1;
  readonly inputs: readonly QuerySyqlPublicInput[];
  readonly plan: QuerySyqlExecutionPlan;
  readonly identity?: readonly string[];
}

/** Physical relation boundaries in the exact positional SQL statement. */
export interface QueryRelation {
  readonly table: string;
  readonly start: number;
  readonly end: number;
  readonly alias?: string;
}

/** The findings of the query plan check (`docs/SYQL.md` §14.5). */
export const QUERY_PLAN_FINDINGS = [
  'scan',
  'automatic_index',
  'unbounded',
  'many_tables',
] as const;
export type QueryPlanFinding = (typeof QUERY_PLAN_FINDINGS)[number];

/** An author's acknowledgement of one plan finding, with its reason.
 * `plan` acknowledges every finding of a query only the server runs. */
export interface QueryAcknowledgement {
  readonly finding: QueryPlanFinding | 'plan';
  /** Absent for `many_tables` and `plan`. */
  readonly table?: string;
  readonly reason: string;
}

export interface AnalyzedQuery {
  /** camelCase function name (path-derived, or a `-- name:` override). */
  readonly name: string;
  /** Source location for errors, e.g. `billing/list.sql` (or `list.sql#2`
   * for the 2nd statement of a multi-statement file). */
  readonly file: string;
  /** The SQL as authored (named `:params`), trimmed — pre-lowering. */
  readonly sourceSql: string;
  /** The LOWERED SQL (named `:params`): §5 projection aliasing applied, so
   * runtime result keys are the language-facing names. Equals `sourceSql`
   * when nothing needed rewriting. */
  readonly sql: string;
  /** The lowered SQL with `:name` rewritten to positional `?`. */
  readonly positionalSql: string;
  readonly relations: readonly QueryRelation[];
  /** Params in first-occurrence (positional) order. */
  readonly params: readonly QueryParam[];
  /** Result columns in SELECT order. */
  readonly columns: readonly QueryColumn[];
  /** IR tables this query reads (the useRawSql `{tables}` set), sorted. */
  readonly tables: readonly string[];
  readonly reactive: QueryReactiveMetadata;
  /** Revision-1 frontend/public-input and physical execution contract. When
   * present, emitters use this instead of treating `params` as the API. */
  readonly syql?: QuerySyqlMetadata;
  /** Plan findings the author acknowledged on the statement. */
  readonly acknowledgements: readonly QueryAcknowledgement[];
}

/** The public SYQL input an emitter binds by name. */
export function syqlInput(
  query: AnalyzedQuery,
  name: string,
): QuerySyqlPublicInput {
  const input = query.syql?.inputs.find((candidate) => candidate.name === name);
  if (input === undefined) throw new Error(`unknown SYQL input ${name}`);
  return input;
}

// -- path → name --------------------------------------------------------------

/** A single kebab-case path segment (folder) or filename stem. */
const KEBAB_SEGMENT_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A valid camelCase identifier — what a `-- name:` override must be. */
const CAMEL_IDENT_RE = /^[a-z][A-Za-z0-9]*$/;

/** Split a kebab word list into a camelCase suffix (used per segment). */
function kebabWords(segment: string): string[] {
  return segment.split('-');
}

/**
 * Path-relative default name. `billing/invoices/list.sql` → `billingInvoicesList`;
 * a flat `list-todos.sql` → `listTodos` (unchanged). Every folder segment AND
 * the filename stem must be lowercase kebab-case — rejects loudly, naming the
 * offending segment, so a stray `List.sql` or `Billing/` fails at generate time.
 */
export function queryNameFromPath(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/');
  if (!norm.endsWith('.sql')) {
    throw new TypegenError(
      relPath,
      `query file must end in .sql, got ${JSON.stringify(relPath)}`,
    );
  }
  const withoutExt = norm.slice(0, -'.sql'.length);
  const segments = withoutExt.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new TypegenError(
      relPath,
      `invalid query path ${JSON.stringify(relPath)}`,
    );
  }
  const words: string[] = [];
  for (const segment of segments) {
    if (!KEBAB_SEGMENT_RE.test(segment)) {
      throw new TypegenError(
        relPath,
        `path segment ${JSON.stringify(segment)} in ${JSON.stringify(norm)} must be lowercase kebab-case (e.g. billing/invoices/list-open.sql → billingInvoicesListOpen)`,
      );
    }
    words.push(...kebabWords(segment));
  }
  const first = words[0] as string;
  return (
    first +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('')
  );
}

/** Back-compat flat-file helper: `list-todos.sql` → `listTodos`. Rejects a
 * path with folders (use {@link queryNameFromPath} for nested queries). */
export function queryNameFromFile(file: string): string {
  if (file.includes('/') || file.includes('\\')) {
    throw new TypegenError(
      file,
      `queryNameFromFile takes a flat filename; got a path ${JSON.stringify(file)} — use queryNameFromPath`,
    );
  }
  return queryNameFromPath(file);
}

/** Validate a `-- name:` override is a camelCase identifier (loud otherwise). */
export function validateOverrideName(name: string, location: string): string {
  if (!CAMEL_IDENT_RE.test(name)) {
    throw new TypegenError(
      location,
      `-- name: ${JSON.stringify(name)} must be a camelCase identifier (start lowercase, letters/digits only, e.g. billingInvoicesList)`,
    );
  }
  return name;
}

// -- SQL tokens -----------------------------------------------------------------
//
// Every scan below reads the lossless SYQL lexer (`syql-lexer.ts`), so string
// literals, quoted identifiers, and comments are atomic tokens: their text is
// never split, rescanned, or rewritten. SQLite remains the authority on
// correctness.

/** Significant SQL tokens (no trivia) with each token's parenthesis depth,
 * its innermost enclosing `(` (or -1), and every `(` index's matching `)`. */
function sqlStructure(sql: string, file = 'query SQL') {
  const tokens = lexSyqlSqlSource(file, sql).filter(
    (token) => !isSyqlTrivia(token) && token.kind !== 'eof',
  );
  const depths: number[] = [];
  const parents: number[] = [];
  const closes = new Map<number, number>();
  const stack: number[] = [];
  tokens.forEach((token, index) => {
    if (token.text === ')') {
      const open = stack.pop();
      if (open !== undefined) closes.set(open, index);
    }
    parents[index] = stack.at(-1) ?? -1;
    depths[index] = stack.length;
    if (token.text === '(') stack.push(index);
  });
  return { tokens, depths, parents, closes };
}

function lowerWord(token: SyqlToken | undefined): string | undefined {
  return token?.kind === 'identifier' ? token.text.toLowerCase() : undefined;
}

export interface SplitStatement {
  /** The raw statement text (leading comment block + SQL), as written. */
  readonly text: string;
  /** 1-based line number of the statement's first character in the file. */
  readonly startLine: number;
}

/** Split file content into statements on top-level `;` tokens. A statement
 * keeps its leading comment block; comment-only parts are dropped. The
 * SELECT-only subset has no BEGIN/END blocks, so every `;` token ends one
 * statement and a trailing `;` is optional. */
export function splitStatements(
  content: string,
  file = 'query SQL',
): SplitStatement[] {
  const out: SplitStatement[] = [];
  let lead: SyqlToken | undefined;
  let hasSql = false;
  for (const token of lexSyqlSqlSource(file, content)) {
    if (token.kind === 'eof' || token.text === ';') {
      if (lead !== undefined && hasSql) {
        out.push({
          text: content.slice(lead.span.start.offset, token.span.start.offset),
          startLine: lead.span.start.line,
        });
      }
      lead = undefined;
      hasSql = false;
    } else if (token.kind !== 'whitespace') {
      lead ??= token;
      hasSql ||= !isSyqlTrivia(token);
    }
  }
  return out;
}

/** The `--` comments before a statement's first SQL token. `-- name:` and
 * `-- param` markers are scoped to the statement they precede. */
function leadingComments(statementText: string): string[] {
  const comments: string[] = [];
  for (const token of lexSyqlSqlSource('query SQL', statementText)) {
    if (!isSyqlTrivia(token)) break;
    if (token.kind === 'line-comment') comments.push(token.text);
  }
  return comments;
}

const NAME_MARKER_RE = /^--\s*name:\s*(\S+)\s*$/;

/** The `-- name:` override in a statement's leading comment block, or null. */
export function parseStatementName(
  statementText: string,
  location: string,
): string | null {
  let found: string | null = null;
  for (const comment of leadingComments(statementText)) {
    const m = NAME_MARKER_RE.exec(comment);
    if (m === null) continue;
    if (found !== null) {
      throw new TypegenError(
        location,
        `two \`-- name:\` markers on one statement (${JSON.stringify(found)} and ${JSON.stringify(m[1])}) — a statement is named once`,
      );
    }
    found = validateOverrideName(m[1] as string, location);
  }
  return found;
}

interface CommentParam {
  readonly name: string;
  readonly type: IrColumnType;
}

const PARAM_COMMENT_RE =
  /^--\s*param\s+:([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_]+)\s*$/;

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

/** Parse the `-- param :name <type>` markers of the leading comment block. */
function parseCommentParams(file: string, raw: string): CommentParam[] {
  const out: CommentParam[] = [];
  for (const comment of leadingComments(raw)) {
    const match = PARAM_COMMENT_RE.exec(comment);
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

const ACKNOWLEDGEMENT_RE = new RegExp(
  `^--\\s*allow\\s+(${QUERY_PLAN_FINDINGS.join('|')}|plan)\\b`,
);

/** Parse the `-- allow <finding> [table]: <reason>` acknowledgements of the
 * leading comment block (`docs/SYQL.md` §14.5). */
function parseCommentAcknowledgements(
  file: string,
  raw: string,
): QueryAcknowledgement[] {
  const out: QueryAcknowledgement[] = [];
  for (const comment of leadingComments(raw)) {
    const kind = ACKNOWLEDGEMENT_RE.exec(comment)?.[1];
    const finding = [...QUERY_PLAN_FINDINGS, 'plan' as const].find(
      (name) => name === kind,
    );
    if (finding === undefined) continue;
    const match =
      /^--\s*allow\s+\w+(?:\s+([A-Za-z_][A-Za-z0-9_]*))?\s*:\s*(\S.*?)\s*$/.exec(
        comment,
      );
    const table = match?.[1];
    if (
      match === null ||
      (finding === 'many_tables' || finding === 'plan') !==
        (table === undefined) ||
      out.some(
        (other) =>
          (other.finding === finding && other.table === table) ||
          (other.finding === 'plan') !== (finding === 'plan'),
      )
    ) {
      throw new TypegenError(
        file,
        'invalid query plan acknowledgement; write `-- allow <finding> <table>: <reason>` once per finding',
        'typegen.query_acknowledgement_invalid',
        { file, comment },
      );
    }
    out.push({
      finding,
      ...(table === undefined ? {} : { table }),
      reason: match[2] as string,
    });
  }
  return out;
}

/** Blank comments and string/blob literals with spaces (newlines kept), so
 * offset-preserving text scans never read inside them. */
export function stripCommentsAndStrings(sql: string): string {
  return lexSyqlSqlSource('query SQL', sql)
    .map((token) =>
      token.kind === 'line-comment' ||
      token.kind === 'block-comment' ||
      token.kind === 'string' ||
      token.kind === 'blob'
        ? token.text.replace(/[^\n]/g, ' ')
        : token.text,
    )
    .join('');
}

/** Distinct `:name` binds in first-occurrence order (SQLite's paramsCount
 * counts distinct names). */
function scanParamNames(sql: string): string[] {
  const names: string[] = [];
  for (const token of lexSyqlSqlSource('query SQL', sql)) {
    const name = token.text.slice(1);
    if (token.kind === 'bind' && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The emitted single-line statement: `:name` binds become positional, every
 * whitespace/comment run between tokens becomes one space, and every other
 * token (string literals, quoted identifiers) keeps its exact text.
 *
 * When every param occurs exactly once, plain `?` is emitted. When ANY
 * param repeats (the §7 neutralization guards mention a param in the guard
 * AND the predicate), the WHOLE statement uses SQLite's numbered `?N`
 * form — one bound value per DISTINCT param, reuse resolved by SQLite —
 * so the generated bind array stays one-entry-per-param. */
export function toPositionalSql(sql: string): string {
  const tokens = lexSyqlSqlSource('query SQL', sql);
  const order = scanParamNames(sql);
  const repeats =
    tokens.filter((token) => token.kind === 'bind').length > order.length;
  let out = '';
  let space = false;
  for (const token of tokens) {
    if (isSyqlTrivia(token) || token.kind === 'eof') {
      space = out.length > 0;
      continue;
    }
    if (space) out += ' ';
    space = false;
    out +=
      token.kind !== 'bind'
        ? token.text
        : repeats
          ? `?${order.indexOf(token.text.slice(1)) + 1}`
          : '?';
  }
  return out;
}

// -- FROM/JOIN table resolution ----------------------------------------------

export interface TableRef {
  readonly table: string;
  readonly start: number;
  readonly end: number;
  readonly explicitAlias?: string;
  /** Alias (or the table name when un-aliased). */
  readonly alias: string;
  /** True when an enclosing flat join chain can null-extend this relation. */
  readonly nullable: boolean;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
// `FROM tbl [AS] a`, `JOIN tbl [AS] a`. We only need the referenced base
// tables that exist in the IR; SQLite has already proven every reference.
const RESERVED_ALIAS = new Set([
  'on',
  'where',
  'group',
  'order',
  'inner',
  'left',
  'right',
  'full',
  'outer',
  'natural',
  'join',
  'cross',
  'using',
  'limit',
  'having',
  'union',
  'intersect',
  'except',
  'offset',
  'window',
  'indexed',
  'not',
]);
/** The name a plain or quoted identifier token spells. */
export function sqlIdentifier(
  token: SyqlToken | undefined,
): string | undefined {
  if (token?.kind === 'identifier') return token.text;
  if (token?.kind !== 'quoted-identifier') return undefined;
  const quote = token.text[0];
  const value = token.text.slice(1, -1);
  return quote === '[' ? value : value.split(`${quote}${quote}`).join(quote);
}

/** A common table expression read in a FROM/JOIN position. */
export interface CteRef {
  /** Lowercased CTE name. */
  readonly name: string;
  /** Alias (or the CTE name when un-aliased). */
  readonly alias: string;
  readonly start: number;
  readonly nullable: boolean;
}

/** A CTE of the top-level `WITH` whose body is one SELECT scope. */
export interface CteScope {
  /** Lowercased CTE name. */
  readonly name: string;
  /** Offsets of the body text between the CTE parentheses. */
  readonly start: number;
  readonly end: number;
  /** True for `name(a, b) AS (...)`, which renames the body columns. */
  readonly renamed: boolean;
}

export interface SqlRelations {
  readonly tables: TableRef[];
  readonly cteRefs: CteRef[];
  readonly cteScopes: CteScope[];
  readonly recursive: boolean;
  /** `main` for the outer statement, `cte:<name>` directly inside a
   * top-level CTE body, `nested` inside any other subquery. */
  readonly scopeAt: (offset: number) => string;
}

export function scanTableRefs(
  sql: string,
  ir: IrDocument,
  lowered = false,
): TableRef[] {
  return scanRelations(sql, ir, lowered).tables;
}

/** `lowered` scans emitted SQL, whose FTS mapping reads
 * ({@link lowerFtsSourceIds}) are internal and not relations of the query. */
export function scanRelations(
  sql: string,
  ir: IrDocument,
  lowered = false,
): SqlRelations {
  const { tokens, depths, parents, closes } = sqlStructure(sql);
  const known = new Map(
    ir.tables.flatMap((table) => [
      [table.name.toLowerCase(), table.name] as const,
      ...table.ftsIndexes.map(
        (index) => [index.name.toLowerCase(), index.name] as const,
      ),
    ]),
  );
  const mappings = new Set(
    lowered
      ? ir.tables.flatMap((table) =>
          table.ftsIndexes.map((index) =>
            ftsMappingTable(index.name).toLowerCase(),
          ),
        )
      : [],
  );
  const activeFromDepths = new Set<number>();
  const clauseEnders = new Set([
    'where',
    'group',
    'having',
    'order',
    'limit',
    'window',
    'union',
    'except',
    'intersect',
    'returning',
  ]);
  for (const [index, token] of tokens.entries()) {
    const depth = depths[index] ?? 0;
    const word =
      token.kind === 'identifier' ? token.text.toLowerCase() : undefined;
    if (word === 'in' && sqlIdentifier(tokens[index + 1]) !== undefined) {
      throw new TypegenError(
        'query SQL',
        'table-name IN expressions are unsupported; use an explicit SELECT subquery',
      );
    }
    if (word === 'from') activeFromDepths.add(depth);
    else if (word !== undefined && clauseEnders.has(word))
      activeFromDepths.delete(depth);
    else if (token.text === ')') activeFromDepths.delete(depth + 1);
    else if (token.text === '(' && activeFromDepths.has(depth)) {
      const previous = tokens[index - 1]?.text.toLowerCase();
      const next = tokens[index + 1];
      if (
        previous !== undefined &&
        ['from', 'join', ',', '('].includes(previous) &&
        !(
          next?.kind === 'identifier' &&
          ['select', 'with', 'values'].includes(next.text.toLowerCase())
        )
      ) {
        activeFromDepths.add(depth + 1);
      }
    } else if (token.text === ',' && activeFromDepths.has(depth)) {
      throw new TypegenError(
        'query SQL',
        'comma-separated table sources are unsupported because reactive proof requires every relation; use an explicit JOIN ... ON clause',
      );
    }
  }
  const ctes: { name: string; start: number; end: number }[] = [];
  const cteScopes: (CteScope & { open: number })[] = [];
  let recursive = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== 'identifier' || token.text.toLowerCase() !== 'with')
      continue;
    const scopeEnd = closes.get(parents[index] ?? -1) ?? tokens.length;
    let cursor = index + 1;
    if (tokens[cursor]?.text.toLowerCase() === 'recursive') {
      recursive = true;
      cursor += 1;
    }
    for (;;) {
      const name = sqlIdentifier(tokens[cursor]);
      if (name === undefined) break;
      cursor += 1;
      const renamed = tokens[cursor]?.text === '(';
      if (renamed) cursor = (closes.get(cursor) ?? scopeEnd) + 1;
      if (tokens[cursor]?.text.toLowerCase() !== 'as') break;
      cursor += 1;
      if (tokens[cursor]?.text.toLowerCase() === 'not') cursor += 1;
      if (tokens[cursor]?.text.toLowerCase() === 'materialized') cursor += 1;
      if (tokens[cursor]?.text !== '(') break;
      ctes.push({ name: name.toLowerCase(), start: index, end: scopeEnd });
      const close = tokens[closes.get(cursor) ?? -1];
      if (
        index === 0 &&
        close !== undefined &&
        tokens[cursor + 1]?.text.toLowerCase() === 'select'
      ) {
        cteScopes.push({
          name: name.toLowerCase(),
          open: cursor,
          start: (tokens[cursor] as SyqlToken).span.end.offset,
          end: close.span.start.offset,
          renamed,
        });
      }
      cursor = (closes.get(cursor) ?? scopeEnd) + 1;
      if (tokens[cursor]?.text !== ',') break;
      cursor += 1;
    }
  }
  const refs: TableRef[] = [];
  const cteRefs: CteRef[] = [];
  const relationStartByDepth = new Map<number, number>();
  const nullableGroups: { start: number; end: number }[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== 'identifier') continue;
    const operator = token.text.toLowerCase();
    if (operator !== 'from' && operator !== 'join') continue;
    let outerKind: string | undefined;
    if (operator === 'join') {
      let previous = index - 1;
      if (tokens[previous]?.text.toLowerCase() === 'outer') previous -= 1;
      if (tokens[previous]?.kind === 'identifier')
        outerKind = tokens[previous]?.text.toLowerCase();
    }
    const operatorDepth = depths[index] ?? 0;
    let cursor = index + 1;
    if (operator === 'from')
      relationStartByDepth.set(operatorDepth, refs.length);
    if (outerKind === 'right' || outerKind === 'full') {
      for (
        let prior = relationStartByDepth.get(operatorDepth) ?? refs.length;
        prior < refs.length;
        prior += 1
      ) {
        const ref = refs[prior];
        if (ref !== undefined) refs[prior] = { ...ref, nullable: true };
      }
      // Conservative: any CTE read before a RIGHT/FULL join is optional.
      cteRefs.forEach((ref, prior) => {
        cteRefs[prior] = { ...ref, nullable: true };
      });
    }
    if (
      (outerKind === 'left' || outerKind === 'full') &&
      tokens[cursor]?.text === '('
    ) {
      nullableGroups.push({
        start: cursor,
        end: closes.get(cursor) ?? tokens.length,
      });
    }
    while (tokens[cursor]?.text === '(') cursor += 1;
    const tableToken = tokens[cursor];
    if (
      tableToken?.kind === 'identifier' &&
      ['select', 'with', 'values'].includes(tableToken.text.toLowerCase())
    )
      continue;
    const rawTable = sqlIdentifier(tableToken);
    if (rawTable === undefined || tableToken === undefined) {
      throw new TypegenError('query SQL', 'cannot resolve table relation');
    }
    if (tokens[cursor + 1]?.text === '.') {
      throw new TypegenError(
        'query SQL',
        'schema-qualified relations are unsupported; use application table names',
      );
    }
    let aliasToken = tokens[cursor + 1];
    if (
      aliasToken?.kind === 'identifier' &&
      aliasToken.text.toLowerCase() === 'as'
    )
      aliasToken = tokens[cursor + 2];
    const explicitAlias =
      aliasToken?.kind === 'quoted-identifier' ||
      (aliasToken?.kind === 'identifier' &&
        !RESERVED_ALIAS.has(aliasToken.text.toLowerCase()))
        ? sqlIdentifier(aliasToken)
        : undefined;
    const nullable =
      outerKind === 'left' ||
      outerKind === 'full' ||
      nullableGroups.some(
        (group) => cursor > group.start && cursor < group.end,
      );
    if (
      ctes.some(
        (cte) =>
          cte.name === rawTable.toLowerCase() &&
          cursor > cte.start &&
          cursor < cte.end,
      )
    ) {
      cteRefs.push({
        name: rawTable.toLowerCase(),
        alias: explicitAlias ?? rawTable,
        start: tableToken.span.start.offset,
        nullable,
      });
      continue;
    }
    if (mappings.has(rawTable.toLowerCase())) continue;
    const table = known.get(rawTable.toLowerCase());
    if (table === undefined)
      throw new TypegenError(
        'query SQL',
        `unresolved table relation ${JSON.stringify(rawTable)}`,
      );
    const tableDepth = depths[cursor] ?? operatorDepth;
    if (operator === 'from' || !relationStartByDepth.has(tableDepth))
      relationStartByDepth.set(tableDepth, refs.length);
    refs.push({
      table,
      start: tableToken.span.start.offset,
      end: tableToken.span.end.offset,
      alias: explicitAlias ?? table,
      ...(explicitAlias === undefined ? {} : { explicitAlias }),
      nullable,
    });
  }
  const selectOpens = tokens.flatMap((token, index) => {
    const close = tokens[closes.get(index) ?? -1];
    const next = tokens[index + 1];
    return token.text === '(' &&
      close !== undefined &&
      next?.kind === 'identifier' &&
      ['select', 'with', 'values'].includes(next.text.toLowerCase())
      ? [
          {
            index,
            start: token.span.start.offset,
            end: close.span.start.offset,
          },
        ]
      : [];
  });
  return {
    tables: refs,
    cteRefs,
    cteScopes: cteScopes.map(({ open: _open, ...scope }) => scope),
    recursive,
    scopeAt(offset) {
      const innermost = selectOpens
        .filter((open) => open.start < offset && offset < open.end)
        .at(-1);
      if (innermost === undefined) return 'main';
      const cte = cteScopes.find((scope) => scope.open === innermost.index);
      return cte === undefined ? 'nested' : `cte:${cte.name}`;
    },
  };
}

// -- scope proofs (SYQL §13) ----------------------------------------------------

/** A declared scope column of one table instance: the instance's SELECT scope
 * ({@link SqlRelations.scopeAt}), lowercased alias, and lowercased column. */
export interface ScopeColumn {
  readonly scope: string;
  readonly alias: string;
  readonly column: string;
}

export interface ScopeProofs {
  /** `column = :bind`, `:bind = column`, `column IS :bind`, and
   * `column IN (:a, :b)` conjuncts of a WHERE clause. */
  readonly binds: readonly (ScopeColumn & {
    readonly operator: 'equal' | 'in';
    readonly params: readonly string[];
  })[];
  /** Qualified `a.x = b.y` conjuncts. A symmetric equality (a WHERE conjunct
   * or an inner-join ON conjunct) proves each operand from the other; an
   * outer-join ON conjunct proves only `target` from `source`. */
  readonly equalities: readonly {
    readonly target: ScopeColumn;
    readonly source: ScopeColumn;
    readonly symmetric: boolean;
  }[];
}

const CLAUSE_WORDS = new Set([
  'where',
  'group',
  'having',
  'order',
  'limit',
  'window',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
]);

/**
 * The scope-proof rule shared by `.sql` and `.syql` queries (SYQL §13). A
 * comparison proves a scope only when it is a whole top-level conjunct of
 * the WHERE clause of the SELECT scope that reads the instance: the outer
 * statement or a top-level CTE body. Parentheses around a whole conjunct are
 * transparent. Nothing else is a proof: a WHERE clause with a top-level OR, a
 * compound SELECT scope, a nested subquery, and any other conjunct shape (NOT,
 * a comparison of the comparison, a function, CASE, COLLATE, IS after the
 * bind, a literal in an IN list). Column equalities also come from the
 * conjuncts of an ON clause without OR, NOT, or a subquery.
 */
export function scopeProofs(sql: string, ir: IrDocument): ScopeProofs {
  const { tokens, depths, closes } = sqlStructure(sql);
  const relations = scanRelations(sql, ir);
  const binds: ScopeProofs['binds'][number][] = [];
  const equalities: ScopeProofs['equalities'][number][] = [];
  const tableOf = (ref: TableRef) =>
    ir.tables.find((table) => table.name === ref.table);
  const scopeColumn = (
    scope: string,
    qualifier: string | undefined,
    column: string,
  ): ScopeColumn | undefined => {
    const name = column.toLowerCase();
    const candidates = relations.tables.filter(
      (ref) =>
        relations.scopeAt(ref.start) === scope &&
        (qualifier === undefined
          ? tableOf(ref)?.columns.some((c) => c.name.toLowerCase() === name)
          : ref.alias.toLowerCase() === qualifier.toLowerCase()),
    );
    const ref = candidates.length === 1 ? candidates[0] : undefined;
    const declared =
      ref === undefined
        ? undefined
        : tableOf(ref)?.scopes.find((s) => s.column.toLowerCase() === name);
    return ref === undefined || declared === undefined
      ? undefined
      : { scope, alias: ref.alias.toLowerCase(), column: name };
  };
  const columnAt = (index: number) => {
    const first = sqlIdentifier(tokens[index]);
    if (first === undefined) return undefined;
    if (tokens[index + 1]?.text !== '.')
      return { qualifier: undefined, column: first, next: index + 1 };
    const column = sqlIdentifier(tokens[index + 2]);
    return column === undefined
      ? undefined
      : { qualifier: first, column, next: index + 3 };
  };
  const equal = (index: number) =>
    tokens[index]?.text === '=' || tokens[index]?.text === '==';
  const bindAt = (index: number) =>
    tokens[index]?.kind === 'bind'
      ? (tokens[index] as SyqlToken).text.slice(1)
      : undefined;
  const conjuncts = (from: number, to: number): [number, number][] => {
    const parts: [number, number][] = [];
    let start = from;
    let cases = 0;
    let between = false;
    for (let index = from; index < to; index += 1) {
      if (depths[index] !== depths[from]) continue;
      const word = lowerWord(tokens[index]);
      if (word === 'case') cases += 1;
      else if (word === 'end') cases -= 1;
      else if (cases > 0) continue;
      else if (word === 'or') return [];
      else if (word === 'between') between = true;
      else if (word === 'and' && between) between = false;
      else if (word === 'and') {
        parts.push([start, index]);
        start = index + 1;
      }
    }
    parts.push([start, to]);
    return parts.flatMap(([start, end]) =>
      tokens[start]?.text === '(' &&
      closes.get(start) === end - 1 &&
      !['select', 'with', 'values'].includes(lowerWord(tokens[start + 1]) ?? '')
        ? conjuncts(start + 1, end - 1)
        : [[start, end]],
    );
  };
  const classify = (
    scope: string,
    start: number,
    end: number,
    join?: {
      readonly kind: string | undefined;
      readonly introduced: ReadonlySet<string>;
    },
  ): void => {
    const reversed = bindAt(start);
    const left = columnAt(reversed === undefined ? start : start + 2);
    if (left === undefined) return;
    if (reversed !== undefined) {
      const subject = scopeColumn(scope, left.qualifier, left.column);
      if (
        join === undefined &&
        equal(start + 1) &&
        left.next === end &&
        subject
      )
        binds.push({ ...subject, operator: 'equal', params: [reversed] });
      return;
    }
    const operator = left.next;
    const bind = bindAt(operator + 1);
    const list = tokens.slice(operator + 2, end - 1);
    const right = columnAt(operator + 1);
    if (
      join === undefined &&
      bind !== undefined &&
      operator + 2 === end &&
      (equal(operator) || lowerWord(tokens[operator]) === 'is')
    ) {
      const subject = scopeColumn(scope, left.qualifier, left.column);
      if (subject)
        binds.push({ ...subject, operator: 'equal', params: [bind] });
    } else if (
      join === undefined &&
      lowerWord(tokens[operator]) === 'in' &&
      closes.get(operator + 1) === end - 1 &&
      list.length % 2 === 1 &&
      list.every((token, index) =>
        index % 2 === 0 ? token.kind === 'bind' : token.text === ',',
      )
    ) {
      const subject = scopeColumn(scope, left.qualifier, left.column);
      const params = list.flatMap((token) =>
        token.kind === 'bind' ? [token.text.slice(1)] : [],
      );
      if (subject) binds.push({ ...subject, operator: 'in', params });
    } else if (
      equal(operator) &&
      right?.next === end &&
      left.qualifier !== undefined &&
      right.qualifier !== undefined
    ) {
      const l = scopeColumn(scope, left.qualifier, left.column);
      const r = scopeColumn(scope, right.qualifier, right.column);
      if (l === undefined || r === undefined) return;
      if (join?.kind !== 'left' && join?.kind !== 'right') {
        equalities.push({ target: l, source: r, symmetric: true });
        return;
      }
      // An outer join's ON constrains matched rows of its null-extended side
      // only; an equality with both operands on one side proves nothing.
      if (join.introduced.has(l.alias) === join.introduced.has(r.alias)) return;
      const [introduced, prior] = join.introduced.has(l.alias)
        ? [l, r]
        : [r, l];
      equalities.push(
        join.kind === 'left'
          ? { target: introduced, source: prior, symmetric: false }
          : { target: prior, source: introduced, symmetric: false },
      );
    }
  };
  const ranges = [
    { scope: 'main', from: 0, to: tokens.length },
    ...relations.cteScopes.map((cte) => ({
      scope: `cte:${cte.name}`,
      from: tokens.findIndex((token) => token.span.start.offset >= cte.start),
      to: tokens.findIndex((token) => token.span.start.offset >= cte.end),
    })),
  ];
  for (const range of ranges) {
    const own: number[] = [];
    for (let index = range.from; index < range.to; index += 1) {
      if (depths[index] === depths[range.from]) own.push(index);
    }
    const words = own.map((index) => lowerWord(tokens[index]) ?? '');
    if (words.some((w) => w === 'union' || w === 'intersect' || w === 'except'))
      continue;
    own.forEach((at, position) => {
      const word = words[position];
      if (word !== 'where' && word !== 'on') return;
      let next = position + 1;
      while (next < words.length && !CLAUSE_WORDS.has(words[next] as string))
        next += 1;
      const to = own[next] ?? range.to;
      if (word === 'where') {
        for (const [start, end] of conjuncts(at + 1, to))
          classify(range.scope, start, end);
        return;
      }
      if (
        tokens
          .slice(at + 1, to)
          .some((token) =>
            ['or', 'not', 'select', 'with'].includes(lowerWord(token) ?? ''),
          )
      )
        return;
      const join = words.lastIndexOf('join', position);
      if (join < 0) return;
      const kind =
        words[join - 1] === 'outer' ? words[join - 2] : words[join - 1];
      if (kind === 'full') return;
      // The relations between JOIN and ON, a parenthesized group included.
      const introduced = new Set(
        relations.tables
          .filter(
            (ref) =>
              ref.start >
                (tokens[own[join] as number] as SyqlToken).span.start.offset &&
              ref.start < (tokens[at] as SyqlToken).span.start.offset,
          )
          .map((ref) => ref.alias.toLowerCase()),
      );
      for (const [start, end] of conjuncts(at + 1, to))
        classify(range.scope, start, end, { kind, introduced });
    });
  }
  return { binds, equalities };
}

// -- SELECT column → source resolution ---------------------------------------
//
// For each result column bun gives us (name + decltype), we resolve its origin
// IR column so we can attach exact NULLABILITY (decltype carries type but not
// NOT NULL). We parse the SELECT list into items and, per item, try to find a
// plain column ref (`col`, `alias.col`) that names an IR column of one of the
// FROM/JOIN tables. When found, that IR column is the source (exact fidelity);
// otherwise it is a computed expression (fallback fidelity).

export interface SelectItem {
  /** The raw expression text (before any `AS alias`). */
  readonly expr: string;
  /** The explicit `AS alias`, if any. */
  readonly alias: string | undefined;
}

/** Split the outermost SELECT list of `sql` into items. Returns null when the
 * statement has no outer `SELECT … FROM` or projects `*` / `t.*`. */
export function splitSelectList(sql: string): SelectItem[] | null {
  const projection = findProjection(stripCommentsAndStrings(sql));
  if (projection === null) return null;
  const items: SelectItem[] = [];
  for (const { text } of projection.items) {
    const raw = text.replace(/\s+/g, ' ');
    if (raw === '*' || /\.\s*\*$/.test(raw)) return null;
    // `expr AS alias` or `expr alias` (trailing bare identifier). Only treat
    // a trailing word as an alias when the expr has more than that word.
    // Projection lowering emits the alias double-quoted, so accept both.
    const asMatch =
      /^(.*?)\s+AS\s+(?:"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_]*))$/i.exec(raw);
    if (asMatch !== null) {
      items.push({
        expr: (asMatch[1] as string).trim(),
        alias: (asMatch[2] ?? (asMatch[3] as string)).replaceAll('""', '"'),
      });
    } else {
      items.push({ expr: raw, alias: undefined });
    }
  }
  return items;
}

export const PLAIN_REF_RE = new RegExp(`^(?:(${IDENT})\\.)?(${IDENT})$`);

interface ResolvedSource {
  readonly table: string;
  readonly column: IrTable['columns'][number];
  readonly nullableByJoin: boolean;
}

function declaredFtsProjection(ir: IrDocument, tableName: string): boolean {
  return ir.tables.some((table) =>
    table.ftsIndexes.some((index) => index.name === tableName),
  );
}

const FTS_SOURCE_ID_IR_COLUMN: IrTable['columns'][number] = {
  name: FTS_SOURCE_ID_COLUMN,
  type: 'string',
  nullable: false,
};

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
    const ref = refs.find(
      (candidate) => candidate.alias.toLowerCase() === qualifier.toLowerCase(),
    );
    if (ref === undefined) return null;
    const table = byName.get(ref.table);
    const col = table?.columns.find(
      (candidate) => candidate.name.toLowerCase() === columnName.toLowerCase(),
    );
    if (col !== undefined) {
      return {
        table: ref.table,
        column: col,
        nullableByJoin: ref.nullable,
      };
    }
    if (
      columnName === FTS_SOURCE_ID_COLUMN &&
      declaredFtsProjection(ir, ref.table)
    ) {
      return {
        table: ref.table,
        column: FTS_SOURCE_ID_IR_COLUMN,
        nullableByJoin: ref.nullable,
      };
    }
    return null;
  }
  // Unqualified: search every FROM/JOIN table (SQLite already resolved
  // ambiguity; a single-table query is the common case). A USING/NATURAL
  // coalesced name can have more than one physical origin, so keep it on the
  // honest nullable fallback path instead of guessing one side.
  const matches: ResolvedSource[] = [];
  for (const ref of refs) {
    const table = byName.get(ref.table);
    const col = table?.columns.find(
      (candidate) => candidate.name.toLowerCase() === columnName.toLowerCase(),
    );
    if (col !== undefined) {
      matches.push({
        table: ref.table,
        column: col,
        nullableByJoin: ref.nullable,
      });
    }
    if (
      columnName === FTS_SOURCE_ID_COLUMN &&
      declaredFtsProjection(ir, ref.table)
    ) {
      matches.push({
        table: ref.table,
        column: FTS_SOURCE_ID_IR_COLUMN,
        nullableByJoin: ref.nullable,
      });
    }
  }
  return matches.length === 1 ? (matches[0] as ResolvedSource) : null;
}

/** Resolve the one supported query-only protocol column. SQLite still proves
 * qualifier/ambiguity against the synthesized local tables. */
function syncVersionSourceNullability(
  item: SelectItem,
  refs: readonly TableRef[],
): boolean | null {
  const match = PLAIN_REF_RE.exec(item.expr);
  if (match === null || match[2] !== SYNC_VERSION_COLUMN) return null;
  const qualifier = match[1];
  if (qualifier === undefined) {
    return refs.length === 1 ? (refs[0]?.nullable ?? null) : null;
  }
  const matches = refs.filter(
    (ref) => ref.alias.toLowerCase() === qualifier.toLowerCase(),
  );
  return matches.length === 1 ? (matches[0]?.nullable ?? null) : null;
}

// -- param type inference -----------------------------------------------------
//
// Infer a param's type from `col <op> :name` or `col IN (:name, …)` where `col`
// is a plain ref to an IR column. Equality/comparison/IN only — anything else
// needs the `-- param` comment (kept deliberately simple and honest).

function applicationColumnType(column: IrColumn): IrColumnType {
  return column.encrypted === true && column.declaredType !== undefined
    ? column.declaredType
    : column.type;
}

/**
 * Every column/LIKE/MATCH type constraint on one bind, in pattern order. A
 * `.sql` query takes the first; SYQL rejects conflicting evidence.
 */
export function inferParamTypeEvidence(
  paramName: string,
  sql: string,
  refs: readonly TableRef[],
  ir: IrDocument,
): readonly IrColumnType[] {
  const cleaned = stripCommentsAndStrings(sql);
  const byName = new Map(
    ir.tables.map((table) => [table.name, table] as const),
  );
  const evidence: IrColumnType[] = [];
  const add = (qualifier: string | undefined, column: string): void => {
    if (qualifier !== undefined) {
      const ref = refs.find((candidate) => candidate.alias === qualifier);
      const table = ref === undefined ? undefined : byName.get(ref.table);
      const item = table?.columns.find(
        (candidate) => candidate.name === column,
      );
      const type = item === undefined ? undefined : applicationColumnType(item);
      if (type !== undefined) evidence.push(type);
      return;
    }
    // An unqualified name read by several relations is evidence only when
    // every candidate column has the same type.
    const matches = new Set(
      refs.flatMap((ref) => {
        const item = byName
          .get(ref.table)
          ?.columns.find((candidate) => candidate.name === column);
        return item === undefined ? [] : [applicationColumnType(item)];
      }),
    );
    if (matches.size === 1) evidence.push(...matches);
  };

  const comparison = new RegExp(
    `(?:(${IDENT})\\.)?(${IDENT})\\s*(?:=|==|!=|<>|<=|>=|<|>|\\bLIKE\\b|\\bIS\\b)\\s*:${paramName}\\b`,
    'gi',
  );
  for (const match of cleaned.matchAll(comparison)) {
    add(match[1], match[2] as string);
  }
  const reversed = new RegExp(
    `:${paramName}\\b\\s*(?:=|==|!=|<>|<=|>=|<|>)\\s*(?:(${IDENT})\\.)?(${IDENT})`,
    'gi',
  );
  for (const match of cleaned.matchAll(reversed)) {
    add(match[1], match[2] as string);
  }
  const inList = new RegExp(
    `(?:(${IDENT})\\.)?(${IDENT})\\s+IN\\s*\\(([^)]*:${paramName}\\b[^)]*)\\)`,
    'gi',
  );
  for (const match of cleaned.matchAll(inList)) {
    add(match[1], match[2] as string);
  }
  const betweenLeft = new RegExp(
    `(?:(${IDENT})\\.)?(${IDENT})\\s+BETWEEN\\s+:${paramName}\\b`,
    'gi',
  );
  for (const match of cleaned.matchAll(betweenLeft)) {
    add(match[1], match[2] as string);
  }
  const betweenRight = new RegExp(
    `(?:(${IDENT})\\.)?(${IDENT})\\s+BETWEEN\\s+\\S+\\s+AND\\s+:${paramName}\\b`,
    'gi',
  );
  for (const match of cleaned.matchAll(betweenRight)) {
    add(match[1], match[2] as string);
  }
  const like = new RegExp(`\\bLIKE\\b[^()]*:${paramName}\\b`, 'gi');
  if (like.test(cleaned)) evidence.push('string');
  const match = new RegExp(`\\bMATCH\\b\\s*:${paramName}\\b`, 'gi');
  if (match.test(cleaned)) evidence.push('string');
  return evidence;
}

// -- fallback column typing (computed expressions) ----------------------------

export const AGGREGATE_FUNCTIONS = new Set([
  'avg',
  'count',
  'group_concat',
  'max',
  'min',
  'sum',
  'total',
]);

/** True when `expr` calls an aggregate outside a subquery. `min`/`max` with
 * several arguments are scalar functions, and an OVER clause makes a window
 * function, which aggregates no rows. */
function callsAggregate(expr: string): boolean {
  const { tokens, depths, parents, closes } = sqlStructure(expr);
  return tokens.some((token, index) => {
    const name = lowerWord(token) ?? '';
    const close = closes.get(index + 1);
    if (!AGGREGATE_FUNCTIONS.has(name) || close === undefined) return false;
    for (let open = parents[index] ?? -1; open >= 0; open = parents[open] ?? -1)
      if (lowerWord(tokens[open + 1]) === 'select') return false;
    let after = close + 1;
    if (lowerWord(tokens[after]) === 'filter')
      after = (closes.get(after + 1) ?? after) + 1;
    const scalar =
      (name === 'min' || name === 'max') &&
      tokens
        .slice(index + 2, close)
        .some(
          (arg, at) =>
            arg.text === ',' && depths[index + 2 + at] === depths[index + 2],
        );
    return !scalar && lowerWord(tokens[after]) !== 'over';
  });
}

function inferReactiveMetadata(
  sql: string,
  relations: SqlRelations,
  ir: IrDocument,
  columns: readonly QueryColumn[],
): QueryReactiveMetadata {
  const refs = relations.tables;
  const proofs = scopeProofs(sql, ir).binds;
  const dependencies: Array<{
    table: string;
    scopes: QueryScopeBinding[];
  }> = [];
  const coverage: QueryCoverageBinding[] = [];
  const ftsOwner = new Map(
    ir.tables.flatMap((table) =>
      table.ftsIndexes.map((index) => [index.name, table.name] as const),
    ),
  );

  for (const tableName of [
    ...new Set(refs.map((ref) => ftsOwner.get(ref.table) ?? ref.table)),
  ].sort()) {
    const table = ir.tables.find((candidate) => candidate.name === tableName);
    const tableRefs = refs.filter((ref) => ref.table === tableName);
    const ref = tableRefs.length === 1 ? tableRefs[0] : undefined;
    const scopes: QueryScopeBinding[] = [];
    if (table !== undefined && ref !== undefined) {
      for (const scope of table.scopes) {
        const params = [
          ...new Set(
            proofs
              .filter(
                (proof) =>
                  proof.scope === relations.scopeAt(ref.start) &&
                  proof.alias === ref.alias.toLowerCase() &&
                  proof.column === scope.column.toLowerCase(),
              )
              .flatMap((proof) => proof.params),
          ),
        ];
        if (params.length > 0) {
          scopes.push({
            table: tableName,
            variable: scope.variable,
            pattern: scope.pattern,
            params,
          });
        }
      }
      if (table.scopes.length > 0 && scopes.length === table.scopes.length) {
        const variable = scopes[0] as QueryScopeBinding;
        coverage.push({
          table: tableName,
          variable: variable.variable,
          units: variable.params,
          fixedScopes: scopes.slice(1).map((scope) => ({
            variable: scope.variable,
            params: scope.params,
          })),
        });
      }
    }
    dependencies.push({ table: tableName, scopes });
  }

  let rowKey: readonly string[] | undefined;
  const simpleSingleTable =
    refs.length === 1 &&
    !/\b(?:DISTINCT|GROUP\s+BY|UNION|EXCEPT|INTERSECT)\b/i.test(
      stripCommentsAndStrings(sql),
    );
  if (simpleSingleTable) {
    const table = ir.tables.find(
      (candidate) => candidate.name === refs[0]?.table,
    );
    const primary = columns.find(
      (column) =>
        table !== undefined &&
        column.origin?.table === table.name &&
        column.origin?.column === table.primaryKey,
    );
    if (primary !== undefined) rowKey = [primary.langName];
  }
  return {
    dependencies,
    coverage,
    ...(rowKey !== undefined ? { rowKey } : {}),
  };
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
  /** The `EXPLAIN QUERY PLAN` rows of `sql`. With `index`, a `CREATE INDEX`
   * statement, SQLite plans as if that index existed; the database keeps no
   * trace of it afterwards. */
  plan(
    sql: string,
    index?: string,
  ): readonly { id: number; parent: number; detail: string }[];
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
    // The materialized local client table always carries this hidden protocol
    // token. It is absent from IR mutation types but may be explicitly aliased
    // by a named read query for optimistic concurrency.
    cols.push(`  ${SYNC_VERSION_COLUMN} INTEGER NOT NULL DEFAULT -1`);
    lines.push(`CREATE TABLE ${table.name} (\n${cols.join(',\n')}\n);`);
    // Create the declared indexes too — harmless for prepare()/decltype, and
    // keeps the type-check DB's shape honest with what the client materializes.
    for (const index of table.indexes) {
      const unique = index.unique ? 'UNIQUE ' : '';
      lines.push(
        `CREATE ${unique}INDEX ${index.name} ON ${table.name} (${index.columns.join(', ')});`,
      );
    }
    for (const index of table.ftsIndexes) {
      const tokenize = index.tokenize.replaceAll("'", "''");
      lines.push(
        `CREATE VIRTUAL TABLE ${index.name} USING fts5(${FTS_SOURCE_ID_COLUMN} UNINDEXED, ${index.columns.join(', ')}, tokenize='${tokenize}');`,
        `CREATE TABLE ${ftsMappingTable(index.name)} (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL UNIQUE);`,
      );
    }
  }
  return lines.join('\n');
}

/** SPEC client-local FTS5 projections: the source-id mapping table whose `id`
 * equals the projection rowid. */
export function ftsMappingTable(index: string): string {
  return `_syncular_fts_${index}`;
}

const FTS_LOWERING_STOPS = new Set([
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'where',
  'group',
  'having',
  'order',
  'limit',
  'window',
  'union',
  'except',
  'intersect',
]);
const SELECT_LIST_BOUNDARIES = new Set([
  'select',
  'from',
  'where',
  'group',
  'having',
  'order',
  'limit',
  'on',
  'join',
  'window',
  'values',
]);

/**
 * SYQL §15 FTS source-id lowering. Reading an FTS projection's
 * `_syncular_source_id` makes FTS5 fetch the content row of every hit. Each
 * FTS relation introduced by `FROM` or an inner `JOIN` gains a join to its
 * mapping table on the projection rowid, and every reference that SQLite binds
 * to that relation reads the mapping's `source_id` instead. The mapping
 * columns carry `__syql_fts_` names, so no authored unqualified name changes
 * its binding. A bare projected reference keeps its result name through an
 * explicit alias. References this pass cannot bind with certainty keep
 * reading the projection; both read the same value.
 */
export function lowerFtsSourceIds(sql: string, ir: IrDocument): string {
  const ftsNames = new Set(
    ir.tables.flatMap((table) => table.ftsIndexes.map((index) => index.name)),
  );
  const relations = scanRelations(sql, ir);
  if (!relations.tables.some((ref) => ftsNames.has(ref.table))) return sql;
  const { tokens, depths, closes } = sqlStructure(sql);
  const lower = (index: number) => lowerWord(tokens[index]);
  // Every SELECT scope as an offset range; the outer statement spans all.
  const scopes = [
    { start: -1, end: sql.length + 1 },
    ...tokens.flatMap((token, index) => {
      const close = tokens[closes.get(index) ?? -1];
      const next = lower(index + 1);
      return token.text === '(' &&
        close !== undefined &&
        (next === 'select' || next === 'with' || next === 'values')
        ? [{ start: token.span.start.offset, end: close.span.start.offset }]
        : [];
    }),
  ];
  const scopeAt = (offset: number) =>
    scopes
      .filter((scope) => scope.start < offset && offset < scope.end)
      .reduce((inner, scope) =>
        scope.end - scope.start < inner.end - inner.start ? scope : inner,
      );
  const tokenAt = (offset: number) =>
    tokens.findIndex((token) => token.span.start.offset === offset);
  const bindings = [
    ...relations.tables.map((ref) => ({ alias: ref.alias, start: ref.start })),
    ...relations.cteRefs.map((ref) => ({ alias: ref.alias, start: ref.start })),
  ].map((relation) => ({ ...relation, scope: scopeAt(relation.start) }));

  const edits: { start: number; end: number; text: string }[] = [];
  const lowered = new Map<number, string>();
  for (const ref of relations.tables) {
    if (!ftsNames.has(ref.table) || ref.nullable) continue;
    const at = tokenAt(ref.start);
    const operator = lower(at - 1);
    if (operator !== 'from' && operator !== 'join') continue;
    let after = at + 1;
    if (lower(after) === 'as') after += 1;
    if (ref.explicitAlias !== undefined) after += 1;
    const depth = depths[at] ?? 0;
    let insertAt = (tokens[after - 1] as SyqlToken).span.end.offset;
    if (lower(after) === 'on') {
      let cursor = after + 1;
      while (
        cursor < tokens.length &&
        (depths[cursor] ?? 0) >= depth &&
        !(
          depths[cursor] === depth &&
          (tokens[cursor]?.text === ',' ||
            FTS_LOWERING_STOPS.has(lower(cursor) ?? ''))
        )
      )
        cursor += 1;
      insertAt = (tokens[cursor - 1] as SyqlToken).span.end.offset;
    } else if (lower(after) === 'using') {
      const close = tokens[closes.get(after + 1) ?? -1];
      if (close === undefined) continue;
      insertAt = close.span.end.offset;
    }
    const n = lowered.size + 1;
    const mapping = `__syql_fts_${n}`;
    lowered.set(ref.start, `${mapping}.__syql_fts_source_${n}`);
    edits.push({
      start: insertAt,
      end: insertAt,
      text: ` JOIN (SELECT id AS __syql_fts_rowid_${n}, source_id AS __syql_fts_source_${n} FROM ${ftsMappingTable(ref.table)}) AS ${mapping} ON ${mapping}.__syql_fts_rowid_${n} = ${(tokens[ref.explicitAlias === undefined ? at : after - 1] as SyqlToken).text}.rowid`,
    });
  }
  if (lowered.size === 0) return sql;

  // An authored `AS _syncular_source_id` alias could capture an unqualified
  // ORDER BY reference; leave unqualified references alone then.
  const aliased = tokens.some(
    (token, index) =>
      lower(index - 1) === 'as' &&
      sqlIdentifier(token)?.toLowerCase() === FTS_SOURCE_ID_COLUMN,
  );
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as SyqlToken;
    if (
      sqlIdentifier(token)?.toLowerCase() !== FTS_SOURCE_ID_COLUMN ||
      lower(index - 1) === 'as' ||
      tokens[index + 1]?.text === '.' ||
      tokens[index + 1]?.text === '('
    )
      continue;
    const qualified = tokens[index - 1]?.text === '.';
    const first = qualified ? index - 2 : index;
    const firstToken = tokens[first] as SyqlToken;
    const scope = scopeAt(token.span.start.offset);
    let target: string | undefined;
    if (qualified) {
      const qualifier = sqlIdentifier(firstToken)?.toLowerCase();
      const bound = bindings
        .filter(
          (relation) =>
            relation.alias.toLowerCase() === qualifier &&
            relation.scope.start < token.span.start.offset &&
            token.span.start.offset < relation.scope.end,
        )
        .reduce<(typeof bindings)[number] | undefined>(
          (inner, relation) =>
            inner === undefined ||
            relation.scope.end - relation.scope.start <
              inner.scope.end - inner.scope.start
              ? relation
              : inner,
          undefined,
        );
      target = bound === undefined ? undefined : lowered.get(bound.start);
    } else if (!aliased) {
      const own = bindings.filter((relation) => relation.scope === scope);
      target = own.length === 1 ? lowered.get(own[0]?.start ?? -1) : undefined;
    }
    if (target === undefined) continue;
    // A bare select-list item keeps its result name.
    let boundary = first - 1;
    while (
      boundary >= 0 &&
      !(
        depths[boundary] === depths[first] &&
        SELECT_LIST_BOUNDARIES.has(lower(boundary) ?? '')
      ) &&
      (depths[boundary] ?? 0) >= (depths[first] ?? 0)
    )
      boundary -= 1;
    const previous = tokens[first - 1]?.text.toLowerCase();
    const next = tokens[index + 1]?.text.toLowerCase();
    const bare =
      lower(boundary) === 'select' &&
      (previous === ',' ||
        previous === 'select' ||
        previous === 'distinct' ||
        previous === 'all') &&
      (next === ',' || next === 'from');
    edits.push({
      start: firstToken.span.start.offset,
      end: token.span.end.offset,
      text: bare ? `${target} AS ${token.text}` : target,
    });
  }
  return edits
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce(
      (text, edit) =>
        text.slice(0, edit.start) + edit.text + text.slice(edit.end),
      sql,
    );
}

/**
 * Analyze ONE already-split statement against the IR + a prepared-DDL DB. The
 * name is pre-resolved (path-derived or a `-- name:` override) by the caller;
 * `statementText` is a single statement's leading comment block + SQL (no
 * top-level `;`). This is the per-statement core; {@link analyzeQueryFile}
 * splits a file and drives it.
 */
export function analyzeStatement(
  name: string,
  location: string,
  statementText: string,
  ir: IrDocument,
  db: QueryDb,
  naming: QueryNamingOptions = DEFAULT_NAMING,
): AnalyzedQuery {
  const file = location;
  const commentParams = parseCommentParams(file, statementText);
  const acknowledgements = parseCommentAcknowledgements(file, statementText);
  const sourceSql = statementText.trim();
  if (sourceSql.length === 0) {
    throw new TypegenError(file, 'query file is empty');
  }
  // SELECT-only (the read tier). A `WITH` is allowed when its main statement
  // is a SELECT (SQLite also allows WITH … INSERT/UPDATE/DELETE — writes).
  // CTE bodies sit inside parentheses and a bare keyword cannot name a CTE,
  // so the first depth-0 verb after `WITH` is the main verb.
  const statement = sqlStructure(statementText, file);
  const firstKeyword = lowerWord(statement.tokens[0]);
  if (firstKeyword === 'with') {
    const main = statement.tokens.find(
      (token, index) =>
        statement.depths[index] === 0 &&
        ['select', 'values', 'insert', 'update', 'delete', 'replace'].includes(
          lowerWord(token) ?? '',
        ),
    );
    if (lowerWord(main) !== 'select') {
      throw new TypegenError(
        file,
        `named queries are SELECT-only (the read tier); this WITH statement's main verb is ${JSON.stringify(main?.text.toUpperCase() ?? '')}. Writes go through mutate() (SPEC §7.1).`,
      );
    }
  } else if (firstKeyword !== 'select') {
    throw new TypegenError(
      file,
      `named queries are SELECT-only (the read tier); found ${JSON.stringify(statement.tokens[0]?.text ?? '')}. Writes go through mutate() (SPEC §7.1).`,
    );
  }

  // Let SQLite validate + describe the AUTHORED query first. Any bad
  // reference throws here with SQLite's own message.
  const analyze = (candidate: string): ReturnType<QueryDb['analyze']> => {
    try {
      return db.analyze(candidate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TypegenError(file, `SQL rejected by SQLite: ${message}`);
    }
  };
  let described = analyze(sourceSql);

  const refs = scanTableRefs(sourceSql, ir);
  const ftsOwner = new Map(
    ir.tables.flatMap((table) =>
      table.ftsIndexes.map((index) => [index.name, table.name] as const),
    ),
  );
  const tableSet = new Set(
    refs.map((ref) => ftsOwner.get(ref.table) ?? ref.table),
  );
  const tables = [...tableSet].sort();
  if (tables.length === 0) {
    throw new TypegenError(
      file,
      'query reads no synced table — every named query must read at least one IR table (for exact invalidation)',
    );
  }

  // §5 lowering: rewrite the projection so runtime result keys are the
  // language-facing names ("camel"); a no-op pass-through under "preserve".
  let sql = sourceSql;
  let sqlNames: readonly string[] = described.columnNames;
  let langNames: readonly string[] = described.columnNames;
  if (naming.naming === 'camel') {
    const lowered = lowerProjection(
      sourceSql,
      refs,
      ir,
      file,
      (candidate) => analyze(candidate).columnNames,
      (names) =>
        buildNamingMap(names, 'camel', file, 'projection', naming.targets).map(
          (m) => m.langName,
        ),
    );
    sqlNames = lowered.sqlNames;
    langNames = lowered.langNames;
    if (lowered.changed) {
      sql = lowered.sql;
      described = analyze(sql);
      // Defensive: the rewritten projection's runtime keys must BE the
      // language names — this is the whole point of the lowering.
      if (
        described.columnNames.length !== langNames.length ||
        described.columnNames.some((n, i) => n !== langNames[i])
      ) {
        throw new TypegenError(
          file,
          `internal: lowered projection keys [${described.columnNames.join(', ')}] do not match the naming map [${langNames.join(', ')}]`,
        );
      }
    }
  }

  // Columns: pair bun's column names + decltypes with our source resolution
  // (against the LOWERED sql — aliased plain refs still resolve exactly).
  // Each item resolves against the relations of its own SELECT scope; a
  // qualified reference to a top-level CTE resolves through the CTE body.
  const scoped = scanRelations(sql, ir);
  const resolveInScope = (
    item: SelectItem,
    scope: string,
  ): ResolvedSource | null => {
    const direct = resolveSource(
      item,
      scoped.tables.filter((ref) => scoped.scopeAt(ref.start) === scope),
      ir,
    );
    const plain = PLAIN_REF_RE.exec(item.expr);
    if (direct !== null || plain?.[1] === undefined) return direct;
    const cteRef = scoped.cteRefs.find(
      (ref) =>
        scoped.scopeAt(ref.start) === scope &&
        ref.alias.toLowerCase() === plain[1]?.toLowerCase(),
    );
    const body = scoped.cteScopes.find((cte) => cte.name === cteRef?.name);
    if (cteRef === undefined || body === undefined || body.renamed) return null;
    const bodyItem = splitSelectList(sql.slice(body.start, body.end))?.find(
      (candidate) =>
        (
          candidate.alias ?? PLAIN_REF_RE.exec(candidate.expr)?.[2]
        )?.toLowerCase() === plain[2]?.toLowerCase(),
    );
    const source =
      bodyItem === undefined
        ? null
        : resolveInScope(bodyItem, `cte:${body.name}`);
    return source === null
      ? null
      : { ...source, nullableByJoin: source.nullableByJoin || cteRef.nullable };
  };
  const items = splitSelectList(sql);
  // A bare column of a SELECT that aggregates without GROUP BY reads NULL
  // when no row matches, and a compound SELECT returns the rows of every
  // branch, so a column is nullable when any branch can yield NULL there.
  const outer = sqlStructure(sql);
  const cuts = outer.tokens.flatMap((token, index) =>
    outer.depths[index] === 0 &&
    ['union', 'intersect', 'except'].includes(lowerWord(token) ?? '')
      ? [token.span]
      : [],
  );
  const branches = [0, ...cuts.map((span) => span.end.offset)].map(
    (start, index) => {
      const end = cuts[index]?.start.offset ?? sql.length;
      const branchItems = splitSelectList(sql.slice(start, end));
      const grouped = outer.tokens.some(
        (token, at) =>
          outer.depths[at] === 0 &&
          token.span.start.offset >= start &&
          token.span.start.offset < end &&
          lowerWord(token) === 'group',
      );
      const aggregated =
        !grouped &&
        (branchItems?.some((item) => callsAggregate(item.expr)) ?? false);
      return { start, end, items: branchItems, aggregated };
    },
  );
  const branchNullable = (index: number): boolean =>
    branches.some((branch, position) => {
      if (branch.aggregated) return true;
      if (position === 0) return false;
      const item = branch.items?.[index];
      const source =
        item === undefined
          ? null
          : resolveSource(
              item,
              scoped.tables.filter(
                (ref) =>
                  scoped.scopeAt(ref.start) === 'main' &&
                  ref.start >= branch.start &&
                  ref.start < branch.end,
              ),
              ir,
            );
      return source === null || source.column.nullable || source.nullableByJoin;
    });
  const columns: QueryColumn[] = described.columnNames.map((colName, index) => {
    const decl = described.declaredTypes[index];
    const item = items?.[index];
    const source = item !== undefined ? resolveInScope(item, 'main') : null;
    const sqlName = sqlNames[index] ?? colName;
    const langName = langNames[index] ?? colName;
    const syncVersionNullable =
      item !== undefined ? syncVersionSourceNullability(item, refs) : null;
    if (syncVersionNullable !== null) {
      if (sqlName === SYNC_VERSION_COLUMN) {
        throw new TypegenError(
          file,
          `${SYNC_VERSION_COLUMN} is stripped from app-facing query rows unless explicitly aliased (for example \`${SYNC_VERSION_COLUMN} AS server_version\`)`,
        );
      }
      return {
        name: sqlName,
        langName,
        type: 'integer',
        nullable: syncVersionNullable || branchNullable(index),
        fidelity: 'exact',
      };
    }
    if (source !== null) {
      // Exact: app-facing queries read the decrypted local mirror. Encrypted
      // columns therefore expose their pre-wire declaredType, while the schema
      // IR and mutation codec continue to carry the bytes wire type.
      return {
        name: sqlName,
        langName,
        type: applicationColumnType(source.column),
        nullable:
          source.column.nullable ||
          source.nullableByJoin ||
          branchNullable(index),
        fidelity: 'exact',
        origin: { table: source.table, column: source.column.name },
      };
    }
    // Computed column (SYQL §14.1): the type is the decltype SQLite reports,
    // else the target of a whole-expression CAST, else integer for a
    // whole-expression count(); anything else is refused.
    const { tokens, depths, closes } = sqlStructure(item?.expr ?? '');
    const whole =
      tokens[1]?.text === '(' && closes.get(1) === tokens.length - 1
        ? lowerWord(tokens[0])
        : undefined;
    const asAt = tokens.findLastIndex(
      (token, at) => depths[at] === 1 && lowerWord(token) === 'as',
    );
    const castType = tokens
      .flatMap((token, at) =>
        at > asAt && depths[at] === 1 && token.kind === 'identifier'
          ? [token.text.toUpperCase()]
          : [],
      )
      .join(' ');
    const type =
      (decl !== null && decl !== undefined
        ? DECLTYPE_MAP[decl.toUpperCase()]
        : undefined) ??
      // SQLite gives the other mapped names NUMERIC or BLOB affinity, which
      // can change the value's storage class.
      (whole === 'cast' &&
      asAt > 0 &&
      /^(INTEGER|INT|BIGINT|SMALLINT|TEXT|REAL|FLOAT|DOUBLE|BLOB|BOOLEAN|BOOL)$/.test(
        castType,
      )
        ? DECLTYPE_MAP[castType]
        : undefined) ??
      (whole === 'count' ? 'integer' : undefined);
    if (type === undefined) {
      throw new TypegenError(
        file,
        'computed result column has no declared type; wrap the expression in CAST(... AS <type>)',
        'typegen.computed_column_type',
        { query: name, column: sqlName },
      );
    }
    return {
      name: sqlName,
      langName,
      type,
      nullable: true,
      fidelity: 'fallback',
    };
  });

  // Params: names from the text (positional order), types from inference or
  // the `-- param` comment; every param must resolve. Param langNames go
  // through the same §12 map (authored camelCase params are identity).
  const paramNames = scanParamNames(sql);
  if (paramNames.length !== described.paramsCount) {
    // Defensive: our scan and SQLite disagree (shouldn't happen for the subset).
    throw new TypegenError(
      file,
      `internal: scanned ${paramNames.length} params (${paramNames.join(', ')}) but SQLite reports ${described.paramsCount}`,
    );
  }
  const internalParams = new Set(naming.internalParams ?? []);
  const publicParamLangNames = buildNamingMap(
    paramNames.filter((name) => !internalParams.has(name)),
    naming.naming,
    file,
    'params',
    naming.targets,
  );
  const langNameByParam = new Map(
    publicParamLangNames.map((mapping) => [mapping.sqlName, mapping.langName]),
  );
  const commentByName = new Map(commentParams.map((p) => [p.name, p.type]));
  const params: QueryParam[] = paramNames.map((paramName) => {
    const langName = langNameByParam.get(paramName) ?? paramName;
    const commented = commentByName.get(paramName);
    if (commented !== undefined) {
      return { name: paramName, langName, type: commented, source: 'comment' };
    }
    const inferred = inferParamTypeEvidence(paramName, sql, refs, ir)[0];
    if (inferred !== undefined) {
      return { name: paramName, langName, type: inferred, source: 'inferred' };
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

  validateQueryIdentifier(name, naming.targets, file, 'query name');
  for (const column of columns) {
    validateQueryIdentifier(
      column.langName,
      naming.targets,
      file,
      'result column',
    );
  }
  for (const param of params) {
    if (!internalParams.has(param.name))
      validateQueryIdentifier(param.langName, naming.targets, file, 'param');
  }

  const reactive = inferReactiveMetadata(sql, scoped, ir, columns);

  // The emitted statement is what SQLite checks: the positional form, with
  // FTS source-id lowering applied, must prepare to the same result columns
  // and take exactly one value per distinct param.
  const physical = lowerFtsSourceIds(sql, ir);
  const positionalSql = toPositionalSql(physical);
  const emitted = analyze(positionalSql);
  if (
    emitted.paramsCount !== params.length ||
    emitted.columnNames.join('\0') !== described.columnNames.join('\0')
  ) {
    throw new TypegenError(
      file,
      'internal: the emitted positional SQL does not prepare to the analyzed columns and params',
      'typegen.emitted_sql_mismatch',
      {
        columns: described.columnNames,
        emittedColumns: emitted.columnNames,
        params: params.length,
        emittedParams: emitted.paramsCount,
      },
    );
  }

  return {
    name,
    file,
    sourceSql,
    sql: physical,
    positionalSql,
    relations: scanTableRefs(positionalSql, ir, true).map((ref) => ({
      table: ref.table,
      start: ref.start,
      end: ref.end,
      ...(ref.explicitAlias === undefined ? {} : { alias: ref.explicitAlias }),
    })),
    params,
    columns,
    tables,
    reactive,
    acknowledgements,
  };
}

/**
 * Analyze a whole query FILE: split into statements, resolve each statement's
 * name (path-derived default, or a `-- name:` override), enforce the
 * multi-statement contract, and analyze each. `relPath` is the file's path
 * relative to the queries root (drives the default name + error locations).
 *
 * Rules (agreed 2026-07-04):
 * - A file with ONE statement may omit `-- name:` → the path-derived default.
 * - A file with MULTIPLE statements requires `-- name:` on EVERY statement; a
 *   missing one errors, naming the file + the statement's position/first line.
 */
export function analyzeQueryFile(
  relPath: string,
  content: string,
  ir: IrDocument,
  db: QueryDb,
  naming: QueryNamingOptions = DEFAULT_NAMING,
): AnalyzedQuery[] {
  const statements = splitStatements(content, relPath);
  if (statements.length === 0) {
    throw new TypegenError(relPath, 'query file is empty');
  }
  const multi = statements.length > 1;
  const defaultName = queryNameFromPath(relPath);
  return statements.map((stmt, index) => {
    const location = multi ? `${relPath}#${index + 1}` : relPath;
    const override = parseStatementName(stmt.text, location);
    if (multi && override === null) {
      const firstLine =
        stripCommentsAndStrings(stmt.text).trim().split('\n')[0]?.trim() ?? '';
      throw new TypegenError(
        location,
        `${relPath} holds ${statements.length} statements, so each requires a \`-- name: <camelCase>\` marker; statement #${index + 1} (line ${stmt.startLine}: ${JSON.stringify(firstLine.slice(0, 60))}) has none`,
      );
    }
    const name = override ?? defaultName;
    return analyzeStatement(name, location, stmt.text, ir, db, naming);
  });
}

/** Back-compat single-statement analyzer: resolve the name from the file path
 * (or a `-- name:` override) and analyze. Rejects a `;`-separated file loudly
 * — use {@link analyzeQueryFile} for the multi-statement contract. */
export function analyzeQuery(
  file: string,
  raw: string,
  ir: IrDocument,
  db: QueryDb,
  naming: QueryNamingOptions = DEFAULT_NAMING,
): AnalyzedQuery {
  const statements = splitStatements(raw, file);
  if (statements.length > 1) {
    throw new TypegenError(
      file,
      'a query file holds exactly one SELECT statement here (found a `;` separating statements) — use analyzeQueryFile for multi-statement files',
    );
  }
  const results = analyzeQueryFile(file, raw, ir, db, naming);
  return results[0] as AnalyzedQuery;
}

/**
 * The query plan check (`docs/SYQL.md` §14.5): plan every physical statement
 * against the schema database and fail on the first finding the query does
 * not acknowledge, then on the first acknowledgement that matches no finding.
 */
export function checkQueryPlan(
  query: AnalyzedQuery,
  ir: IrDocument,
  db: QueryDb,
): void {
  const findings: {
    readonly finding: QueryPlanFinding;
    readonly table?: string;
    readonly details: Readonly<Record<string, unknown>>;
  }[] = [];
  const tables = new Map(ir.tables.map((table) => [table.name, table]));
  const statements = query.syql?.plan.statements ?? [query];
  statements.forEach(({ positionalSql: sql, relations }, statement) => {
    const rows = db.plan(sql);
    const plan = rows.map((row) => row.detail);
    const scans = (details: readonly string[]): number =>
      details.filter(
        (detail) =>
          detail.startsWith('SCAN ') && !detail.includes(' VIRTUAL TABLE'),
      ).length;
    // A plan names a relation by its alias, or by its table when unaliased.
    const tableOf = (name: string): string =>
      relations.find((relation) => (relation.alias ?? relation.table) === name)
        ?.table ?? name;
    const context = { query: query.name, file: query.file, statement, sql };
    for (const detail of plan) {
      const automatic =
        /^SEARCH (\S+) USING AUTOMATIC (?:PARTIAL )?(?:COVERING )?INDEX \((.*)\)/.exec(
          detail,
        );
      if (automatic === null) continue;
      const table = tableOf(automatic[1] as string);
      findings.push({
        finding: 'automatic_index',
        table,
        details: {
          ...context,
          table,
          columns: [...(automatic[2] as string).matchAll(/(\w+)[=<>]/g)].map(
            (key) => key[1],
          ),
          plan,
        },
      });
    }
    const scanCount = scans(plan);
    if (scanCount > 0) {
      for (const table of [
        ...new Set(relations.map((relation) => relation.table)),
      ]) {
        const columns = (tables.get(table)?.columns ?? [])
          .map((column) => column.name)
          .filter(
            (column) =>
              scans(
                db
                  .plan(
                    sql,
                    `CREATE INDEX "__syncular_plan_probe" ON "${table}" ("${column}")`,
                  )
                  .map((row) => row.detail),
              ) < scanCount,
          );
        if (columns.length > 0) {
          findings.push({
            finding: 'scan',
            table,
            details: { ...context, table, columns, plan },
          });
        }
      }
    }
    const { tokens, depths } = sqlStructure(sql);
    const bounded = tokens.some(
      (token, index) =>
        depths[index] === 0 &&
        ['where', 'limit'].includes(lowerWord(token) ?? ''),
    );
    const topScan = rows.find(
      (row) =>
        row.parent === 0 &&
        scans([row.detail]) === 1 &&
        tables.has(tableOf(row.detail.split(' ')[1] as string)),
    );
    if (!bounded && topScan !== undefined) {
      const table = tableOf(topScan.detail.split(' ')[1] as string);
      findings.push({
        finding: 'unbounded',
        table,
        details: { ...context, table, plan },
      });
    }
  });
  const dependencies = [
    ...new Set(query.reactive.dependencies.map(({ table }) => table)),
  ].sort();
  if (dependencies.length > 4) {
    findings.push({
      finding: 'many_tables',
      details: { query: query.name, file: query.file, tables: dependencies },
    });
  }

  const messages: Record<QueryPlanFinding, string> = {
    scan: 'the query plan scans a table that an index on one of the listed columns would let SQLite search; declare the index or acknowledge the finding',
    automatic_index:
      'the query plan builds an automatic index on every run; declare an index on the listed columns or acknowledge the finding',
    unbounded:
      'the query reads every row of a table, with no WHERE and no LIMIT; bound the query or acknowledge the finding',
    many_tables:
      'the query reads more than four tables, and a change to any of them re-runs it; split the query or acknowledge the finding',
  };
  const acknowledged = (
    acknowledgement: QueryAcknowledgement,
    found: (typeof findings)[number],
  ): boolean =>
    acknowledgement.finding === 'plan' ||
    (acknowledgement.finding === found.finding &&
      acknowledgement.table === found.table);
  for (const found of findings) {
    if (!query.acknowledgements.some((ack) => acknowledged(ack, found))) {
      throw new TypegenError(
        query.file,
        messages[found.finding],
        `typegen.query_${found.finding}`,
        found.details,
      );
    }
  }
  for (const ack of query.acknowledgements) {
    if (!findings.some((found) => acknowledged(ack, found))) {
      throw new TypegenError(
        query.file,
        'the query plan acknowledgement matches no finding of its query; remove it',
        'typegen.query_acknowledgement_unused',
        {
          query: query.name,
          file: query.file,
          finding: ack.finding,
          table: ack.table ?? null,
        },
      );
    }
  }
}
