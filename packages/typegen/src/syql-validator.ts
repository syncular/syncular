/** Schema-aware revision-1 SYQL validation (§§5, 8–13). */
import type { IrColumnType, IrDocument } from './ir';
import {
  type AnalyzedQuery,
  analyzeStatement,
  inferParamTypeEvidence,
  type QueryCoverageBinding,
  type QueryDb,
  type QueryNamingOptions,
  type QueryReactiveMetadata,
  type QueryScopeBinding,
  scanTableRefs,
  stripCommentsAndStrings,
  type TableRef,
} from './query';
import {
  isSyqlTrivia,
  lexSyqlSqlSource,
  SyqlFrontendError,
  type SyqlSourceSpan,
  type SyqlToken,
} from './syql-lexer';
import type {
  SyqlQueryDeclaration,
  SyqlQueryParameter,
  SyqlTemplate,
  SyqlValueType,
} from './syql-parser';
import type {
  SyqlLogicalQuery,
  SyqlLogicalTemplateNode,
  SyqlLogicalWhenNode,
  SyqlSemanticProgram,
} from './syql-semantics';
import { syqlRangeEndBind, syqlRangeStartBind } from './syql-semantics';

export type SyqlValidationErrorCode =
  | 'SYQL6001_INVALID_PLACEMENT'
  | 'SYQL6002_INVALID_SQL'
  | 'SYQL6003_NONDETERMINISTIC_SQL'
  | 'SYQL6004_TYPE_CONFLICT'
  | 'SYQL6005_INVALID_SYNC_QUERY'
  | 'SYQL6006_INVALID_SORT'
  | 'SYQL6007_INVALID_LIMIT'
  | 'SYQL6008_INVALID_IDENTITY';

export interface SyqlValidatedSort {
  readonly control: string;
  readonly defaultProfile: string;
  readonly profiles: readonly { readonly name: string; readonly sql: string }[];
}

export interface SyqlValidatedQuery {
  readonly logical: SyqlLogicalQuery;
  /** Reference realization: every conditional active, default controls. */
  readonly referenceSql: string;
  readonly analysis: AnalyzedQuery;
  readonly bindTypes: ReadonlyMap<string, SyqlValueType>;
  readonly reactive: QueryReactiveMetadata;
  readonly identity?: readonly string[];
  readonly sort?: SyqlValidatedSort;
  readonly limit?: {
    readonly control: string;
    readonly defaultSize: number;
    readonly maxSize: number;
  };
}

export interface SyqlValidatedProgram {
  readonly semantic: SyqlSemanticProgram;
  readonly queries: readonly SyqlValidatedQuery[];
}

interface Marker {
  readonly name: string;
  readonly node: SyqlLogicalWhenNode;
}

interface StructuralToken {
  readonly token: SyqlToken;
  readonly depth: number;
}

interface SqlStructure {
  readonly tokens: readonly StructuralToken[];
  readonly outer: readonly StructuralToken[];
  readonly hasOuterOrder: boolean;
  readonly hasOuterLimit: boolean;
  readonly hasOuterOffset: boolean;
  readonly hasCompound: boolean;
  readonly orderStart?: number;
  readonly orderBodyStart?: number;
  readonly orderEnd?: number;
  readonly tailStart?: number;
}

interface BindSymbol {
  readonly name: string;
  readonly parameter: SyqlQueryParameter;
  readonly span: SyqlSourceSpan;
  readonly authoredType?: SyqlValueType;
}

interface SqliteDiagnostic {
  readonly span: SyqlSourceSpan;
  readonly message: string;
}

const IDENT_SOURCE = '[A-Za-z_][A-Za-z0-9_]*';
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQLITE_SUBJECT_RE = '[A-Za-z_][A-Za-z0-9_$]*';
const NONDETERMINISTIC_FUNCTIONS = new Set([
  'random',
  'randomblob',
  'changes',
  'total_changes',
  'last_insert_rowid',
  'sqlite_version',
  'sqlite_source_id',
]);
const DATE_FUNCTIONS = new Set([
  'date',
  'time',
  'datetime',
  'julianday',
  'unixepoch',
  'strftime',
  'timediff',
]);
const CURRENT_TIME_KEYWORDS = new Set([
  'current_date',
  'current_time',
  'current_timestamp',
]);

function editDistance(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] as number) + 1,
        (previous[rightIndex] as number) + 1,
        (previous[rightIndex - 1] as number) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] as number;
}

function nearestName(
  authored: string,
  candidates: readonly string[],
): string | undefined {
  const normalized = authored.toLowerCase();
  const ranked = [...new Set(candidates)]
    .filter((candidate) => candidate.toLowerCase() !== normalized)
    .map((candidate) => ({
      candidate,
      distance: editDistance(normalized, candidate.toLowerCase()),
    }))
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.candidate.localeCompare(right.candidate),
    );
  const nearest = ranked[0];
  if (nearest === undefined) return undefined;
  const threshold = Math.max(1, Math.floor(normalized.length / 3));
  return nearest.distance <= threshold ? nearest.candidate : undefined;
}

function suggestion(authored: string, candidates: readonly string[]): string {
  const nearest = nearestName(authored, candidates);
  return nearest === undefined ? '' : `; did you mean \`${nearest}\`?`;
}

function identifierText(token: SyqlToken | undefined): string | undefined {
  if (token?.kind === 'identifier') return token.text;
  if (token?.kind !== 'quoted-identifier') return undefined;
  if (token.text.startsWith('[') && token.text.endsWith(']')) {
    return token.text.slice(1, -1).replaceAll(']]', ']');
  }
  const quote = token.text[0];
  return token.text.slice(1, -1).replaceAll(`${quote}${quote}`, quote ?? '');
}
const AGGREGATE_FUNCTIONS = new Set([
  'avg',
  'count',
  'group_concat',
  'max',
  'min',
  'sum',
  'total',
]);
/**
 * The function surface of the standard SQLite 3.46.0 amalgamation.
 *
 * Keep this explicit: preparing with Bun's host SQLite proves that SQL is
 * valid on that (usually newer) engine, not that it is valid on the revision-1
 * floor. Unknown, extension-provided, and post-floor functions are rejected
 * before the host prepare step.
 */
const SQLITE_346_PORTABLE_FUNCTIONS = new Set([
  // Core scalar and aggregate functions.
  'abs',
  'avg',
  'char',
  'cast',
  'coalesce',
  'concat',
  'concat_ws',
  'count',
  'format',
  'glob',
  'group_concat',
  'hex',
  'ifnull',
  'iif',
  'instr',
  'length',
  'like',
  'likelihood',
  'likely',
  'lower',
  'ltrim',
  'max',
  'min',
  'nullif',
  'octet_length',
  'printf',
  'quote',
  'replace',
  'round',
  'rtrim',
  'sign',
  'string_agg',
  'substr',
  'substring',
  'sum',
  'total',
  'trim',
  'typeof',
  'unhex',
  'unicode',
  'unlikely',
  'upper',
  'zeroblob',
  // Date/time functions. Determinism applies additional restrictions below.
  ...DATE_FUNCTIONS,
  // JSON1 and JSONB are core in the 3.46.0 amalgamation.
  'json',
  'json_array',
  'json_array_length',
  'json_error_position',
  'json_each',
  'json_extract',
  'json_group_array',
  'json_group_object',
  'json_insert',
  'json_object',
  'json_patch',
  'json_pretty',
  'json_quote',
  'json_remove',
  'json_replace',
  'json_set',
  'json_type',
  'json_tree',
  'json_valid',
  'jsonb',
  'jsonb_array',
  'jsonb_extract',
  'jsonb_group_array',
  'jsonb_group_object',
  'jsonb_insert',
  'jsonb_object',
  'jsonb_patch',
  'jsonb_remove',
  'jsonb_replace',
  'jsonb_set',
]);
/**
 * Deterministic FTS5 auxiliary functions available only when the query reads
 * a schema-declared FTS projection. FTS5 is an explicit Syncular client
 * requirement in that case, not an arbitrary host extension.
 */
const SQLITE_FTS5_AUXILIARY_FUNCTIONS = new Set([
  'bm25',
  'highlight',
  'snippet',
]);
const SQL_PAREN_KEYWORDS = new Set([
  'and',
  'as',
  'else',
  'exists',
  'filter',
  'from',
  'group',
  'having',
  'in',
  'join',
  'limit',
  'not',
  'offset',
  'on',
  'or',
  'order',
  'over',
  'select',
  'then',
  'values',
  'when',
  'where',
  'with',
]);
const SQLITE_346_PORTABLE_COLLATIONS = new Set(['binary', 'nocase', 'rtrim']);
const OUTER_CLAUSE_ENDERS = new Set([
  'group',
  'having',
  'order',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
]);

function typeText(type: SyqlValueType | IrColumnType): string {
  return typeof type === 'string'
    ? type
    : `${type.base}${type.nullable ? ' | null' : ''}`;
}

function valueType(
  base: IrColumnType,
  nullable: boolean,
  span: SyqlSourceSpan,
): SyqlValueType {
  return { base, nullable, span };
}

function significant(tokens: readonly SyqlToken[]): readonly SyqlToken[] {
  return tokens.filter((token) => !isSyqlTrivia(token) && token.kind !== 'eof');
}

function tokenLower(token: SyqlToken | undefined): string | undefined {
  return token?.kind === 'identifier' ? token.text.toLowerCase() : token?.text;
}

function decodeSqlString(token: SyqlToken): string | undefined {
  if (token.kind !== 'string' || token.text.length < 2) return undefined;
  return token.text.slice(1, -1).replaceAll("''", "'");
}

function templateText(template: SyqlTemplate): string {
  return template.tokens
    .map((token) => token.text)
    .join('')
    .trim();
}

function functionArgumentCount(
  tokens: readonly SyqlToken[],
  openIndex: number,
): number | undefined {
  let depth = 0;
  let commas = 0;
  let hasArgument = false;
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index] as SyqlToken;
    if (token.text === '(') {
      depth += 1;
      hasArgument = true;
    } else if (token.text === ')') {
      if (depth === 0) return hasArgument ? commas + 1 : 0;
      depth -= 1;
      hasArgument = true;
    } else if (token.text === ',' && depth === 0) {
      commas += 1;
    } else {
      hasArgument = true;
    }
  }
  return undefined;
}

function matchingParenIndex(
  tokens: readonly SyqlToken[],
  openIndex: number,
): number | undefined {
  let depth = 0;
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index] as SyqlToken;
    if (token.text === '(') depth += 1;
    else if (token.text === ')') {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return undefined;
}

class Validator {
  readonly #semantic: SyqlSemanticProgram;
  readonly #ir: IrDocument;
  readonly #db: QueryDb;
  readonly #naming: QueryNamingOptions | undefined;

  constructor(
    semantic: SyqlSemanticProgram,
    ir: IrDocument,
    db: QueryDb,
    naming: QueryNamingOptions | undefined,
  ) {
    this.#semantic = semantic;
    this.#ir = ir;
    this.#db = db;
    this.#naming = naming;
  }

  validate(): SyqlValidatedProgram {
    return {
      semantic: this.#semantic,
      queries: this.#semantic.queries.map((query) =>
        this.#validateQuery(query),
      ),
    };
  }

  #validateQuery(logical: SyqlLogicalQuery): SyqlValidatedQuery {
    const location = `${logical.module.file} (query ${logical.declaration.name})`;
    const markers: Marker[] = [];
    const markerSql = this.#render(logical.template, 'markers', markers);
    const markerStructure = this.#inspect(markerSql, location);
    this.#validatePlacement(markerStructure, markers, logical.declaration);

    const activeSql = this.#render(logical.template, 'active', []);
    const activeStructure = this.#inspect(activeSql, location);
    this.#validateStatementShape(
      activeSql,
      activeStructure,
      logical.declaration,
      location,
    );
    this.#validateDeterminism(activeSql, logical.declaration.statement.span);
    const refs = scanTableRefs(activeSql, this.#ir);
    this.#validatePortableProfile(
      activeSql,
      logical.declaration.statement.span,
      refs,
    );
    this.#validateSqlite(activeSql, logical, refs);

    const bindSymbols = this.#bindSymbols(logical.declaration);
    const bindTypes = this.#resolveBindTypes(
      logical,
      activeSql,
      refs,
      bindSymbols,
    );

    const sort = this.#validateSort(
      logical.declaration,
      activeStructure,
      location,
    );
    let referenceSql = this.#composeSort(
      activeSql,
      activeStructure,
      sort?.profiles.find((profile) => profile.name === sort.defaultProfile)
        ?.sql,
    );
    if (logical.declaration.limit !== undefined) {
      referenceSql = `${referenceSql.trimEnd()} limit ${logical.declaration.limit.defaultSize}`;
    }

    const usedBindNames = new Set(
      lexSyqlSqlSource(location, activeSql)
        .filter((token) => token.kind === 'bind')
        .map((token) => token.text.slice(1)),
    );
    const headers = [...bindTypes]
      .filter(([name]) => usedBindNames.has(name))
      .map(([name, type]) => `-- param :${name} ${type.base}`)
      .join('\n');
    const statement =
      headers.length === 0 ? referenceSql : `${headers}\n${referenceSql}`;
    let analysis: AnalyzedQuery;
    try {
      const analysisNaming =
        this.#naming === undefined
          ? undefined
          : {
              ...this.#naming,
              internalParams: [
                ...(this.#naming.internalParams ?? []),
                ...[...usedBindNames].filter((name) =>
                  name.startsWith('__syql'),
                ),
              ],
            };
      analysis = analyzeStatement(
        logical.declaration.name,
        location,
        statement,
        this.#ir,
        this.#db,
        analysisNaming,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#fail(
        'SYQL6002_INVALID_SQL',
        logical.declaration.statement.span,
        `reference SQL rejected: ${message}`,
      );
    }

    for (const profile of sort?.profiles ?? []) {
      const candidate = this.#composeSort(
        activeSql,
        activeStructure,
        profile.sql,
      );
      const paged =
        logical.declaration.limit === undefined
          ? candidate
          : `${candidate.trimEnd()} limit ${logical.declaration.limit.defaultSize}`;
      try {
        this.#db.analyze(paged);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#fail(
          'SYQL6006_INVALID_SORT',
          logical.declaration.sort?.span ?? logical.declaration.statement.span,
          `sort profile ${profile.name} rejected by SQLite: ${message}`,
        );
      }
    }

    const reactive = this.#inferReactive(logical, markerSql, refs, bindSymbols);
    const identity = this.#proveIdentity(
      logical.declaration,
      activeSql,
      refs,
      analysis,
    );
    this.#validateStableOrder(
      logical.declaration,
      activeSql,
      activeStructure,
      sort,
      identity,
      analysis,
      refs,
    );
    const reactiveWithIdentity: QueryReactiveMetadata = {
      ...reactive,
      ...(identity === undefined ? {} : { rowKey: identity }),
    };

    return {
      logical,
      referenceSql,
      analysis: { ...analysis, reactive: reactiveWithIdentity },
      bindTypes,
      reactive: reactiveWithIdentity,
      ...(identity === undefined ? {} : { identity }),
      ...(sort === undefined ? {} : { sort }),
      ...(logical.declaration.limit === undefined
        ? {}
        : {
            limit: {
              control: logical.declaration.limit.control,
              defaultSize: logical.declaration.limit.defaultSize,
              maxSize: logical.declaration.limit.maxSize,
            },
          }),
    };
  }

  #render(
    nodes: readonly SyqlLogicalTemplateNode[],
    mode: 'active' | 'markers',
    markers: Marker[],
  ): string {
    return nodes
      .map((node) => {
        if (node.kind === 'sql') {
          return node.parts
            .map((part) => (part.kind === 'text' ? part.text : `:${part.name}`))
            .join('');
        }
        if (node.kind === 'predicate') {
          return `(${this.#render(node.body, mode, markers)})`;
        }
        if (mode === 'markers') {
          const name = `__syql_node_${markers.length}`;
          markers.push({ name, node });
          return name;
        }
        if (node.kind === 'when') {
          return `(${this.#render(node.body, mode, markers)})`;
        }
        throw new Error('unknown SYQL logical template node');
      })
      .join('');
  }

  #inspect(sql: string, file: string): SqlStructure {
    const raw = significant(lexSyqlSqlSource(file, sql));
    const tokens: StructuralToken[] = [];
    let depth = 0;
    for (const token of raw) {
      if (token.kind === 'punctuation' && token.text === ')') depth -= 1;
      tokens.push({ token, depth });
      if (token.kind === 'punctuation' && token.text === '(') depth += 1;
      if (depth < 0) {
        this.#fail(
          'SYQL6002_INVALID_SQL',
          token.span,
          'unbalanced SQL parenthesis',
        );
      }
    }
    if (depth !== 0) {
      this.#fail(
        'SYQL6002_INVALID_SQL',
        raw[raw.length - 1]?.span ?? {
          file,
          start: { offset: 0, line: 1, column: 1 },
          end: { offset: 0, line: 1, column: 1 },
        },
        'unbalanced SQL parenthesis',
      );
    }
    const outer = tokens.filter((item) => item.depth === 0);
    let orderStart: number | undefined;
    let orderBodyStart: number | undefined;
    let orderEnd: number | undefined;
    let tailStart: number | undefined;
    let hasOuterLimit = false;
    let hasOuterOffset = false;
    let hasCompound = false;
    for (let index = 0; index < outer.length; index += 1) {
      const item = outer[index] as StructuralToken;
      const lower = tokenLower(item.token);
      const next = outer[index + 1]?.token;
      if (lower === 'order' && tokenLower(next) === 'by') {
        orderStart = item.token.span.start.offset;
        orderBodyStart = next?.span.end.offset;
      } else if (lower === 'limit') {
        hasOuterLimit = true;
        tailStart = Math.min(
          tailStart ?? Number.MAX_SAFE_INTEGER,
          item.token.span.start.offset,
        );
      } else if (lower === 'offset') {
        hasOuterOffset = true;
        tailStart = Math.min(
          tailStart ?? Number.MAX_SAFE_INTEGER,
          item.token.span.start.offset,
        );
      } else if (
        lower === 'union' ||
        lower === 'intersect' ||
        lower === 'except'
      ) {
        hasCompound = true;
      }
      if (
        orderBodyStart !== undefined &&
        orderEnd === undefined &&
        (lower === 'limit' ||
          lower === 'offset' ||
          lower === 'union' ||
          lower === 'intersect' ||
          lower === 'except')
      ) {
        orderEnd = item.token.span.start.offset;
      }
    }
    if (orderBodyStart !== undefined && orderEnd === undefined)
      orderEnd = sql.length;
    return {
      tokens,
      outer,
      hasOuterOrder: orderStart !== undefined,
      hasOuterLimit,
      hasOuterOffset,
      hasCompound,
      ...(orderStart === undefined ? {} : { orderStart }),
      ...(orderBodyStart === undefined ? {} : { orderBodyStart }),
      ...(orderEnd === undefined ? {} : { orderEnd }),
      ...(tailStart === undefined ? {} : { tailStart }),
    };
  }

  #validatePlacement(
    structure: SqlStructure,
    markers: readonly Marker[],
    query: SyqlQueryDeclaration,
  ): void {
    const byName = new Map(markers.map((marker) => [marker.name, marker]));
    let clause: string | undefined;
    for (let index = 0; index < structure.outer.length; index += 1) {
      const item = structure.outer[index] as StructuralToken;
      const lower = tokenLower(item.token);
      if (lower === 'where' || lower === 'having') clause = lower;
      else if (OUTER_CLAUSE_ENDERS.has(lower ?? '')) clause = undefined;
      const marker = byName.get(item.token.text);
      if (marker === undefined) continue;
      const previous = tokenLower(structure.outer[index - 1]?.token);
      const next = tokenLower(structure.outer[index + 1]?.token);
      const boundaryBefore =
        previous === 'where' || previous === 'having' || previous === 'and';
      const boundaryAfter =
        next === undefined || next === 'and' || OUTER_CLAUSE_ENDERS.has(next);
      if (!boundaryBefore || !boundaryAfter) {
        this.#fail(
          'SYQL6001_INVALID_PLACEMENT',
          marker.node.span,
          'when must be an entire outer conjunct',
        );
      }
      if (clause !== 'where' && clause !== 'having') {
        this.#fail(
          'SYQL6001_INVALID_PLACEMENT',
          marker.node.span,
          'when is allowed only in the outer WHERE or HAVING clause',
        );
      }
    }
    for (const marker of markers) {
      if (!structure.outer.some((item) => item.token.text === marker.name)) {
        this.#fail(
          'SYQL6001_INVALID_PLACEMENT',
          marker.node.span,
          'when cannot appear in a nested SQL expression or statement',
        );
      }
    }
    if (structure.hasCompound && markers.length > 0) {
      this.#fail(
        'SYQL6001_INVALID_PLACEMENT',
        query.statement.span,
        'embedded SYQL conjuncts are ambiguous in a compound outer statement',
      );
    }
  }

  #validateStatementShape(
    sql: string,
    structure: SqlStructure,
    query: SyqlQueryDeclaration,
    location: string,
  ): void {
    if (query.sort !== undefined && structure.hasOuterOrder) {
      this.#fail(
        'SYQL6006_INVALID_SORT',
        query.sort.span,
        'sort section conflicts with an authored outer ORDER BY',
      );
    }
    if (
      query.limit !== undefined &&
      (structure.hasOuterLimit || structure.hasOuterOffset)
    ) {
      this.#fail(
        'SYQL6007_INVALID_LIMIT',
        query.limit.span,
        'dynamic LIMIT conflicts with an authored outer LIMIT or OFFSET',
      );
    }
    const first = structure.outer
      .find((item) => item.token.kind === 'identifier')
      ?.token.text.toLowerCase();
    if (first !== 'select' && first !== 'with') {
      this.#fail(
        'SYQL6002_INVALID_SQL',
        query.statement.span,
        `${location} must contain one SELECT or WITH ... SELECT statement`,
      );
    }
    if (sql.trim().length === 0) {
      this.#fail(
        'SYQL6002_INVALID_SQL',
        query.statement.span,
        'empty SQL statement',
      );
    }
  }

  #validateDeterminism(sql: string, span: SyqlSourceSpan): void {
    const tokens = significant(lexSyqlSqlSource(span.file, sql));
    const functionStack: Array<string | undefined> = [];
    let depth = 0;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index] as SyqlToken;
      const lower = tokenLower(token);
      const next = tokens[index + 1];
      if (
        depth > 0 &&
        token.kind === 'identifier' &&
        (lower === 'limit' || lower === 'offset')
      ) {
        this.#fail(
          'SYQL6003_NONDETERMINISTIC_SQL',
          token.span,
          `nested ${token.text.toUpperCase()} is rejected until its local row identity and total order can be proven`,
        );
      }
      if (token.kind === 'identifier' && lower === 'over') {
        this.#fail(
          'SYQL6003_NONDETERMINISTIC_SQL',
          token.span,
          'window expressions are rejected until their partition identity and total order can be proven',
        );
      }
      if (CURRENT_TIME_KEYWORDS.has(lower ?? '')) {
        this.#fail(
          'SYQL6003_NONDETERMINISTIC_SQL',
          span,
          `${token.text} depends on wall-clock time`,
        );
      }
      if (
        token.kind === 'identifier' &&
        next?.text === '(' &&
        NONDETERMINISTIC_FUNCTIONS.has(lower ?? '')
      ) {
        this.#fail(
          'SYQL6003_NONDETERMINISTIC_SQL',
          span,
          `${token.text}() is not deterministic from snapshot and inputs`,
        );
      }
      if (token.text === '(') {
        const previous = tokens[index - 1];
        functionStack.push(
          previous?.kind === 'identifier'
            ? previous.text.toLowerCase()
            : undefined,
        );
        depth += 1;
      } else if (token.text === ')') {
        functionStack.pop();
        depth -= 1;
      } else if (
        decodeSqlString(token)?.toLowerCase() === 'now' &&
        functionStack.some(
          (name) => name !== undefined && DATE_FUNCTIONS.has(name),
        )
      ) {
        this.#fail(
          'SYQL6003_NONDETERMINISTIC_SQL',
          span,
          "SQLite date/time modifier 'now' is not deterministic",
        );
      }
    }
  }

  #validatePortableProfile(
    sql: string,
    span: SyqlSourceSpan,
    refs?: readonly TableRef[],
  ): void {
    const tokens = significant(lexSyqlSqlSource(span.file, sql));
    const declaredFtsTables = new Set(
      this.#ir.tables.flatMap((table) =>
        table.ftsIndexes.map((index) => index.name),
      ),
    );
    const queryRefs = refs ?? scanTableRefs(sql, this.#ir);
    const readsDeclaredFts = queryRefs.some((ref) =>
      declaredFtsTables.has(ref.table),
    );
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index] as SyqlToken;
      const lower = tokenLower(token);
      if (lower === 'collate') {
        const collation = tokens[index + 1];
        const name = tokenLower(collation);
        if (
          collation === undefined ||
          !SQLITE_346_PORTABLE_COLLATIONS.has(name ?? '')
        ) {
          this.#fail(
            'SYQL6002_INVALID_SQL',
            collation?.span ?? token.span,
            `collation ${collation?.text ?? '<missing>'} is outside the portable SQLite 3.46.0 profile`,
          );
        }
      }
      if (
        token.kind !== 'identifier' ||
        tokens[index + 1]?.text !== '(' ||
        SQL_PAREN_KEYWORDS.has(lower ?? '')
      ) {
        continue;
      }

      const closeIndex = matchingParenIndex(tokens, index + 1);
      // A WITH declaration such as `items(id) AS (...)` is not a function.
      if (
        closeIndex !== undefined &&
        tokenLower(tokens[closeIndex + 1]) === 'as' &&
        tokens[closeIndex + 2]?.text === '('
      ) {
        continue;
      }
      const allowedFtsAuxiliary =
        readsDeclaredFts && SQLITE_FTS5_AUXILIARY_FUNCTIONS.has(lower ?? '');
      if (
        !SQLITE_346_PORTABLE_FUNCTIONS.has(lower ?? '') &&
        !allowedFtsAuxiliary
      ) {
        this.#fail(
          'SYQL6002_INVALID_SQL',
          token.span,
          `${token.text}() is not a core built-in in the portable SQLite 3.46.0 profile or an auxiliary function of a referenced schema-declared FTS5 projection`,
        );
      }

      const argumentCount = functionArgumentCount(tokens, index + 1);
      if (lower === 'iif' && argumentCount !== 3) {
        this.#fail(
          'SYQL6002_INVALID_SQL',
          token.span,
          'SQLite 3.46.0 requires exactly three arguments to iif()',
        );
      }
      if (
        (lower === 'date' ||
          lower === 'time' ||
          lower === 'datetime' ||
          lower === 'julianday' ||
          lower === 'unixepoch') &&
        argumentCount === 0
      ) {
        this.#fail(
          'SYQL6003_NONDETERMINISTIC_SQL',
          token.span,
          `${token.text}() without a time-value implicitly reads the wall clock`,
        );
      }
      if (lower === 'strftime' && (argumentCount ?? 0) < 2) {
        this.#fail(
          'SYQL6003_NONDETERMINISTIC_SQL',
          token.span,
          'strftime() without an explicit time-value implicitly reads the wall clock',
        );
      }
    }
  }

  #validateSqlite(
    sql: string,
    logical: SyqlLogicalQuery,
    refs: readonly TableRef[],
  ): void {
    try {
      this.#db.analyze(sql);
    } catch (error) {
      const sqliteMessage =
        error instanceof Error ? error.message : String(error);
      const diagnostic = this.#describeSqliteError(
        sqliteMessage,
        logical,
        refs,
      );
      this.#fail('SYQL6002_INVALID_SQL', diagnostic.span, diagnostic.message);
    }
  }

  #describeSqliteError(
    sqliteMessage: string,
    logical: SyqlLogicalQuery,
    refs: readonly TableRef[],
  ): SqliteDiagnostic {
    const fallback = logical.declaration.statement.span;
    const tableNames = this.#ir.tables.flatMap((table) => [
      table.name,
      ...table.ftsIndexes.map((index) => index.name),
    ]);
    const noTable = new RegExp(
      `no such table:\\s*(?:main\\.)?(${SQLITE_SUBJECT_RE})`,
      'i',
    ).exec(sqliteMessage);
    if (noTable !== null) {
      const table = noTable[1] as string;
      return {
        span: this.#sqlSubjectSpan(logical, table, 'table') ?? fallback,
        message: `unknown table \`${table}\`${suggestion(table, tableNames)}`,
      };
    }

    const noColumn = new RegExp(
      `no such column:\\s*(${SQLITE_SUBJECT_RE})(?:\\.(${SQLITE_SUBJECT_RE}))?`,
      'i',
    ).exec(sqliteMessage);
    if (noColumn !== null) {
      const first = noColumn[1] as string;
      const second = noColumn[2];
      if (second !== undefined) {
        const qualifier = first;
        const ref = refs.find(
          (candidate) =>
            candidate.alias.toLowerCase() === qualifier.toLowerCase(),
        );
        if (ref === undefined) {
          const qualifiers = refs.map((candidate) => candidate.alias);
          return {
            span:
              this.#sqlSubjectSpan(
                logical,
                `${qualifier}.${second}`,
                'qualifier',
              ) ?? fallback,
            message: `unknown table or alias \`${qualifier}\`${suggestion(qualifier, qualifiers)}`,
          };
        }
        const columns = this.#columnsForTable(ref.table);
        return {
          span:
            this.#sqlSubjectSpan(logical, `${qualifier}.${second}`, 'column') ??
            fallback,
          message: `unknown column \`${second}\` on \`${qualifier}\`${suggestion(second, columns)}`,
        };
      }
      const columns = refs.flatMap((ref) => this.#columnsForTable(ref.table));
      return {
        span: this.#sqlSubjectSpan(logical, first, 'column') ?? fallback,
        message: `unknown column \`${first}\`${suggestion(first, columns)}`,
      };
    }

    const ambiguous = new RegExp(
      `ambiguous column name:\\s*(?:${SQLITE_SUBJECT_RE}\\.)?(${SQLITE_SUBJECT_RE})`,
      'i',
    ).exec(sqliteMessage);
    if (ambiguous !== null) {
      const column = ambiguous[1] as string;
      const choices = refs
        .filter((ref) =>
          this.#columnsForTable(ref.table).some(
            (candidate) => candidate.toLowerCase() === column.toLowerCase(),
          ),
        )
        .map((ref) => `\`${ref.alias}.${column}\``);
      return {
        span: this.#sqlSubjectSpan(logical, column, 'column') ?? fallback,
        message: `column \`${column}\` is ambiguous${
          choices.length === 0
            ? '; add a table or alias qualifier'
            : `; use ${choices.join(' or ')}`
        }`,
      };
    }

    const syntax = /near\s+["']([^"']+)["']:\s*syntax error/i.exec(
      sqliteMessage,
    );
    if (syntax !== null) {
      const token = syntax[1] as string;
      return {
        span: this.#sqlSubjectSpan(logical, token, 'token') ?? fallback,
        message: `SQL syntax error near \`${token}\``,
      };
    }
    if (/incomplete input/i.test(sqliteMessage)) {
      return {
        span: {
          file: fallback.file,
          start: fallback.end,
          end: fallback.end,
        },
        message: 'incomplete SQL statement',
      };
    }
    return {
      span: fallback,
      message: `SQL rejected by SQLite: ${sqliteMessage}`,
    };
  }

  #columnsForTable(tableName: string): readonly string[] {
    const table = this.#ir.tables.find(
      (candidate) => candidate.name === tableName,
    );
    if (table !== undefined) return table.columns.map((column) => column.name);
    for (const owner of this.#ir.tables) {
      const fts = owner.ftsIndexes.find(
        (candidate) => candidate.name === tableName,
      );
      if (fts !== undefined) return ['_syncular_source_id', ...fts.columns];
    }
    return [];
  }

  #sqlSubjectSpan(
    logical: SyqlLogicalQuery,
    subject: string,
    focus: 'table' | 'qualifier' | 'column' | 'token',
  ): SyqlSourceSpan | undefined {
    const tokens = significant(logical.declaration.statement.tokens);
    const [qualifier, column] = subject.split('.', 2);
    const matches = (token: SyqlToken | undefined, expected: string): boolean =>
      identifierText(token)?.toLowerCase() === expected.toLowerCase();

    if (focus === 'table') {
      for (let index = 0; index < tokens.length - 1; index += 1) {
        const keyword = tokenLower(tokens[index]);
        if (
          (keyword === 'from' || keyword === 'join') &&
          matches(tokens[index + 1], subject)
        ) {
          return tokens[index + 1]?.span;
        }
      }
    }
    if (column !== undefined) {
      for (let index = 0; index < tokens.length - 2; index += 1) {
        if (
          matches(tokens[index], qualifier as string) &&
          tokens[index + 1]?.text === '.' &&
          matches(tokens[index + 2], column)
        ) {
          return focus === 'qualifier'
            ? tokens[index]?.span
            : tokens[index + 2]?.span;
        }
      }
    }
    for (const token of tokens) {
      if (matches(token, subject)) return token.span;
    }
    return undefined;
  }

  #bindSymbols(query: SyqlQueryDeclaration): ReadonlyMap<string, BindSymbol> {
    const symbols = new Map<string, BindSymbol>();
    for (const parameter of query.parameters) {
      if (parameter.kind === 'range') {
        for (const name of [
          syqlRangeStartBind(parameter.name),
          syqlRangeEndBind(parameter.name),
        ]) {
          symbols.set(name, {
            name,
            parameter,
            span: parameter.nameSpan,
            ...(parameter.type === undefined
              ? {}
              : { authoredType: parameter.type }),
          });
        }
      } else if (parameter.kind === 'group') {
        for (const member of parameter.members) {
          symbols.set(member.name, {
            name: member.name,
            parameter,
            span: member.nameSpan,
            ...(member.type === undefined ? {} : { authoredType: member.type }),
          });
        }
      } else {
        symbols.set(parameter.name, {
          name: parameter.name,
          parameter,
          span: parameter.nameSpan,
          ...(parameter.type === undefined
            ? {}
            : { authoredType: parameter.type }),
        });
      }
    }
    return symbols;
  }

  #resolveBindTypes(
    logical: SyqlLogicalQuery,
    sql: string,
    refs: readonly TableRef[],
    symbols: ReadonlyMap<string, BindSymbol>,
  ): ReadonlyMap<string, SyqlValueType> {
    const resolved = new Map(logical.bindTypes);

    for (const symbol of symbols.values()) {
      const evidence = inferParamTypeEvidence(symbol.name, sql, refs, this.#ir);
      const unique = [...new Set(evidence)];
      if (unique.length > 1) {
        this.#fail(
          'SYQL6004_TYPE_CONFLICT',
          symbol.span,
          `bind :${symbol.name} has conflicting checked types: ${unique.join(', ')}`,
        );
      }
      const existing = resolved.get(symbol.name) ?? symbol.authoredType;
      const inferred = unique[0];
      if (
        existing !== undefined &&
        inferred !== undefined &&
        existing.base !== inferred
      ) {
        this.#fail(
          'SYQL6004_TYPE_CONFLICT',
          symbol.span,
          `bind :${symbol.name} is declared ${typeText(existing)} but SQL requires ${inferred}`,
        );
      }
      if (existing !== undefined) resolved.set(symbol.name, existing);
      else if (inferred !== undefined) {
        resolved.set(symbol.name, valueType(inferred, false, symbol.span));
      } else {
        this.#fail(
          'SYQL6004_TYPE_CONFLICT',
          symbol.span,
          `cannot infer a revision-1 type for bind :${symbol.name}; add an annotation`,
        );
      }
    }
    return resolved;
  }

  #inferReactive(
    logical: SyqlLogicalQuery,
    markerSql: string,
    refs: readonly TableRef[],
    symbols: ReadonlyMap<string, BindSymbol>,
  ): QueryReactiveMetadata {
    type InferredScope = {
      readonly binding: QueryScopeBinding;
      readonly operator: 'equal' | 'in';
    };
    type Candidate = {
      readonly ref: TableRef;
      readonly scopes: readonly InferredScope[];
    };
    const cleaned = stripCommentsAndStrings(markerSql);
    const structure = this.#inspect(
      cleaned,
      logical.declaration.statement.span.file,
    );
    const escapeRegex = (value: string): string =>
      value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const requiredAt = (index: number): boolean => {
      let whereStart: number | undefined;
      for (const item of structure.outer) {
        if (item.token.span.start.offset >= index) break;
        const lower = tokenLower(item.token);
        if (lower === 'where') whereStart = item.token.span.end.offset;
        else if (OUTER_CLAUSE_ENDERS.has(lower ?? '')) whereStart = undefined;
      }
      if (whereStart === undefined) return false;

      const clauseEnd =
        structure.outer.find(
          (item) =>
            item.token.span.start.offset > index &&
            OUTER_CLAUSE_ENDERS.has(tokenLower(item.token) ?? ''),
        )?.token.span.start.offset ?? cleaned.length;
      const matchStack: number[] = [];
      for (let cursor = whereStart; cursor < index; cursor += 1) {
        if (cleaned[cursor] === '(') matchStack.push(cursor);
        else if (cleaned[cursor] === ')') matchStack.pop();
      }

      // Parenthesized boolean expressions are valid, but predicates inside a
      // CTE or subquery are not outer proof obligations for sync coverage.
      if (
        matchStack.some((open) =>
          /\b(?:SELECT|WITH)\b/i.test(cleaned.slice(open + 1, index)),
        )
      ) {
        return false;
      }

      // Negated equality does not constrain the result to that scope.
      const prefix = cleaned.slice(whereStart, index);
      const boundaries = [...prefix.matchAll(/\b(?:AND|OR)\b/gi)].map(
        (match) => (match.index ?? -1) + match[0].length,
      );
      const lastBoundary = Math.max(prefix.lastIndexOf('('), ...boundaries);
      if (/\bNOT\b/i.test(prefix.slice(lastBoundary + 1))) return false;
      if (
        matchStack.some((open) =>
          /\bNOT\s*$/i.test(cleaned.slice(whereStart, open)),
        )
      ) {
        return false;
      }

      const stack: number[] = [];
      for (let cursor = whereStart; cursor < clauseEnd; cursor += 1) {
        const char = cleaned[cursor];
        if (char === '(') stack.push(cursor);
        else if (char === ')') stack.pop();
        if (
          /^OR\b/i.test(cleaned.slice(cursor)) &&
          stack.length <= matchStack.length &&
          stack.every((open, stackIndex) => matchStack[stackIndex] === open)
        ) {
          return false;
        }
      }
      return true;
    };
    const requiredJoinEqualityAt = (index: number): boolean => {
      const prefix = cleaned.slice(0, index);
      const clauses = [
        ...prefix.matchAll(
          /\b(ON|JOIN|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|UNION|EXCEPT|INTERSECT)\b/gi,
        ),
      ];
      const last = clauses.at(-1);
      if (last?.[1]?.toUpperCase() !== 'ON') return false;
      const start = (last.index ?? 0) + last[0].length;
      const next =
        /\b(?:JOIN|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|UNION|EXCEPT|INTERSECT)\b/i.exec(
          cleaned.slice(index),
        );
      const end = next === null ? cleaned.length : index + next.index;
      const clause = cleaned.slice(start, end);
      return !/\b(?:OR|NOT|SELECT|WITH)\b/i.test(clause);
    };
    const refByAlias = new Map(
      refs.map((ref) => [ref.alias.toLowerCase(), ref] as const),
    );
    const scopeNode = (alias: string, column: string): string =>
      `${alias.toLowerCase()}\0${column.toLowerCase()}`;
    const parents = new Map<string, string>();
    const find = (node: string): string => {
      const parent = parents.get(node);
      if (parent === undefined) {
        parents.set(node, node);
        return node;
      }
      if (parent === node) return node;
      const root = find(parent);
      parents.set(node, root);
      return root;
    };
    const union = (left: string, right: string): void => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
    };
    const scopeColumn = (alias: string, column: string): boolean => {
      const ref = refByAlias.get(alias.toLowerCase());
      const table = this.#ir.tables.find((item) => item.name === ref?.table);
      return (
        table?.scopes.some(
          (scope) => scope.column.toLowerCase() === column.toLowerCase(),
        ) === true
      );
    };
    const qualifiedEquality = new RegExp(
      `(${IDENT_SOURCE})\\.(${IDENT_SOURCE})\\s*(?:=|==|\\bIS\\b)\\s*(${IDENT_SOURCE})\\.(${IDENT_SOURCE})`,
      'gi',
    );
    for (const match of cleaned.matchAll(qualifiedEquality)) {
      const leftAlias = match[1] as string;
      const leftColumn = match[2] as string;
      const rightAlias = match[3] as string;
      const rightColumn = match[4] as string;
      if (
        !scopeColumn(leftAlias, leftColumn) ||
        !scopeColumn(rightAlias, rightColumn) ||
        (!requiredAt(match.index ?? 0) &&
          !requiredJoinEqualityAt(match.index ?? 0))
      ) {
        continue;
      }
      union(
        scopeNode(leftAlias, leftColumn),
        scopeNode(rightAlias, rightColumn),
      );
    }
    const required = new Set(
      [...symbols.values()].flatMap((symbol) =>
        symbol.parameter.kind === 'value' &&
        !symbol.parameter.optional &&
        symbol.authoredType?.nullable !== true
          ? [symbol.name]
          : [],
      ),
    );
    const candidates: Candidate[] = [];
    const directScopeEvidence = new Map<string, InferredScope>();
    for (const ref of refs) {
      const table = this.#ir.tables.find((item) => item.name === ref.table);
      if (table === undefined) continue;
      const inferred: InferredScope[] = [];
      for (const scope of table.scopes) {
        const alias = escapeRegex(ref.alias);
        const column = escapeRegex(scope.column);
        const unqualifiedMatches = refs.filter((candidate) => {
          const other = this.#ir.tables.find(
            (item) => item.name === candidate.table,
          );
          return other?.columns.some((item) => item.name === scope.column);
        }).length;
        const subject =
          unqualifiedMatches === 1
            ? `(?:${alias}\\.)?${column}`
            : `${alias}\\.${column}`;
        const found: Array<{ name: string; operator: 'equal' | 'in' }> = [];
        const equality = new RegExp(
          `${subject}\\s*(?:=|==|\\bIS\\b)\\s*:([A-Za-z_][A-Za-z0-9_]*)\\b|:([A-Za-z_][A-Za-z0-9_]*)\\b\\s*(?:=|==)\\s*${subject}`,
          'gi',
        );
        for (const match of cleaned.matchAll(equality)) {
          if (!requiredAt(match.index)) continue;
          const name = match[1] ?? match[2];
          if (name !== undefined && required.has(name)) {
            found.push({ name, operator: 'equal' });
          }
        }
        const inList = new RegExp(`${subject}\\s+IN\\s*\\(([^)]*)\\)`, 'gi');
        for (const match of cleaned.matchAll(inList)) {
          if (!requiredAt(match.index)) continue;
          const body = match[1] ?? '';
          const bodyStart = match.index + match[0].length - body.length - 1;
          const bodyTokens = significant(
            lexSyqlSqlSource(
              logical.declaration.statement.span.file,
              markerSql.slice(bodyStart, bodyStart + body.length),
            ),
          );
          const validBindList = bodyTokens.every((token, index) =>
            index % 2 === 0
              ? token.kind === 'bind'
              : token.kind === 'punctuation' && token.text === ',',
          );
          const params = bodyTokens
            .filter((_, index) => index % 2 === 0)
            .map((token) => token.text.slice(1));
          if (
            validBindList &&
            params.length > 0 &&
            params.every((name) => required.has(name))
          ) {
            for (const name of params) found.push({ name, operator: 'in' });
          }
        }
        const params = [...new Set(found.map((item) => item.name))];
        if (params.length > 0) {
          const evidence: InferredScope = {
            binding: {
              table: table.name,
              variable: scope.variable,
              pattern: scope.pattern,
              params,
            },
            operator: found.some((item) => item.operator === 'in')
              ? 'in'
              : 'equal',
          };
          inferred.push(evidence);
          directScopeEvidence.set(scopeNode(ref.alias, scope.column), evidence);
        }
      }
      candidates.push({ ref, scopes: inferred });
    }

    const resolvedCandidates = candidates.map((candidate): Candidate => {
      const table = this.#ir.tables.find(
        (item) => item.name === candidate.ref.table,
      );
      if (table === undefined) return candidate;
      const directByVariable = new Map(
        candidate.scopes.map((scope) => [scope.binding.variable, scope]),
      );
      const scopes = table.scopes.flatMap((scope): InferredScope[] => {
        const direct = directByVariable.get(scope.variable);
        if (direct !== undefined) return [direct];
        const root = find(scopeNode(candidate.ref.alias, scope.column));
        const inherited = [...directScopeEvidence.entries()]
          .filter(([node]) => find(node) === root)
          .map(([, evidence]) => evidence);
        const params = [
          ...new Set(inherited.flatMap((evidence) => evidence.binding.params)),
        ];
        if (params.length === 0) return [];
        return [
          {
            binding: {
              table: table.name,
              variable: scope.variable,
              pattern: scope.pattern,
              params,
            },
            operator: inherited.some((evidence) => evidence.operator === 'in')
              ? 'in'
              : 'equal',
          },
        ];
      });
      return { ...candidate, scopes };
    });

    const ftsOwners = new Map(
      this.#ir.tables.flatMap((table) =>
        table.ftsIndexes.map((index) => [index.name, table.name] as const),
      ),
    );
    const dependencies = [
      ...new Set(refs.map((ref) => ftsOwners.get(ref.table) ?? ref.table)),
    ]
      .sort()
      .map((table) => {
        const instances = resolvedCandidates.filter(
          (item) => item.ref.table === table,
        );
        if (
          instances.length !== 1 ||
          instances.some((item) => item.scopes.length === 0)
        ) {
          return { table, scopes: [] };
        }
        const scopes = instances
          .flatMap((item) => item.scopes.map((scope) => scope.binding))
          .reduce<QueryScopeBinding[]>((out, scope) => {
            const existing = out.find(
              (item) => item.variable === scope.variable,
            );
            if (existing === undefined) out.push(scope);
            else {
              out[out.indexOf(existing)] = {
                ...existing,
                params: [...new Set([...existing.params, ...scope.params])],
              };
            }
            return out;
          }, []);
        return { table, scopes };
      });

    if (!logical.declaration.sync) return { dependencies, coverage: [] };
    const syncedCandidates = resolvedCandidates.filter((candidate) =>
      this.#ir.tables.some((table) => table.name === candidate.ref.table),
    );
    const eligible = syncedCandidates.filter((candidate) => {
      const table = this.#ir.tables.find(
        (item) => item.name === candidate.ref.table,
      );
      return (
        table !== undefined &&
        syncedCandidates.filter(
          (item) => item.ref.table === candidate.ref.table,
        ).length === 1 &&
        table.scopes.length > 0 &&
        candidate.scopes.length === table.scopes.length
      );
    });
    const syncBy = logical.declaration.syncBy;
    if (eligible.length === 0 || eligible.length !== syncedCandidates.length) {
      this.#fail(
        'SYQL6005_INVALID_SYNC_QUERY',
        logical.declaration.syncBy?.span ?? logical.declaration.nameSpan,
        'sync query coverage cannot be proven for every read table from required equality/IN predicates over every declared scope; split the query or add an exact compatible scope proof',
      );
    }
    const byCandidate =
      syncBy === undefined
        ? undefined
        : eligible.find(
            (candidate) => candidate.ref.alias === syncBy.qualifier,
          );
    if (syncBy !== undefined && byCandidate === undefined) {
      this.#fail(
        'SYQL6005_INVALID_SYNC_QUERY',
        syncBy.span,
        `sync query \`by ${syncBy.qualifier}.${syncBy.column}\` does not name one fully coverable table instance`,
      );
    }
    if (
      syncBy === undefined &&
      eligible.some((candidate) => {
        const table = this.#ir.tables.find(
          (item) => item.name === candidate.ref.table,
        );
        return (table?.scopes.length ?? 0) > 1;
      })
    ) {
      this.#fail(
        'SYQL6005_INVALID_SYNC_QUERY',
        logical.declaration.nameSpan,
        'a sync query reading any multi-scope table must select an anchor unit dimension with `by alias.scope_column`',
      );
    }

    let anchorUnit: InferredScope | undefined;
    if (byCandidate !== undefined && syncBy !== undefined) {
      const table = this.#ir.tables.find(
        (item) => item.name === byCandidate.ref.table,
      );
      const dimension = table?.scopes.find(
        (scope) => scope.column === syncBy.column,
      );
      anchorUnit = byCandidate.scopes.find(
        (scope) => scope.binding.variable === dimension?.variable,
      );
      if (dimension === undefined || anchorUnit === undefined) {
        this.#fail(
          'SYQL6005_INVALID_SYNC_QUERY',
          syncBy.span,
          `${byCandidate.ref.alias}.${syncBy.column} is not a proven declared scope`,
        );
      }
    }

    const sameParams = (
      left: readonly string[],
      right: readonly string[],
    ): boolean =>
      left.length === right.length &&
      left.every((value) => right.includes(value));
    const coverage = eligible.map((candidate): QueryCoverageBinding => {
      const table = this.#ir.tables.find(
        (item) => item.name === candidate.ref.table,
      );
      if (table === undefined) throw new Error('eligible table disappeared');
      const byVariable = new Map(
        candidate.scopes.map((scope) => [scope.binding.variable, scope]),
      );
      let unit: InferredScope | undefined;
      if (candidate === byCandidate) {
        unit = anchorUnit;
      } else if (table.scopes.length === 1) {
        unit = candidate.scopes[0];
      } else if (anchorUnit !== undefined) {
        const matching = candidate.scopes.filter((scope) =>
          sameParams(scope.binding.params, anchorUnit.binding.params),
        );
        if (matching.length === 1) unit = matching[0];
      }
      if (unit === undefined) {
        this.#fail(
          'SYQL6005_INVALID_SYNC_QUERY',
          syncBy?.span ?? logical.declaration.nameSpan,
          `joined multi-scope table ${table.name} has no unambiguous unit dimension compatible with the selected anchor; split the query`,
        );
      }
      const fixedScopes = table.scopes
        .filter((scope) => scope.variable !== unit.binding.variable)
        .map((scope) => {
          const fixed = byVariable.get(scope.variable) as
            | InferredScope
            | undefined;
          if (
            fixed === undefined ||
            fixed.operator !== 'equal' ||
            fixed.binding.params.length !== 1
          ) {
            this.#fail(
              'SYQL6005_INVALID_SYNC_QUERY',
              syncBy?.span ?? logical.declaration.nameSpan,
              `fixed sync scope ${table.name}.${scope.column} must use one required equality bind`,
            );
          }
          return {
            variable: fixed.binding.variable,
            params: fixed.binding.params,
          };
        });
      return {
        table: table.name,
        variable: unit.binding.variable,
        units: unit.binding.params,
        fixedScopes,
      };
    });
    coverage.sort((left, right) => left.table.localeCompare(right.table));
    return { dependencies, coverage };
  }

  #validateSort(
    query: SyqlQueryDeclaration,
    structure: SqlStructure,
    location: string,
  ): SyqlValidatedSort | undefined {
    if (query.sort === undefined) return undefined;
    if (structure.hasOuterOrder) {
      this.#fail(
        'SYQL6006_INVALID_SORT',
        query.sort.span,
        'sort section conflicts with authored outer ORDER BY',
      );
    }
    const profiles = query.sort.profiles.map((profile) => {
      const sql = templateText(profile.order);
      const tokens = significant(lexSyqlSqlSource(location, sql));
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] as SyqlToken;
        const lower = tokenLower(token);
        if (
          lower === 'select' ||
          lower === 'limit' ||
          lower === 'offset' ||
          lower === 'window' ||
          lower === 'over' ||
          lower === 'order' ||
          lower === 'group' ||
          lower === 'having'
        ) {
          this.#fail(
            'SYQL6006_INVALID_SORT',
            profile.order.span,
            `sort profile ${profile.name} contains forbidden ${token.text}`,
          );
        }
        if (
          token.kind === 'identifier' &&
          tokens[index + 1]?.text === '(' &&
          AGGREGATE_FUNCTIONS.has(lower ?? '')
        ) {
          this.#fail(
            'SYQL6006_INVALID_SORT',
            profile.order.span,
            `sort profile ${profile.name} contains aggregate ${token.text}()`,
          );
        }
      }
      this.#validateDeterminism(sql, profile.order.span);
      this.#validatePortableProfile(sql, profile.order.span);
      return { name: profile.name, sql };
    });
    return {
      control: query.sort.control,
      defaultProfile: query.sort.defaultProfile,
      profiles,
    };
  }

  #composeSort(
    sql: string,
    structure: SqlStructure,
    order: string | undefined,
  ): string {
    if (order === undefined) return sql.trim();
    const insertion = structure.tailStart ?? sql.length;
    return `${sql.slice(0, insertion).trimEnd()} order by ${order} ${sql
      .slice(insertion)
      .trimStart()}`.trim();
  }

  #proveIdentity(
    query: SyqlQueryDeclaration,
    sql: string,
    refs: readonly TableRef[],
    analysis: AnalyzedQuery,
  ): readonly string[] | undefined {
    const cleaned = stripCommentsAndStrings(sql);
    const nonSimple =
      /\b(?:DISTINCT|GROUP\s+BY|UNION|INTERSECT|EXCEPT|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN)\b/i.test(
        cleaned,
      ) ||
      /\b(?:count|sum|total|avg|min|max|group_concat)\s*\(/i.test(cleaned) ||
      (cleaned.match(/\bSELECT\b/gi)?.length ?? 0) !== 1 ||
      new Set(refs.map((ref) => `${ref.table}\0${ref.alias}`)).size !==
        refs.length ||
      new Set(refs.map((ref) => ref.table)).size !== refs.length;

    const resultNames = new Set<string>();
    for (const column of analysis.columns) {
      if (!IDENT_RE.test(column.name)) {
        this.#fail(
          'SYQL6008_INVALID_IDENTITY',
          query.statement.span,
          `result name ${JSON.stringify(column.name)} must be an unquoted IDENT value`,
        );
      }
      if (resultNames.has(column.name)) {
        this.#fail(
          'SYQL6008_INVALID_IDENTITY',
          query.statement.span,
          `result name ${JSON.stringify(column.name)} is duplicated`,
        );
      }
      resultNames.add(column.name);
    }

    if (nonSimple || refs.length === 0) return undefined;
    const inferred: string[] = [];
    for (const ref of refs) {
      const table = this.#ir.tables.find((item) => item.name === ref.table);
      const primaryKey =
        table?.primaryKey ??
        (this.#ir.tables.some((item) =>
          item.ftsIndexes.some((index) => index.name === ref.table),
        )
          ? '_syncular_source_id'
          : undefined);
      const column = analysis.columns.find(
        (candidate) =>
          primaryKey !== undefined &&
          candidate.origin?.table === ref.table &&
          candidate.origin.column === primaryKey &&
          !candidate.nullable,
      );
      if (column === undefined) return undefined;
      inferred.push(column.langName);
    }
    return inferred;
  }

  #validateStableOrder(
    query: SyqlQueryDeclaration,
    sql: string,
    structure: SqlStructure,
    sort: SyqlValidatedSort | undefined,
    identity: readonly string[] | undefined,
    analysis: AnalyzedQuery,
    refs: readonly TableRef[],
  ): void {
    const bounded =
      query.limit !== undefined ||
      structure.hasOuterLimit ||
      structure.hasOuterOffset;
    if (!bounded) return;
    if (identity === undefined || identity.length === 0) {
      this.#fail(
        'SYQL6006_INVALID_SORT',
        query.sort?.span ?? query.limit?.span ?? query.statement.span,
        'a bounded query requires a proven identity and total outer order',
      );
    }
    const orders =
      sort?.profiles.map((profile) => ({
        name: profile.name,
        sql: profile.sql,
        span: query.sort?.span ?? query.statement.span,
      })) ??
      (structure.orderBodyStart !== undefined &&
      structure.orderEnd !== undefined
        ? [
            {
              name: 'authored',
              sql: sql
                .slice(structure.orderBodyStart, structure.orderEnd)
                .trim(),
              span: query.statement.span,
            },
          ]
        : []);
    if (orders.length === 0) {
      this.#fail(
        'SYQL6006_INVALID_SORT',
        query.limit?.span ?? query.statement.span,
        'a bounded query requires an outer ORDER BY or sort section',
      );
    }
    for (const order of orders) {
      const terms = this.#splitOrderTerms(order.sql, order.span);
      if (terms.length < identity.length) {
        this.#fail(
          'SYQL6006_INVALID_SORT',
          order.span,
          `order ${order.name} does not end in the complete identity tie-breaker`,
        );
      }
      const suffix = terms.slice(terms.length - identity.length);
      identity.forEach((field, index) => {
        const result = analysis.columns.find(
          (column) => column.langName === field,
        );
        const origin = result?.origin;
        const match =
          /^(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)\s+(?:asc|desc)$/i.exec(
            suffix[index] ?? '',
          );
        if (
          origin === undefined ||
          match === null ||
          match[2] !== origin.column
        ) {
          this.#fail(
            'SYQL6006_INVALID_SORT',
            order.span,
            `order ${order.name} must end with plain ${origin?.column ?? field} ASC/DESC identity term`,
          );
        }
        const qualifier = match[1];
        if (qualifier !== undefined) {
          const ref = refs.find((candidate) => candidate.alias === qualifier);
          if (ref?.table !== origin.table) {
            this.#fail(
              'SYQL6006_INVALID_SORT',
              order.span,
              `identity order qualifier ${qualifier} does not resolve to ${origin.table}`,
            );
          }
        }
      });
    }
  }

  #splitOrderTerms(sql: string, span: SyqlSourceSpan): readonly string[] {
    const tokens = lexSyqlSqlSource(span.file, sql).filter(
      (token) => token.kind !== 'eof',
    );
    const terms: string[] = [];
    let depth = 0;
    let current = '';
    for (const token of tokens) {
      if (token.kind === 'punctuation' && token.text === ')') depth -= 1;
      if (token.kind === 'punctuation' && token.text === ',' && depth === 0) {
        if (current.trim().length === 0) {
          this.#fail('SYQL6006_INVALID_SORT', span, 'empty ORDER BY term');
        }
        terms.push(current.trim());
        current = '';
        continue;
      }
      current += token.text;
      if (token.kind === 'punctuation' && token.text === '(') depth += 1;
    }
    if (current.trim().length > 0) terms.push(current.trim());
    if (terms.length === 0) {
      this.#fail('SYQL6006_INVALID_SORT', span, 'empty ORDER BY list');
    }
    return terms;
  }

  #fail(
    code: SyqlValidationErrorCode,
    span: SyqlSourceSpan,
    message: string,
  ): never {
    throw new SyqlFrontendError(code, span, message);
  }
}

/** Validate a semantic SYQL program against schema IR and SQLite. */
export function validateSyqlProgram(
  semantic: SyqlSemanticProgram,
  ir: IrDocument,
  db: QueryDb,
  naming?: QueryNamingOptions,
): SyqlValidatedProgram {
  return new Validator(semantic, ir, db, naming).validate();
}
