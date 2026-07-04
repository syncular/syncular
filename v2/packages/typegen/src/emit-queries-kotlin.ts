/**
 * Kotlin named-query emitter: analyzed queries → a standalone
 * `Syncular.queries.kt` file. Per query `q` it emits a `data class QRow` +
 * `fromRow` companion, and an `object <ObjectName>Queries` with a
 * `q(client, …): List<QRow>` runner + `qTables` constant. The runner binds
 * named params positionally into the wrapper's `query(sql, params)`.
 *
 * Reuses the schema file's `rowBool`/`rowBytes` helpers (they are top-level
 * private in the schema module; queries live in the same package so re-declare
 * package-private copies here to stay self-contained — the query file is a
 * separate output). Header carries the IR hash for byte-exact `--check`.
 */
import type { IrColumnType } from './ir';
import type { AnalyzedQuery, QueryColumn } from './query';

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

function typeName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
}

function rowAccessor(column: QueryColumn): string {
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
      return `queryRowBool(${key})`;
    case 'bytes':
    case 'crdt':
      return `queryRowBytes(${key})`;
  }
}

function paramValue(type: IrColumnType, name: string): string {
  switch (type) {
    case 'integer':
      // JsonValue.of has no Long overload; widen to Double (SQLite numbers).
      return `JsonValue.of(${name}.toDouble())`;
    case 'float':
      return `JsonValue.of(${name})`;
    case 'boolean':
      return `JsonValue.of(${name})`;
    case 'bytes':
    case 'crdt':
      return `queryBindBytes(${name})`;
    default:
      return `JsonValue.of(${name})`;
  }
}

function emitDataClass(query: AnalyzedQuery): string[] {
  const Row = `${typeName(query.name)}Row`;
  const lines: string[] = [];
  lines.push(`/** One row of the ${query.name} query (its projection). */`);
  lines.push(`data class ${Row}(`);
  for (const column of query.columns) {
    const opt = column.nullable ? '?' : '';
    lines.push(
      `    val ${camelCase(column.name)}: ${KOTLIN_TYPE[column.type]}${opt},`,
    );
  }
  lines.push(') {');
  lines.push('    companion object {');
  lines.push(`        fun fromRow(row: JsonValue): ${Row}? {`);
  for (const column of query.columns) {
    const name = camelCase(column.name);
    const accessor = rowAccessor(column);
    if (column.nullable) {
      lines.push(`            val ${name} = ${accessor}`);
    } else {
      lines.push(`            val ${name} = ${accessor} ?: return null`);
    }
  }
  const args = query.columns.map((c) => camelCase(c.name)).join(', ');
  lines.push(`            return ${Row}(${args})`);
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  return lines;
}

function emitRunner(query: AnalyzedQuery): string[] {
  const Row = `${typeName(query.name)}Row`;
  const lines: string[] = [];
  lines.push(
    `        val ${query.name}Tables = listOf(${query.tables.map(quote).join(', ')})`,
  );
  lines.push(
    `        private const val ${query.name}Sql = ${quote(query.positionalSql)}`,
  );
  lines.push('');
  lines.push(`        /** Run the ${query.name} named query (SELECT-only). */`);
  const args = query.params
    .map((p) => `${camelCase(p.name)}: ${KOTLIN_TYPE[p.type]}`)
    .join(', ');
  const signature =
    query.params.length > 0
      ? `client: SyncularClient, ${args}`
      : 'client: SyncularClient';
  lines.push(`        fun ${query.name}(${signature}): List<${Row}> {`);
  if (query.params.length > 0) {
    const binds = query.params
      .map((p) => paramValue(p.type, camelCase(p.name)))
      .join(', ');
    lines.push(`            val params = listOf(${binds})`);
    lines.push(
      `            return client.query(${query.name}Sql, params).mapNotNull { ${Row}.fromRow(it) }`,
    );
  } else {
    lines.push(
      `            return client.query(${query.name}Sql).mapNotNull { ${Row}.fromRow(it) }`,
    );
  }
  lines.push('        }');
  return lines;
}

export function emitQueriesKotlinModule(
  queries: readonly AnalyzedQuery[],
  hash: string,
  irVersion: number,
  packageName: string,
  objectName: string,
): string {
  const parts: string[] = [];
  parts.push(
    [
      '// Generated by @syncular-v2/typegen — DO NOT EDIT.',
      `// irVersion: ${irVersion}`,
      `// irHash: ${hash}`,
      '',
      `package ${packageName}`,
      '',
      'import dev.syncular.JsonValue',
      'import dev.syncular.SyncularClient',
    ].join('\n'),
  );

  // Row-decode + bind helpers (package-private; distinct names so they don't
  // clash with the schema file's rowBool/rowBytes in the same package).
  parts.push(
    [
      'private fun queryRowBool(value: JsonValue?): Boolean? {',
      '    value?.bool?.let { return it }',
      '    value?.number?.let { return it != 0.0 }',
      '    return null',
      '}',
      '',
      'private fun queryRowBytes(value: JsonValue?): ByteArray? {',
      '    val hex = value?.get("\\$bytes")?.string ?: return null',
      '    if (hex.length % 2 != 0) return null',
      '    return ByteArray(hex.length / 2) { i ->',
      '        hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()',
      '    }',
      '}',
      '',
      'private fun queryBindBytes(value: ByteArray): JsonValue {',
      '    val hex = value.joinToString("") { "%02x".format(it) }',
      '    return JsonValue.obj("\\$bytes" to JsonValue.of(hex))',
      '}',
    ].join('\n'),
  );

  for (const query of queries) {
    parts.push(emitDataClass(query).join('\n'));
  }

  const objLines: string[] = [];
  objLines.push('/** Typed named queries (the sqlc/SQLDelight tier). */');
  objLines.push(`object ${objectName}Queries {`);
  objLines.push(queries.map((q) => emitRunner(q).join('\n')).join('\n\n'));
  objLines.push('}');
  parts.push(objLines.join('\n'));

  return `${parts.join('\n\n')}\n`;
}
