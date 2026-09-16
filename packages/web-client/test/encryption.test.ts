/**
 * §5.11 client-side encryption, end to end over the loopback server.
 * Proves: local mirror is plaintext, the server stores ciphertext, a
 * scope-mate with the key decrypts on apply, and a wrong-key client surfaces
 * `client.decrypt_failed`.
 */
import { describe, expect, test } from 'bun:test';
import {
  type ClientSchema,
  compileClientSchema,
  decryptRowValues,
  encryptionConfigFromKeyring,
} from '@syncular/client';
import { DecryptError, encryptValue, type RowColumn } from '@syncular/core';
import type { ServerSchema } from '@syncular/server';
import { makeClient, makeServer, PARTITION, tableRows } from './helpers';

const SECRETS_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  // Encrypted columns: wire/stored type is `bytes`, app type is declaredType.
  {
    name: 'note',
    type: 'bytes',
    nullable: false,
    encrypted: true,
    declaredType: 'string',
  },
  {
    name: 'amount',
    type: 'bytes',
    nullable: true,
    encrypted: true,
    declaredType: 'integer',
  },
];

const SECRETS_TABLE = {
  name: 'secrets',
  columns: SECRETS_COLUMNS,
  primaryKey: 'id',
  scopes: ['project:{project_id}'],
} as const;

const SERVER_SCHEMA: ServerSchema = { version: 1, tables: [SECRETS_TABLE] };
const CLIENT_SCHEMA: ClientSchema = { version: 1, tables: [SECRETS_TABLE] };

const KEY = new Uint8Array(32).fill(0x2a);
const goodProvider = (id: string) => (id === 'secrets' ? KEY : undefined);
const wrongProvider = (id: string) =>
  id === 'secrets' ? new Uint8Array(32).fill(0x99) : undefined;

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

describe('§5.11 encrypted round-trip', () => {
  test('local plaintext, wire ciphertext, scope-mate decrypts', async () => {
    const server = makeServer(SERVER_SCHEMA);
    server.allowed['actor-1'] = { project_id: ['p1'] };
    const a = await makeClient(server, {
      clientId: 'client-a',
      schema: CLIENT_SCHEMA,
      encryption: { keyProvider: goodProvider },
    });
    const b = await makeClient(server, {
      clientId: 'client-b',
      schema: CLIENT_SCHEMA,
      encryption: { keyProvider: goodProvider },
    });
    a.client.subscribe({
      id: 's1',
      table: 'secrets',
      scopes: { project_id: ['p1'] },
    });
    b.client.subscribe({
      id: 's1',
      table: 'secrets',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();
    await b.client.syncUntilIdle();

    a.client.mutate([
      {
        table: 'secrets',
        op: 'upsert',
        values: { id: 's1', project_id: 'p1', note: 'top secret', amount: 42 },
      },
    ]);
    // Local mirror on A is PLAINTEXT (declared-type values) before any round.
    const aRows = tableRows(a.db, 'secrets');
    expect(aRows[0]?.note).toBe('top secret');
    expect(aRows[0]?.amount).toBe(42);

    await a.client.sync();

    // The server-stored row must NOT contain the plaintext bytes.
    const stored = await server.storage.getRow(PARTITION, 'secrets', 's1');
    expect(stored).toBeDefined();
    expect(
      contains(
        stored?.payload ?? new Uint8Array(),
        new TextEncoder().encode('top secret'),
      ),
    ).toBe(false);

    // B pulls and decrypts on apply back to plaintext.
    await b.client.syncUntilIdle();
    const bRows = tableRows(b.db, 'secrets');
    expect(bRows).toHaveLength(1);
    expect(bRows[0]?.note).toBe('top secret');
    expect(bRows[0]?.amount).toBe(42);
  });

  test('a NULL encrypted column stays NULL (not an envelope)', async () => {
    const server = makeServer(SERVER_SCHEMA);
    server.allowed['actor-1'] = { project_id: ['p1'] };
    const a = await makeClient(server, {
      clientId: 'client-a',
      schema: CLIENT_SCHEMA,
      encryption: { keyProvider: goodProvider },
    });
    a.client.subscribe({
      id: 's1',
      table: 'secrets',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();
    a.client.mutate([
      {
        table: 'secrets',
        op: 'upsert',
        values: { id: 's2', project_id: 'p1', note: 'x', amount: null },
      },
    ]);
    await a.client.sync();
    const b = await makeClient(server, {
      clientId: 'client-b',
      schema: CLIENT_SCHEMA,
      encryption: { keyProvider: goodProvider },
    });
    b.client.subscribe({
      id: 's1',
      table: 'secrets',
      scopes: { project_id: ['p1'] },
    });
    await b.client.syncUntilIdle();
    const row = tableRows(b.db, 'secrets')[0];
    expect(row?.note).toBe('x');
    expect(row?.amount).toBeNull();
  });

  test('wrong key surfaces client.decrypt_failed on apply', async () => {
    const server = makeServer(SERVER_SCHEMA);
    server.allowed['actor-1'] = { project_id: ['p1'] };
    const a = await makeClient(server, {
      clientId: 'client-a',
      schema: CLIENT_SCHEMA,
      encryption: { keyProvider: goodProvider },
    });
    a.client.subscribe({
      id: 's1',
      table: 'secrets',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();
    a.client.mutate([
      {
        table: 'secrets',
        op: 'upsert',
        values: {
          id: 's3',
          project_id: 'p1',
          note: 'confidential',
          amount: 7,
        },
      },
    ]);
    await a.client.sync();

    const bad = await makeClient(server, {
      clientId: 'client-bad',
      schema: CLIENT_SCHEMA,
      encryption: { keyProvider: wrongProvider },
    });
    bad.client.subscribe({
      id: 's1',
      table: 'secrets',
      scopes: { project_id: ['p1'] },
    });
    let caught: unknown;
    try {
      await bad.client.syncUntilIdle();
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string })?.code).toBe('client.decrypt_failed');
  });
});

describe('portable keyring hardening', () => {
  test('a wire keyId naming a prototype member reads as a missing key', async () => {
    const config = encryptionConfigFromKeyring({ keys: { secrets: KEY } });
    // Own-property lookups only: inherited names resolve to no key at all.
    expect(config.keyProvider('constructor')).toBeUndefined();
    expect(config.keyProvider('toString')).toBeUndefined();
    expect(config.keyProvider('hasOwnProperty')).toBeUndefined();
    expect(config.keyProvider('secrets')).toBe(KEY);

    // End to end through the apply seam: an envelope carrying such a keyId
    // surfaces the clean missing-key DecryptError.
    const table = compileClientSchema(CLIENT_SCHEMA).tables.get('secrets');
    if (table === undefined) throw new Error('fixture table missing');
    const envelope = await encryptValue('string', 'ghost', 'constructor', KEY);
    let caught: unknown;
    try {
      await decryptRowValues(config, table, ['s1', 'p1', envelope, null]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DecryptError);
    expect(String((caught as Error).message)).toContain(
      'no key for keyId "constructor"',
    );
  });

  test('a wrong-length key fails loud at install time', () => {
    for (const length of [0, 16, 31, 33, 64]) {
      let caught: unknown;
      try {
        encryptionConfigFromKeyring({
          keys: { secrets: new Uint8Array(length) },
        });
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string })?.code).toBe('sync.invalid_request');
      expect(String((caught as Error).message)).toContain(
        `must be 32 bytes (AES-256), got ${length}`,
      );
    }
    // A correct-length keyring installs cleanly.
    expect(() =>
      encryptionConfigFromKeyring({ keys: { secrets: KEY } }),
    ).not.toThrow();
  });
});

describe('sparse patch key-id fallback (SYNCULAR-SPARSE-PATCH-KEYID-001)', () => {
  const COLUMNS: readonly RowColumn[] = [
    { name: 'id', type: 'string', nullable: false },
    { name: 'project_id', type: 'string', nullable: false },
    { name: 'encryption_key_id', type: 'string', nullable: true },
    { name: 'memo', type: 'string', nullable: true },
    {
      name: 'note',
      type: 'bytes',
      nullable: true,
      encrypted: true,
      declaredType: 'string',
    },
  ];
  const TABLE = {
    name: 'secrets',
    columns: COLUMNS,
    primaryKey: 'id',
    scopes: ['project:{project_id}'],
  } as const;
  const SERVER_SCHEMA: ServerSchema = { version: 1, tables: [TABLE] };
  const CLIENT_SCHEMA: ClientSchema = { version: 1, tables: [TABLE] };
  const KEY_ID = 'practice-key-v1';
  const encryption = {
    keyProvider: (id: string) => (id === KEY_ID ? KEY : undefined),
    keyIdColumns: { secrets: 'encryption_key_id' },
  };

  async function seededClient() {
    const server = makeServer(SERVER_SCHEMA);
    server.allowed['actor-1'] = { project_id: ['p1'] };
    const handle = await makeClient(server, {
      clientId: 'sparse-keyid',
      schema: CLIENT_SCHEMA,
      encryption,
    });
    handle.client.subscribe({
      id: 's1',
      table: 'secrets',
      scopes: { project_id: ['p1'] },
    });
    await handle.client.syncUntilIdle();
    return { server, handle };
  }

  test('a sparse patch omitting the key-id column uses the stored key id', async () => {
    const { server, handle } = await seededClient();
    handle.client.mutate([
      {
        table: 'secrets',
        op: 'upsert',
        values: {
          id: 'r1',
          project_id: 'p1',
          encryption_key_id: KEY_ID,
          memo: null,
          note: 'original',
        },
      },
    ]);
    await handle.client.syncUntilIdle();

    // The patch presents an encrypted column but not the key-id column.
    handle.client.patch('secrets', 'r1', { note: 'updated' });
    await handle.client.sync();

    const stored = await server.storage.getRow(PARTITION, 'secrets', 'r1');
    expect(stored).toBeDefined();
    expect(
      contains(
        stored?.payload ?? new Uint8Array(),
        new TextEncoder().encode('updated'),
      ),
    ).toBe(false);
    expect(
      contains(
        stored?.payload ?? new Uint8Array(),
        new TextEncoder().encode('original'),
      ),
    ).toBe(false);
    expect(tableRows(handle.db, 'secrets')[0]).toMatchObject({
      note: 'updated',
      encryption_key_id: KEY_ID,
    });
  });

  test('a sparse patch presenting no encrypted column needs no key', async () => {
    const server = makeServer(SERVER_SCHEMA);
    server.allowed['actor-1'] = { project_id: ['p1'] };
    // The provider knows no key at all: any key resolution would fail, so
    // reaching the server proves resolution was skipped, not resolved.
    const handle = await makeClient(server, {
      clientId: 'sparse-keyless',
      schema: CLIENT_SCHEMA,
      encryption: {
        keyProvider: () => undefined,
        keyIdColumns: { secrets: 'encryption_key_id' },
      },
    });
    handle.client.subscribe({
      id: 's1',
      table: 'secrets',
      scopes: { project_id: ['p1'] },
    });
    await handle.client.syncUntilIdle();
    // A NULL encrypted column is never encrypted, so even this full-row
    // write needs no key.
    handle.client.mutate([
      {
        table: 'secrets',
        op: 'upsert',
        values: {
          id: 'r2',
          project_id: 'p1',
          encryption_key_id: KEY_ID,
          memo: null,
          note: null,
        },
      },
    ]);
    await handle.client.syncUntilIdle();
    handle.client.patch('secrets', 'r2', { memo: 'plain' });
    await handle.client.sync();
    expect(tableRows(handle.db, 'secrets')[0]).toMatchObject({
      memo: 'plain',
      note: null,
    });
    expect(handle.client.rejections()).toHaveLength(0);
  });

  test('an unresolvable key id rejects the commit without throwing from sync()', async () => {
    const { handle } = await seededClient();
    handle.client.mutate([
      {
        table: 'secrets',
        op: 'upsert',
        values: {
          id: 'r3',
          project_id: 'p1',
          encryption_key_id: KEY_ID,
          memo: null,
          note: 'sealed',
        },
      },
    ]);
    await handle.client.syncUntilIdle();
    // A patch on a locally absent row presents an encrypted column with no
    // stored key id to fall back to.
    const badId = handle.client.patch('secrets', 'ghost', { note: 'x' });
    const goodId = handle.client.patch('secrets', 'r3', { memo: 'y' });
    await handle.client.sync();
    expect(handle.client.commitOutcome(badId)).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          rejection: { code: 'client.encrypt_failed' },
        },
      ],
    });
    // The unrelated commit in the same round still applied.
    expect(handle.client.commitOutcome(goodId)?.status).toBe('applied');
  });
});
