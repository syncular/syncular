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
import type {
  AnalyzedQuery,
  QueryColumn,
  QuerySyqlPlanBind,
  QuerySyqlPublicInput,
} from './query';

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

function syqlInput(query: AnalyzedQuery, name: string): QuerySyqlPublicInput {
  const input = query.syql?.inputs.find((candidate) => candidate.name === name);
  if (input === undefined) throw new Error(`unknown SYQL input ${name}`);
  return input;
}

function syqlDartType(type: IrColumnType, nullable: boolean): string {
  return `${DART_TYPE[type]}${nullable ? '?' : ''}`;
}

function syqlControlActive(query: AnalyzedQuery, name: string): string {
  const input = syqlInput(query, name);
  const access = camelCase(input.langName);
  if (input.kind === 'switch') return access;
  if (input.kind === 'value' && input.nullable) return `${access}.isPresent`;
  if (input.kind === 'value' || input.kind === 'group') {
    return `${access} != null`;
  }
  throw new Error(`${name} is not an activation control`);
}

function syqlBindExpr(query: AnalyzedQuery, bind: QuerySyqlPlanBind): string {
  if (bind.kind === 'condition-active') {
    return bind.controls
      .map((control) => syqlControlActive(query, control))
      .join(' && ');
  }
  const input = syqlInput(query, bind.input);
  const access = camelCase(input.langName);
  if (bind.kind === 'page') return `effective${typeName(access)}`;
  if (bind.kind === 'group-member') {
    if (input.kind !== 'group') throw new Error('group bind/input mismatch');
    const member = input.members.find(
      (candidate) => candidate.name === bind.member,
    );
    if (member === undefined)
      throw new Error(`unknown group member ${bind.member}`);
    const memberAccess = `${access}.${camelCase(member.langName)}`;
    const value = member.nullable
      ? optionalParamValue(member.type, memberAccess)
      : paramValue(member.type, memberAccess);
    return `${access} == null ? null : ${value}`;
  }
  if (input.kind !== 'value') throw new Error('value bind/input mismatch');
  if (input.required) {
    return input.nullable
      ? optionalParamValue(input.type, access)
      : paramValue(input.type, access);
  }
  return input.nullable
    ? `${access}.isPresent ? ${optionalParamValue(input.type, `${access}.value`)} : null`
    : optionalParamValue(input.type, access);
}

function emitSyqlDartTypes(query: AnalyzedQuery): string[] {
  const lines: string[] = [];
  for (const input of query.syql?.inputs ?? []) {
    if (input.kind === 'group') {
      const name = `${typeName(query.name)}${typeName(input.langName)}`;
      lines.push(`class ${name} {`);
      for (const member of input.members) {
        lines.push(
          `  final ${syqlDartType(member.type, member.nullable)} ${camelCase(member.langName)};`,
        );
      }
      const args = input.members
        .map((member) => `required this.${camelCase(member.langName)}`)
        .join(', ');
      lines.push(`  const ${name}({${args}});`, '}', '');
    } else if (input.kind === 'sort') {
      const name = `${typeName(query.name)}${typeName(input.langName)}`;
      lines.push(
        `enum ${name} { ${input.profiles.map((profile) => camelCase(profile.langName)).join(', ')} }`,
        '',
      );
    }
  }
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function emitSyqlDartRunner(query: AnalyzedQuery): string[] {
  const metadata = query.syql;
  if (metadata === undefined) throw new Error('missing SYQL metadata');
  const Row = `${typeName(query.name)}Row`;
  const Pascal = pascalCase(query.name);
  const lines: string[] = [];
  lines.push(
    `/// Tables the ${query.name} query reads (exact invalidation set).`,
    `const List<String> syncular${Pascal}QueryTables = [${query.tables.map(quote).join(', ')}];`,
    '',
    `/// Run the ${query.name} revision-1 SYQL query.`,
  );
  const args: string[] = [];
  for (const input of metadata.inputs) {
    const name = camelCase(input.langName);
    if (input.kind === 'value') {
      const type = syqlDartType(input.type, input.nullable);
      if (input.required) args.push(`required ${type} ${name}`);
      else if (input.nullable) {
        args.push(
          `SyqlQueryPresence<${type}> ${name} = const SyqlQueryPresence.absent()`,
        );
      } else args.push(`${type}? ${name}`);
    } else if (input.kind === 'group') {
      args.push(`${typeName(query.name)}${typeName(input.langName)}? ${name}`);
    } else if (input.kind === 'switch') {
      args.push(`bool ${name} = false`);
    } else if (input.kind === 'sort') {
      const defaultCase =
        input.profiles.find((profile) => profile.name === input.defaultProfile)
          ?.langName ?? input.defaultProfile;
      const type = `${typeName(query.name)}${typeName(input.langName)}`;
      args.push(`${type} ${name} = ${type}.${camelCase(defaultCase)}`);
    } else {
      args.push(`int? ${name}`);
    }
  }
  const argsClause = args.length > 0 ? `, {${args.join(', ')}}` : '';
  lines.push(
    `List<${Row}> syncular${Pascal}Query(SyncularClient client${argsClause}) {`,
  );
  const page = metadata.inputs.find((input) => input.kind === 'page');
  if (page?.kind === 'page') {
    const name = camelCase(page.langName);
    lines.push(
      `  final effective${typeName(name)} = ${name} ?? ${page.defaultSize};`,
      `  if (effective${typeName(name)} < 1 || effective${typeName(name)} > ${page.maxSize}) {`,
      `    throw SyqlQueryInputException('SYQL_RUNTIME_INVALID_PAGE', ${quote(`${query.name}: invalid page size`)});`,
      '  }',
    );
  }
  if (metadata.plan.backend === 'variants') {
    lines.push('  var activationMask = 0;');
    metadata.plan.activationControls.forEach((control, index) => {
      lines.push(
        `  if (${syqlControlActive(query, control)}) activationMask |= ${2 ** index};`,
      );
    });
  }
  const sort = metadata.inputs.find((input) => input.kind === 'sort');
  const profileCount = sort?.kind === 'sort' ? sort.profiles.length : 1;
  const sortIndex =
    sort?.kind === 'sort' ? `${camelCase(sort.langName)}.index` : '0';
  const index =
    metadata.plan.backend === 'variants'
      ? `activationMask * ${profileCount} + ${sortIndex}`
      : sortIndex;
  lines.push(
    `  final statementIndex = ${index};`,
    '  late final String sql;',
    '  late final List<Object?> params;',
    '  switch (statementIndex) {',
  );
  metadata.plan.statements.forEach((statement, statementIndex) => {
    const binds = statement.binds
      .map((bind) => syqlBindExpr(query, bind))
      .join(', ');
    lines.push(
      `    case ${statementIndex}: sql = ${quote(statement.positionalSql)}; params = <Object?>[${binds}]; break;`,
    );
  });
  lines.push(
    "    default: throw StateError('invalid generated SYQL statement index');",
    '  }',
    `  return client.query(sql, params: params).map(${Row}.fromRow).whereType<${Row}>().toList();`,
    '}',
  );
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
  if (query.syql !== undefined) return emitSyqlDartRunner(query);
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
  lines.push(`const String _${query.name}Sql = ${quote(query.positionalSql)};`);
  lines.push('');
  lines.push(`/// Run the ${query.name} named query (SELECT-only).`);
  const args: string[] = [];
  for (const p of query.params) {
    const name = camelCase(p.langName);
    args.push(`required ${DART_TYPE[p.type]} ${name}`);
  }
  const argsClause = args.length > 0 ? `, {${args.join(', ')}}` : '';
  lines.push(
    `List<${Row}> syncular${Pascal}Query(SyncularClient client${argsClause}) {`,
  );
  const sqlRef = `_${query.name}Sql`;
  if (query.params.length > 0) {
    const binds = query.params
      .map((p) => {
        const name = camelCase(p.langName);
        return paramValue(p.type, name);
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

  if (queries.some((query) => query.syql !== undefined)) {
    parts.push(
      [
        'class SyqlQueryPresence<T> {',
        '  final bool isPresent;',
        '  final T? value;',
        '  const SyqlQueryPresence.absent() : isPresent = false, value = null;',
        '  const SyqlQueryPresence.present(this.value) : isPresent = true;',
        '}',
        '',
        'class SyqlQueryInputException implements Exception {',
        '  final String code;',
        '  final String message;',
        '  const SyqlQueryInputException(this.code, this.message);',
        '  @override',
        "  String toString() => '$code: $message';",
        '}',
      ].join('\n'),
    );
  }

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

  for (const query of queries) {
    const syqlTypes = emitSyqlDartTypes(query);
    if (syqlTypes.length > 0) parts.push(syqlTypes.join('\n'));
    parts.push(emitClass(query).join('\n'));
  }
  for (const query of queries) {
    parts.push(emitRunner(query).join('\n'));
  }

  return `${parts.join('\n\n')}\n`;
}
