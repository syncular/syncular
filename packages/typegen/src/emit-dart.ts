/**
 * Dart emitter: neutral IR → one standalone `.dart` file exporting
 *
 * - `const syncularSchema` — the ServerSchema-compatible `Map<String,
 *   Object?>` built from the IR (fed straight into `SyncularClient.create(
 *   schema: …)`),
 * - one class per table with typed fields (per the six §2.4 column types +
 *   blob_ref/crdt) and a `fromRow(Map<String, Object?>)` factory,
 * - a `syncular<Name>Subscription` helper per subscription with a typed
 *   `scopes(...)` builder.
 *
 * The row shape is `Map<String, Object?>` — the exact type the Dart wrapper's
 * `query`/`readRows` return. The header carries the IR hash so `--check`
 * verifies freshness byte-exactly.
 */
import type { IrColumnType, IrDocument, IrSubscription, IrTable } from './ir';
import { snakeToCamel } from './naming';

/** §2.4 column type → honest Dart type. `json`/`blob_ref` are the raw
 * canonical JSON string; `bytes`/`crdt` are opaque `List<int>`. */
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

/** §5.11: app-side Dart type — declaredType for an encrypted column. */
function appDartType(column: IrTable['columns'][number]): string {
  const type =
    column.encrypted === true && column.declaredType !== undefined
      ? column.declaredType
      : column.type;
  return DART_TYPE[type];
}

function pascalCase(name: string): string {
  return name
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** Language-facing field name — the pinned §12 naming map. */
function camelCase(name: string): string {
  return snakeToCamel(name);
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$')}'`;
}

function emitSchemaValue(ir: IrDocument, indent: string): string[] {
  const lines: string[] = [];
  const i = indent;
  lines.push(`${i}<String, Object?>{`);
  lines.push(`${i}  'version': ${ir.schemaVersion},`);
  lines.push(`${i}  'tables': [`);
  for (const table of ir.tables) {
    lines.push(`${i}    {`);
    lines.push(`${i}      'name': ${quote(table.name)},`);
    lines.push(`${i}      'primaryKey': ${quote(table.primaryKey)},`);
    lines.push(`${i}      'columns': [`);
    for (const column of table.columns) {
      const parts = [
        `'name': ${quote(column.name)}`,
        `'type': ${quote(column.type)}`,
        `'nullable': ${column.nullable}`,
      ];
      if (column.crdtType !== undefined) {
        parts.push(`'crdtType': ${quote(column.crdtType)}`);
      }
      if (column.encrypted === true) {
        parts.push("'encrypted': true");
        parts.push(
          `'declaredType': ${quote(column.declaredType ?? column.type)}`,
        );
      }
      lines.push(`${i}        {${parts.join(', ')}},`);
    }
    lines.push(`${i}      ],`);
    lines.push(`${i}      'scopes': [`);
    for (const scope of table.scopes) {
      lines.push(
        `${i}        {'pattern': ${quote(scope.pattern)}, 'column': ${quote(scope.column)}},`,
      );
    }
    lines.push(`${i}      ],`);
    lines.push(`${i}    },`);
  }
  lines.push(`${i}  ],`);
  lines.push(`${i}}`);
  return lines;
}

/** The accessor lifting a §2.4 value out of a `Map<String, Object?>` row. */
function rowAccessor(column: { type: IrColumnType; name: string }): string {
  const key = `row[${quote(column.name)}]`;
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
      return `_rowBool(${key})`;
    case 'bytes':
    case 'crdt':
      return `_rowBytes(${key})`;
  }
}

function emitClass(table: IrTable): string[] {
  const type = pascalCase(table.name);
  const lines: string[] = [];
  lines.push(`/// One ${table.name} row (§2.4 column order).`);
  lines.push(`class ${type} {`);
  for (const column of table.columns) {
    const dart = appDartType(column);
    const opt = column.nullable ? '?' : '';
    lines.push(`  final ${dart}${opt} ${camelCase(column.name)};`);
  }
  lines.push('');
  const ctorParams = table.columns
    .map((c) => `${c.nullable ? '' : 'required '}this.${camelCase(c.name)}`)
    .join(', ');
  lines.push(`  const ${type}({${ctorParams}});`);
  lines.push('');
  lines.push(
    `  /// Build from a \`query\`/\`readRows\` row. Returns null when a`,
  );
  lines.push(`  /// non-nullable column is missing or mistyped.`);
  lines.push(`  static ${type}? fromRow(Map<String, Object?> row) {`);
  for (const column of table.columns) {
    if (!column.nullable) {
      const name = camelCase(column.name);
      lines.push(`    final ${name} = ${rowAccessor(column)};`);
      lines.push(`    if (${name} == null) return null;`);
    }
  }
  const args = table.columns
    .map((c) => {
      const name = camelCase(c.name);
      return c.nullable ? `${name}: ${rowAccessor(c)}` : `${name}: ${name}`;
    })
    .join(', ');
  lines.push(`    return ${type}(${args});`);
  lines.push('  }');
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
    `/// Requested-scope template for the ${quote(sub.name)} subscription.`,
  );
  lines.push(`class Syncular${pascalCase(sub.name)}Subscription {`);
  lines.push(`  static const String name = ${quote(sub.name)};`);
  lines.push(`  static const String table = ${quote(sub.table)};`);
  const args = params.map((p) => `required String ${camelCase(p)}`).join(', ');
  const argsClause = args.length > 0 ? `{${args}}` : '';
  lines.push(`  static Map<String, List<String>> scopes(${argsClause}) => {`);
  for (const scope of sub.scopes) {
    const values = scope.values
      .map((value) =>
        value.kind === 'literal' ? quote(value.value) : camelCase(value.name),
      )
      .join(', ');
    lines.push(`        ${quote(scope.variable)}: [${values}],`);
  }
  lines.push('      };');
  lines.push('}');
  return lines;
}

export function emitDartModule(ir: IrDocument, hash: string): string {
  const parts: string[] = [];
  parts.push(
    [
      '// Generated by @syncular/typegen — DO NOT EDIT.',
      `// irVersion: ${ir.irVersion}`,
      `// irHash: ${hash}`,
      '// ignore_for_file: type=lint',
    ].join('\n'),
  );

  // The schema constant.
  const schemaLines: string[] = [];
  schemaLines.push('/// ServerSchema-compatible schema (SPEC §2.4, §3.1) —');
  schemaLines.push('/// pass to `SyncularClient.create(schema: …)`.');
  const schemaValue = emitSchemaValue(ir, '');
  schemaValue[0] = `const Map<String, Object?> syncularSchema = ${schemaValue[0]}`;
  schemaValue[schemaValue.length - 1] =
    `${schemaValue[schemaValue.length - 1]};`;
  for (const line of schemaValue) schemaLines.push(line);
  parts.push(schemaLines.join('\n'));

  // Shared row-decode helpers — emitted only when a column type references
  // them. An unused private helper is an ANALYZER diagnostic (unused_element),
  // which the `type=lint` ignore above does not cover, so a schema without
  // boolean or bytes/crdt columns would fail a fatal-warnings `dart analyze`.
  const columnTypes = new Set(
    ir.tables.flatMap((table) => table.columns.map((column) => column.type)),
  );
  if (columnTypes.has('boolean')) {
    parts.push(
      [
        '/// Lift a SQLite boolean: a real bool, or 0/1 as a number.',
        'bool? _rowBool(Object? value) {',
        '  if (value is bool) return value;',
        '  if (value is num) return value != 0;',
        '  return null;',
        '}',
      ].join('\n'),
    );
  }
  if (columnTypes.has('bytes') || columnTypes.has('crdt')) {
    parts.push(
      [
        "/// Decode the core's {'\\$bytes': '<hex>'} marshaling (bytes as hex).",
        'List<int>? _rowBytes(Object? value) {',
        '  if (value is! Map) return null;',
        "  final hex = value[r'$bytes'];",
        '  if (hex is! String || hex.length % 2 != 0) return null;',
        '  return [',
        '    for (var i = 0; i < hex.length; i += 2)',
        '      int.parse(hex.substring(i, i + 2), radix: 16),',
        '  ];',
        '}',
      ].join('\n'),
    );
  }

  for (const table of ir.tables) {
    parts.push(emitClass(table).join('\n'));
  }
  for (const sub of ir.subscriptions) {
    parts.push(emitSubscription(sub).join('\n'));
  }

  return `${parts.join('\n\n')}\n`;
}
