/**
 * TS named-query emitter: analyzed queries → a standalone
 * `syncular.queries.ts` module. Per query `q` it emits:
 *
 * - `QRow` — the projection row interface (its OWN type per query — the
 *   drift-kill: the row shape is exactly what the SELECT returns),
 * - `QParams` — the typed params object (when the query has params or
 *   knobs); §4 optional params are optional keys (`status?: string | null`),
 *   §6 knobs add `orderBy?/dir?/limit?`,
 * - `qTables` — the readonly table-dependency set (feeds useRawSql `{tables}`
 *   for EXACT invalidation),
 * - `q(client, params?): Promise<QRow[]>` — runs the query over the wrapper's
 *   positional `query(sql, params[])` surface, reordering the named params
 *   object into the positional array the wire expects (optionals bind NULL —
 *   the §7 neutralization guards make an absent param a no-op),
 * - for an orderBy knob: a baked column map + a compose function — user
 *   input only ever SELECTS from the generate-time-checked allowlist (I2);
 *   it never becomes SQL text.
 *
 * A tiny structural `QueryClient` interface (just `query(sql, params?)`) keeps
 * the module import-free — it structurally accepts `SyncClientLike` /
 * `SyncClient` / `SyncClientHandle` alike. Header carries the IR hash so
 * `--check` gates freshness byte-exactly, like every other emitter.
 */
import type { IrColumnType } from './ir';
import type { AnalyzedQuery, QueryParam } from './query';

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

/** A named-query param value is the SqlValue subset its type maps to. */
const PARAM_TS_TYPE: Readonly<Record<IrColumnType, string>> = TS_TYPE;

function isOptional(param: QueryParam): boolean {
  return param.optional === true || param.flag === true;
}

/** The positional bind expression for one param. `access` is `params` or
 * `params?` depending on whether the params object itself may be absent. */
function bindExpr(
  query: AnalyzedQuery,
  param: QueryParam,
  access: string,
): string {
  if (query.limit !== undefined && param.name === 'limit') {
    // The default + clamp live IN the SQL (`min(coalesce(?, d), m)`).
    return `${access}.limit ?? null`;
  }
  const key = propertyKey(param.langName);
  return isOptional(param) ? `${access}.${key} ?? null` : `params.${key}`;
}

function emitQuery(query: AnalyzedQuery): string {
  const Row = `${pascalCase(query.name)}Row`;
  const Params = `${pascalCase(query.name)}Params`;
  const lines: string[] = [];

  // Row interface — keyed by the language-facing names, which ARE the
  // runtime result keys (§5 projection lowering aliases them in SQL).
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

  const hasParams = query.params.length > 0 || query.orderBy !== undefined;
  const requiresParams = query.params.some(
    (p) => !isOptional(p) && !(query.limit !== undefined && p.name === 'limit'),
  );

  // Params interface (params and/or knob keys).
  if (hasParams) {
    lines.push(`/** Named parameters for ${quote(query.name)}. */`);
    lines.push(`export interface ${Params} {`);
    for (const param of query.params) {
      if (query.limit !== undefined && param.name === 'limit') continue;
      const opt = isOptional(param);
      lines.push(
        `  ${propertyKey(param.langName)}${opt ? '?' : ''}: ${PARAM_TS_TYPE[param.type]}${opt ? ' | null' : ''};`,
      );
    }
    if (query.orderBy !== undefined) {
      const keys = query.orderBy.allowed
        .map((c) => quote(c.langName))
        .join(' | ');
      lines.push(
        `  /** §6 orderBy knob — a generate-time-checked allowlist. */`,
      );
      lines.push(`  orderBy?: ${keys};`);
      lines.push(`  dir?: 'asc' | 'desc';`);
    }
    if (query.limit !== undefined) {
      const clamp =
        query.limit.max !== undefined ? ` (clamped to ${query.limit.max})` : '';
      lines.push(
        `  /** §6 limit knob — binds as a value${clamp}; default ${query.limit.default ?? query.limit.max}. */`,
      );
      lines.push('  limit?: number;');
    }
    lines.push('}');
    lines.push('');
  }

  // Tables dependency set (for useRawSql {tables} / useQuery).
  lines.push(
    `/** Tables ${quote(query.name)} reads — the exact useRawSql \`{tables}\` set. */`,
  );
  lines.push(
    `export const ${query.name}Tables = [${query.tables.map(quote).join(', ')}] as const;`,
  );
  lines.push('');

  // SQL constants: the static default statement, plus (orderBy knob) the
  // baked base + column map + compose function.
  const sqlConst = `${query.name}Sql`;
  lines.push(`const ${sqlConst} = ${quote(query.positionalSql)};`);
  const composeFn = `${query.name}ComposeSql`;
  if (query.orderBy !== undefined) {
    const base = `${query.name}SqlBase`;
    const colsConst = `${query.name}OrderColumns`;
    const defaultLang =
      query.orderBy.allowed.find((c) => c.name === query.orderBy?.defaultColumn)
        ?.langName ?? query.orderBy.defaultColumn;
    lines.push(`const ${base} = ${quote(query.positionalSqlBase ?? '')};`);
    lines.push(
      `const ${colsConst} = { ${query.orderBy.allowed
        .map((c) => `${propertyKey(c.langName)}: ${quote(c.name)}`)
        .join(', ')} } as const;`,
    );
    lines.push(`function ${composeFn}(params?: ${Params}): string {`);
    lines.push(
      `  const column = ${colsConst}[params?.orderBy ?? ${quote(defaultLang)}] ?? ${quote(query.orderBy.defaultColumn)};`,
    );
    lines.push(
      `  const dir = (params?.dir ?? ${quote(query.orderBy.defaultDir)}) === 'desc' ? 'desc' : 'asc';`,
    );
    lines.push(
      `  return \`\${${base}} order by \${column} \${dir}${query.positionalLimitTail ?? ''}\`;`,
    );
    lines.push('}');
  }

  // Positional bind list.
  const access = requiresParams ? 'params' : 'params?';
  const positional = hasParams
    ? `[${query.params.map((p) => bindExpr(query, p, access)).join(', ')}]`
    : '[]';

  // §7 variant backend: one statement per provided-combination, selected by
  // a bitmask over the optional groups (bit i = group i provided/true). The
  // neutralization statement above stays the canonical/default form.
  const selectFn = `${query.name}SelectVariant`;
  const paramArgDecl = requiresParams
    ? `params: ${Params}`
    : `params?: ${Params}`;
  if (query.variants !== undefined && query.variantGroups !== undefined) {
    const variantsConst = `${query.name}Variants`;
    lines.push(
      `const ${variantsConst}: { sql: string; bind: (${paramArgDecl}) => QueryValue[] }[] = [`,
    );
    for (const variant of query.variants) {
      const binds = variant.params
        .map((name) => {
          const param = query.params.find((p) => p.name === name);
          if (param === undefined) throw new Error(`unknown param ${name}`);
          return bindExpr(query, param, access);
        })
        .join(', ');
      lines.push(`  // [${variant.when.join(' + ') || 'no optional filters'}]`);
      lines.push(
        `  { sql: ${quote(variant.positionalSql)}, bind: (${requiresParams ? 'params' : 'params?'}) => [${binds}] },`,
      );
    }
    lines.push('];');
    lines.push(
      `function ${selectFn}(${paramArgDecl}): { sql: string; bind: QueryValue[] } {`,
    );
    lines.push('  let mask = 0;');
    query.variantGroups.forEach((group, index) => {
      const langOf = (name: string): string =>
        query.params.find((p) => p.name === name)?.langName ?? name;
      const condition = group.flag
        ? `params?.${propertyKey(langOf(group.params[0] as string))} === true`
        : group.params
            .map(
              (name) =>
                `(params?.${propertyKey(langOf(name))} ?? null) !== null`,
            )
            .join(' && ');
      lines.push(`  if (${condition}) mask |= ${1 << index};`);
    });
    lines.push(
      `  const variant = ${variantsConst}[mask] as (typeof ${variantsConst})[number];`,
    );
    lines.push('  return { sql: variant.sql, bind: variant.bind(params) };');
    lines.push('}');
  }
  lines.push('');

  // The runner.
  const paramArg = !hasParams ? '' : paramArgDecl;
  lines.push(`/** Run the ${quote(query.name)} named query (SELECT-only). */`);
  lines.push(
    `export async function ${query.name}(client: QueryClient${hasParams ? `, ${paramArg}` : ''}): Promise<${Row}[]> {`,
  );
  if (query.variants !== undefined) {
    lines.push(`  const variant = ${selectFn}(params);`);
    lines.push('  const rows = await client.query(variant.sql, variant.bind);');
  } else {
    const sqlExpr =
      query.orderBy !== undefined ? `${composeFn}(params)` : sqlConst;
    if (hasParams) {
      lines.push(
        `  const rows = await client.query(${sqlExpr}, ${positional});`,
      );
    } else {
      lines.push(`  const rows = await client.query(${sqlExpr});`);
    }
  }
  lines.push(`  return rows as unknown as ${Row}[];`);
  lines.push('}');
  lines.push('');

  // A descriptor for react's `useQuery` — the SQL (static, composed from
  // the baked allowlist, or variant-selected), the exact table dependency
  // set, and a `bind(params)` → positional array (always paired with the
  // sqlFor selection). Typed by the query's own Row/Params.
  lines.push(
    `/** Descriptor for \`useQuery(${query.name}Query${hasParams ? ', params' : ''})\` — sql + tables + row type. */`,
  );
  const paramsTypeArg = hasParams ? Params : 'undefined';
  lines.push(
    `export const ${query.name}Query: NamedQuery<${Row}, ${paramsTypeArg}> = {`,
  );
  lines.push(`  sql: ${sqlConst},`);
  if (query.variants !== undefined) {
    lines.push(`  sqlFor: (params: ${Params}) => ${selectFn}(params).sql,`);
  } else if (query.orderBy !== undefined) {
    lines.push(`  sqlFor: (params: ${Params}) => ${composeFn}(params),`);
  }
  lines.push(`  tables: ${query.name}Tables,`);
  if (query.variants !== undefined) {
    lines.push(`  bind: (params: ${Params}) => ${selectFn}(params).bind,`);
  } else if (hasParams) {
    lines.push(`  bind: (params: ${Params}) => ${positional},`);
  } else {
    lines.push('  bind: () => [],');
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
      '/** A named-query descriptor — sql + its exact table dependency set + a',
      ' *  `bind(params)` → positional args. Consumed by',
      " *  `@syncular/react`'s `useQuery`. `Row` is the projection row",
      ' *  type; `Params` is `undefined` for a param-less query. `sqlFor`',
      ' *  (present only with an orderBy knob) composes the statement from a',
      ' *  generate-time-checked column allowlist. */',
      'export interface NamedQuery<Row, Params = undefined> {',
      '  readonly sql: string;',
      '  readonly tables: readonly string[];',
      '  readonly bind: (params: Params) => readonly QueryValue[];',
      '  readonly sqlFor?: (params: Params) => string;',
      '  /** Phantom — carries the Row type for `useQuery` inference. */',
      '  readonly __row?: Row;',
      '}',
    ].join('\n'),
  );
  for (const query of queries) {
    parts.push(emitQuery(query));
  }
  return `${parts.join('\n\n')}\n`;
}
