/**
 * TS named-query emitter: analyzed queries → a standalone
 * `syncular.queries.ts` module. Per query `q` it emits:
 *
 * - `QRow` — the projection row interface (its OWN type per query — the
 *   drift-kill: the row shape is exactly what the SELECT returns),
 * - `QParams` — the typed public input object when the query has inputs,
 * - `qTables` — the readonly table-dependency set (feeds useRawSql `{tables}`
 *   for EXACT invalidation),
 * - `q(client, params?): Promise<QRow[]>` — runs the query over the wrapper's
 *   positional `query(sql, params[])` surface, reordering the named params
 *   object into the positional array the wire expects. Revision-1 SYQL
 *   selection is driven exclusively by its target-neutral physical plan.
 *
 * A tiny structural `QueryClient` interface (just `query(sql, params?)`) keeps
 * the module import-free — it structurally accepts `SyncClientLike` /
 * `SyncClient` / `SyncClientHandle` alike. Header carries the IR hash so
 * `--check` gates freshness byte-exactly, like every other emitter.
 */
import type { IrColumnType } from './ir';
import type {
  AnalyzedQuery,
  QueryParam,
  QuerySyqlPlanBind,
  QuerySyqlPublicInput,
} from './query';

const TS_TYPE: Readonly<Record<IrColumnType, string>> = {
  string: 'string',
  integer: 'number',
  float: 'number',
  boolean: 'boolean',
  json: 'string',
  bytes: 'Uint8Array',
  blob_ref: 'string',
  crdt: 'Uint8Array',
};

function pascalCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function propertyKey(name: string): string {
  return IDENTIFIER_RE.test(name) ? name : quote(name);
}

function emitResultMapper(query: AnalyzedQuery, Row: string): string[] {
  const booleans = query.columns.filter((column) => column.type === 'boolean');
  const lines = [
    `/** Decode one storage-shaped result row for ${quote(query.name)}. */`,
    `export function ${query.name}MapRow(row: Readonly<Record<string, unknown>>): ${Row} {`,
  ];
  if (booleans.length === 0) {
    lines.push(`  return row as unknown as ${Row};`);
  } else {
    lines.push('  return {', '    ...row,');
    for (const column of booleans) {
      const access = `row[${quote(column.langName)}]`;
      const decoded = `decodeQueryBoolean(${access}, ${quote(query.name)}, ${quote(column.langName)})`;
      lines.push(
        `    ${propertyKey(column.langName)}: ${column.nullable ? `${access} === null ? null : ${decoded}` : decoded},`,
      );
    }
    lines.push(`  } as unknown as ${Row};`);
  }
  lines.push('}');
  return lines;
}

/** A named-query param value is the SqlValue subset its type maps to. */
const PARAM_TS_TYPE: Readonly<Record<IrColumnType, string>> = TS_TYPE;
const SYQL_PARAM_TS_TYPE: Readonly<Record<IrColumnType, string>> = {
  ...TS_TYPE,
  integer: 'bigint',
};

function bindExpr(param: QueryParam): string {
  return `params.${propertyKey(param.langName)}`;
}

function reactiveParam(query: AnalyzedQuery, name: string): string {
  if (query.syql !== undefined) {
    const input = query.syql.inputs.find(
      (candidate) => candidate.kind === 'value' && candidate.name === name,
    );
    if (input?.kind !== 'value')
      throw new Error(`unknown reactive input ${name}`);
    const access = `params.${propertyKey(input.langName)}`;
    return `String(${input.default === false ? `${access} ?? false` : access})`;
  }
  const param = query.params.find((candidate) => candidate.name === name);
  if (param === undefined) throw new Error(`unknown reactive param ${name}`);
  return `String(params.${propertyKey(param.langName)})`;
}

function syqlInput(query: AnalyzedQuery, name: string): QuerySyqlPublicInput {
  const input = query.syql?.inputs.find((candidate) => candidate.name === name);
  if (input === undefined) throw new Error(`unknown SYQL input ${name}`);
  return input;
}

function syqlTsValueType(type: IrColumnType, nullable: boolean): string {
  return `${SYQL_PARAM_TS_TYPE[type]}${nullable ? ' | null' : ''}`;
}

function syqlTsTypeCheck(
  expression: string,
  type: IrColumnType,
  nullable: boolean,
): string {
  let check: string;
  switch (type) {
    case 'integer':
      check = `typeof ${expression} === 'bigint'`;
      break;
    case 'float':
      check = `typeof ${expression} === 'number' && Number.isFinite(${expression})`;
      break;
    case 'boolean':
      check = `typeof ${expression} === 'boolean'`;
      break;
    case 'bytes':
    case 'crdt':
      check = `${expression} instanceof Uint8Array`;
      break;
    default:
      check = `typeof ${expression} === 'string'`;
  }
  return nullable ? `${expression} === null || (${check})` : check;
}

function syqlControlActive(
  query: AnalyzedQuery,
  control: string,
  params: string,
): string {
  const input = syqlInput(query, control);
  const access = `${params}.${propertyKey(input.langName)}`;
  if (input.kind === 'value' && input.default === false)
    return `${access} === true`;
  if (input.kind === 'value' || input.kind === 'group') {
    return `${access} !== undefined`;
  }
  throw new Error(`${control} is not an activation control`);
}

function syqlBindExpr(
  query: AnalyzedQuery,
  bind: QuerySyqlPlanBind,
  params: string,
): string {
  if (bind.kind === 'condition-active') {
    return bind.controls
      .map((control) => syqlControlActive(query, control, params))
      .join(' && ');
  }
  const input = syqlInput(query, bind.input);
  const access = `${params}.${propertyKey(input.langName)}`;
  if (bind.kind === 'limit') {
    if (input.kind !== 'limit') throw new Error('limit bind/input mismatch');
    return `${access} ?? ${input.defaultSize}`;
  }
  if (bind.kind === 'group-member') {
    if (input.kind !== 'group') throw new Error('group bind/input mismatch');
    const member = input.members.find(
      (candidate) => candidate.name === bind.member,
    );
    if (member === undefined)
      throw new Error(`unknown group member ${bind.member}`);
    return `${access}?.${propertyKey(member.langName)} ?? null`;
  }
  if (input.kind !== 'value') throw new Error('value bind/input mismatch');
  if (input.default === false) return `${access} ?? false`;
  if (input.required) return access;
  return input.nullable ? `${access}?.value ?? null` : `${access} ?? null`;
}

function emitSyqlValidation(query: AnalyzedQuery, Params: string): string[] {
  const inputs = query.syql?.inputs ?? [];
  const lines: string[] = [];
  lines.push(
    `function ${query.name}Validate(raw?: ${Params}): ${Params} {`,
    `  const params = raw ?? ({} as ${Params});`,
    `  const allowed = new Set([${inputs.map((input) => quote(input.langName)).join(', ')}]);`,
    '  for (const key of Object.keys(params)) {',
    `    if (!allowed.has(key)) throw new SyqlInputError('SYQL_RUNTIME_UNKNOWN_INPUT', ${quote(query.name)} + ': unknown input ' + key);`,
    '  }',
  );
  for (const input of inputs) {
    const key = propertyKey(input.langName);
    const access = `params.${key}`;
    if (input.kind === 'value') {
      if (input.required) {
        lines.push(
          `  if (!Object.prototype.hasOwnProperty.call(params, ${quote(input.langName)})) throw new SyqlInputError('SYQL_RUNTIME_MISSING_REQUIRED_INPUT', ${quote(`${query.name}: missing required input ${input.name}`)});`,
          `  if (!(${syqlTsTypeCheck(access, input.type, input.nullable)})) throw new SyqlInputError('SYQL_RUNTIME_INVALID_INPUT', ${quote(`${query.name}: invalid input ${input.name}`)});`,
        );
      } else if (input.nullable) {
        lines.push(
          `  if (${access} !== undefined && (typeof ${access} !== 'object' || ${access} === null || ${access}.present !== true || !(${syqlTsTypeCheck(`${access}.value`, input.type, true)}))) throw new SyqlInputError('SYQL_RUNTIME_INVALID_INPUT', ${quote(`${query.name}: invalid optional input ${input.name}`)});`,
        );
      } else {
        lines.push(
          `  if (${access} !== undefined && !(${syqlTsTypeCheck(access, input.type, false)})) throw new SyqlInputError('SYQL_RUNTIME_INVALID_INPUT', ${quote(`${query.name}: invalid optional input ${input.name}`)});`,
        );
      }
    } else if (input.kind === 'group') {
      lines.push(
        `  if (${access} !== undefined) {`,
        `    if (typeof ${access} !== 'object' || ${access} === null) throw new SyqlInputError('SYQL_RUNTIME_INVALID_GROUP', ${quote(`${query.name}: invalid group ${input.name}`)});`,
        `    const allowedMembers = new Set([${input.members.map((member) => quote(member.langName)).join(', ')}]);`,
        `    if (Object.keys(${access}).some((key) => !allowedMembers.has(key))) throw new SyqlInputError('SYQL_RUNTIME_INVALID_GROUP', ${quote(`${query.name}: unknown member in group ${input.name}`)});`,
      );
      for (const member of input.members) {
        const memberAccess = `${access}.${propertyKey(member.langName)}`;
        lines.push(
          `    if (!Object.prototype.hasOwnProperty.call(${access}, ${quote(member.langName)}) || !(${syqlTsTypeCheck(memberAccess, member.type, member.nullable)})) throw new SyqlInputError('SYQL_RUNTIME_INVALID_GROUP', ${quote(`${query.name}: invalid or partial group ${input.name}`)});`,
        );
      }
      lines.push('  }');
    } else if (input.kind === 'sort') {
      lines.push(
        `  if (${access} !== undefined && ![${input.profiles.map((profile) => quote(profile.langName)).join(', ')}].includes(${access})) throw new SyqlInputError('SYQL_RUNTIME_INVALID_SORT', ${quote(`${query.name}: invalid sort profile`)});`,
      );
    } else {
      lines.push(
        `  if (${access} !== undefined && (!Number.isSafeInteger(${access}) || ${access} < 1 || ${access} > ${input.maxSize})) throw new SyqlInputError('SYQL_RUNTIME_INVALID_LIMIT', ${quote(`${query.name}: limit must be an integer from 1 through ${input.maxSize}`)});`,
      );
    }
  }
  lines.push('  return params;', '}');
  return lines;
}

function emitSyqlQuery(query: AnalyzedQuery, hash: string): string {
  const metadata = query.syql;
  if (metadata === undefined) throw new Error('missing SYQL metadata');
  const Row = `${pascalCase(query.name)}Row`;
  const Params = `${pascalCase(query.name)}Params`;
  const inputs = metadata.inputs;
  const hasParams = inputs.length > 0;
  const requiresParams = inputs.some(
    (input) => input.kind === 'value' && input.required,
  );
  const lines: string[] = [];
  lines.push(
    `/** One row of the ${quote(query.name)} query (its projection). */`,
  );
  lines.push(`export interface ${Row} {`);
  for (const column of query.columns) {
    lines.push(
      `  ${propertyKey(column.langName)}: ${TS_TYPE[column.type]}${column.nullable ? ' | null' : ''};`,
    );
  }
  lines.push('}', '');
  lines.push(...emitResultMapper(query, Row), '');

  for (const input of inputs) {
    if (input.kind === 'group') {
      lines.push(
        `export interface ${pascalCase(query.name)}${pascalCase(input.langName)} {`,
      );
      for (const member of input.members) {
        lines.push(
          `  ${propertyKey(member.langName)}: ${syqlTsValueType(member.type, member.nullable)};`,
        );
      }
      lines.push('}', '');
    }
  }
  if (hasParams) {
    lines.push(
      `/** Public revision-1 SYQL inputs for ${quote(query.name)}. */`,
    );
    lines.push(`export interface ${Params} {`);
    for (const input of inputs) {
      const key = propertyKey(input.langName);
      if (input.kind === 'value') {
        const optional = !input.required;
        const type = syqlTsValueType(input.type, input.nullable);
        lines.push(
          `  ${key}${optional ? '?' : ''}: ${optional && input.nullable ? `SyqlPresent<${type}>` : type};`,
        );
      } else if (input.kind === 'group') {
        lines.push(
          `  ${key}?: ${pascalCase(query.name)}${pascalCase(input.langName)};`,
        );
      } else if (input.kind === 'sort') {
        lines.push(
          `  ${key}?: ${input.profiles.map((profile) => quote(profile.langName)).join(' | ')};`,
        );
      } else {
        lines.push(`  ${key}?: number;`);
      }
    }
    lines.push('}', '');
    lines.push(...emitSyqlValidation(query, Params), '');
  }

  lines.push(
    `/** Tables ${quote(query.name)} reads (compatibility/export surface). */`,
    `export const ${query.name}Tables = [${query.tables.map(quote).join(', ')}] as const;`,
    '',
  );
  const paramDecl = !hasParams
    ? ''
    : requiresParams
      ? `raw: ${Params}`
      : `raw?: ${Params}`;
  const validated = hasParams ? `${query.name}Validate(raw)` : undefined;
  const statementType = hasParams
    ? `{ sql: string; bind: (params: ${Params}) => QueryValue[] }`
    : '{ sql: string; bind: () => QueryValue[] }';
  lines.push(`const ${query.name}Statements: ${statementType}[] = [`);
  for (const statement of metadata.plan.statements) {
    const binds = statement.binds
      .map((bind) => syqlBindExpr(query, bind, 'params'))
      .join(', ');
    lines.push(
      `  { sql: ${quote(statement.positionalSql)}, bind: (${hasParams ? 'params' : ''}) => [${binds}] },`,
    );
  }
  lines.push('];');
  const sort = inputs.find((input) => input.kind === 'sort');
  if (sort?.kind === 'sort') {
    lines.push(
      `const ${query.name}SortIndexes = { ${sort.profiles.map((profile, index) => `${propertyKey(profile.langName)}: ${index}`).join(', ')} } as const;`,
    );
  }
  lines.push(
    `function ${query.name}Select(${paramDecl}): { sql: string; bind: QueryValue[] } {`,
  );
  if (validated !== undefined) lines.push(`  const params = ${validated};`);
  let maskExpression = '0';
  if (metadata.plan.backend === 'variants') {
    lines.push('  let mask = 0;');
    metadata.plan.activationControls.forEach((control, index) => {
      lines.push(
        `  if (${syqlControlActive(query, control, 'params')}) mask |= ${2 ** index};`,
      );
    });
    maskExpression = 'mask';
  }
  let sortExpression = '0';
  const profileCount = sort?.kind === 'sort' ? sort.profiles.length : 1;
  if (sort?.kind === 'sort') {
    sortExpression = `${query.name}SortIndexes[params.${propertyKey(sort.langName)} ?? ${quote(sort.profiles.find((profile) => profile.name === sort.defaultProfile)?.langName ?? sort.defaultProfile)}]`;
  }
  const indexExpression =
    metadata.plan.backend === 'variants'
      ? `${maskExpression} * ${profileCount} + ${sortExpression}`
      : sortExpression;
  lines.push(
    `  const statement = ${query.name}Statements[${indexExpression}];`,
    `  if (statement === undefined) throw new Error('invalid generated SYQL statement index');`,
    `  return { sql: statement.sql, bind: statement.bind(${hasParams ? 'params' : ''}) };`,
    '}',
    '',
  );

  const runnerParam = !hasParams
    ? ''
    : requiresParams
      ? `, params: ${Params}`
      : `, params?: ${Params}`;
  lines.push(
    `/** Run the ${quote(query.name)} named query (SELECT-only). */`,
    `export async function ${query.name}(client: QueryClient${runnerParam}): Promise<${Row}[]> {`,
    `  const selected = ${query.name}Select(${hasParams ? 'params' : ''});`,
    '  const rows = await client.query(selected.sql, selected.bind);',
    `  return rows.map((row) => ${query.name}MapRow(row as Readonly<Record<string, unknown>>));`,
    '}',
    '',
  );

  const paramsType = hasParams ? Params : 'undefined';
  const defaultStatement = metadata.plan.statements.find(
    (statement) =>
      (statement.activationMask === undefined ||
        statement.activationMask === 0) &&
      (sort?.kind !== 'sort' || statement.sortProfile === sort.defaultProfile),
  );
  lines.push(
    `/** Revisioned reactive descriptor for \`useQuery(${query.name}Query${hasParams ? ', params' : ''})\`. */`,
    `export const ${query.name}Query: NamedQuery<${Row}, ${paramsType}> = {`,
    `  id: ${quote(`${hash}/${query.name}`)},`,
    `  hasParams: ${hasParams},`,
    `  sql: ${quote(defaultStatement?.positionalSql ?? query.positionalSql)},`,
    `  mapRow: ${query.name}MapRow,`,
  );
  if (hasParams) {
    lines.push(
      `  sqlFor: (params: ${Params}) => ${query.name}Select(params).sql,`,
    );
  }
  lines.push(`  tables: ${query.name}Tables,`);
  const reactiveUsesParams = query.reactive.dependencies.some((dependency) =>
    dependency.scopes.some((scope) => scope.params.length > 0),
  );
  lines.push(`  dependencies: (${reactiveUsesParams ? 'params' : ''}) => [`);
  for (const dependency of query.reactive.dependencies) {
    const keys = dependency.scopes.flatMap((scope) =>
      scope.params.map((param) =>
        scopeKeyExpression(query, scope.pattern, scope.variable, param),
      ),
    );
    lines.push(
      `    { table: ${quote(dependency.table)}${keys.length > 0 ? `, scopeKeys: [${keys.join(', ')}]` : ''} },`,
    );
  }
  lines.push('  ],');
  const coverageUsesParams = query.reactive.coverage.some(
    (coverage) =>
      coverage.units.length > 0 ||
      coverage.fixedScopes.some((scope) => scope.params.length > 0),
  );
  lines.push(`  coverage: (${coverageUsesParams ? 'params' : ''}) => [`);
  for (const coverage of query.reactive.coverage) {
    const fixed = coverage.fixedScopes
      .map(
        (scope) =>
          `${propertyKey(scope.variable)}: [${scope.params.map((param) => reactiveParam(query, param)).join(', ')}]`,
      )
      .join(', ');
    lines.push(
      `    { base: { table: ${quote(coverage.table)}, variable: ${quote(coverage.variable)}${fixed.length > 0 ? `, fixedScopes: { ${fixed} }` : ''} }, units: [${coverage.units.map((param) => reactiveParam(query, param)).join(', ')}] },`,
    );
  }
  lines.push(
    '  ],',
    hasParams
      ? `  bind: (params: ${Params}) => ${query.name}Select(params).bind,`
      : `  bind: () => ${query.name}Select().bind,`,
  );
  if (query.reactive.rowKey !== undefined) {
    lines.push(
      `  rowKey: (row) => [${query.reactive.rowKey.map((key) => `row.${propertyKey(key)}`).join(', ')}],`,
    );
  }
  lines.push('};');
  return lines.join('\n');
}

function scopeKeyExpression(
  query: AnalyzedQuery,
  pattern: string,
  variable: string,
  param: string,
): string {
  const marker = `{${variable}}`;
  const index = pattern.indexOf(marker);
  if (index < 0) throw new Error(`scope pattern ${pattern} lacks ${marker}`);
  const prefix = pattern.slice(0, index);
  const suffix = pattern.slice(index + marker.length);
  return `${quote(prefix)} + ${reactiveParam(query, param)} + ${quote(suffix)}`;
}

function emitQuery(query: AnalyzedQuery, hash: string): string {
  if (query.syql !== undefined) return emitSyqlQuery(query, hash);
  const Row = `${pascalCase(query.name)}Row`;
  const Params = `${pascalCase(query.name)}Params`;
  const lines: string[] = [];

  lines.push(
    `/** One row of the ${quote(query.name)} query (its projection). */`,
  );
  lines.push(`export interface ${Row} {`);
  for (const column of query.columns) {
    lines.push(
      `  ${propertyKey(column.langName)}: ${TS_TYPE[column.type]}${column.nullable ? ' | null' : ''};`,
    );
  }
  lines.push('}');
  lines.push('');
  lines.push(...emitResultMapper(query, Row));
  lines.push('');

  const hasParams = query.params.length > 0;
  if (hasParams) {
    lines.push(`/** Named parameters for ${quote(query.name)}. */`);
    lines.push(`export interface ${Params} {`);
    for (const param of query.params) {
      lines.push(
        `  ${propertyKey(param.langName)}: ${PARAM_TS_TYPE[param.type]};`,
      );
    }
    lines.push('}');
    lines.push('');
  }

  lines.push(
    `/** Tables ${quote(query.name)} reads (compatibility/export surface). */`,
  );
  lines.push(
    `export const ${query.name}Tables = [${query.tables.map(quote).join(', ')}] as const;`,
  );
  lines.push('');

  const sqlConst = `${query.name}Sql`;
  lines.push(`const ${sqlConst} = ${quote(query.positionalSql)};`);
  const positional = hasParams
    ? `[${query.params.map(bindExpr).join(', ')}]`
    : '[]';
  lines.push('');

  lines.push(`/** Run the ${quote(query.name)} named query (SELECT-only). */`);
  lines.push(
    `export async function ${query.name}(client: QueryClient${hasParams ? `, params: ${Params}` : ''}): Promise<${Row}[]> {`,
  );
  if (hasParams) {
    lines.push(
      `  const rows = await client.query(${sqlConst}, ${positional});`,
    );
  } else {
    lines.push(`  const rows = await client.query(${sqlConst});`);
  }
  lines.push(
    `  return rows.map((row) => ${query.name}MapRow(row as Readonly<Record<string, unknown>>));`,
  );
  lines.push('}');
  lines.push('');

  lines.push(
    `/** Revisioned reactive descriptor for \`useQuery(${query.name}Query${hasParams ? ', params' : ''})\`. */`,
  );
  const paramsTypeArg = hasParams ? Params : 'undefined';
  lines.push(
    `export const ${query.name}Query: NamedQuery<${Row}, ${paramsTypeArg}> = {`,
  );
  lines.push(`  id: ${quote(`${hash}/${query.name}`)},`);
  lines.push(`  hasParams: ${hasParams},`);
  lines.push(`  sql: ${sqlConst},`);
  lines.push(`  mapRow: ${query.name}MapRow,`);
  lines.push(`  tables: ${query.name}Tables,`);
  const reactiveUsesParams = query.reactive.dependencies.some((dependency) =>
    dependency.scopes.some((scope) => scope.params.length > 0),
  );
  lines.push(`  dependencies: (${reactiveUsesParams ? 'params' : ''}) => [`);
  for (const dependency of query.reactive.dependencies) {
    const keys = dependency.scopes.flatMap((scope) =>
      scope.params.map((param) =>
        scopeKeyExpression(query, scope.pattern, scope.variable, param),
      ),
    );
    lines.push(
      `    { table: ${quote(dependency.table)}${keys.length > 0 ? `, scopeKeys: [${keys.join(', ')}]` : ''} },`,
    );
  }
  lines.push('  ],');
  const coverageUsesParams = query.reactive.coverage.some(
    (coverage) =>
      coverage.units.length > 0 ||
      coverage.fixedScopes.some((scope) => scope.params.length > 0),
  );
  lines.push(`  coverage: (${coverageUsesParams ? 'params' : ''}) => [`);
  for (const coverage of query.reactive.coverage) {
    const fixed = coverage.fixedScopes
      .map(
        (scope) =>
          `${propertyKey(scope.variable)}: [${scope.params.map((param) => reactiveParam(query, param)).join(', ')}]`,
      )
      .join(', ');
    const fixedPart = fixed.length > 0 ? `, fixedScopes: { ${fixed} }` : '';
    lines.push(
      `    { base: { table: ${quote(coverage.table)}, variable: ${quote(coverage.variable)}${fixedPart} }, units: [${coverage.units.map((param) => reactiveParam(query, param)).join(', ')}] },`,
    );
  }
  lines.push('  ],');
  if (hasParams) {
    lines.push(`  bind: (params: ${Params}) => ${positional},`);
  } else {
    lines.push('  bind: () => [],');
  }
  if (query.reactive.rowKey !== undefined) {
    lines.push(
      `  rowKey: (row) => [${query.reactive.rowKey.map((key) => `row.${propertyKey(key)}`).join(', ')}],`,
    );
  }
  lines.push('};');
  return lines.join('\n');
}

export function emitQueriesModule(
  queries: readonly AnalyzedQuery[],
  hash: string,
  irVersion: number,
): string {
  const parts: string[] = [];
  parts.push(
    [
      '// Generated by @syncular/typegen — DO NOT EDIT.',
      `// irVersion: ${irVersion}`,
      `// irHash: ${hash}`,
    ].join('\n'),
  );
  if (queries.some((query) => query.syql !== undefined)) {
    parts.push(
      [
        'export type SyqlRuntimeErrorCode =',
        "  | 'SYQL_RUNTIME_MISSING_REQUIRED_INPUT'",
        "  | 'SYQL_RUNTIME_UNKNOWN_INPUT'",
        "  | 'SYQL_RUNTIME_INVALID_INPUT'",
        "  | 'SYQL_RUNTIME_INVALID_GROUP'",
        "  | 'SYQL_RUNTIME_INVALID_SORT'",
        "  | 'SYQL_RUNTIME_INVALID_LIMIT';",
        '',
        'export class SyqlInputError extends Error {',
        "  readonly name = 'SyqlInputError';",
        '  constructor(readonly code: SyqlRuntimeErrorCode, message: string) {',
        '    super(message);',
        '  }',
        '}',
        '',
        'export interface SyqlPresent<T> {',
        '  readonly present: true;',
        '  readonly value: T;',
        '}',
        '',
        'export function syqlPresent<T>(value: T): SyqlPresent<T> {',
        '  return { present: true, value };',
        '}',
      ].join('\n'),
    );
  }
  if (
    queries.some((query) =>
      query.columns.some((column) => column.type === 'boolean'),
    )
  ) {
    parts.push(
      [
        '/** A generated named-query row did not match its analyzed result type. */',
        'export class QueryResultDecodeError extends TypeError {',
        "  readonly name = 'QueryResultDecodeError';",
        '  constructor(readonly query: string, readonly column: string) {',
        "    super(query + ': result column ' + column + ' is not a SQLite boolean');",
        '  }',
        '}',
        '',
        '/** Lift a SQLite boolean: preserve booleans, map 0 to false and finite non-zero numbers to true. */',
        'function decodeQueryBoolean(value: unknown, query: string, column: string): boolean {',
        "  if (typeof value === 'boolean') return value;",
        "  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;",
        '  throw new QueryResultDecodeError(query, column);',
        '}',
      ].join('\n'),
    );
  }
  parts.push(
    [
      "/** A bindable SQL param/row value (the wrapper's SqlValue subset). */",
      'export type QueryValue =',
      '  | string',
      '  | number',
      '  | bigint',
      '  | boolean',
      '  | Uint8Array',
      '  | null;',
      '',
      "/** Minimal structural client surface — the wrapper's positional",
      ' *  `query(sql, params?)`. `SyncClient`/`SyncClientHandle`/`SyncClientLike`',
      ' *  all satisfy it, so this module imports nothing. */',
      'export interface QueryClient {',
      '  query(',
      '    sql: string,',
      '    params?: readonly QueryValue[],',
      '  ): unknown[] | Promise<unknown[]>;',
      '}',
      '',
      '/** A named-query descriptor — checked SQL plus revisioned reactive metadata and a',
      ' *  `bind(params)` → positional args. Consumed by',
      " *  `@syncular/react`'s `useQuery`. `Row` is the projection row",
      ' *  type; `Params` is `undefined` for a param-less query. `sqlFor`',
      ' *  selects a checked revision-1 SYQL physical statement when needed. */',
      'export interface NamedQuery<Row, Params = undefined> {',
      '  readonly id: string;',
      '  readonly hasParams: boolean;',
      '  readonly sql: string;',
      '  readonly mapRow: (row: Readonly<Record<string, unknown>>) => Row;',
      '  readonly tables: readonly string[];',
      '  readonly bind: (params: Params) => readonly QueryValue[];',
      '  readonly sqlFor?: (params: Params) => string;',
      '  readonly dependencies: (params: Params) => readonly QueryDependency[];',
      '  readonly coverage: (params: Params) => readonly WindowCoverage[];',
      '  readonly rowKey?: (row: Row) => readonly QueryValue[];',
      '  /** Phantom — carries the Row type for `useQuery` inference. */',
      '  readonly __row?: Row;',
      '}',
      '',
      'export interface QueryDependency {',
      '  readonly table: string;',
      '  readonly scopeKeys?: readonly string[];',
      '}',
      '',
      'export interface WindowCoverage {',
      '  readonly base: {',
      '    readonly table: string;',
      '    readonly variable: string;',
      '    readonly fixedScopes?: Readonly<Record<string, readonly string[]>>;',
      '    readonly params?: string;',
      '  };',
      '  readonly units: readonly string[];',
      '}',
    ].join('\n'),
  );
  for (const query of queries) {
    parts.push(emitQuery(query, hash));
  }
  return `${parts.join('\n\n')}\n`;
}
