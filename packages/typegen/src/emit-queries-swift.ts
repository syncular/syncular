/**
 * Swift named-query emitter: analyzed queries → a standalone
 * `Syncular.queries.swift` file. Per query `q` it emits:
 *
 * - `struct QRow` + `init?(row:)` — the projection's OWN typed row (decoded
 *   through the shared row helpers already in `Syncular.generated.swift`),
 * - `enum <EnumName>Queries { static func q(client:params) -> [QRow] }` —
 *   runs the query over the wrapper's positional `query(_:params:)`, binding
 *   the named params in positional order,
 * - `static let qTables` — the table-dependency set.
 *
 * It reuses the generated schema file's `SyncularSchemaRow` helpers (bool /
 * bytes decode). Header carries the IR hash for byte-exact `--check`.
 */
import type { IrColumnType } from './ir';
import { snakeToCamel } from './naming';
import type { AnalyzedQuery, QueryColumn, QueryParam } from './query';

const SWIFT_TYPE: Readonly<Record<IrColumnType, string>> = {
  string: 'String',
  integer: 'Int',
  float: 'Double',
  boolean: 'Bool',
  json: 'String',
  bytes: '[UInt8]',
  blob_ref: 'String',
  crdt: '[UInt8]',
};

/** Language-facing field name — the pinned §12 naming map. */
function camelCase(name: string): string {
  return snakeToCamel(name);
}

/** The query function/type name: already camelCase; PascalCase for the type. */
function typeName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function rowAccessor(column: QueryColumn): string {
  const key = `row[${quote(column.langName)}]`;
  switch (column.type) {
    case 'string':
    case 'json':
    case 'blob_ref':
      return `${key}?.stringValue`;
    case 'integer':
      return `${key}?.numberValue.map(Int.init)`;
    case 'float':
      return `${key}?.numberValue`;
    case 'boolean':
      return `SyncularSchemaRow.bool(${key})`;
    case 'bytes':
    case 'crdt':
      return `SyncularSchemaRow.bytes(${key})`;
  }
}

function paramValue(type: IrColumnType, name: string): string {
  switch (type) {
    case 'integer':
    case 'float':
      return `.number(Double(${name}))`;
    case 'boolean':
      return `.bool(${name})`;
    case 'bytes':
    case 'crdt':
      return `SyncularSchemaQueryBind.bytes(${name})`;
    default:
      return `.string(${name})`;
  }
}

/** Bind for a §4 OPTIONAL param: `nil` rides as JSON null (the §7
 * neutralization guards make it a no-op). */
function optionalParamValue(type: IrColumnType, name: string): string {
  switch (type) {
    case 'integer':
      return `${name}.map { JSONValue.number(Double($0)) } ?? .null`;
    case 'float':
      return `${name}.map { JSONValue.number($0) } ?? .null`;
    case 'boolean':
      return `${name}.map { JSONValue.bool($0) } ?? .null`;
    case 'bytes':
    case 'crdt':
      return `${name}.map { SyncularSchemaQueryBind.bytes($0) } ?? .null`;
    default:
      return `${name}.map { JSONValue.string($0) } ?? .null`;
  }
}

function isOptionalParam(query: AnalyzedQuery, p: QueryParam): boolean {
  return (
    p.optional === true ||
    p.flag === true ||
    (query.limit !== undefined && p.name === 'limit')
  );
}

function emitRowStruct(query: AnalyzedQuery): string[] {
  const Row = `${typeName(query.name)}Row`;
  const lines: string[] = [];
  lines.push(`/// One row of the ${query.name} query (its projection).`);
  lines.push(`public struct ${Row}: Sendable, Equatable {`);
  for (const column of query.columns) {
    const opt = column.nullable ? '?' : '';
    lines.push(
      `    public let ${camelCase(column.langName)}: ${SWIFT_TYPE[column.type]}${opt}`,
    );
  }
  lines.push('');
  lines.push('    public init?(row: [String: JSONValue]) {');
  for (const column of query.columns) {
    const name = camelCase(column.langName);
    const accessor = rowAccessor(column);
    if (column.nullable) {
      lines.push(`        self.${name} = ${accessor}`);
    } else {
      lines.push(`        guard let ${name} = ${accessor} else { return nil }`);
      lines.push(`        self.${name} = ${name}`);
    }
  }
  lines.push('    }');
  lines.push('}');
  return lines;
}

/** Per-query orderBy allowlist enum (rawValue = the checked SQL column). */
function emitOrderByEnum(query: AnalyzedQuery): string[] {
  if (query.orderBy === undefined) return [];
  const lines: string[] = [];
  lines.push(
    `/// §6 orderBy allowlist for ${query.name} — checked at generate time.`,
  );
  lines.push(`public enum ${typeName(query.name)}OrderBy: String, Sendable {`);
  for (const col of query.orderBy.allowed) {
    lines.push(`    case ${camelCase(col.langName)} = ${quote(col.name)}`);
  }
  lines.push('}');
  return lines;
}

function emitRunner(query: AnalyzedQuery): string[] {
  const Row = `${typeName(query.name)}Row`;
  const lines: string[] = [];
  lines.push(
    `    public static let ${query.name}Tables = [${query.tables.map(quote).join(', ')}]`,
  );
  if (query.orderBy !== undefined) {
    lines.push(
      `    private static let ${query.name}SqlBase = ${quote(query.positionalSqlBase ?? '')}`,
    );
  } else {
    lines.push(
      `    private static let ${query.name}Sql = ${quote(query.positionalSql)}`,
    );
  }
  lines.push('');
  lines.push(`    /// Run the ${query.name} named query (SELECT-only).`);
  const args: string[] = [];
  for (const p of query.params) {
    const name = camelCase(p.langName);
    if (isOptionalParam(query, p)) {
      args.push(`${name}: ${SWIFT_TYPE[p.type]}? = nil`);
    } else {
      args.push(`${name}: ${SWIFT_TYPE[p.type]}`);
    }
  }
  if (query.orderBy !== undefined) {
    const defaultCase = camelCase(
      query.orderBy.allowed.find((c) => c.name === query.orderBy?.defaultColumn)
        ?.langName ?? query.orderBy.defaultColumn,
    );
    args.push(`orderBy: ${typeName(query.name)}OrderBy = .${defaultCase}`);
    args.push(`dir: SyncularQueryDir = .${query.orderBy.defaultDir}`);
  }
  const signature =
    args.length > 0
      ? `client: SyncularClient, ${args.join(', ')}`
      : 'client: SyncularClient';
  lines.push(
    `    public static func ${query.name}(${signature}) throws -> [${Row}] {`,
  );
  const sqlExpr =
    query.orderBy !== undefined
      ? `${query.name}SqlBase + " order by " + orderBy.rawValue + " " + dir.rawValue${query.positionalLimitTail !== undefined ? ` + ${quote(query.positionalLimitTail)}` : ''}`
      : `${query.name}Sql`;
  if (query.orderBy !== undefined) {
    lines.push(`        let sql = ${sqlExpr}`);
  }
  const sqlRef = query.orderBy !== undefined ? 'sql' : `${query.name}Sql`;
  if (query.params.length > 0) {
    const binds = query.params
      .map((p) => {
        const name = camelCase(p.langName);
        return isOptionalParam(query, p)
          ? optionalParamValue(p.type, name)
          : paramValue(p.type, name);
      })
      .join(', ');
    lines.push(`        let params: [JSONValue] = [${binds}]`);
    lines.push(
      `        return try client.query(${sqlRef}, params: params).compactMap { row in`,
    );
  } else {
    lines.push(
      `        return try client.query(${sqlRef}).compactMap { row in`,
    );
  }
  lines.push(
    '            guard case let .object(fields) = row else { return nil }',
  );
  lines.push(`            return ${Row}(row: fields)`);
  lines.push('        }');
  lines.push('    }');
  return lines;
}

export function emitQueriesSwiftModule(
  queries: readonly AnalyzedQuery[],
  hash: string,
  irVersion: number,
  enumName: string,
): string {
  const parts: string[] = [];
  parts.push(
    [
      '// Generated by @syncular/typegen — DO NOT EDIT.',
      `// irVersion: ${irVersion}`,
      `// irHash: ${hash}`,
      '',
      'import Foundation',
      'import Syncular',
    ].join('\n'),
  );

  parts.push(
    [
      '/// Param-bind helpers shared by the generated query runners.',
      'enum SyncularSchemaQueryBind {',
      '    static func bytes(_ value: [UInt8]) -> JSONValue {',
      '        let hex = value.map { String(format: "%02x", $0) }.joined()',
      '        return .object(["$bytes": .string(hex)])',
      '    }',
      '}',
    ].join('\n'),
  );

  if (queries.some((q) => q.orderBy !== undefined)) {
    parts.push(
      [
        '/// §6 orderBy direction (shared by every orderBy-knob query).',
        'public enum SyncularQueryDir: String, Sendable {',
        '    case asc = "asc"',
        '    case desc = "desc"',
        '}',
      ].join('\n'),
    );
  }

  for (const query of queries) {
    parts.push(emitRowStruct(query).join('\n'));
    const orderByEnum = emitOrderByEnum(query);
    if (orderByEnum.length > 0) parts.push(orderByEnum.join('\n'));
  }

  const enumLines: string[] = [];
  enumLines.push('/// Typed named queries (the sqlc/SQLDelight tier).');
  enumLines.push(`public enum ${enumName}Queries {`);
  enumLines.push(queries.map((q) => emitRunner(q).join('\n')).join('\n\n'));
  enumLines.push('}');
  parts.push(enumLines.join('\n'));

  return `${parts.join('\n\n')}\n`;
}
