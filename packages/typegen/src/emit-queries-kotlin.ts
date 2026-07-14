/**
 * Kotlin named-query emitter: analyzed queries → a standalone
 * `Syncular.queries.kt` file. Per query `q` it emits a `data class QRow` +
 * `fromRow` companion, and an `object <ObjectName>Queries` with a
 * `q(client, …): List<QRow>` runner + `qTables` constant. The runner binds
 * named params positionally into the wrapper's `query(sql, params)`.
 *
 * Self-contained: declares its own `queryRowBool`/`queryRowBytes` copies of
 * the schema file's row-decode helpers (distinct names — both files are
 * file-`private` in the same package, and the schema file only emits its
 * helpers when a column type needs them). Header carries the IR hash for
 * byte-exact `--check`.
 */
import type { IrColumnType } from './ir';
import { snakeToCamel } from './naming';
import type {
  AnalyzedQuery,
  QueryColumn,
  QueryParam,
  QuerySyqlPlanBind,
  QuerySyqlPublicInput,
} from './query';

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

function syqlInput(query: AnalyzedQuery, name: string): QuerySyqlPublicInput {
  const input = query.syql?.inputs.find((candidate) => candidate.name === name);
  if (input === undefined) throw new Error(`unknown SYQL input ${name}`);
  return input;
}

function syqlKotlinType(type: IrColumnType, nullable: boolean): string {
  return `${KOTLIN_TYPE[type]}${nullable ? '?' : ''}`;
}

function syqlControlActive(query: AnalyzedQuery, name: string): string {
  const input = syqlInput(query, name);
  const access = camelCase(input.langName);
  if (input.kind === 'switch') return access;
  if (input.kind === 'value' && input.nullable) {
    return `${access} is SyncularQueryPresence.Present`;
  }
  if (input.kind === 'value' || input.kind === 'group') {
    return `${access} != null`;
  }
  throw new Error(`${name} is not an activation control`);
}

function syqlNullablePresenceBind(type: IrColumnType, access: string): string {
  return `when (val presence = ${access}) { is SyncularQueryPresence.Present -> ${optionalParamValue(type, 'presence.value')}; SyncularQueryPresence.Absent -> JsonValue.Null }`;
}

function syqlBindExpr(query: AnalyzedQuery, bind: QuerySyqlPlanBind): string {
  if (bind.kind === 'condition-active') {
    const active = bind.controls
      .map((control) => syqlControlActive(query, control))
      .join(' && ');
    return `JsonValue.of(${active})`;
  }
  const input = syqlInput(query, bind.input);
  const access = camelCase(input.langName);
  if (bind.kind === 'page')
    return `JsonValue.of(effective${typeName(access)}.toDouble())`;
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
    return `${access}?.let { value -> ${present} } ?: JsonValue.Null`;
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

function emitSyqlKotlinTypes(query: AnalyzedQuery): string[] {
  const lines: string[] = [];
  for (const input of query.syql?.inputs ?? []) {
    if (input.kind === 'group') {
      const name = `${typeName(query.name)}${typeName(input.langName)}`;
      lines.push(`data class ${name}(`);
      for (const member of input.members) {
        lines.push(
          `    val ${camelCase(member.langName)}: ${syqlKotlinType(member.type, member.nullable)},`,
        );
      }
      lines.push(')', '');
    } else if (input.kind === 'sort') {
      const name = `${typeName(query.name)}${typeName(input.langName)}`;
      lines.push(`enum class ${name}(val index: Int) {`);
      lines.push(
        `${input.profiles
          .map(
            (profile, index) => `    ${camelCase(profile.langName)}(${index})`,
          )
          .join(',\n')};`,
      );
      lines.push('}', '');
    }
  }
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function emitSyqlKotlinRunner(query: AnalyzedQuery): string[] {
  const metadata = query.syql;
  if (metadata === undefined) throw new Error('missing SYQL metadata');
  const Row = `${typeName(query.name)}Row`;
  const lines: string[] = [];
  lines.push(
    `        val ${query.name}Tables = listOf(${query.tables.map(quote).join(', ')})`,
    '',
    `        /** Run the ${query.name} revision-1 SYQL query. */`,
  );
  const args = ['client: SyncularClient'];
  for (const input of metadata.inputs) {
    const name = camelCase(input.langName);
    if (input.kind === 'value') {
      const type = syqlKotlinType(input.type, input.nullable);
      if (input.required) args.push(`${name}: ${type}`);
      else if (input.nullable) {
        args.push(
          `${name}: SyncularQueryPresence<${type}> = SyncularQueryPresence.Absent`,
        );
      } else args.push(`${name}: ${type}? = null`);
    } else if (input.kind === 'group') {
      args.push(
        `${name}: ${typeName(query.name)}${typeName(input.langName)}? = null`,
      );
    } else if (input.kind === 'switch') {
      args.push(`${name}: Boolean = false`);
    } else if (input.kind === 'sort') {
      const defaultCase =
        input.profiles.find((profile) => profile.name === input.defaultProfile)
          ?.langName ?? input.defaultProfile;
      const type = `${typeName(query.name)}${typeName(input.langName)}`;
      args.push(`${name}: ${type} = ${type}.${camelCase(defaultCase)}`);
    } else {
      args.push(`${name}: Long? = null`);
    }
  }
  lines.push(`        fun ${query.name}(${args.join(', ')}): List<${Row}> {`);
  const page = metadata.inputs.find((input) => input.kind === 'page');
  if (page?.kind === 'page') {
    const name = camelCase(page.langName);
    lines.push(
      `            val effective${typeName(name)} = ${name} ?: ${page.defaultSize}L`,
      `            if (effective${typeName(name)} < 1L || effective${typeName(name)} > ${page.maxSize}L) {`,
      `                throw SyncularQueryInputException("SYQL_RUNTIME_INVALID_PAGE", ${quote(`${query.name}: invalid page size`)})`,
      '            }',
    );
  }
  if (metadata.plan.backend === 'variants') {
    lines.push('            var activationMask = 0');
    metadata.plan.activationControls.forEach((control, index) => {
      lines.push(
        `            if (${syqlControlActive(query, control)}) activationMask = activationMask or ${2 ** index}`,
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
    `            val statementIndex = ${index}`,
    '            val selected: Pair<String, List<JsonValue>> = when (statementIndex) {',
  );
  metadata.plan.statements.forEach((statement, statementIndex) => {
    const binds = statement.binds
      .map((bind) => syqlBindExpr(query, bind))
      .join(', ');
    lines.push(
      `                ${statementIndex} -> Pair(${quote(statement.positionalSql)}, listOf(${binds}))`,
    );
  });
  lines.push(
    '                else -> error("invalid generated SYQL statement index")',
    '            }',
    `            return client.query(selected.first, selected.second).mapNotNull { ${Row}.fromRow(it) }`,
    '        }',
  );
  return lines;
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
  if (query.syql !== undefined) return emitSyqlKotlinRunner(query);
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

  if (queries.some((query) => query.syql !== undefined)) {
    parts.push(
      [
        'sealed class SyncularQueryPresence<out T> {',
        '    object Absent : SyncularQueryPresence<Nothing>()',
        '    data class Present<T>(val value: T) : SyncularQueryPresence<T>()',
        '}',
        '',
        'class SyncularQueryInputException(',
        '    val code: String,',
        '    override val message: String,',
        ') : IllegalArgumentException(message)',
      ].join('\n'),
    );
  }

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
    const syqlTypes = emitSyqlKotlinTypes(query);
    if (syqlTypes.length > 0) parts.push(syqlTypes.join('\n'));
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
