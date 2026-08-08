import type { CompiledTable } from './schema';
import { quoteIdent, SYNC_PARTITION_COLUMN } from './relational-rows';
import type { AuthoritativeQueryValue } from './storage';

export interface PreparedAuthoritativeQuery {
  readonly sql: string;
  readonly params: readonly (AuthoritativeQueryValue | typeof PARTITION_BIND)[];
}

export interface BoundAuthoritativeQuery {
  readonly sql: string;
  readonly params: readonly AuthoritativeQueryValue[];
}

const PARTITION_BIND = Symbol('syncular.authoritative_partition');

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
]);
const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const TABLE_REF_RE = new RegExp(
  `\\b(FROM|(?:NATURAL\\s+)?(?:(?:LEFT|RIGHT|FULL)(?:\\s+OUTER)?|INNER|CROSS)?\\s*JOIN)\\s+((?:\\(\\s*)*)(${IDENT})(?:\\s+(?:AS\\s+)?((?!(?:${[...RESERVED_ALIAS].join('|')})\\b)${IDENT}))?`,
  'gi',
);

function protectedSqlEnd(sql: string, index: number): number | undefined {
  const char = sql[index];
  const next = sql[index + 1];
  if (char === "'" || char === '"' || char === '`') {
    let end = index + 1;
    while (end < sql.length) {
      if (sql[end] === char && sql[end + 1] === char) end += 2;
      else if (sql[end] === char) return end + 1;
      else end += 1;
    }
    return sql.length;
  }
  if (char === '[') {
    const end = sql.indexOf(']', index + 1);
    return end < 0 ? sql.length : end + 1;
  }
  if (char === '-' && next === '-') {
    const end = sql.indexOf('\n', index);
    return end < 0 ? sql.length : end;
  }
  if (char === '/' && next === '*') {
    const end = sql.indexOf('*/', index + 2);
    return end < 0 ? sql.length : end + 2;
  }
  return undefined;
}

function maskedSql(sql: string): string {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const end = protectedSqlEnd(sql, index);
    if (end === undefined) out += sql[index];
    else out += sql.slice(index, end).replace(/[^\n]/g, ' ');
    index = end ?? index + 1;
  }
  return out;
}

/**
 * Turn generated local SQL into a partition-local authoritative statement.
 * Only relations declared by the generated descriptor are rewritten. Values
 * remain parameters; request data is never interpolated into SQL.
 */
export function prepareAuthoritativeQuery(
  sql: string,
  params: readonly AuthoritativeQueryValue[],
  declaredTables: readonly string[],
  tables: ReadonlyMap<string, CompiledTable>,
): PreparedAuthoritativeQuery {
  if (maskedSql(sql).includes(';'))
    throw new Error('registered query must be one SELECT');
  const declared = new Set(declaredTables);
  const masked = maskedSql(sql);
  const replacements: Array<{
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }> = [];
  const found = new Set<string>();
  for (const match of masked.matchAll(TABLE_REF_RE)) {
    const rawTable = match[3] as string;
    const table = tables.get(rawTable);
    if (table === undefined) continue;
    if (!declared.has(table.name)) {
      throw new Error('registered query table metadata does not match its SQL');
    }
    if (!table.materialize) {
      throw new Error('registered query targets a non-materialized table');
    }
    let alias = match[4];
    if (alias !== undefined && RESERVED_ALIAS.has(alias.toLowerCase())) {
      alias = undefined;
    }
    const matchStart = match.index ?? 0;
    const afterOperator = (match[1] as string).length;
    const relative = match[0]
      .toLowerCase()
      .indexOf(rawTable.toLowerCase(), afterOperator);
    const start = matchStart + relative;
    const projection = table.columns.map((column) => quoteIdent(column.name));
    replacements.push({
      start,
      end: start + rawTable.length,
      text: `(SELECT ${projection.join(', ')} FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(SYNC_PARTITION_COLUMN)}=/*syncular_partition*/?)${alias === undefined ? ` AS ${quoteIdent(table.name)}` : ''}`,
    });
    found.add(table.name);
  }
  if (
    found.size !== declared.size ||
    [...declared].some((table) => !found.has(table))
  ) {
    throw new Error('registered query table metadata does not match its SQL');
  }
  let rewritten = sql;
  for (const replacement of replacements.sort(
    (left, right) => right.start - left.start,
  )) {
    rewritten =
      rewritten.slice(0, replacement.start) +
      replacement.text +
      rewritten.slice(replacement.end);
  }

  const bound: (AuthoritativeQueryValue | typeof PARTITION_BIND)[] = [];
  let anonymousIndex = 0;
  let rendered = '';
  for (let index = 0; index < rewritten.length; index += 1) {
    if (rewritten.startsWith('/*syncular_partition*/?', index)) {
      rendered += '?';
      bound.push(PARTITION_BIND);
      index += '/*syncular_partition*/?'.length - 1;
      continue;
    }
    const protectedEnd = protectedSqlEnd(rewritten, index);
    if (protectedEnd !== undefined) {
      rendered += rewritten.slice(index, protectedEnd);
      index = protectedEnd - 1;
      continue;
    }
    const char = rewritten[index] as string;
    if (char !== '?') {
      rendered += char;
      continue;
    }
    let end = index + 1;
    while (end < rewritten.length && /[0-9]/.test(rewritten[end] as string)) {
      end += 1;
    }
    const numbered = rewritten.slice(index + 1, end);
    const parameterIndex =
      numbered.length > 0
        ? Number.parseInt(numbered, 10) - 1
        : anonymousIndex++;
    if (numbered.length > 0) {
      anonymousIndex = Math.max(anonymousIndex, parameterIndex + 1);
    }
    if (parameterIndex < 0 || parameterIndex >= params.length) {
      throw new Error('registered query bind metadata does not match its SQL');
    }
    const value = params[parameterIndex];
    if (value === undefined) {
      throw new Error('registered query bind metadata does not match its SQL');
    }
    rendered += '?';
    bound.push(value);
    index = end - 1;
  }
  return { sql: rendered, params: bound };
}

export function bindAuthoritativePartition(
  prepared: PreparedAuthoritativeQuery,
  partition: string,
): BoundAuthoritativeQuery {
  return {
    sql: prepared.sql,
    params: prepared.params.map((value) =>
      value === PARTITION_BIND ? partition : value,
    ),
  };
}

export function postgresPlaceholders(sql: string): string {
  let bind = 0;
  let rendered = '';
  for (let index = 0; index < sql.length; index += 1) {
    const protectedEnd = protectedSqlEnd(sql, index);
    if (protectedEnd !== undefined) {
      rendered += sql.slice(index, protectedEnd);
      index = protectedEnd - 1;
    } else if (sql[index] === '?') {
      rendered += `$${++bind}`;
    } else {
      rendered += sql[index];
    }
  }
  return rendered;
}
