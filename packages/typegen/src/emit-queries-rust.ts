/**
 * Rust named-query emitter: analyzed QueryIR -> one standalone `.rs` module.
 * QueryIR owns every semantic decision; this file only renders typed inputs,
 * exact physical-plan selection, strict row decoding, reactive metadata, and
 * calls to syncular-client's query/query_snapshot boundary.
 */
import type { IrColumnType } from './ir';
import { buildRustNamingMap, rustPascalCase, rustSnakeCase } from './naming';
import type {
  AnalyzedQuery,
  QueryColumn,
  QueryParam,
  QuerySyqlPlanBind,
  QuerySyqlPublicInput,
} from './query';

const RUST_TYPE: Readonly<Record<IrColumnType, string>> = {
  string: 'String',
  integer: 'i64',
  float: 'f64',
  boolean: 'bool',
  json: 'String',
  bytes: 'Vec<u8>',
  blob_ref: 'String',
  crdt: 'Vec<u8>',
};

function quote(value: string): string {
  let out = '"';
  for (const char of value) {
    const point = char.codePointAt(0) as number;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (point < 0x20 || point === 0x7f)
      out += `\\u{${point.toString(16)}}`;
    else out += char;
  }
  return `${out}"`;
}

function field(name: string): string {
  return rustSnakeCase(name);
}

function typeName(name: string): string {
  return rustPascalCase(name);
}

function queryId(query: AnalyzedQuery, hash: string): string {
  return `${hash}/${query.name}`;
}

function rustType(type: IrColumnType, nullable = false): string {
  const base = RUST_TYPE[type];
  return nullable ? `Option<${base}>` : base;
}

function syqlInput(query: AnalyzedQuery, name: string): QuerySyqlPublicInput {
  const input = query.syql?.inputs.find((candidate) => candidate.name === name);
  if (input === undefined) throw new Error(`unknown SYQL input ${name}`);
  return input;
}

function validateQueryNames(query: AnalyzedQuery): void {
  buildRustNamingMap([query.name], query.file, 'query module');
  buildRustNamingMap(
    query.columns.map((column) => column.langName),
    query.file,
    `query ${query.name} projection`,
  );
  if (query.syql === undefined) {
    buildRustNamingMap(
      query.params.map((param) => param.langName),
      query.file,
      `query ${query.name} params`,
    );
    return;
  }
  buildRustNamingMap(
    query.syql.inputs.map((input) => input.langName),
    query.file,
    `query ${query.name} inputs`,
  );
  for (const input of query.syql.inputs) {
    if (input.kind === 'group') {
      buildRustNamingMap(
        input.members.map((member) => member.langName),
        query.file,
        `query ${query.name} group ${input.name}`,
      );
    } else if (input.kind === 'sort') {
      buildRustNamingMap(
        input.profiles.map((profile) => profile.langName),
        query.file,
        `query ${query.name} sort ${input.name}`,
      );
    }
  }
}

function bindValue(
  type: IrColumnType,
  reference: string,
  input: string,
): string {
  switch (type) {
    case 'string':
    case 'json':
    case 'blob_ref':
      return `bind_string(${reference})`;
    case 'integer':
      return `bind_integer(${reference})`;
    case 'float':
      return `bind_float(${reference}, ID, ${quote(input)})?`;
    case 'boolean':
      return `bind_boolean(${reference})`;
    case 'bytes':
    case 'crdt':
      return `bind_bytes(${reference})`;
  }
}

function optionalBindValue(
  type: IrColumnType,
  option: string,
  input: string,
): string {
  return `match ${option} { Some(value) => ${bindValue(type, 'value', input)}, None => QueryValue::Null }`;
}

function syqlControlActive(query: AnalyzedQuery, name: string): string {
  const input = syqlInput(query, name);
  const access = `params.${field(input.langName)}`;
  if (input.kind === 'value' && input.default === false) return access;
  if (input.kind === 'value' && input.nullable) {
    return `matches!(&${access}, SyqlPresence::Present(_))`;
  }
  if (input.kind === 'value' || input.kind === 'group') {
    return `${access}.is_some()`;
  }
  throw new Error(`${name} is not an activation control`);
}

function syqlBindExpr(query: AnalyzedQuery, bind: QuerySyqlPlanBind): string {
  if (bind.kind === 'condition-active') {
    const active = bind.controls
      .map((control) => syqlControlActive(query, control))
      .join(' && ');
    return `bind_boolean(&(${active}))`;
  }
  const input = syqlInput(query, bind.input);
  const access = `params.${field(input.langName)}`;
  if (bind.kind === 'limit') {
    return `bind_integer(&effective_${field(input.langName)})`;
  }
  if (bind.kind === 'group-member') {
    if (input.kind !== 'group') throw new Error('group bind/input mismatch');
    const member = input.members.find(
      (candidate) => candidate.name === bind.member,
    );
    if (member === undefined) {
      throw new Error(`unknown group member ${bind.member}`);
    }
    const memberAccess = `&group.${field(member.langName)}`;
    const present = member.nullable
      ? optionalBindValue(
          member.type,
          memberAccess,
          `${input.langName}.${member.langName}`,
        )
      : bindValue(
          member.type,
          memberAccess,
          `${input.langName}.${member.langName}`,
        );
    return `match &${access} { Some(group) => ${present}, None => QueryValue::Null }`;
  }
  if (input.kind !== 'value') throw new Error('value bind/input mismatch');
  if (input.default === false || (input.required && !input.nullable)) {
    return bindValue(input.type, `&${access}`, input.langName);
  }
  if (input.required) {
    return optionalBindValue(input.type, `&${access}`, input.langName);
  }
  if (input.nullable) {
    return `match &${access} { SyqlPresence::Absent | SyqlPresence::Present(None) => QueryValue::Null, SyqlPresence::Present(Some(value)) => ${bindValue(input.type, 'value', input.langName)} }`;
  }
  return optionalBindValue(input.type, `&${access}`, input.langName);
}

function plainBindExpr(param: QueryParam): string {
  return bindValue(
    param.type,
    `&params.${field(param.langName)}`,
    param.langName,
  );
}

function decodeFunction(type: IrColumnType): string {
  switch (type) {
    case 'string':
    case 'json':
    case 'blob_ref':
      return 'decode_string';
    case 'integer':
      return 'decode_integer';
    case 'float':
      return 'decode_float';
    case 'boolean':
      return 'decode_boolean';
    case 'bytes':
    case 'crdt':
      return 'decode_bytes';
  }
}

function emitRow(query: AnalyzedQuery): string[] {
  const lines = [
    `    /// One strictly decoded row of the ${query.name} query.`,
    '    #[derive(Debug, Clone, PartialEq)]',
    '    pub struct Row {',
  ];
  for (const column of query.columns) {
    lines.push(
      `        pub ${field(column.langName)}: ${rustType(column.type, column.nullable)},`,
    );
  }
  lines.push(
    '    }',
    '',
    '    pub(crate) fn decode(row: QueryRow) -> Result<Row, QueryError> {',
  );
  for (const column of query.columns) {
    const name = field(column.langName);
    const value = `required_value(&row, ID, ${quote(column.langName)})?`;
    const decoder = decodeFunction(column.type);
    if (column.nullable) {
      lines.push(
        `        let ${name} = match ${value} {`,
        '            QueryValue::Null => None,',
        `            value => Some(${decoder}(value, ID, ${quote(column.langName)})?),`,
        '        };',
      );
    } else {
      lines.push(
        `        let ${name} = ${decoder}(${value}, ID, ${quote(column.langName)})?;`,
      );
    }
  }
  lines.push('        Ok(Row {');
  for (const column of query.columns) {
    lines.push(`            ${field(column.langName)},`);
  }
  lines.push('        })', '    }');
  return lines;
}

function syqlFieldType(input: QuerySyqlPublicInput): string {
  if (input.kind === 'value') {
    const valueType = rustType(input.type, input.nullable);
    if (input.required || input.default === false) return valueType;
    return input.nullable
      ? `SyqlPresence<${valueType}>`
      : `Option<${valueType}>`;
  }
  if (input.kind === 'group') return `Option<${typeName(input.langName)}>`;
  if (input.kind === 'sort') return typeName(input.langName);
  return 'Option<i64>';
}

function emitParams(query: AnalyzedQuery): string[] {
  if (query.syql === undefined) return emitPlainParams(query);
  const lines: string[] = [];
  for (const input of query.syql.inputs) {
    if (input.kind === 'group') {
      lines.push(
        '    #[derive(Debug, Clone, PartialEq)]',
        `    pub struct ${typeName(input.langName)} {`,
      );
      for (const member of input.members) {
        lines.push(
          `        pub ${field(member.langName)}: ${rustType(member.type, member.nullable)},`,
        );
      }
      lines.push('    }', '');
    } else if (input.kind === 'sort') {
      lines.push(
        '    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]',
        `    pub enum ${typeName(input.langName)} {`,
      );
      for (const profile of input.profiles) {
        if (profile.name === input.defaultProfile)
          lines.push('        #[default]');
        lines.push(`        ${typeName(profile.langName)},`);
      }
      lines.push('    }', '');
    }
  }
  if (query.syql.inputs.length === 0) {
    lines.push('    pub type Params = ();');
    return lines;
  }
  const required = query.syql.inputs.filter(
    (input) => input.kind === 'value' && input.required,
  );
  lines.push(
    `    #[derive(Debug, Clone, PartialEq${required.length === 0 ? ', Default' : ''})]`,
    '    pub struct Params {',
  );
  for (const input of query.syql.inputs) {
    lines.push(
      `        pub ${field(input.langName)}: ${syqlFieldType(input)},`,
    );
  }
  lines.push('    }', '', '    impl Params {');
  const args = required.map(
    (input) => `${field(input.langName)}: ${syqlFieldType(input)}`,
  );
  lines.push(
    `        pub fn new(${args.join(', ')}) -> Self {`,
    '            Self {',
  );
  for (const input of query.syql.inputs) {
    const name = field(input.langName);
    if (input.kind === 'value' && input.required)
      lines.push(`                ${name},`);
    else if (input.kind === 'value' && input.default === false) {
      lines.push(`                ${name}: false,`);
    } else if (input.kind === 'value' && input.nullable) {
      lines.push(`                ${name}: SyqlPresence::Absent,`);
    } else if (input.kind === 'sort') {
      const profile = input.profiles.find(
        (candidate) => candidate.name === input.defaultProfile,
      );
      if (profile === undefined)
        throw new Error('missing default sort profile');
      lines.push(
        `                ${name}: ${typeName(input.langName)}::${typeName(profile.langName)},`,
      );
    } else {
      lines.push(`                ${name}: None,`);
    }
  }
  lines.push('            }', '        }', '    }');
  return lines;
}

function emitPlainParams(query: AnalyzedQuery): string[] {
  if (query.params.length === 0) return ['    pub type Params = ();'];
  const lines = [
    '    #[derive(Debug, Clone, PartialEq)]',
    '    pub struct Params {',
  ];
  for (const param of query.params) {
    lines.push(
      `        pub ${field(param.langName)}: ${rustType(param.type)},`,
    );
  }
  lines.push('    }', '', '    impl Params {');
  const args = query.params
    .map((param) => `${field(param.langName)}: ${rustType(param.type)}`)
    .join(', ');
  lines.push(`        pub fn new(${args}) -> Self {`, '            Self {');
  for (const param of query.params) {
    lines.push(`                ${field(param.langName)},`);
  }
  lines.push('            }', '        }', '    }');
  return lines;
}

function emitSelect(query: AnalyzedQuery): string[] {
  if (query.syql === undefined) {
    const binds = query.params.map((param) => plainBindExpr(param)).join(', ');
    return [
      `    pub fn select(${query.params.length === 0 ? '_params' : 'params'}: &Params) -> Result<SelectedQuery, QueryError> {`,
      '        Ok(SelectedQuery {',
      `            sql: ${quote(query.positionalSql)},`,
      `            params: vec![${binds}],`,
      '        })',
      '    }',
    ];
  }
  const metadata = query.syql;
  const lines = [
    `    pub fn select(${metadata.inputs.length === 0 ? '_params' : 'params'}: &Params) -> Result<SelectedQuery, QueryError> {`,
  ];
  const limit = metadata.inputs.find((input) => input.kind === 'limit');
  if (limit?.kind === 'limit') {
    const name = field(limit.langName);
    lines.push(
      `        let effective_${name} = params.${name}.unwrap_or(${limit.defaultSize});`,
      `        if !(1..=${limit.maxSize}).contains(&effective_${name}) {`,
      '            return Err(QueryError::Input {',
      '                code: "SYQL_RUNTIME_INVALID_LIMIT",',
      '                query: ID,',
      `                message: ${quote(`${query.name}: limit must be an integer from 1 through ${limit.maxSize}`)}.to_owned(),`,
      '            });',
      '        }',
    );
  }
  const usesActivationMask =
    metadata.plan.backend === 'variants' &&
    metadata.plan.activationControls.length > 0;
  if (usesActivationMask) {
    lines.push('        let mut activation_mask = 0usize;');
    metadata.plan.activationControls.forEach((control, index) => {
      lines.push(
        `        if ${syqlControlActive(query, control)} {`,
        `            activation_mask |= ${2 ** index};`,
        '        }',
      );
    });
  }
  const sort = metadata.inputs.find((input) => input.kind === 'sort');
  if (sort?.kind === 'sort') {
    lines.push(
      `        let sort_index = match params.${field(sort.langName)} {`,
    );
    sort.profiles.forEach((profile, index) => {
      lines.push(
        `            ${typeName(sort.langName)}::${typeName(profile.langName)} => ${index},`,
      );
    });
    lines.push('        };');
  }
  const sortIndex = sort?.kind === 'sort' ? 'sort_index' : '0usize';
  const profileCount = sort?.kind === 'sort' ? sort.profiles.length : 1;
  const index = usesActivationMask
    ? profileCount === 1
      ? 'activation_mask'
      : `activation_mask * ${profileCount} + ${sortIndex}`
    : sortIndex;
  lines.push(
    `        let statement_index = ${index};`,
    '        match statement_index {',
  );
  metadata.plan.statements.forEach((statement, statementIndex) => {
    const binds = statement.binds
      .map((bind) => syqlBindExpr(query, bind))
      .join(', ');
    lines.push(
      `            ${statementIndex} => Ok(SelectedQuery {`,
      `                sql: ${quote(statement.positionalSql)},`,
      `                params: vec![${binds}],`,
      '            }),',
    );
  });
  lines.push(
    '            _ => Err(QueryError::Input {',
    '                code: "SYQL_RUNTIME_INVALID_SORT",',
    '                query: ID,',
    `                message: ${quote(`${query.name}: invalid generated SYQL statement index`)}.to_owned(),`,
    '            }),',
    '        }',
    '    }',
  );
  return lines;
}

function reactiveParam(query: AnalyzedQuery, name: string): string {
  if (query.syql !== undefined) {
    const input = query.syql.inputs.find(
      (candidate) => candidate.kind === 'value' && candidate.name === name,
    );
    if (input?.kind !== 'value' || !input.required || input.nullable) {
      throw new Error(`reactive input ${name} is not required and non-null`);
    }
    return scopeValue(input.type, `params.${field(input.langName)}`);
  }
  const param = query.params.find((candidate) => candidate.name === name);
  if (param === undefined) throw new Error(`unknown reactive param ${name}`);
  return scopeValue(param.type, `params.${field(param.langName)}`);
}

function scopeValue(type: IrColumnType, reference: string): string {
  switch (type) {
    case 'string':
    case 'json':
    case 'blob_ref':
      return `${reference}.clone()`;
    case 'bytes':
    case 'crdt':
      return `encode_hex(&${reference})`;
    default:
      return `${reference}.to_string()`;
  }
}

function scopeKey(
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
  return `format!("{}{}{}", ${quote(prefix)}, ${reactiveParam(query, param)}, ${quote(suffix)})`;
}

function emitDependencies(query: AnalyzedQuery): string[] {
  const usesParams = query.reactive.dependencies.some((dependency) =>
    dependency.scopes.some((scope) => scope.params.length > 0),
  );
  const lines = [
    `    pub fn dependencies(${usesParams ? 'params' : '_params'}: &Params) -> Vec<QueryDependency> {`,
    '        vec![',
  ];
  for (const dependency of query.reactive.dependencies) {
    const keys = dependency.scopes.flatMap((scope) =>
      scope.params.map((param) =>
        scopeKey(query, scope.pattern, scope.variable, param),
      ),
    );
    lines.push(
      '            QueryDependency {',
      `                table: ${quote(dependency.table)},`,
      keys.length === 0
        ? '                scope_keys: None,'
        : `                scope_keys: Some(vec![${keys.join(', ')}]),`,
      '            },',
    );
  }
  lines.push('        ]', '    }');
  return lines;
}

function emitCoverage(query: AnalyzedQuery): string[] {
  const usesParams = query.reactive.coverage.some(
    (coverage) =>
      coverage.units.length > 0 ||
      coverage.fixedScopes.some((scope) => scope.params.length > 0),
  );
  const lines = [
    `    pub fn coverage(${usesParams ? 'params' : '_params'}: &Params) -> Vec<WindowCoverage> {`,
    '        vec![',
  ];
  for (const coverage of query.reactive.coverage) {
    const fixed = coverage.fixedScopes.map((scope) => {
      const values = scope.params
        .map((param) => reactiveParam(query, param))
        .join(', ');
      return `(${quote(scope.variable)}.to_owned(), vec![${values}])`;
    });
    const units = coverage.units
      .map((param) => reactiveParam(query, param))
      .join(', ');
    lines.push(
      '            WindowCoverage {',
      '                base: WindowBase {',
      `                    table: ${quote(coverage.table)}.to_owned(),`,
      `                    variable: ${quote(coverage.variable)}.to_owned(),`,
      `                    fixed_scopes: vec![${fixed.join(', ')}],`,
      '                    params: None,',
      '                },',
      `                units: vec![${units}],`,
      '            },',
    );
  }
  lines.push('        ]', '    }');
  return lines;
}

function keyValue(column: QueryColumn, reference: string): string {
  const value = (() => {
    switch (column.type) {
      case 'string':
      case 'json':
      case 'blob_ref':
        return `bind_string(${reference})`;
      case 'integer':
        return `bind_integer(${reference})`;
      case 'float':
        return `QueryValue::from(*${reference})`;
      case 'boolean':
        return `bind_boolean(${reference})`;
      case 'bytes':
      case 'crdt':
        return `bind_bytes(${reference})`;
    }
  })();
  if (!column.nullable) return value;
  return `match ${reference} { Some(value) => ${keyValue({ ...column, nullable: false }, 'value')}, None => QueryValue::Null }`;
}

function emitRowKey(query: AnalyzedQuery): string[] {
  if (query.reactive.rowKey === undefined) return [];
  const byName = new Map(
    query.columns.map((column) => [column.langName, column] as const),
  );
  const values = query.reactive.rowKey.map((name) => {
    const column = byName.get(name);
    if (column === undefined) throw new Error(`row key column ${name} missing`);
    return keyValue(column, `&row.${field(column.langName)}`);
  });
  return [
    '    pub fn row_key(row: &Row) -> Vec<QueryValue> {',
    `        vec![${values.join(', ')}]`,
    '    }',
  ];
}

function emitDescriptorAndRunners(
  query: AnalyzedQuery,
  hash: string,
): string[] {
  const hasRowKey = query.reactive.rowKey !== undefined;
  const noParams =
    query.syql === undefined
      ? query.params.length === 0
      : query.syql.inputs.length === 0;
  const lines = [
    `    pub const ID: &str = ${quote(queryId(query, hash))};`,
    `    pub const TABLES: &[&str] = &[${query.tables.map(quote).join(', ')}];`,
    '    pub const DESCRIPTOR: QueryDescriptor<Params, Row> = QueryDescriptor {',
    '        id: ID,',
    '        tables: TABLES,',
    '        select,',
    '        dependencies,',
    '        coverage,',
    `        row_key: ${hasRowKey ? 'Some(row_key)' : 'None'},`,
    '    };',
    '',
  ];
  lines.push(
    ...emitSelect(query),
    '',
    ...emitDependencies(query),
    '',
    ...emitCoverage(query),
  );
  const rowKey = emitRowKey(query);
  if (rowKey.length > 0) lines.push('', ...rowKey);
  lines.push('');
  if (noParams) {
    lines.push(
      '    pub fn run(client: &SyncClient) -> Result<Vec<Row>, QueryError> {',
      '        run_with(client, &())',
      '    }',
      '',
      '    pub fn snapshot(',
      '        client: &mut SyncClient,',
      '    ) -> Result<TypedQuerySnapshot<Row>, QueryError> {',
      '        snapshot_with(client, &())',
      '    }',
      '',
      '    fn run_with(client: &SyncClient, params: &Params) -> Result<Vec<Row>, QueryError> {',
    );
  } else {
    lines.push(
      '    pub fn run(client: &SyncClient, params: &Params) -> Result<Vec<Row>, QueryError> {',
    );
  }
  lines.push(
    '        let selected = select(params)?;',
    '        let rows = client',
    '            .query(selected.sql, &selected.params)',
    '            .map_err(|message| QueryError::Client { query: ID, message })?;',
    '        rows.into_iter().map(decode).collect()',
    '    }',
    '',
  );
  if (noParams) {
    lines.push(
      '    fn snapshot_with(',
      '        client: &mut SyncClient,',
      '        params: &Params,',
      '    ) -> Result<TypedQuerySnapshot<Row>, QueryError> {',
    );
  } else {
    lines.push(
      '    pub fn snapshot(',
      '        client: &mut SyncClient,',
      '        params: &Params,',
      '    ) -> Result<TypedQuerySnapshot<Row>, QueryError> {',
    );
  }
  lines.push(
    '        let selected = select(params)?;',
    '        let required_coverage = coverage(params);',
    '        let snapshot = client',
    '            .query_snapshot(selected.sql, &selected.params, &required_coverage)',
    '            .map_err(|message| QueryError::Client { query: ID, message })?;',
    '        let rows = snapshot.rows.into_iter().map(decode).collect::<Result<_, _>>()?;',
    '        Ok(TypedQuerySnapshot {',
    '            revision: snapshot.revision,',
    '            rows,',
    '            coverage: snapshot.coverage,',
    '        })',
    '    }',
  );
  return lines;
}

function emitQuery(query: AnalyzedQuery, hash: string): string {
  validateQueryNames(query);
  const lines = [
    '#[rustfmt::skip]',
    `pub mod ${field(query.name)} {`,
    '    use super::*;',
    '',
  ];
  lines.push(...emitRow(query), '', ...emitParams(query), '');
  lines.push(...emitDescriptorAndRunners(query, hash), '}');
  return lines.join('\n');
}

function emitSupport(clientCrate: string): string {
  return [
    'use std::error::Error;',
    'use std::fmt;',
    `use ${clientCrate}::{`,
    '    CoverageSnapshot, QueryRow, QueryValue, SyncClient, WindowBase, WindowCoverage,',
    '};',
    '',
    '#[derive(Debug, Clone, PartialEq, Eq, Default)]',
    'pub enum SyqlPresence<T> {',
    '    #[default]',
    '    Absent,',
    '    Present(T),',
    '}',
    '',
    '#[derive(Debug, Clone, PartialEq)]',
    'pub struct SelectedQuery {',
    "    pub sql: &'static str,",
    '    pub params: Vec<QueryValue>,',
    '}',
    '',
    '#[derive(Debug, Clone, PartialEq, Eq)]',
    'pub struct QueryDependency {',
    "    pub table: &'static str,",
    '    pub scope_keys: Option<Vec<String>>,',
    '}',
    '',
    '#[derive(Debug, Clone)]',
    'pub struct TypedQuerySnapshot<Row> {',
    '    pub revision: String,',
    '    pub rows: Vec<Row>,',
    '    pub coverage: CoverageSnapshot,',
    '}',
    '',
    '#[derive(Clone, Copy)]',
    'pub struct QueryDescriptor<Params, Row> {',
    "    pub id: &'static str,",
    "    pub tables: &'static [&'static str],",
    '    pub select: fn(&Params) -> Result<SelectedQuery, QueryError>,',
    '    pub dependencies: fn(&Params) -> Vec<QueryDependency>,',
    '    pub coverage: fn(&Params) -> Vec<WindowCoverage>,',
    '    pub row_key: Option<fn(&Row) -> Vec<QueryValue>>,',
    '}',
    '',
    '#[derive(Debug, Clone, PartialEq, Eq)]',
    'pub enum QueryError {',
    '    Input {',
    "        code: &'static str,",
    "        query: &'static str,",
    '        message: String,',
    '    },',
    '    Client {',
    "        query: &'static str,",
    '        message: String,',
    '    },',
    '    Decode {',
    "        query: &'static str,",
    "        column: &'static str,",
    "        expected: &'static str,",
    "        reason: &'static str,",
    '    },',
    '}',
    '',
    'impl fmt::Display for QueryError {',
    "    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {",
    '        match self {',
    '            Self::Input {',
    '                code,',
    '                query,',
    '                message,',
    '            } => write!(formatter, "{code} ({query}): {message}"),',
    '            Self::Client { query, message } => {',
    '                write!(formatter, "query {query} failed: {message}")',
    '            }',
    '            Self::Decode {',
    '                query,',
    '                column,',
    '                expected,',
    '                reason,',
    '            } => write!(',
    '                formatter,',
    '                "query {query} column {column} expected {expected}: {reason}"',
    '            ),',
    '        }',
    '    }',
    '}',
    '',
    'impl Error for QueryError {}',
    '',
    'fn decode_error(',
    "    query: &'static str,",
    "    column: &'static str,",
    "    expected: &'static str,",
    "    reason: &'static str,",
    ') -> QueryError {',
    '    QueryError::Decode {',
    '        query,',
    '        column,',
    '        expected,',
    '        reason,',
    '    }',
    '}',
    '',
    "fn required_value<'a>(",
    "    row: &'a QueryRow,",
    "    query: &'static str,",
    "    column: &'static str,",
    ") -> Result<&'a QueryValue, QueryError> {",
    '    row.get(column)',
    '        .ok_or_else(|| decode_error(query, column, "projected value", "missing column"))',
    '}',
    '',
    'fn decode_string(',
    '    value: &QueryValue,',
    "    query: &'static str,",
    "    column: &'static str,",
    ') -> Result<String, QueryError> {',
    '    value',
    '        .as_str()',
    '        .map(str::to_owned)',
    '        .ok_or_else(|| decode_error(query, column, "string", "wrong dynamic type"))',
    '}',
    '',
    'fn decode_integer(',
    '    value: &QueryValue,',
    "    query: &'static str,",
    "    column: &'static str,",
    ') -> Result<i64, QueryError> {',
    '    if let Some(integer) = value.as_i64() {',
    '        return Ok(integer);',
    '    }',
    '    if let Some(decimal) = value.get("$bigint").and_then(QueryValue::as_str) {',
    '        return decimal',
    '            .parse::<i64>()',
    '            .map_err(|_| decode_error(query, column, "integer", "invalid $bigint envelope"));',
    '    }',
    '    Err(decode_error(query, column, "integer", "wrong dynamic type"))',
    '}',
    '',
    'fn decode_float(',
    '    value: &QueryValue,',
    "    query: &'static str,",
    "    column: &'static str,",
    ') -> Result<f64, QueryError> {',
    '    value',
    '        .as_f64()',
    '        .filter(|number| number.is_finite())',
    '        .ok_or_else(|| decode_error(query, column, "finite float", "wrong dynamic type"))',
    '}',
    '',
    'fn decode_boolean(',
    '    value: &QueryValue,',
    "    query: &'static str,",
    "    column: &'static str,",
    ') -> Result<bool, QueryError> {',
    '    if let Some(boolean) = value.as_bool() {',
    '        return Ok(boolean);',
    '    }',
    '    if let Some(number) = value.as_f64().filter(|number| number.is_finite()) {',
    '        return Ok(number != 0.0);',
    '    }',
    '    Err(decode_error(query, column, "boolean", "wrong dynamic type"))',
    '}',
    '',
    'fn decode_bytes(',
    '    value: &QueryValue,',
    "    query: &'static str,",
    "    column: &'static str,",
    ') -> Result<Vec<u8>, QueryError> {',
    '    let hex = value',
    '        .get("$bytes")',
    '        .and_then(QueryValue::as_str)',
    '        .ok_or_else(|| decode_error(query, column, "bytes", "missing $bytes envelope"))?;',
    '    if hex.len() % 2 != 0 {',
    '        return Err(decode_error(',
    '            query,',
    '            column,',
    '            "bytes",',
    '            "odd-length $bytes envelope",',
    '        ));',
    '    }',
    '    hex.as_bytes()',
    '        .chunks_exact(2)',
    '        .map(|pair| {',
    '            let pair = std::str::from_utf8(pair)',
    '                .map_err(|_| decode_error(query, column, "bytes", "non-ASCII $bytes envelope"))?;',
    '            u8::from_str_radix(pair, 16).map_err(|_| {',
    '                decode_error(',
    '                    query,',
    '                    column,',
    '                    "bytes",',
    '                    "invalid hexadecimal $bytes envelope",',
    '                )',
    '            })',
    '        })',
    '        .collect()',
    '}',
    '',
    'fn bind_string(value: &str) -> QueryValue {',
    '    QueryValue::String(value.to_owned())',
    '}',
    '',
    'fn bind_integer(value: &i64) -> QueryValue {',
    '    QueryValue::from(*value)',
    '}',
    '',
    'fn bind_float(',
    '    value: &f64,',
    "    query: &'static str,",
    "    input: &'static str,",
    ') -> Result<QueryValue, QueryError> {',
    '    if !value.is_finite() {',
    '        return Err(QueryError::Input {',
    '            code: "SYQL_RUNTIME_INVALID_INPUT",',
    '            query,',
    '            message: format!("{query}: input {input} must be finite"),',
    '        });',
    '    }',
    '    Ok(QueryValue::from(*value))',
    '}',
    '',
    'fn bind_boolean(value: &bool) -> QueryValue {',
    '    QueryValue::Bool(*value)',
    '}',
    '',
    'fn encode_hex(value: &[u8]) -> String {',
    '    const HEX: &[u8; 16] = b"0123456789abcdef";',
    '    let mut out = String::with_capacity(value.len() * 2);',
    '    for byte in value {',
    '        out.push(HEX[(byte >> 4) as usize] as char);',
    '        out.push(HEX[(byte & 0x0f) as usize] as char);',
    '    }',
    '    out',
    '}',
    '',
    'fn bind_bytes(value: &[u8]) -> QueryValue {',
    '    let mut envelope = QueryRow::new();',
    '    envelope.insert("$bytes".to_owned(), QueryValue::String(encode_hex(value)));',
    '    QueryValue::Object(envelope)',
    '}',
  ].join('\n');
}

export function emitQueriesRustModule(
  queries: readonly AnalyzedQuery[],
  hash: string,
  irVersion: number,
  clientCrate = 'syncular_client',
): string {
  buildRustNamingMap(
    queries.map((query) => query.name),
    'queries',
    'query modules',
  );
  const parts = [
    [
      '// Generated by @syncular/typegen — DO NOT EDIT.',
      `// irVersion: ${irVersion}`,
      `// irHash: ${hash}`,
    ].join('\n'),
    emitSupport(clientCrate),
    ...queries.map((query) => emitQuery(query, hash)),
  ];
  return `${parts.join('\n\n')}\n`;
}
