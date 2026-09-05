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

/** Compiler-proven occurrences in the exact generated positional statement. */
export interface AuthoritativeRelationPlan {
  readonly sql: string;
  readonly relations: readonly {
    readonly table: string;
    readonly start: number;
    readonly end: number;
    readonly alias?: string;
  }[];
}

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

/** Validate trusted generated metadata before registration or storage execution. */
export function validateAuthoritativeRelationPlan(
  plan: AuthoritativeRelationPlan,
  declaredTables: readonly string[],
): void {
  if (
    plan === undefined ||
    typeof plan.sql !== 'string' ||
    !Array.isArray(plan.relations)
  ) {
    throw new Error(
      'registered query requires generated relation plans; regenerate queries',
    );
  }
  const sql = plan.sql;
  const declared = new Set(declaredTables);
  const found = new Set<string>();
  let previousEnd = 0;
  for (const relation of plan.relations) {
    if (
      !Number.isSafeInteger(relation.start) ||
      !Number.isSafeInteger(relation.end) ||
      relation.start < previousEnd ||
      relation.end <= relation.start ||
      relation.end > sql.length
    ) {
      throw new Error(
        'registered query relation boundaries do not match its SQL; regenerate queries',
      );
    }
    previousEnd = relation.end;
    if (!declared.has(relation.table)) {
      throw new Error('registered query table metadata does not match its SQL');
    }
    const spelling = sql.slice(relation.start, relation.end);
    const quote = spelling[0];
    const name =
      quote === '['
        ? spelling.slice(1, -1)
        : quote === '"' || quote === '`'
          ? spelling
              .slice(1, -1)
              .split(quote + quote)
              .join(quote)
          : spelling;
    if (name.toLowerCase() !== relation.table.toLowerCase()) {
      throw new Error(
        'registered query relation name does not match its SQL; regenerate queries',
      );
    }
    found.add(relation.table);
  }
  if (
    found.size !== declared.size ||
    [...declared].some((table) => !found.has(table))
  ) {
    throw new Error('registered query table metadata does not match its SQL');
  }
}

/** Bind every compiler-proven table occurrence to the authenticated partition. */
export function prepareAuthoritativeQuery(
  plan: AuthoritativeRelationPlan,
  params: readonly AuthoritativeQueryValue[],
  declaredTables: readonly string[],
  tables: ReadonlyMap<string, CompiledTable>,
): PreparedAuthoritativeQuery {
  validateAuthoritativeRelationPlan(plan, declaredTables);
  const sql = plan.sql;
  const replacements = plan.relations.map((relation) => {
    const table = tables.get(relation.table);
    if (table === undefined)
      throw new Error('registered query targets an unknown table');
    if (!table.materialize)
      throw new Error('registered query targets a non-materialized table');
    return {
      start: relation.start,
      end: relation.end,
      text: `(SELECT ${table.columns.map((column) => quoteIdent(column.name)).join(', ')} FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(SYNC_PARTITION_COLUMN)}=?)${relation.alias === undefined ? ` AS ${quoteIdent(table.name)}` : ''}`,
    };
  });
  const bound: (AuthoritativeQueryValue | typeof PARTITION_BIND)[] = [];
  let anonymousIndex = 0;
  let rendered = '';
  let nextRelation = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const replacement = replacements[nextRelation];
    if (replacement?.start === index) {
      rendered += replacement.text;
      bound.push(PARTITION_BIND);
      index = replacement.end - 1;
      nextRelation += 1;
      continue;
    }
    const protectedEnd = protectedSqlEnd(sql, index);
    if (protectedEnd !== undefined) {
      rendered += sql.slice(index, protectedEnd);
      index = protectedEnd - 1;
      continue;
    }
    const char = sql[index] as string;
    if (char !== '?') {
      rendered += char;
      continue;
    }
    let end = index + 1;
    while (end < sql.length && /[0-9]/.test(sql[end] as string)) {
      end += 1;
    }
    const numbered = sql.slice(index + 1, end);
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
