/**
 * Dart named-query emitter: analyzed queries → a standalone
 * `syncular.queries.dart` file. Per query `q` it emits a `class QRow` +
 * `fromRow` factory, and a top-level `syncular<Q>Query(client, …)` function
 * returning `List<QRow>` plus a `syncular<Q>QueryTables` const. The runner
 * binds named params positionally into `query(sql, params: […])`.
 *
 * Header carries the IR hash for byte-exact `--check`.
 */
import type { IrColumnType } from './ir';
import { snakeToCamel } from './naming';
import type { AnalyzedQuery, QueryColumn, QueryParam } from './query';

const DART_TYPE: Readonly<Record<IrColumnType, string>> = {
  string: 'String',
  integer: 'int',
  float: 'double',
  boolean: 'bool',
  json: 'String',
  bytes: 'List<int>',
  blob_ref: 'String',
  crdt: 'List<int>',
};

function pascalCase(name: string): string {
  return name
    .split(/[_-]+/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/** Language-facing field name — the pinned §12 naming map. */
function camelCase(name: string): string {
  return snakeToCamel(name);
}

function typeName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$')}'`;
}

function rowAccessor(column: QueryColumn): string {
  const key = `row[${quote(column.langName)}]`;
  switch (column.type) {
    case 'string':
    case 'json':
    case 'blob_ref':
      return `${key} as String?`;
    case 'integer':
      return `(${key} as num?)?.toInt()`;
    case 'float':
      return `(${key} as num?)?.toDouble()`;
    case 'boolean':
      return `_queryRowBool(${key})`;
    case 'bytes':
    case 'crdt':
      return `_queryRowBytes(${key})`;
  }
}

function paramValue(type: IrColumnType, name: string): string {
  switch (type) {
    case 'bytes':
    case 'crdt':
      return `_queryBindBytes(${name})`;
    default:
      // String/int/double/bool ride as-is in the params list.
      return name;
  }
}

/** Bind for a §4 OPTIONAL param: Dart `null` rides as JSON null (the §7
 * neutralization guards make it a no-op). */
function optionalParamValue(type: IrColumnType, name: string): string {
  switch (type) {
    case 'bytes':
    case 'crdt':
      return `${name} == null ? null : _queryBindBytes(${name})`;
    default:
      return name;
  }
}

function isOptionalParam(query: AnalyzedQuery, p: QueryParam): boolean {
  return (
    p.optional === true ||
    p.flag === true ||
    (query.limit !== undefined && p.name === 'limit')
  );
}

/** Per-query orderBy allowlist enum (column = the checked SQL column). */
function emitOrderByEnum(query: AnalyzedQuery): string[] {
  if (query.orderBy === undefined) return [];
  const lines: string[] = [];
  lines.push(
    `/// §6 orderBy allowlist for ${query.name} — checked at generate time.`,
  );
  lines.push(`enum ${typeName(query.name)}OrderBy {`);
  lines.push(
    `${query.orderBy.allowed
      .map((col) => `  ${camelCase(col.langName)}(${quote(col.name)})`)
      .join(',\n')};`,
  );
  lines.push('');
  lines.push(`  const ${typeName(query.name)}OrderBy(this.column);`);
  lines.push('  final String column;');
  lines.push('}');
  return lines;
}

function emitClass(query: AnalyzedQuery): string[] {
  const Row = `${typeName(query.name)}Row`;
  const lines: string[] = [];
  lines.push(`/// One row of the ${query.name} query (its projection).`);
  lines.push(`class ${Row} {`);
  for (const column of query.columns) {
    const opt = column.nullable ? '?' : '';
    lines.push(
      `  final ${DART_TYPE[column.type]}${opt} ${camelCase(column.langName)};`,
    );
  }
  lines.push('');
  const ctorParams = query.columns
    .map((c) => `${c.nullable ? '' : 'required '}this.${camelCase(c.langName)}`)
    .join(', ');
  lines.push(`  const ${Row}({${ctorParams}});`);
  lines.push('');
  lines.push(`  static ${Row}? fromRow(Map<String, Object?> row) {`);
  for (const column of query.columns) {
    if (!column.nullable) {
      const name = camelCase(column.langName);
      lines.push(`    final ${name} = ${rowAccessor(column)};`);
      lines.push(`    if (${name} == null) return null;`);
    }
  }
  const args = query.columns
    .map((c) => {
      const name = camelCase(c.langName);
      return c.nullable ? `${name}: ${rowAccessor(c)}` : `${name}: ${name}`;
    })
    .join(', ');
  lines.push(`    return ${Row}(${args});`);
  lines.push('  }');
  lines.push('}');
  return lines;
}

function emitRunner(query: AnalyzedQuery): string[] {
  const Row = `${typeName(query.name)}Row`;
  const Pascal = pascalCase(query.name);
  const lines: string[] = [];
  lines.push(
    `/// Tables the ${query.name} query reads (exact invalidation set).`,
  );
  lines.push(
    `const List<String> syncular${Pascal}QueryTables = [${query.tables.map(quote).join(', ')}];`,
  );
  lines.push('');
  if (query.orderBy !== undefined) {
    lines.push(
      `const String _${query.name}SqlBase = ${quote(query.positionalSqlBase ?? '')};`,
    );
  } else {
    lines.push(
      `const String _${query.name}Sql = ${quote(query.positionalSql)};`,
    );
  }
  lines.push('');
  lines.push(`/// Run the ${query.name} named query (SELECT-only).`);
  const args: string[] = [];
  for (const p of query.params) {
    const name = camelCase(p.langName);
    if (isOptionalParam(query, p)) {
      args.push(`${DART_TYPE[p.type]}? ${name}`);
    } else {
      args.push(`required ${DART_TYPE[p.type]} ${name}`);
    }
  }
  if (query.orderBy !== undefined) {
    const defaultCase = camelCase(
      query.orderBy.allowed.find((c) => c.name === query.orderBy?.defaultColumn)
        ?.langName ?? query.orderBy.defaultColumn,
    );
    args.push(
      `${typeName(query.name)}OrderBy orderBy = ${typeName(query.name)}OrderBy.${defaultCase}`,
    );
    args.push(
      `SyncularQueryDir dir = SyncularQueryDir.${query.orderBy.defaultDir}`,
    );
  }
  const argsClause = args.length > 0 ? `, {${args.join(', ')}}` : '';
  lines.push(
    `List<${Row}> syncular${Pascal}Query(SyncularClient client${argsClause}) {`,
  );
  if (query.orderBy !== undefined) {
    const limitTail =
      query.positionalLimitTail !== undefined
        ? ` ${quote(query.positionalLimitTail.trim())}`
        : '';
    lines.push(
      `  final sql = '$_${query.name}SqlBase order by \${orderBy.column} \${dir.name}'${limitTail === '' ? '' : `\n      ' ' ${limitTail.trim()}`};`,
    );
  }
  const sqlRef = query.orderBy !== undefined ? 'sql' : `_${query.name}Sql`;
  if (query.params.length > 0) {
    const binds = query.params
      .map((p) => {
        const name = camelCase(p.langName);
        return isOptionalParam(query, p)
          ? optionalParamValue(p.type, name)
          : paramValue(p.type, name);
      })
      .join(', ');
    lines.push(`  final params = <Object?>[${binds}];`);
    lines.push(
      `  return client.query(${sqlRef}, params: params).map(${Row}.fromRow).whereType<${Row}>().toList();`,
    );
  } else {
    lines.push(
      `  return client.query(${sqlRef}).map(${Row}.fromRow).whereType<${Row}>().toList();`,
    );
  }
  lines.push('}');
  return lines;
}

export function emitQueriesDartModule(
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
      '// ignore_for_file: type=lint',
      '',
      "import 'package:syncular/syncular.dart';",
    ].join('\n'),
  );

  parts.push(
    [
      '/// Lift a SQLite boolean: a real bool, or 0/1 as a number.',
      'bool? _queryRowBool(Object? value) {',
      '  if (value is bool) return value;',
      '  if (value is num) return value != 0;',
      '  return null;',
      '}',
      '',
      "/// Decode the core's {'\\$bytes': '<hex>'} marshaling (bytes as hex).",
      'List<int>? _queryRowBytes(Object? value) {',
      '  if (value is! Map) return null;',
      "  final hex = value[r'$bytes'];",
      '  if (hex is! String || hex.length % 2 != 0) return null;',
      '  return [',
      '    for (var i = 0; i < hex.length; i += 2)',
      '      int.parse(hex.substring(i, i + 2), radix: 16),',
      '  ];',
      '}',
      '',
      "/// Encode bytes as the core's {'\\$bytes': '<hex>'} marshaling for binding.",
      'Map<String, Object?> _queryBindBytes(List<int> value) {',
      "  final hex = value.map((b) => b.toRadixString(16).padLeft(2, '0')).join();",
      "  return {r'$bytes': hex};",
      '}',
    ].join('\n'),
  );

  if (queries.some((q) => q.orderBy !== undefined)) {
    parts.push(
      [
        '/// §6 orderBy direction (shared by every orderBy-knob query).',
        'enum SyncularQueryDir { asc, desc }',
      ].join('\n'),
    );
  }

  for (const query of queries) {
    parts.push(emitClass(query).join('\n'));
    const orderByEnum = emitOrderByEnum(query);
    if (orderByEnum.length > 0) parts.push(orderByEnum.join('\n'));
  }
  for (const query of queries) {
    parts.push(emitRunner(query).join('\n'));
  }

  return `${parts.join('\n\n')}\n`;
}
