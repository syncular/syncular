export type ColumnCodecDialect = 'sqlite' | 'postgres';

export interface ColumnCodecTypeImport {
  name: string;
  from: string;
}

export type ColumnCodecType =
  | string
  | { type: string; import?: ColumnCodecTypeImport };

export interface ColumnCodec<App, Db> {
  ts: ColumnCodecType;
  toDb(value: App): Db;
  fromDb(value: Db): App;
  dialects?: Partial<
    Record<
      ColumnCodecDialect,
      {
        toDb?(value: App): Db;
        fromDb?(value: Db): App;
      }
    >
  >;
}

export type AnyColumnCodec = ColumnCodec<unknown, unknown>;

export interface ColumnCodecColumn {
  table: string;
  column: string;
  sqlType?: string;
  nullable?: boolean;
  isPrimaryKey?: boolean;
  hasDefault?: boolean;
  dialect?: ColumnCodecDialect;
}

export type TableColumnCodecs = Record<string, AnyColumnCodec>;

export type ColumnCodecSource = (
  column: ColumnCodecColumn
) => AnyColumnCodec | undefined;

function hasCodecs(tableCodecs: TableColumnCodecs): boolean {
  return Object.keys(tableCodecs).length > 0;
}

function resolveCodecToDb(
  codec: AnyColumnCodec,
  dialect: ColumnCodecDialect
): (value: unknown) => unknown {
  return codec.dialects?.[dialect]?.toDb ?? codec.toDb;
}

function resolveCodecFromDb(
  codec: AnyColumnCodec,
  dialect: ColumnCodecDialect
): (value: unknown) => unknown {
  return codec.dialects?.[dialect]?.fromDb ?? codec.fromDb;
}

export function toTableColumnCodecs(
  table: string,
  codecSource: ColumnCodecSource | undefined,
  columns: Iterable<string>,
  options: {
    dialect?: ColumnCodecDialect;
    sqlTypes?: Record<string, string | undefined>;
  } = {}
): TableColumnCodecs {
  if (!codecSource) return {};
  const out: TableColumnCodecs = {};

  for (const column of columns) {
    if (column.length === 0) continue;
    const codec = codecSource({
      table,
      column,
      sqlType: options.sqlTypes?.[column],
      dialect: options.dialect,
    });
    if (codec) out[column] = codec;
  }

  return out;
}

export function applyCodecToDbValue(
  codec: AnyColumnCodec,
  value: unknown,
  dialect: ColumnCodecDialect = 'sqlite'
): unknown {
  if (value === null || value === undefined) return value;
  const transform = resolveCodecToDb(codec, dialect);
  return transform(value);
}

export function applyCodecFromDbValue(
  codec: AnyColumnCodec,
  value: unknown,
  dialect: ColumnCodecDialect = 'sqlite'
): unknown {
  if (value === null || value === undefined) return value;
  const transform = resolveCodecFromDb(codec, dialect);
  return transform(value);
}

export function applyCodecsToDbRow(
  row: Record<string, unknown>,
  tableCodecs: TableColumnCodecs,
  dialect: ColumnCodecDialect = 'sqlite'
): Record<string, unknown> {
  if (!hasCodecs(tableCodecs)) return { ...row };

  const transformed: Record<string, unknown> = { ...row };
  for (const [column, codec] of Object.entries(tableCodecs)) {
    if (!(column in transformed)) continue;
    transformed[column] = applyCodecToDbValue(
      codec,
      transformed[column],
      dialect
    );
  }
  return transformed;
}

export function applyCodecsFromDbRow(
  row: Record<string, unknown>,
  tableCodecs: TableColumnCodecs,
  dialect: ColumnCodecDialect = 'sqlite'
): Record<string, unknown> {
  if (!hasCodecs(tableCodecs)) return { ...row };

  const transformed: Record<string, unknown> = { ...row };
  for (const [column, codec] of Object.entries(tableCodecs)) {
    if (!(column in transformed)) continue;
    transformed[column] = applyCodecFromDbValue(
      codec,
      transformed[column],
      dialect
    );
  }
  return transformed;
}

function parseBooleanValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 't') return true;
    if (normalized === 'false' || normalized === 'f') return false;
    const asNumber = Number(normalized);
    if (Number.isFinite(asNumber)) return asNumber !== 0;
    return false;
  }
  return Boolean(value);
}

export function numberBoolean(): ColumnCodec<
  boolean,
  number | boolean | string
> {
  return {
    ts: 'boolean',
    toDb: (value) => (value ? 1 : 0),
    fromDb: (value) => parseBooleanValue(value),
    dialects: {
      postgres: {
        toDb: (value) => value,
        fromDb: (value) => parseBooleanValue(value),
      },
    },
  };
}

export interface StringJsonCodecOptions<T> {
  ts?: ColumnCodecType;
  import?: ColumnCodecTypeImport;
  stringify?: (value: T) => string;
  parse?: (value: string) => T;
}

export function stringJson<T = unknown>(
  options: StringJsonCodecOptions<T> = {}
): ColumnCodec<T, string | T> {
  const stringify = options.stringify ?? ((value: T) => JSON.stringify(value));
  const parse = options.parse ?? ((value: string) => JSON.parse(value) as T);

  const ts: ColumnCodecType =
    options.ts ??
    (options.import
      ? { type: options.import.name, import: options.import }
      : 'unknown');

  return {
    ts,
    toDb: (value) => stringify(value),
    fromDb: (value) => {
      if (typeof value === 'string') {
        return parse(value);
      }
      return value as T;
    },
  };
}

export function timestampDate(): ColumnCodec<Date, string | Date> {
  return {
    ts: 'Date',
    toDb: (value) => value.toISOString(),
    fromDb: (value) =>
      value instanceof Date ? value : new Date(String(value)),
  };
}

export function dateString(): ColumnCodec<string, string | Date> {
  return {
    ts: 'string',
    toDb: (value) => value,
    fromDb: (value) =>
      value instanceof Date ? value.toISOString().slice(0, 10) : String(value),
  };
}

export const codecs = {
  numberBoolean,
  stringJson,
  timestampDate,
  dateString,
};
