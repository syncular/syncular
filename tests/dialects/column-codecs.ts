import {
  type ColumnCodec,
  type ColumnCodecDialect,
  codecs,
  createColumnCodecsPlugin,
} from '@syncular/core';
import type { JsonValue } from './json';

const JSON_COLUMNS = new Set(['j_json', 'j_large', 'nullable_json']);
const BOOLEAN_COLUMNS = new Set(['b_bool', 'nullable_bool']);
const DATE_COLUMNS = new Set(['d_date', 'nullable_date']);

function conformanceJsonCodec(): ColumnCodec<JsonValue, string | JsonValue> {
  return {
    ...codecs.stringJson<JsonValue>(),
    dialects: {
      postgres: {
        toDb: (value) => value,
        fromDb: (value) =>
          typeof value === 'string' ? JSON.parse(value) : value,
      },
    },
  };
}

export function createConformanceColumnCodecsPlugin(
  dialect: ColumnCodecDialect
) {
  return createColumnCodecsPlugin({
    dialect,
    codecs: (col) => {
      if (col.table !== 'dialect_conformance') return undefined;
      if (BOOLEAN_COLUMNS.has(col.column)) return codecs.numberBoolean();
      if (JSON_COLUMNS.has(col.column)) return conformanceJsonCodec();
      if (DATE_COLUMNS.has(col.column)) return codecs.timestampDate();
      return undefined;
    },
  });
}
