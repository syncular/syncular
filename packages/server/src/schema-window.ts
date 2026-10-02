import { decodeRow, encodeRow, type RowValue } from '@syncular/core';
import {
  compileSchema,
  type CompiledSchema,
  type CompiledTable,
  type ServerSchema,
} from './schema';

const validatedWindows = new WeakMap<
  readonly CompiledSchema[],
  CompiledSchema
>();

/** A host-reviewed newest-first window. Storage and validation always use current. */
export function schemaWindowOf(
  current: ServerSchema,
  configured?: readonly CompiledSchema[],
): readonly CompiledSchema[] {
  const head = compileSchema(current);
  if (configured === undefined) return [head];
  if (validatedWindows.get(configured) === head) return configured;
  if (configured.length === 0 || configured[0] !== head)
    throw new Error('sync.schema_window.invalid_head');
  let previous = head.version + 1;
  for (const schema of configured) {
    if (schema.version >= previous)
      throw new Error('sync.schema_window.invalid_order');
    previous = schema.version;
    for (const table of schema.tables.values()) {
      const next = head.tables.get(table.name);
      if (
        next === undefined ||
        table.columns.length > next.columns.length ||
        table.columns.some(
          (column, i) =>
            JSON.stringify(column) !== JSON.stringify(next.columns[i]),
        ) ||
        next.columns
          .slice(table.columns.length)
          .some((column) => !column.nullable) ||
        table.primaryKeyIndex !== next.primaryKeyIndex ||
        JSON.stringify(table.scopePatterns) !==
          JSON.stringify(next.scopePatterns) ||
        JSON.stringify(table.references) !== JSON.stringify(next.references)
      ) {
        throw new Error('sync.schema_window.incompatible_schema');
      }
    }
  }
  validatedWindows.set(configured, head);
  return configured;
}

/** Canonical stored bytes never leave the server under another version's codec. */
export function projectRowValues(
  current: CompiledTable,
  target: CompiledTable,
  payload: Uint8Array,
): RowValue[] {
  const values = decodeRow(current.columns, payload);
  return values.slice(0, target.columns.length);
}

export function projectRowPayload(
  current: CompiledTable,
  target: CompiledTable,
  payload: Uint8Array,
): Uint8Array {
  return current === target
    ? payload
    : encodeRow(target.columns, projectRowValues(current, target, payload));
}
