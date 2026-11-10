/**
 * §3.1: a scope column is a `string`, `integer` or `float`. `compileSchema`
 * rejects every other column type with a static code.
 */
import { describe, expect, test } from 'bun:test';
import type { RowColumn } from '@syncular/core';
import { compileSchema, type ServerSchema } from '../src';

function schemaWith(type: RowColumn['type']): ServerSchema {
  return {
    version: 1,
    tables: [
      {
        name: 'tasks',
        columns: [
          { name: 'id', type: 'string', nullable: false },
          { name: 'project_id', type, nullable: false },
        ],
        primaryKey: 'id',
        scopes: ['p:{project_id}'],
      },
    ],
  };
}

describe('§3.1 scope column types', () => {
  test.each(['string', 'integer', 'float'] as const)(
    '%s is accepted',
    (type) => {
      expect(compileSchema(schemaWith(type)).tables.get('tasks')).toBeDefined();
    },
  );

  test.each(['boolean', 'json', 'bytes', 'blob_ref', 'crdt'] as const)(
    '%s is refused',
    (type) => {
      let error: unknown;
      try {
        compileSchema(schemaWith(type));
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: 'schema.scope_column_type',
        details: { table: 'tasks', column: 'project_id', type },
      });
    },
  );
});
