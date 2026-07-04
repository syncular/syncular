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
import type { AnalyzedQuery, QueryColumn } from './query';

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

function pascalCase(name: string): string {
  return name
    .split(/[_-]+/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

function camelCase(name: string): string {
  const pascal = pascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** The query function/type name: already camelCase; PascalCase for the type. */
function typeName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function rowAccessor(column: QueryColumn): string {
  const key = `row[${quote(column.name)}]`;
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

function emitRowStruct(query: AnalyzedQuery): string[] {
  const Row = `${typeName(query.name)}Row`;
  const lines: string[] = [];
  lines.push(`/// One row of the ${query.name} query (its projection).`);
  lines.push(`public struct ${Row}: Sendable, Equatable {`);
  for (const column of query.columns) {
    const opt = column.nullable ? '?' : '';
    lines.push(
      `    public let ${camelCase(column.name)}: ${SWIFT_TYPE[column.type]}${opt}`,
    );
  }
  lines.push('');
  lines.push('    public init?(row: [String: JSONValue]) {');
  for (const column of query.columns) {
    const name = camelCase(column.name);
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

function emitRunner(query: AnalyzedQuery): string[] {
  const Row = `${typeName(query.name)}Row`;
  const lines: string[] = [];
  lines.push(
    `    public static let ${query.name}Tables = [${query.tables.map(quote).join(', ')}]`,
  );
  lines.push(
    `    private static let ${query.name}Sql = ${quote(query.positionalSql)}`,
  );
  lines.push('');
  lines.push(`    /// Run the ${query.name} named query (SELECT-only).`);
  const args = query.params
    .map((p) => `${camelCase(p.name)}: ${SWIFT_TYPE[p.type]}`)
    .join(', ');
  const signature =
    query.params.length > 0
      ? `client: SyncularClient, ${args}`
      : 'client: SyncularClient';
  lines.push(
    `    public static func ${query.name}(${signature}) throws -> [${Row}] {`,
  );
  if (query.params.length > 0) {
    const binds = query.params
      .map((p) => paramValue(p.type, camelCase(p.name)))
      .join(', ');
    lines.push(`        let params: [JSONValue] = [${binds}]`);
    lines.push(
      `        return try client.query(${query.name}Sql, params: params).compactMap { row in`,
    );
  } else {
    lines.push(
      `        return try client.query(${query.name}Sql).compactMap { row in`,
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
      '// Generated by @syncular-v2/typegen — DO NOT EDIT.',
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

  for (const query of queries) {
    parts.push(emitRowStruct(query).join('\n'));
  }

  const enumLines: string[] = [];
  enumLines.push('/// Typed named queries (the sqlc/SQLDelight tier).');
  enumLines.push(`public enum ${enumName}Queries {`);
  enumLines.push(queries.map((q) => emitRunner(q).join('\n')).join('\n\n'));
  enumLines.push('}');
  parts.push(enumLines.join('\n'));

  return `${parts.join('\n\n')}\n`;
}
