/**
 * Swift emitter: neutral IR → one standalone `.swift` file exporting
 *
 * - `enum <EnumName> { static let schema: JSONValue }` — the ServerSchema
 *   object, built from the IR with byte-stable ordering (fed straight into
 *   `SyncularClient(schema:)`),
 * - one `struct` per table with typed properties (per the six §2.4 column
 *   types, plus blob_ref/crdt in their honest Swift shapes) and a
 *   `init?(row:)` from a `[String: JSONValue]` (the shape `query`/`readRows`
 *   return),
 * - a `subscriptions` namespace of typed requested-scope builders.
 *
 * The file imports only `Syncular` (for `JSONValue`). The header carries the
 * IR hash so `--check` verifies freshness byte-exactly, exactly like the TS
 * emitter.
 */
import type { IrColumnType, IrDocument, IrSubscription, IrTable } from './ir';

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

function pascalCase(name: string): string {
  return name
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function camelCase(name: string): string {
  const pascal = pascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Emit a `JSONValue` literal for the schema object (built from the IR). */
function emitSchemaValue(ir: IrDocument, indent: string): string[] {
  const lines: string[] = [];
  const i = indent;
  lines.push(`${i}.object([`);
  lines.push(`${i}  "version": .number(${ir.schemaVersion}),`);
  lines.push(`${i}  "tables": .array([`);
  for (const table of ir.tables) {
    lines.push(`${i}    .object([`);
    lines.push(`${i}      "name": .string(${quote(table.name)}),`);
    lines.push(`${i}      "primaryKey": .string(${quote(table.primaryKey)}),`);
    lines.push(`${i}      "columns": .array([`);
    for (const column of table.columns) {
      const parts = [
        `"name": .string(${quote(column.name)})`,
        `"type": .string(${quote(column.type)})`,
        `"nullable": .bool(${column.nullable})`,
      ];
      if (column.crdtType !== undefined) {
        parts.push(`"crdtType": .string(${quote(column.crdtType)})`);
      }
      lines.push(`${i}        .object([${parts.join(', ')}]),`);
    }
    lines.push(`${i}      ]),`);
    lines.push(`${i}      "scopes": .array([`);
    for (const scope of table.scopes) {
      lines.push(
        `${i}        .object(["pattern": .string(${quote(scope.pattern)}), "column": .string(${quote(scope.column)})]),`,
      );
    }
    lines.push(`${i}      ]),`);
    lines.push(`${i}    ]),`);
  }
  lines.push(`${i}  ]),`);
  lines.push(`${i}])`);
  return lines;
}

/** The accessor that lifts a §2.4 value out of a `[String: JSONValue]` row. */
function rowAccessor(column: {
  type: IrColumnType;
  name: string;
  nullable: boolean;
}): string {
  const key = `row[${quote(column.name)}]`;
  switch (column.type) {
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
    const swift = SWIFT_TYPE[column.type];
    const opt = column.nullable ? '?' : '';
    lines.push(`    public let ${camelCase(column.name)}: ${swift}${opt}`);
  }
  lines.push('');
  // Memberwise init (public, so app code can build rows too).
  const params = table.columns
    .map((c) => {
      const swift = SWIFT_TYPE[c.type];
      const opt = c.nullable ? '? = nil' : '';
      return `${camelCase(c.name)}: ${swift}${opt}`;
    })
    .join(', ');
  lines.push(`    public init(${params}) {`);
  for (const column of table.columns) {
    const name = camelCase(column.name);
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

function emitSubscription(sub: IrSubscription): string[] {
  const params: string[] = [];
  for (const scope of sub.scopes) {
    for (const value of scope.values) {
      if (value.kind === 'parameter' && !params.includes(value.name)) {
        params.push(value.name);
      }
    }
  }
  const lines: string[] = [];
  lines.push(
    `        /// Requested-scope template for the ${quote(sub.name)} subscription.`,
  );
  lines.push(`        public enum ${pascalCase(sub.name)} {`);
  lines.push(`            public static let name = ${quote(sub.name)}`);
  lines.push(`            public static let table = ${quote(sub.table)}`);
  const args = params.map((p) => `${camelCase(p)}: String`).join(', ');
  lines.push(
    `            public static func scopes(${args}) -> [String: [String]] {`,
  );
  lines.push('                [');
  for (const scope of sub.scopes) {
    const values = scope.values
      .map((value) =>
        value.kind === 'literal' ? quote(value.value) : camelCase(value.name),
      )
      .join(', ');
    lines.push(`                    ${quote(scope.variable)}: [${values}],`);
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
  schemaLines.push('    public static let schema: JSONValue =');
  for (const line of emitSchemaValue(ir, '        ')) {
    schemaLines.push(line);
  }
  schemaLines.push('');
  // Subscriptions namespace nested in the schema enum.
  schemaLines.push('    /// Typed requested-scope builders per subscription.');
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
