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
import { snakeToCamel } from './naming';
import type { AnalyzedQuery, QueryColumn, QueryParam } from './query';

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

/** Language-facing field name — the pinned §12 naming map. */
function camelCase(name: string): string {
  return snakeToCamel(name);
}

function typeName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
}

function rowAccessor(column: QueryColumn): string {
  const key = `row[${quote(column.langName)}]`;
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

/** Bind for a §4 OPTIONAL param: `null` rides as JSON null (the §7
 * neutralization guards make it a no-op). */
function optionalParamValue(type: IrColumnType, name: string): string {
  switch (type) {
    case 'integer':
      return `${name}?.let { JsonValue.of(it.toDouble()) } ?: JsonValue.Null`;
    case 'bytes':
    case 'crdt':
      return `${name}?.let { queryBindBytes(it) } ?: JsonValue.Null`;
    default:
      return `${name}?.let { JsonValue.of(it) } ?: JsonValue.Null`;
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
    `/** §6 orderBy allowlist for ${query.name} — checked at generate time. */`,
  );
  lines.push(`enum class ${typeName(query.name)}OrderBy(val column: String) {`);
  lines.push(
    `${query.orderBy.allowed
      .map((col) => `    ${camelCase(col.langName)}(${quote(col.name)})`)
      .join(',\n')};`,
  );
  lines.push('}');
  return lines;
}

function emitDataClass(query: AnalyzedQuery): string[] {
  const Row = `${typeName(query.name)}Row`;
  const lines: string[] = [];
  lines.push(`/** One row of the ${query.name} query (its projection). */`);
  lines.push(`data class ${Row}(`);
  for (const column of query.columns) {
    const opt = column.nullable ? '?' : '';
    lines.push(
      `    val ${camelCase(column.langName)}: ${KOTLIN_TYPE[column.type]}${opt},`,
    );
  }
  lines.push(') {');
  lines.push('    companion object {');
  lines.push(`        fun fromRow(row: JsonValue): ${Row}? {`);
  for (const column of query.columns) {
    const name = camelCase(column.langName);
    const accessor = rowAccessor(column);
    if (column.nullable) {
      lines.push(`            val ${name} = ${accessor}`);
    } else {
      lines.push(`            val ${name} = ${accessor} ?: return null`);
    }
  }
  const args = query.columns.map((c) => camelCase(c.langName)).join(', ');
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
  if (query.orderBy !== undefined) {
    lines.push(
      `        private const val ${query.name}SqlBase = ${quote(query.positionalSqlBase ?? '')}`,
    );
  } else {
    lines.push(
      `        private const val ${query.name}Sql = ${quote(query.positionalSql)}`,
    );
  }
  lines.push('');
  lines.push(`        /** Run the ${query.name} named query (SELECT-only). */`);
  const args: string[] = [];
  for (const p of query.params) {
    const name = camelCase(p.langName);
    if (isOptionalParam(query, p)) {
      args.push(`${name}: ${KOTLIN_TYPE[p.type]}? = null`);
    } else {
      args.push(`${name}: ${KOTLIN_TYPE[p.type]}`);
    }
  }
  if (query.orderBy !== undefined) {
    const defaultCase = camelCase(
      query.orderBy.allowed.find((c) => c.name === query.orderBy?.defaultColumn)
        ?.langName ?? query.orderBy.defaultColumn,
    );
    args.push(
      `orderBy: ${typeName(query.name)}OrderBy = ${typeName(query.name)}OrderBy.${defaultCase}`,
    );
    args.push(
      `dir: SyncularQueryDir = SyncularQueryDir.${query.orderBy.defaultDir.toUpperCase()}`,
    );
  }
  const signature =
    args.length > 0
      ? `client: SyncularClient, ${args.join(', ')}`
      : 'client: SyncularClient';
  lines.push(`        fun ${query.name}(${signature}): List<${Row}> {`);
  if (query.orderBy !== undefined) {
    const limitTail =
      query.positionalLimitTail !== undefined
        ? ` + ${quote(query.positionalLimitTail)}`
        : '';
    lines.push(
      `            val sql = ${query.name}SqlBase + " order by " + orderBy.column + " " + dir.sql${limitTail}`,
    );
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
    lines.push(`            val params = listOf(${binds})`);
    lines.push(
      `            return client.query(${sqlRef}, params).mapNotNull { ${Row}.fromRow(it) }`,
    );
  } else {
    lines.push(
      `            return client.query(${sqlRef}).mapNotNull { ${Row}.fromRow(it) }`,
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
      '// Generated by @syncular/typegen — DO NOT EDIT.',
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

  if (queries.some((q) => q.orderBy !== undefined)) {
    parts.push(
      [
        '/** §6 orderBy direction (shared by every orderBy-knob query). */',
        'enum class SyncularQueryDir(val sql: String) {',
        '    ASC("asc"),',
        '    DESC("desc");',
        '}',
      ].join('\n'),
    );
  }

  for (const query of queries) {
    parts.push(emitDataClass(query).join('\n'));
    const orderByEnum = emitOrderByEnum(query);
    if (orderByEnum.length > 0) parts.push(orderByEnum.join('\n'));
  }

  const objLines: string[] = [];
  objLines.push('/** Typed named queries (the sqlc/SQLDelight tier). */');
  objLines.push(`object ${objectName}Queries {`);
  objLines.push(queries.map((q) => emitRunner(q).join('\n')).join('\n\n'));
  objLines.push('}');
  parts.push(objLines.join('\n'));

  return `${parts.join('\n\n')}\n`;
}
