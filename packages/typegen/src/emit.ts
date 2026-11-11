/**
 * TS emitter: neutral IR → one standalone generated module exporting
 *
 * - `schema` — a ServerSchema-compatible object (structurally typed; the
 *   generated file imports nothing),
 * - a `<Table>Row` interface per table,
 * - `<Table>Insert` / `<Table>Update` mutation-input shapes honoring
 *   nullability,
 * - a `<name>Subscription` helper constant per manifest unit template with
 *   a typed builder of its unit scope map (SPEC §4.1).
 *
 * The header carries the IR hash so `--check` verifies freshness
 * byte-exactly.
 */
import {
  appColumnType,
  type IrColumnType,
  type IrDocument,
  type IrSubscription,
  type IrTable,
  serializeSchema,
} from './ir';
import {
  type NamingMode,
  pascalCase,
  snakeToCamel,
  stringLiteral,
} from './naming';

const TS_TYPE: Readonly<Record<IrColumnType, string>> = {
  string: 'string',
  integer: 'number',
  float: 'number',
  boolean: 'boolean',
  json: 'string',
  bytes: 'Uint8Array',
  // §5.9: a blob_ref value is the raw canonical BlobRef JSON string
  // (like `json`); the client's blob API parses it into a BlobRef object.
  blob_ref: 'string',
  // §5.10: a crdt value is opaque bytes (like `bytes`); the Y.Doc accessor
  // is an app-level helper in @syncular/crdt-yjs, not generated code.
  crdt: 'Uint8Array',
};

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propertyKey(name: string): string {
  return IDENTIFIER_RE.test(name) ? name : stringLiteral(name, 'ts');
}

function emitRowInterfaces(table: IrTable, naming: NamingMode): string {
  const type = pascalCase(table.name);
  // §5: mutation-input/row keys are the language-facing names; `mutate`
  // normalizes them back through the schema naming map (camel or snake both
  // bind — one map lookup per key).
  const key = (name: string): string =>
    propertyKey(naming === 'camel' ? snakeToCamel(name) : name);
  const lines: string[] = [];
  lines.push(`/** One ${table.name} row (§2.4 column order). */`);
  lines.push(`export interface ${type}Row {`);
  for (const column of table.columns) {
    const ts = TS_TYPE[appColumnType(column)];
    lines.push(
      `  ${key(column.name)}: ${ts}${column.nullable ? ' | null' : ''};`,
    );
  }
  lines.push('}');
  lines.push('');
  lines.push(`/** Insert shape: nullable columns may be omitted. */`);
  lines.push(`export interface ${type}Insert {`);
  for (const column of table.columns) {
    const ts = TS_TYPE[appColumnType(column)];
    lines.push(
      column.nullable
        ? `  ${key(column.name)}?: ${ts} | null;`
        : `  ${key(column.name)}: ${ts};`,
    );
  }
  lines.push('}');
  lines.push('');
  lines.push(
    `/** Update shape: primary key required, all other columns optional. */`,
  );
  lines.push(`export interface ${type}Update {`);
  for (const column of table.columns) {
    const ts = TS_TYPE[appColumnType(column)];
    if (column.name === table.primaryKey) {
      lines.push(`  ${key(column.name)}: ${ts};`);
    } else {
      lines.push(
        `  ${key(column.name)}?: ${ts}${column.nullable ? ' | null' : ''};`,
      );
    }
  }
  lines.push('}');
  return lines.join('\n');
}

function emitTableDescriptor(table: IrTable, naming: NamingMode): string {
  const type = pascalCase(table.name);
  const primary = table.columns.find(
    (column) => column.name === table.primaryKey,
  );
  if (primary === undefined)
    throw new Error(`table ${table.name} lacks its primary key`);
  const field =
    naming === 'camel' ? snakeToCamel(table.primaryKey) : table.primaryKey;
  const constant = `${naming === 'camel' ? snakeToCamel(table.name) : table.name}Table`;
  return [
    `/** Typed mutation/resource descriptor for ${stringLiteral(table.name, 'ts')}. */`,
    `export const ${constant}: SyncTable<${type}Row, ${type}Insert, ${type}Update, ${TS_TYPE[appColumnType(primary)]}> = {`,
    `  name: ${stringLiteral(table.name, 'ts')},`,
    `  primaryKey: ${stringLiteral(field, 'ts')},`,
    `  physicalPrimaryKey: ${stringLiteral(table.primaryKey, 'ts')},`,
    '};',
  ].join('\n');
}

function emitSubscription(sub: IrSubscription): string {
  const params = [
    ...new Set(
      sub.scopes.flatMap(({ value }) =>
        value.kind === 'parameter' ? [value.name] : [],
      ),
    ),
  ];
  const lines: string[] = [];
  const paramsType = `${pascalCase(sub.name)}Params`;
  if (params.length > 0) {
    lines.push(`export interface ${paramsType} {`);
    for (const param of params) {
      lines.push(`  ${propertyKey(param)}: string;`);
    }
    lines.push('}');
    lines.push('');
  }
  lines.push(
    `/** Unit template for the ${stringLiteral(sub.name, 'ts')} subscription (SPEC §4.1). */`,
  );
  lines.push(`export const ${sub.name}Subscription = {`);
  lines.push(`  name: ${stringLiteral(sub.name, 'ts')},`);
  const args = params.length > 0 ? `params: ${paramsType}` : '';
  lines.push(`  scopes: (${args}): Record<string, string> => ({`);
  for (const { variable, value } of sub.scopes) {
    lines.push(
      `    ${propertyKey(variable)}: ${value.kind === 'literal' ? stringLiteral(value.value, 'ts') : `params.${propertyKey(value.name)}`},`,
    );
  }
  lines.push('  }),');
  lines.push('} as const;');
  return lines.join('\n');
}

export function emitModule(
  ir: IrDocument,
  hash: string,
  naming: NamingMode = 'camel',
): string {
  const parts: string[] = [];
  parts.push(
    [
      '// Generated by @syncular/typegen — DO NOT EDIT.',
      `// irVersion: ${ir.irVersion}`,
      `// irHash: ${hash}`,
    ].join('\n'),
  );
  parts.push(
    [
      '/** Structural descriptor consumed by renderer bindings; phantom type',
      ' * fields make row/insert/update/id inference available without imports. */',
      'export interface SyncTable<Row, Insert, Update, Id> {',
      '  readonly name: string;',
      '  /** Language-facing key used in generated row and mutation types. */',
      '  readonly primaryKey: keyof Row & string;',
      '  /** Physical SQLite/wire primary-key column. */',
      '  readonly physicalPrimaryKey: string;',
      '  readonly __row?: Row;',
      '  readonly __insert?: Insert;',
      '  readonly __update?: Update;',
      '  readonly __id?: Id;',
      '}',
    ].join('\n'),
  );
  parts.push(
    [
      '/** ServerSchema-compatible schema object (SPEC §2.4, §3.1). */',
      `export const schema = ${serializeSchema(ir)} as const;`,
    ].join('\n'),
  );
  for (const table of ir.tables) {
    parts.push(emitRowInterfaces(table, naming));
    parts.push(emitTableDescriptor(table, naming));
  }
  for (const sub of ir.subscriptions) {
    parts.push(emitSubscription(sub));
  }
  return `${parts.join('\n\n')}\n`;
}
