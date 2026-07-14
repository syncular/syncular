/** Schema-aware revision-1 SYQL validation (§§5, 8–13). */
import type { IrColumnType, IrDocument, IrTable } from './ir';
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
  SyqlLogicalReactiveNode,
  SyqlLogicalTemplateNode,
  SyqlLogicalWhenNode,
  SyqlSemanticProgram,
} from './syql-semantics';

export type SyqlValidationErrorCode =
  | 'SYQL6001_INVALID_PLACEMENT'
  | 'SYQL6002_INVALID_SQL'
  | 'SYQL6003_NONDETERMINISTIC_SQL'
  | 'SYQL6004_TYPE_CONFLICT'
  | 'SYQL6005_INVALID_REACTIVE_DIRECTIVE'
  | 'SYQL6006_INVALID_SORT'
  | 'SYQL6007_INVALID_PAGE'
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
  readonly page?: {
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
  readonly node: SyqlLogicalWhenNode | SyqlLogicalReactiveNode;
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

interface ResolvedDirective {
  readonly node: SyqlLogicalReactiveNode;
  readonly ref: TableRef;
  readonly table: IrTable;
  readonly scopes: readonly QueryScopeBinding[];
  readonly coverage?: QueryCoverageBinding;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
const AGGREGATE_FUNCTIONS = new Set([
  'avg',
  'count',
  'group_concat',
  'max',
  'min',
  'sum',
  'total',
]);
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
    this.#validateDeterminism(activeSql, logical.declaration.sql.span);

    const refs = scanTableRefs(activeSql, this.#ir);
    const bindSymbols = this.#bindSymbols(logical.declaration);
    const resolvedDirectives = this.#resolveDirectives(
      logical,
      refs,
      bindSymbols,
    );
    const bindTypes = this.#resolveBindTypes(
      logical,
      activeSql,
      refs,
      bindSymbols,
      resolvedDirectives,
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
    if (logical.declaration.page !== undefined) {
      referenceSql = `${referenceSql.trimEnd()} limit ${logical.declaration.page.defaultSize}`;
    }

    const headers = [...bindTypes]
      .map(([name, type]) => `-- param :${name} ${type.base}`)
      .join('\n');
    const statement =
      headers.length === 0 ? referenceSql : `${headers}\n${referenceSql}`;
    let analysis: AnalyzedQuery;
    try {
      analysis = analyzeStatement(
        logical.declaration.name,
        location,
        statement,
        this.#ir,
        this.#db,
        this.#naming,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#fail(
        'SYQL6002_INVALID_SQL',
        logical.declaration.sql.span,
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
        logical.declaration.page === undefined
          ? candidate
          : `${candidate.trimEnd()} limit ${logical.declaration.page.defaultSize}`;
      try {
        this.#db.analyze(paged);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#fail(
          'SYQL6006_INVALID_SORT',
          logical.declaration.sort?.span ?? logical.declaration.sql.span,
          `sort profile ${profile.name} rejected by SQLite: ${message}`,
        );
      }
    }

    const reactive = this.#buildReactive(refs, resolvedDirectives);
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
      ...(logical.declaration.page === undefined
        ? {}
        : {
            page: {
              control: logical.declaration.page.control,
              defaultSize: logical.declaration.page.defaultSize,
              maxSize: logical.declaration.page.maxSize,
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
        return this.#renderDirective(node);
      })
      .join('');
  }

  #renderDirective(node: SyqlLogicalReactiveNode): string {
    const predicates = node.directive.bindings.map((binding) => {
      const column = `${binding.column.qualifier}.${binding.column.name}`;
      const values = binding.values.map((value) => `:${value.name}`);
      return binding.operator === 'equal'
        ? `${column} = ${values[0]}`
        : `${column} in (${values.join(', ')})`;
    });
    return `(${predicates.join(' and ')})`;
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
          `${marker.node.kind === 'when' ? 'when' : `@${marker.node.kind}`} must be an entire outer conjunct`,
        );
      }
      if (marker.node.kind === 'when') {
        if (clause !== 'where' && clause !== 'having') {
          this.#fail(
            'SYQL6001_INVALID_PLACEMENT',
            marker.node.span,
            'when is allowed only in the outer WHERE or HAVING clause',
          );
        }
      } else if (clause !== 'where') {
        this.#fail(
          'SYQL6001_INVALID_PLACEMENT',
          marker.node.span,
          `@${marker.node.kind} is allowed only in the outer WHERE clause`,
        );
      }
    }
    for (const marker of markers) {
      if (!structure.outer.some((item) => item.token.text === marker.name)) {
        this.#fail(
          'SYQL6001_INVALID_PLACEMENT',
          marker.node.span,
          `${marker.node.kind === 'when' ? 'when' : `@${marker.node.kind}`} cannot appear in a nested SQL expression or statement`,
        );
      }
    }
    if (structure.hasCompound && markers.length > 0) {
      this.#fail(
        'SYQL6001_INVALID_PLACEMENT',
        query.sql.span,
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
      query.page !== undefined &&
      (structure.hasOuterLimit || structure.hasOuterOffset)
    ) {
      this.#fail(
        'SYQL6007_INVALID_PAGE',
        query.page.span,
        'page declaration conflicts with an authored outer LIMIT or OFFSET',
      );
    }
    const first = structure.outer
      .find((item) => item.token.kind === 'identifier')
      ?.token.text.toLowerCase();
    if (first !== 'select' && first !== 'with') {
      this.#fail(
        'SYQL6002_INVALID_SQL',
        query.sql.span,
        `${location} must contain one SELECT or WITH ... SELECT statement`,
      );
    }
    if (sql.trim().length === 0) {
      this.#fail('SYQL6002_INVALID_SQL', query.sql.span, 'empty SQL statement');
    }
  }

  #validateDeterminism(sql: string, span: SyqlSourceSpan): void {
    const tokens = significant(lexSyqlSqlSource(span.file, sql));
    const functionStack: Array<string | undefined> = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index] as SyqlToken;
      const lower = tokenLower(token);
      const next = tokens[index + 1];
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
      } else if (token.text === ')') {
        functionStack.pop();
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

  #bindSymbols(query: SyqlQueryDeclaration): ReadonlyMap<string, BindSymbol> {
    const symbols = new Map<string, BindSymbol>();
    for (const parameter of query.parameters) {
      if (parameter.kind === 'switch') continue;
      if (parameter.kind === 'group') {
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
    directives: readonly ResolvedDirective[],
  ): ReadonlyMap<string, SyqlValueType> {
    const resolved = new Map(logical.bindTypes);
    const directiveTypes = new Map<string, IrColumnType[]>();
    for (const directive of directives) {
      for (const binding of directive.node.directive.bindings) {
        const column = directive.table.columns.find(
          (item) => item.name === binding.column.name,
        );
        if (column === undefined) continue;
        for (const bind of binding.values) {
          const list = directiveTypes.get(bind.name) ?? [];
          list.push(column.type);
          directiveTypes.set(bind.name, list);
        }
      }
    }

    for (const symbol of symbols.values()) {
      const evidence = [
        ...inferParamTypeEvidence(symbol.name, sql, refs, this.#ir),
        ...(directiveTypes.get(symbol.name) ?? []),
      ];
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
    for (const directive of directives) {
      for (const binding of directive.node.directive.bindings) {
        const column = directive.table.columns.find(
          (item) => item.name === binding.column.name,
        );
        if (column === undefined) continue;
        for (const bind of binding.values) {
          const type = resolved.get(bind.name);
          if (
            type === undefined ||
            type.base !== column.type ||
            type.nullable !== column.nullable
          ) {
            this.#fail(
              'SYQL6005_INVALID_REACTIVE_DIRECTIVE',
              bind.span,
              `scope bind :${bind.name} must exactly match ${column.type}${column.nullable ? ' | null' : ''}`,
            );
          }
        }
      }
    }
    return resolved;
  }

  #resolveDirectives(
    logical: SyqlLogicalQuery,
    refs: readonly TableRef[],
    symbols: ReadonlyMap<string, BindSymbol>,
  ): readonly ResolvedDirective[] {
    const nodes: SyqlLogicalReactiveNode[] = [];
    const collect = (template: readonly SyqlLogicalTemplateNode[]): void => {
      for (const node of template) {
        if (node.kind === 'scope' || node.kind === 'cover') nodes.push(node);
        else if (node.kind === 'predicate') collect(node.body);
      }
    };
    collect(logical.template);
    return nodes.map((node) => {
      const first = node.directive.bindings[0];
      if (first === undefined) {
        this.#fail(
          'SYQL6005_INVALID_REACTIVE_DIRECTIVE',
          node.span,
          `@${node.kind} requires a binding`,
        );
      }
      const qualifier = first.column.qualifier;
      const matchingRefs = refs.filter((ref) => ref.alias === qualifier);
      if (matchingRefs.length !== 1) {
        this.#fail(
          'SYQL6005_INVALID_REACTIVE_DIRECTIVE',
          first.column.span,
          `scope qualifier ${qualifier} must resolve to exactly one read table instance`,
        );
      }
      const ref = matchingRefs[0] as TableRef;
      const table = this.#ir.tables.find((item) => item.name === ref.table);
      if (table === undefined) {
        this.#fail(
          'SYQL6005_INVALID_REACTIVE_DIRECTIVE',
          first.column.span,
          `scope qualifier ${qualifier} does not resolve to a synced table`,
        );
      }
      const seenColumns = new Set<string>();
      const scopes: QueryScopeBinding[] = [];
      for (const binding of node.directive.bindings) {
        if (binding.column.qualifier !== qualifier) {
          this.#fail(
            'SYQL6005_INVALID_REACTIVE_DIRECTIVE',
            binding.column.span,
            `all @${node.kind} bindings must name the same table instance`,
          );
        }
        if (seenColumns.has(binding.column.name)) {
          this.#fail(
            'SYQL6005_INVALID_REACTIVE_DIRECTIVE',
            binding.column.span,
            `scope column ${binding.column.name} is listed twice`,
          );
        }
        seenColumns.add(binding.column.name);
        const scope = table.scopes.find(
          (candidate) => candidate.column === binding.column.name,
        );
        if (scope === undefined) {
          this.#fail(
            'SYQL6005_INVALID_REACTIVE_DIRECTIVE',
            binding.column.span,
            `${table.name}.${binding.column.name} is not a declared scope column`,
          );
        }
        for (const bind of binding.values) {
          const symbol = symbols.get(bind.name);
          if (
            symbol === undefined ||
            symbol.parameter.kind !== 'value' ||
            symbol.parameter.optional
          ) {
            this.#fail(
              'SYQL6005_INVALID_REACTIVE_DIRECTIVE',
              bind.span,
              `scope value :${bind.name} must be a required scalar input`,
            );
          }
        }
        scopes.push({
          table: table.name,
          variable: scope.variable,
          pattern: scope.pattern,
          params: binding.values.map((value) => value.name),
        });
      }
      let coverage: QueryCoverageBinding | undefined;
      if (node.kind === 'cover') {
        const required = new Set(table.scopes.map((scope) => scope.column));
        if (
          seenColumns.size !== required.size ||
          [...required].some((column) => !seenColumns.has(column))
        ) {
          this.#fail(
            'SYQL6005_INVALID_REACTIVE_DIRECTIVE',
            node.span,
            `@cover for ${table.name} must bind every declared scope exactly once`,
          );
        }
        const firstScope = scopes[0] as QueryScopeBinding;
        for (
          let index = 1;
          index < node.directive.bindings.length;
          index += 1
        ) {
          const binding = node.directive.bindings[index];
          if (binding?.operator !== 'equal' || binding.values.length !== 1) {
            this.#fail(
              'SYQL6005_INVALID_REACTIVE_DIRECTIVE',
              binding?.span ?? node.span,
              'fixed @cover scopes after the first binding must use one equality bind',
            );
          }
        }
        const byVariable = new Map(
          scopes.map((scope) => [scope.variable, scope]),
        );
        coverage = {
          table: table.name,
          variable: firstScope.variable,
          units: firstScope.params,
          fixedScopes: table.scopes
            .filter((scope) => scope.variable !== firstScope.variable)
            .map((scope) => {
              const fixed = byVariable.get(scope.variable) as QueryScopeBinding;
              return { variable: fixed.variable, params: fixed.params };
            }),
        };
      }
      return {
        node,
        ref,
        table,
        scopes,
        ...(coverage === undefined ? {} : { coverage }),
      };
    });
  }

  #buildReactive(
    refs: readonly TableRef[],
    directives: readonly ResolvedDirective[],
  ): QueryReactiveMetadata {
    const dependencies: Array<{
      table: string;
      scopes: QueryScopeBinding[];
    }> = [];
    const coverage: QueryCoverageBinding[] = [];
    for (const tableName of [...new Set(refs.map((ref) => ref.table))].sort()) {
      const instances = refs.filter((ref) => ref.table === tableName);
      const byAlias = new Map<string, ResolvedDirective[]>();
      for (const directive of directives.filter(
        (item) => item.table.name === tableName,
      )) {
        const list = byAlias.get(directive.ref.alias) ?? [];
        list.push(directive);
        byAlias.set(directive.ref.alias, list);
      }
      const fallback = instances.some(
        (instance) => !byAlias.has(instance.alias),
      );
      const scopes = fallback
        ? []
        : [...byAlias.values()]
            .flatMap((items) => items.flatMap((item) => item.scopes))
            .reduce<QueryScopeBinding[]>((out, scope) => {
              const existing = out.find(
                (item) => item.variable === scope.variable,
              );
              if (existing === undefined) out.push(scope);
              else {
                const merged = [
                  ...new Set([...existing.params, ...scope.params]),
                ];
                out[out.indexOf(existing)] = { ...existing, params: merged };
              }
              return out;
            }, []);
      dependencies.push({ table: tableName, scopes });
      if (!fallback) {
        coverage.push(
          ...[...byAlias.values()].flatMap((items) =>
            items.flatMap((item) =>
              item.coverage === undefined ? [] : [item.coverage],
            ),
          ),
        );
      }
    }
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
          query.identity?.span ?? query.sql.span,
          `result name ${JSON.stringify(column.name)} must be an unquoted IDENT value`,
        );
      }
      if (resultNames.has(column.name)) {
        this.#fail(
          'SYQL6008_INVALID_IDENTITY',
          query.identity?.span ?? query.sql.span,
          `result name ${JSON.stringify(column.name)} is duplicated`,
        );
      }
      resultNames.add(column.name);
    }

    if (query.identity !== undefined) {
      if (nonSimple) {
        this.#fail(
          'SYQL6008_INVALID_IDENTITY',
          query.identity.span,
          'identity cannot be proven for this grouped, compound, nested, outer-join, aggregate, or self-join shape',
        );
      }
      const selected = query.identity.fields.map((field) => {
        const matches = analysis.columns.filter(
          (column) => column.name === field,
        );
        const column = matches[0];
        if (
          matches.length !== 1 ||
          column === undefined ||
          column.fidelity !== 'exact' ||
          column.nullable ||
          column.origin === undefined
        ) {
          this.#fail(
            'SYQL6008_INVALID_IDENTITY',
            query.identity?.span ?? query.sql.span,
            `identity field ${field} must be one exact, non-null physical result column`,
          );
        }
        return column;
      });
      for (const ref of refs) {
        const table = this.#ir.tables.find((item) => item.name === ref.table);
        if (
          table !== undefined &&
          !selected.some(
            (column) =>
              column.origin?.table === table.name &&
              column.origin.column === table.primaryKey,
          )
        ) {
          this.#fail(
            'SYQL6008_INVALID_IDENTITY',
            query.identity.span,
            `identity must include projected primary key ${table.name}.${table.primaryKey}`,
          );
        }
      }
      return selected.map((column) => column.langName);
    }

    if (nonSimple || refs.length === 0) return undefined;
    const inferred: string[] = [];
    for (const ref of refs) {
      const table = this.#ir.tables.find((item) => item.name === ref.table);
      const column = analysis.columns.find(
        (candidate) =>
          table !== undefined &&
          candidate.origin?.table === table.name &&
          candidate.origin.column === table.primaryKey &&
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
      query.page !== undefined ||
      structure.hasOuterLimit ||
      structure.hasOuterOffset;
    if (!bounded) return;
    if (identity === undefined || identity.length === 0) {
      this.#fail(
        'SYQL6006_INVALID_SORT',
        query.sort?.span ?? query.page?.span ?? query.sql.span,
        'a bounded query requires a proven identity and total outer order',
      );
    }
    const orders =
      sort?.profiles.map((profile) => ({
        name: profile.name,
        sql: profile.sql,
        span: query.sort?.span ?? query.sql.span,
      })) ??
      (structure.orderBodyStart !== undefined &&
      structure.orderEnd !== undefined
        ? [
            {
              name: 'authored',
              sql: sql
                .slice(structure.orderBodyStart, structure.orderEnd)
                .trim(),
              span: query.sql.span,
            },
          ]
        : []);
    if (orders.length === 0) {
      this.#fail(
        'SYQL6006_INVALID_SORT',
        query.page?.span ?? query.sql.span,
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
