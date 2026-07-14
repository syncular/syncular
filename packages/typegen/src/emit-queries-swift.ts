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
import type {
  AnalyzedQuery,
  QueryColumn,
  QuerySyqlPlanBind,
  QuerySyqlPublicInput,
} from './query';

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
const SYQL_SWIFT_TYPE: Readonly<Record<IrColumnType, string>> = {
  ...SWIFT_TYPE,
  integer: 'Int64',
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

function syqlInput(query: AnalyzedQuery, name: string): QuerySyqlPublicInput {
  const input = query.syql?.inputs.find((candidate) => candidate.name === name);
  if (input === undefined) throw new Error(`unknown SYQL input ${name}`);
  return input;
}

function syqlSwiftType(type: IrColumnType, nullable: boolean): string {
  return `${SYQL_SWIFT_TYPE[type]}${nullable ? '?' : ''}`;
}

function syqlControlActive(query: AnalyzedQuery, name: string): string {
  const input = syqlInput(query, name);
  const access = camelCase(input.langName);
  if (input.kind === 'switch') return access;
  if (input.kind === 'value' && input.nullable) {
    return `{ if case .present = ${access} { return true }; return false }()`;
  }
  if (input.kind === 'value' || input.kind === 'group') {
    return `${access} != nil`;
  }
  throw new Error(`${name} is not an activation control`);
}

function syqlNullablePresenceBind(type: IrColumnType, access: string): string {
  return `{ () -> JSONValue in switch ${access} { case .absent: return .null; case .present(let value): return ${optionalParamValue(type, 'value')} } }()`;
}

function syqlBindExpr(query: AnalyzedQuery, bind: QuerySyqlPlanBind): string {
  if (bind.kind === 'condition-active') {
    const active = bind.controls
      .map((control) => syqlControlActive(query, control))
      .join(' && ');
    return `.bool(${active})`;
  }
  const input = syqlInput(query, bind.input);
  const access = camelCase(input.langName);
  if (bind.kind === 'page')
    return `.number(Double(effective${typeName(access)}))`;
  if (bind.kind === 'group-member') {
    if (input.kind !== 'group') throw new Error('group bind/input mismatch');
    const member = input.members.find(
      (candidate) => candidate.name === bind.member,
    );
    if (member === undefined)
      throw new Error(`unknown group member ${bind.member}`);
    const memberName = camelCase(member.langName);
    const present = member.nullable
      ? optionalParamValue(member.type, `value.${memberName}`)
      : paramValue(member.type, `value.${memberName}`);
    return `${access}.map { value in ${present} } ?? .null`;
  }
  if (input.kind !== 'value') throw new Error('value bind/input mismatch');
  if (input.required) {
    return input.nullable
      ? optionalParamValue(input.type, access)
      : paramValue(input.type, access);
  }
  return input.nullable
    ? syqlNullablePresenceBind(input.type, access)
    : optionalParamValue(input.type, access);
}

function emitSyqlSwiftTypes(query: AnalyzedQuery): string[] {
  const lines: string[] = [];
  for (const input of query.syql?.inputs ?? []) {
    if (input.kind === 'group') {
      const name = `${typeName(query.name)}${typeName(input.langName)}`;
      lines.push(`public struct ${name}: Sendable {`);
      for (const member of input.members) {
        lines.push(
          `    public let ${camelCase(member.langName)}: ${syqlSwiftType(member.type, member.nullable)}`,
        );
      }
      const args = input.members
        .map(
          (member) =>
            `${camelCase(member.langName)}: ${syqlSwiftType(member.type, member.nullable)}`,
        )
        .join(', ');
      lines.push(`    public init(${args}) {`);
      for (const member of input.members) {
        const name = camelCase(member.langName);
        lines.push(`        self.${name} = ${name}`);
      }
      lines.push('    }', '}', '');
    } else if (input.kind === 'sort') {
      const name = `${typeName(query.name)}${typeName(input.langName)}`;
      lines.push(`public enum ${name}: Int, Sendable {`);
      input.profiles.forEach((profile, index) => {
        lines.push(`    case ${camelCase(profile.langName)} = ${index}`);
      });
      lines.push('}', '');
    }
  }
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function emitSyqlSwiftRunner(query: AnalyzedQuery): string[] {
  const metadata = query.syql;
  if (metadata === undefined) throw new Error('missing SYQL metadata');
  const Row = `${typeName(query.name)}Row`;
  const lines: string[] = [];
  lines.push(
    `    public static let ${query.name}Tables = [${query.tables.map(quote).join(', ')}]`,
    '',
    `    /// Run the ${query.name} revision-1 SYQL query.`,
  );
  const args = ['client: SyncularClient'];
  for (const input of metadata.inputs) {
    const name = camelCase(input.langName);
    if (input.kind === 'value') {
      const type = syqlSwiftType(input.type, input.nullable);
      if (input.required) args.push(`${name}: ${type}`);
      else if (input.nullable)
        args.push(`${name}: SyncularQueryPresence<${type}> = .absent`);
      else args.push(`${name}: ${type}? = nil`);
    } else if (input.kind === 'group') {
      args.push(
        `${name}: ${typeName(query.name)}${typeName(input.langName)}? = nil`,
      );
    } else if (input.kind === 'switch') {
      args.push(`${name}: Bool = false`);
    } else if (input.kind === 'sort') {
      const defaultCase =
        input.profiles.find((profile) => profile.name === input.defaultProfile)
          ?.langName ?? input.defaultProfile;
      args.push(
        `${name}: ${typeName(query.name)}${typeName(input.langName)} = .${camelCase(defaultCase)}`,
      );
    } else {
      args.push(`${name}: Int? = nil`);
    }
  }
  lines.push(
    `    public static func ${query.name}(${args.join(', ')}) throws -> [${Row}] {`,
  );
  const page = metadata.inputs.find((input) => input.kind === 'page');
  if (page?.kind === 'page') {
    const name = camelCase(page.langName);
    lines.push(
      `        let effective${typeName(name)} = ${name} ?? ${page.defaultSize}`,
      `        guard effective${typeName(name)} >= 1 && effective${typeName(name)} <= ${page.maxSize} else {`,
      `            throw SyncularQueryInputError(code: "SYQL_RUNTIME_INVALID_PAGE", message: ${quote(`${query.name}: invalid page size`)})`,
      '        }',
    );
  }
  if (metadata.plan.backend === 'variants') {
    lines.push('        var activationMask = 0');
    metadata.plan.activationControls.forEach((control, index) => {
      lines.push(
        `        if ${syqlControlActive(query, control)} { activationMask |= ${2 ** index} }`,
      );
    });
  }
  const sort = metadata.inputs.find((input) => input.kind === 'sort');
  const profileCount = sort?.kind === 'sort' ? sort.profiles.length : 1;
  const sortIndex =
    sort?.kind === 'sort' ? `${camelCase(sort.langName)}.rawValue` : '0';
  const index =
    metadata.plan.backend === 'variants'
      ? `activationMask * ${profileCount} + ${sortIndex}`
      : sortIndex;
  lines.push(
    `        let statementIndex = ${index}`,
    '        let selected: (String, [JSONValue])',
    '        switch statementIndex {',
  );
  metadata.plan.statements.forEach((statement, statementIndex) => {
    const binds = statement.binds
      .map((bind) => syqlBindExpr(query, bind))
      .join(', ');
    lines.push(
      `        case ${statementIndex}: selected = (${quote(statement.positionalSql)}, [${binds}])`,
    );
  });
  lines.push(
    '        default: preconditionFailure("invalid generated SYQL statement index")',
    '        }',
    '        return try client.query(selected.0, params: selected.1).compactMap { row in',
    '            guard case let .object(fields) = row else { return nil }',
    `            return ${Row}(row: fields)`,
    '        }',
    '    }',
  );
  return lines;
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

function emitRunner(query: AnalyzedQuery): string[] {
  if (query.syql !== undefined) return emitSyqlSwiftRunner(query);
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
  const args: string[] = [];
  for (const p of query.params) {
    const name = camelCase(p.langName);
    args.push(`${name}: ${SWIFT_TYPE[p.type]}`);
  }
  const signature =
    args.length > 0
      ? `client: SyncularClient, ${args.join(', ')}`
      : 'client: SyncularClient';
  lines.push(
    `    public static func ${query.name}(${signature}) throws -> [${Row}] {`,
  );
  const sqlRef = `${query.name}Sql`;
  if (query.params.length > 0) {
    const binds = query.params
      .map((p) => {
        const name = camelCase(p.langName);
        return paramValue(p.type, name);
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

  if (queries.some((query) => query.syql !== undefined)) {
    parts.push(
      [
        'public enum SyncularQueryPresence<Value: Sendable>: Sendable {',
        '    case absent',
        '    case present(Value)',
        '}',
        '',
        'public struct SyncularQueryInputError: Error, Sendable {',
        '    public let code: String',
        '    public let message: String',
        '    public init(code: String, message: String) {',
        '        self.code = code',
        '        self.message = message',
        '    }',
        '}',
      ].join('\n'),
    );
  }

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
    const syqlTypes = emitSyqlSwiftTypes(query);
    if (syqlTypes.length > 0) parts.push(syqlTypes.join('\n'));
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
