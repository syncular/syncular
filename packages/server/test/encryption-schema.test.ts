/**
 * §5.11 server: `compileSchema` records encrypted column indices so the pull
 * path (§5.3 image eligibility) can exclude an encrypted table from the
 * sqlite-image lane. The server never decrypts — it only needs to know a
 * table has encrypted columns.
 */
import { describe, expect, test } from 'bun:test';
import type { RowColumn } from '@syncular/core';
import { compileSchema, type ServerSchema } from '../src';

const columns: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  {
    name: 'note',
    type: 'bytes',
    nullable: false,
    encrypted: true,
    declaredType: 'string',
  },
  { name: 'plain', type: 'string', nullable: true },
];

const schema: ServerSchema = {
  version: 1,
  tables: [
    { name: 'secrets', columns, primaryKey: 'id', scopes: ['p:{project_id}'] },
    {
      name: 'plainrows',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: ['p:{project_id}'],
    },
  ],
};

describe('§5.11 compileSchema encryptedColumnIndices', () => {
  test('records the encrypted column index', () => {
    const compiled = compileSchema(schema);
    const secrets = compiled.tables.get('secrets');
    expect(secrets?.encryptedColumnIndices).toEqual([2]);
  });

  test('a plain table has no encrypted indices (image-eligible)', () => {
    const compiled = compileSchema(schema);
    const plain = compiled.tables.get('plainrows');
    expect(plain?.encryptedColumnIndices).toEqual([]);
  });
});
