/**
 * Swift emitter: neutral IR → one standalone `.swift` file exporting
 *
 * - `enum <EnumName> { static let schema: JSONValue }` — the ServerSchema
 *   object: the exact `serializeSchema` JSON the TS module embeds, parsed
 *   from a string literal (fed straight into `SyncularClient(schema:)`),
 * - one `struct` per table with typed properties (per the six §2.4 column
 *   types, plus blob_ref/crdt in their honest Swift shapes) and a
 *   `init?(row:)` from a `[String: JSONValue]` (the shape `query`/`readRows`
 *   return),
 * - a `subscriptions` namespace of typed unit-template builders (SPEC §4.1).
 *
 * The file imports only `Syncular` (for `JSONValue`). The header carries the
 * IR hash so `--check` verifies freshness byte-exactly, exactly like the TS
 * emitter.
 */
import {
  appColumnType,
  type IrColumnType,
  type IrDocument,
  type IrSubscription,
  type IrTable,
  serializeSchema,
} from './ir';
import { pascalCase, snakeToCamel, stringLiteral } from './naming';

/**
 * §2.4 column type → honest Swift type. `json`/`blob_ref` are the raw
 * canonical JSON string (the client's blob API parses blob_ref); `bytes`/
 * `crdt` are opaque `[UInt8]`.
 */
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

/** The accessor that lifts a §2.4 value out of a `[String: JSONValue]` row. */
function rowAccessor(column: IrTable['columns'][number]): string {
  const key = `row[${stringLiteral(column.name, 'swift')}]`;
  switch (appColumnType(column)) {
    case 'string':
    case 'json':
    case 'blob_ref':
      return `${key}?.stringValue`;
    case 'integer':
      // SQLite integers ride as JSON numbers; round to Int. Uses `.map(Int.init)`
      // (not a trailing closure) so it parses inside a `guard let … else`.
      return `${key}?.numberValue.map(Int.init)`;
    case 'float':
      return `${key}?.numberValue`;
    case 'boolean':
      // SQLite has no bool: it stores 0/1. Accept a real JSON bool OR 0/1.
      return `SyncularSchemaRow.bool(${key})`;
    case 'bytes':
    case 'crdt':
      // The core marshals bytes as {"$bytes":"<hex>"}; decode to [UInt8].
      return `SyncularSchemaRow.bytes(${key})`;
  }
}

function emitStruct(table: IrTable): string[] {
  const type = pascalCase(table.name);
  const lines: string[] = [];
  lines.push(`/// One ${table.name} row (§2.4 column order).`);
  lines.push(`public struct ${type}: Sendable, Equatable {`);
  for (const column of table.columns) {
    const swift = SWIFT_TYPE[appColumnType(column)];
    const opt = column.nullable ? '?' : '';
    lines.push(`    public let ${snakeToCamel(column.name)}: ${swift}${opt}`);
  }
  lines.push('');
  // Memberwise init (public, so app code can build rows too).
  const params = table.columns
    .map((c) => {
      const swift = SWIFT_TYPE[appColumnType(c)];
      const opt = c.nullable ? '? = nil' : '';
      return `${snakeToCamel(c.name)}: ${swift}${opt}`;
    })
    .join(', ');
  lines.push(`    public init(${params}) {`);
  for (const column of table.columns) {
    const name = snakeToCamel(column.name);
    lines.push(`        self.${name} = ${name}`);
  }
  lines.push('    }');
  lines.push('');
  lines.push(
    `    /// Build from a \`query\`/\`readRows\` row (\`[String: JSONValue]\`).`,
  );
  lines.push(
    `    /// Returns nil when a non-nullable column is missing or mistyped.`,
  );
  lines.push('    public init?(row: [String: JSONValue]) {');
  for (const column of table.columns) {
    const name = snakeToCamel(column.name);
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

function emitSubscription(sub: IrSubscription): string[] {
  const params = [
    ...new Set(
      sub.scopes.flatMap(({ value }) =>
        value.kind === 'parameter' ? [value.name] : [],
      ),
    ),
  ];
  const lines: string[] = [];
  lines.push(
    `        /// Unit template for the ${stringLiteral(sub.name, 'swift')} subscription (SPEC §4.1).`,
  );
  lines.push(`        public enum ${pascalCase(sub.name)} {`);
  lines.push(
    `            public static let name = ${stringLiteral(sub.name, 'swift')}`,
  );
  const args = params.map((p) => `${snakeToCamel(p)}: String`).join(', ');
  lines.push(
    `            public static func scopes(${args}) -> [String: String] {`,
  );
  lines.push('                [');
  for (const { variable, value } of sub.scopes) {
    lines.push(
      `                    ${stringLiteral(variable, 'swift')}: ${value.kind === 'literal' ? stringLiteral(value.value, 'swift') : snakeToCamel(value.name)},`,
    );
  }
  lines.push('                ]');
  lines.push('            }');
  lines.push('        }');
  return lines;
}

export function emitSwiftModule(
  ir: IrDocument,
  hash: string,
  enumName: string,
): string {
  const parts: string[] = [];
  parts.push(
    [
      '// Generated by @syncular/typegen — DO NOT EDIT.',
      `// irVersion: ${ir.irVersion}`,
      `// irHash: ${hash}`,
      '',
      'import Foundation',
      'import Syncular',
    ].join('\n'),
  );

  // The schema namespace.
  const schemaLines: string[] = [];
  schemaLines.push(
    `/// The generated syncular schema (SPEC §2.4, §3.1) + typed rows.`,
  );
  schemaLines.push(`public enum ${enumName} {`);
  schemaLines.push(
    `    /// ServerSchema-compatible schema — pass to \`SyncularClient(schema:)\`.`,
  );
  // A multi-line literal strips the closing delimiter's indentation from
  // every line, so the parsed string is the serializeSchema bytes. JSON
  // escapes every quote inside a string, so it never holds the closing
  // delimiter; doubling backslashes also disarms `\(` interpolation.
  schemaLines.push(
    '    public static let schema: JSONValue = try! JSONValue(decoding: """',
  );
  for (const line of serializeSchema(ir).split('\n')) {
    schemaLines.push(`        ${line.replaceAll('\\', '\\\\')}`);
  }
  schemaLines.push('        """)');
  schemaLines.push('');
  // Subscriptions namespace nested in the schema enum.
  schemaLines.push(
    '    /// Typed unit-template builders per subscription (SPEC §4.1).',
  );
  schemaLines.push('    public enum subscriptions {');
  if (ir.subscriptions.length === 0) {
    schemaLines.push('        // (no subscriptions declared)');
  }
  for (const sub of ir.subscriptions) {
    for (const line of emitSubscription(sub)) schemaLines.push(line);
  }
  schemaLines.push('    }');
  schemaLines.push('}');
  parts.push(schemaLines.join('\n'));

  // Shared row-decode helpers (0/1 booleans, {$bytes} decode).
  parts.push(
    [
      '/// Row-decode helpers shared by the generated structs.',
      'enum SyncularSchemaRow {',
      '    /// Lift a SQLite boolean: a real JSON bool, or 0/1 as a number.',
      '    static func bool(_ value: JSONValue?) -> Bool? {',
      '        if let b = value?.boolValue { return b }',
      '        if let n = value?.numberValue { return n != 0 }',
      '        return nil',
      '    }',
      '',
      '    /// Decode the core\'s `{"$bytes":"<hex>"}` marshaling into bytes.',
      '    static func bytes(_ value: JSONValue?) -> [UInt8]? {',
      '        guard let hex = value?["$bytes"]?.stringValue else { return nil }',
      '        var out: [UInt8] = []',
      '        out.reserveCapacity(hex.count / 2)',
      '        var index = hex.startIndex',
      '        while index < hex.endIndex {',
      '            let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex',
      '            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }',
      '            out.append(byte)',
      '            index = next',
      '        }',
      '        return out',
      '    }',
      '}',
    ].join('\n'),
  );

  for (const table of ir.tables) {
    parts.push(emitStruct(table).join('\n'));
  }

  return `${parts.join('\n\n')}\n`;
}
