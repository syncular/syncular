/**
 * Kotlin emitter: neutral IR → one standalone `.kt` file exporting
 *
 * - `object <ObjectName> { val schema: JsonValue }` — the ServerSchema
 *   object built from the IR (fed straight into `SyncularClient.create(
 *   schema = …)`),
 * - one `data class` per table with typed properties (per the six §2.4 column
 *   types + blob_ref/crdt) and a `fromRow(row: JsonValue)` companion factory,
 * - a `Subscriptions` object of typed requested-scope builders.
 *
 * The row shape is `JsonValue` — the exact type the Kotlin wrapper's
 * `query`/`readRows` return (each row a `JsonValue.Obj`). The header carries
 * the IR hash so `--check` verifies freshness byte-exactly.
 */
import type { IrColumnType, IrDocument, IrSubscription, IrTable } from './ir';
import { snakeToCamel } from './naming';

/** §2.4 column type → honest Kotlin type. `json`/`blob_ref` are the raw
 * canonical JSON string; `bytes`/`crdt` are opaque `ByteArray`. */
const KOTLIN_TYPE: Readonly<Record<IrColumnType, string>> = {
  string: 'String',
  integer: 'Long',
  float: 'Double',
  boolean: 'Boolean',
  json: 'String',
  bytes: 'ByteArray',
  blob_ref: 'String',
  crdt: 'ByteArray',
};

/** §5.11: app-side Kotlin type — declaredType for an encrypted column. */
function appKotlinType(column: IrTable['columns'][number]): string {
  const type =
    column.encrypted === true && column.declaredType !== undefined
      ? column.declaredType
      : column.type;
  return KOTLIN_TYPE[type];
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
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
}

function emitSchemaValue(ir: IrDocument, indent: string): string[] {
  const lines: string[] = [];
  const i = indent;
  lines.push(`${i}JsonValue.obj(`);
  lines.push(`${i}  "version" to JsonValue.of(${ir.schemaVersion}),`);
  lines.push(`${i}  "tables" to JsonValue.arr(listOf(`);
  for (const table of ir.tables) {
    lines.push(`${i}    JsonValue.obj(`);
    lines.push(`${i}      "name" to JsonValue.of(${quote(table.name)}),`);
    lines.push(
      `${i}      "primaryKey" to JsonValue.of(${quote(table.primaryKey)}),`,
    );
    lines.push(`${i}      "columns" to JsonValue.arr(listOf(`);
    for (const column of table.columns) {
      const parts = [
        `"name" to JsonValue.of(${quote(column.name)})`,
        `"type" to JsonValue.of(${quote(column.type)})`,
        `"nullable" to JsonValue.of(${column.nullable})`,
      ];
      if (column.crdtType !== undefined) {
        parts.push(`"crdtType" to JsonValue.of(${quote(column.crdtType)})`);
      }
      if (column.encrypted === true) {
        parts.push('"encrypted" to JsonValue.of(true)');
        parts.push(
          `"declaredType" to JsonValue.of(${quote(column.declaredType ?? column.type)})`,
        );
      }
      lines.push(`${i}        JsonValue.obj(${parts.join(', ')}),`);
    }
    lines.push(`${i}      )),`);
    lines.push(`${i}      "scopes" to JsonValue.arr(listOf(`);
    for (const scope of table.scopes) {
      lines.push(
        `${i}        JsonValue.obj("pattern" to JsonValue.of(${quote(scope.pattern)}), "column" to JsonValue.of(${quote(scope.column)})),`,
      );
    }
    lines.push(`${i}      )),`);
    lines.push(`${i}    ),`);
  }
  lines.push(`${i}  )),`);
  lines.push(`${i})`);
  return lines;
}

/** The accessor lifting a §2.4 value out of a row `JsonValue`. */
function rowAccessor(column: { type: IrColumnType; name: string }): string {
  const key = `row[${quote(column.name)}]`;
  switch (column.type) {
    case 'string':
    case 'json':
    case 'blob_ref':
      return `${key}?.string`;
    case 'integer':
      return `${key}?.number?.toLong()`;
    case 'float':
      return `${key}?.number`;
    case 'boolean':
      return `rowBool(${key})`;
    case 'bytes':
    case 'crdt':
      return `rowBytes(${key})`;
  }
}

function emitDataClass(table: IrTable): string[] {
  const type = pascalCase(table.name);
  const lines: string[] = [];
  lines.push(`/** One ${table.name} row (§2.4 column order). */`);
  lines.push(`data class ${type}(`);
  for (const column of table.columns) {
    const kotlin = appKotlinType(column);
    const opt = column.nullable ? '?' : '';
    lines.push(`    val ${camelCase(column.name)}: ${kotlin}${opt},`);
  }
  lines.push(') {');
  lines.push('    companion object {');
  lines.push(
    `        /** Build from a \`query\`/\`readRows\` row. Null on a missing/mistyped non-nullable column. */`,
  );
  lines.push(`        fun fromRow(row: JsonValue): ${type}? {`);
  for (const column of table.columns) {
    const name = camelCase(column.name);
    const accessor = rowAccessor(column);
    if (column.nullable) {
      lines.push(`            val ${name} = ${accessor}`);
    } else {
      lines.push(`            val ${name} = ${accessor} ?: return null`);
    }
  }
  const args = table.columns.map((c) => camelCase(c.name)).join(', ');
  lines.push(`            return ${type}(${args})`);
  lines.push('        }');
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
    `        /** Requested-scope template for the ${quote(sub.name)} subscription. */`,
  );
  lines.push(`        object ${pascalCase(sub.name)} {`);
  lines.push(`            const val name = ${quote(sub.name)}`);
  lines.push(`            const val table = ${quote(sub.table)}`);
  const args = params.map((p) => `${camelCase(p)}: String`).join(', ');
  lines.push(
    `            fun scopes(${args}): Map<String, List<String>> = mapOf(`,
  );
  for (const scope of sub.scopes) {
    const values = scope.values
      .map((value) =>
        value.kind === 'literal' ? quote(value.value) : camelCase(value.name),
      )
      .join(', ');
    lines.push(
      `                ${quote(scope.variable)} to listOf(${values}),`,
    );
  }
  lines.push('            )');
  lines.push('        }');
  return lines;
}

export function emitKotlinModule(
  ir: IrDocument,
  hash: string,
  packageName: string,
  objectName: string,
): string {
  const parts: string[] = [];
  parts.push(
    [
      '// Generated by @syncular/typegen — DO NOT EDIT.',
      `// irVersion: ${ir.irVersion}`,
      `// irHash: ${hash}`,
      '',
      `package ${packageName}`,
      '',
      'import dev.syncular.JsonValue',
    ].join('\n'),
  );

  const schemaLines: string[] = [];
  schemaLines.push('/** The generated syncular schema (SPEC §2.4, §3.1). */');
  schemaLines.push(`object ${objectName} {`);
  schemaLines.push(
    `    /** ServerSchema-compatible schema — pass to \`SyncularClient.create(schema = …)\`. */`,
  );
  schemaLines.push('    val schema: JsonValue =');
  for (const line of emitSchemaValue(ir, '        ')) schemaLines.push(line);
  schemaLines.push('');
  schemaLines.push(
    '    /** Typed requested-scope builders per subscription. */',
  );
  schemaLines.push('    object Subscriptions {');
  if (ir.subscriptions.length === 0) {
    schemaLines.push('        // (no subscriptions declared)');
  }
  for (const sub of ir.subscriptions) {
    for (const line of emitSubscription(sub)) schemaLines.push(line);
  }
  schemaLines.push('    }');
  schemaLines.push('}');
  parts.push(schemaLines.join('\n'));

  // Shared row-decode helpers — emitted only when a column type references
  // them (the Dart emitter's rule): an unused private fun is dead code in a
  // generated file and an "is never used" inspection in every IDE. The
  // query emitter is unaffected — it declares its own queryRowBool/
  // queryRowBytes copies under distinct names.
  const columnTypes = new Set(
    ir.tables.flatMap((table) => table.columns.map((column) => column.type)),
  );
  if (columnTypes.has('boolean')) {
    parts.push(
      [
        '/** Lift a SQLite boolean: a real JSON bool, or 0/1 as a number. */',
        'private fun rowBool(value: JsonValue?): Boolean? {',
        '    value?.bool?.let { return it }',
        '    value?.number?.let { return it != 0.0 }',
        '    return null',
        '}',
      ].join('\n'),
    );
  }
  if (columnTypes.has('bytes') || columnTypes.has('crdt')) {
    parts.push(
      [
        '/** Decode the core\'s `{"$bytes":"<hex>"}` marshaling into a ByteArray. */',
        'private fun rowBytes(value: JsonValue?): ByteArray? {',
        '    val hex = value?.get("\\$bytes")?.string ?: return null',
        '    if (hex.length % 2 != 0) return null',
        '    return ByteArray(hex.length / 2) { i ->',
        '        hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()',
        '    }',
        '}',
      ].join('\n'),
    );
  }

  for (const table of ir.tables) {
    parts.push(emitDataClass(table).join('\n'));
  }

  return `${parts.join('\n\n')}\n`;
}
