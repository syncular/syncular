import { describe, expect, it } from 'bun:test';
import { introspectCurrentSchema } from '@syncular/typegen';
import { postgresMigrations } from './fixtures';

describe('PostgreSQL introspection', () => {
  it('introspects basic table columns', async () => {
    const schema = await introspectCurrentSchema(
      postgresMigrations,
      'postgres'
    );
    expect(schema.version).toBe(1);
    expect(schema.tables).toHaveLength(1);

    const users = schema.tables[0]!;
    expect(users.name).toBe('users');
    expect(users.columns).toHaveLength(11);

    const idCol = users.columns.find((c) => c.name === 'id')!;
    expect(idCol.sqlType).toBe('uuid');
    expect(idCol.isPrimaryKey).toBe(true);
    expect(idCol.nullable).toBe(false);

    const nameCol = users.columns.find((c) => c.name === 'name')!;
    expect(nameCol.sqlType).toBe('text');
    expect(nameCol.nullable).toBe(false);

    const ageCol = users.columns.find((c) => c.name === 'age')!;
    expect(ageCol.sqlType).toBe('int4');
    expect(ageCol.nullable).toBe(true);

    const bigIdCol = users.columns.find((c) => c.name === 'big_id')!;
    expect(bigIdCol.sqlType).toBe('int8');
    expect(bigIdCol.nullable).toBe(true);

    const isActiveCol = users.columns.find((c) => c.name === 'is_active')!;
    expect(isActiveCol.sqlType).toBe('bool');
    expect(isActiveCol.hasDefault).toBe(true);
    expect(isActiveCol.nullable).toBe(false);

    const avatarCol = users.columns.find((c) => c.name === 'avatar')!;
    expect(avatarCol.sqlType).toBe('bytea');

    const metadataCol = users.columns.find((c) => c.name === 'metadata')!;
    expect(metadataCol.sqlType).toBe('jsonb');

    const tagsCol = users.columns.find((c) => c.name === 'tags')!;
    expect(tagsCol.sqlType).toBe('text[]');

    const createdAtCol = users.columns.find((c) => c.name === 'created_at')!;
    expect(createdAtCol.sqlType).toBe('timestamptz');
    expect(createdAtCol.nullable).toBe(false);

    const ipCol = users.columns.find((c) => c.name === 'ip_address')!;
    expect(ipCol.sqlType).toBe('inet');
  });

  it('supports table filtering', async () => {
    const schema = await introspectCurrentSchema(
      postgresMigrations,
      'postgres',
      ['nonexistent']
    );
    expect(schema.tables).toHaveLength(0);
  });

  it('returns empty tsType (to be resolved later)', async () => {
    const schema = await introspectCurrentSchema(
      postgresMigrations,
      'postgres'
    );
    const col = schema.tables[0]!.columns[0]!;
    expect(col.tsType).toBe('');
  });

  it('detects postgres-specific score type', async () => {
    const schema = await introspectCurrentSchema(
      postgresMigrations,
      'postgres'
    );
    const scoreCol = schema.tables[0]!.columns.find((c) => c.name === 'score')!;
    expect(scoreCol.sqlType).toBe('float8');
  });
});
