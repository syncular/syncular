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
  ensureLocalSchema,
} from '@syncular/client';
import {
  DecryptError,
  encryptValue,
  type RowColumn,
  type RowValue,
} from '@syncular/core';
import type { ServerSchema } from '@syncular/server';
import { applyRowsSegment, applySqliteSegment } from '../src/apply';
import { BunClientDatabase } from '../src/bun-database';
import {
  decryptOrSealRowValues,
  decryptRowValues,
  encryptRowValues,
  installKeys,
} from '../src/encryption';
import {
  drive,
  makeClient,
  makeServer,
  PARTITION,
  tableRows,
  outcomeOf,
} from './helpers';

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
const GOOD = { keys: { secrets: KEY } };
const WRONG = { keys: { secrets: new Uint8Array(32).fill(0x99) } };

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
      encryption: GOOD,
    });
    const b = await makeClient(server, {
      clientId: 'client-b',
      schema: CLIENT_SCHEMA,
      encryption: GOOD,
    });
    a.client.subscribe({ project_id: 'p1' });
    b.client.subscribe({ project_id: 'p1' });
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
      encryption: GOOD,
    });
    a.client.subscribe({ project_id: 'p1' });
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
      encryption: GOOD,
    });
    b.client.subscribe({ project_id: 'p1' });
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
      encryption: GOOD,
    });
    a.client.subscribe({ project_id: 'p1' });
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
      encryption: WRONG,
    });
    bad.client.subscribe({ project_id: 'p1' });
    let caught: unknown;
    try {
      await bad.client.syncUntilIdle();
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string })?.code).toBe('client.decrypt_failed');
  });

  test('encrypted columns without an encryption config fail loudly in both directions', async () => {
    const server = makeServer(SERVER_SCHEMA);
    server.allowed['actor-1'] = { project_id: ['p1'] };
    const plain = await makeClient(server, {
      clientId: 'client-no-config',
      schema: CLIENT_SCHEMA,
    });
    const id = plain.client.mutate([
      {
        table: 'secrets',
        op: 'upsert',
        values: { id: 's4', project_id: 'p1', note: 'plaintext', amount: 1 },
      },
    ]);
    await plain.client.sync();
    expect(outcomeOf(plain.client.commitDelivery(id))).toMatchObject({
      status: 'rejected',
      results: [
        { status: 'error', rejection: { code: 'client.encrypt_failed' } },
      ],
    });
    expect(await server.storage.getRow(PARTITION, 'secrets', 's4')).toBe(
      undefined,
    );

    const writer = await makeClient(server, {
      clientId: 'client-writer',
      schema: CLIENT_SCHEMA,
      encryption: GOOD,
    });
    writer.client.mutate([
      {
        table: 'secrets',
        op: 'upsert',
        values: { id: 's5', project_id: 'p1', note: 'sealed', amount: 2 },
      },
    ]);
    await writer.client.sync();
    plain.client.subscribe({ project_id: 'p1' });
    await expect(plain.client.syncUntilIdle()).rejects.toMatchObject({
      code: 'client.decrypt_failed',
    });
    expect(tableRows(plain.db, 'secrets')).toHaveLength(0);

    const table = compileClientSchema(CLIENT_SCHEMA).tables.get('secrets')!;
    await expect(
      encryptRowValues(undefined, table, ['s6', 'p1', 'x', null]),
    ).rejects.toMatchObject({ code: 'client.encrypt_failed' });
    await expect(
      decryptRowValues(undefined, table, ['s6', 'p1', new Uint8Array(1), null]),
    ).rejects.toMatchObject({ code: 'client.decrypt_failed' });
  });

  test('a sqlite image for a table with encrypted columns is rejected', async () => {
    const schema = compileClientSchema(CLIENT_SCHEMA);
    const db = new BunClientDatabase();
    try {
      await expect(
        applySqliteSegment(
          db,
          schema,
          schema.tables.get('secrets')!,
          new Uint8Array(),
          {
            table: 'secrets',
            rowCount: 0,
            asOfCommitSeq: 1,
            scopeDigest: 'digest',
          },
          {
            clearFirst: true,
            effective: { project_id: ['p1'] },
            owners: () => [],
          },
        ),
      ).rejects.toMatchObject({
        code: 'sync.invalid_request',
        message: expect.stringContaining('encrypted columns'),
      });
    } finally {
      db.close();
    }
  });
});

describe('portable keyring hardening', () => {
  test('a wire keyId naming a prototype member reads as a missing key', async () => {
    const config = installKeys(GOOD);
    // Inherited names resolve to no key at all.
    expect(config.keys.get('constructor')).toBeUndefined();
    expect(config.keys.get('toString')).toBeUndefined();
    expect(config.keys.get('secrets')).toEqual(KEY);

    // End to end through the apply seam: an envelope carrying such a keyId
    // surfaces the missing-key error naming the table and key id.
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
    expect(caught).toMatchObject({
      code: 'client.encryption_key_missing',
      retryable: false,
      details: { table: 'secrets', keyId: 'constructor' },
    });
  });

  test('a wrong-length key fails loud at install time', () => {
    for (const length of [0, 16, 31, 33, 64]) {
      expect(() =>
        installKeys({ keys: { secrets: new Uint8Array(length) } }),
      ).toThrow(
        expect.objectContaining({
          code: 'sync.invalid_request',
          message: 'encryption key must be 32 bytes (AES-256)',
          details: { keyId: 'secrets' },
        }),
      );
    }
    // A correct-length keyring installs cleanly.
    expect(() => installKeys(GOOD)).not.toThrow();
  });

  test('adding keys is strictly additive and all or nothing', () => {
    const keyring = installKeys(GOOD);
    const other = new Uint8Array(32).fill(0x07);
    // A held key id with other bytes refuses the whole call, new ids included.
    expect(() =>
      installKeys({ keys: { fresh: other, secrets: other } }, keyring),
    ).toThrow(
      expect.objectContaining({
        code: 'sync.invalid_request',
        message: 'encryption key id is already held with different key bytes',
        details: { keyId: 'secrets' },
      }),
    );
    expect([...keyring.keys.keys()]).toEqual(['secrets']);
    // Two bad keys: the first in key-id order is named, whatever the input order.
    expect(() =>
      installKeys(
        { keys: { zeta: new Uint8Array(31), secrets: other } },
        keyring,
      ),
    ).toThrow(expect.objectContaining({ details: { keyId: 'secrets' } }));
    // The same bytes again are a no-op; the held copy stays installed.
    const held = keyring.keys.get('secrets');
    const extended = installKeys(
      { keys: { secrets: new Uint8Array(KEY), fresh: other } },
      keyring,
    );
    expect(extended.keys.get('secrets')).toBe(held!);
    expect(extended.keys.get('fresh')).toEqual(new Uint8Array(32).fill(0x07));
  });

  test('the keyring holds copies: the app may zero its buffers after install', async () => {
    const table = compileClientSchema(CLIENT_SCHEMA).tables.get('secrets')!;
    const envelope = await encryptValue('string', 'kept', 'secrets', KEY);
    const appKey = new Uint8Array(KEY);
    const keyring = installKeys({ keys: { secrets: appKey } });
    appKey.fill(0);
    const added = new Uint8Array(KEY);
    const extended = installKeys({ keys: { added } }, keyring);
    added.fill(0);
    expect(
      await decryptRowValues(extended, table, ['s1', 'p1', envelope, null]),
    ).toEqual(['s1', 'p1', 'kept', null]);
    expect(extended.keys.get('added')).toEqual(KEY);
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
    keys: { [KEY_ID]: KEY },
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
    handle.client.subscribe({ project_id: 'p1' });
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
        keys: {},
        keyIdColumns: { secrets: 'encryption_key_id' },
      },
    });
    handle.client.subscribe({ project_id: 'p1' });
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

  test('a present NULL key-id column never falls back to the stored key id', async () => {
    // Unit seam: the patch presents the selector explicitly as NULL with a
    // stored key id able to rescue it. Absent is not NULL, so the stored key
    // id must stay unused and the NULL selector must fail as unusable.
    const table = compileClientSchema(CLIENT_SCHEMA).tables.get('secrets')!;
    const values: readonly (RowValue | undefined)[] = [
      'r4',
      undefined,
      null,
      undefined,
      'updated',
    ];
    await expect(
      encryptRowValues(installKeys(encryption), table, values, KEY_ID),
    ).rejects.toMatchObject({ code: 'client.encrypt_failed' });

    // The same patch with an ABSENT selector does read the stored key id.
    const absent: readonly (RowValue | undefined)[] = [
      'r4',
      undefined,
      undefined,
      undefined,
      'updated',
    ];
    const encrypted = await encryptRowValues(
      installKeys(encryption),
      table,
      absent,
      KEY_ID,
    );
    expect(encrypted[2]).toBeUndefined();
    expect(encrypted[4]).not.toBe('updated');
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
    // A local row with no selector can author an encrypted edit, which the
    // push seam rejects precisely when it cannot select a key.
    handle.client.mutate([
      {
        table: 'secrets',
        op: 'upsert',
        values: {
          id: 'ghost',
          project_id: 'p1',
          encryption_key_id: null,
          memo: null,
          note: null,
        },
      },
    ]);
    await handle.client.syncUntilIdle();
    const badId = handle.client.patch('secrets', 'ghost', { note: 'x' });
    const goodId = handle.client.patch('secrets', 'r3', { memo: 'y' });
    await handle.client.sync();
    expect(outcomeOf(handle.client.commitDelivery(badId))).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          rejection: { code: 'client.encrypt_failed' },
        },
      ],
    });
    // The unrelated commit in the same round still applied.
    expect(outcomeOf(handle.client.commitDelivery(goodId))?.status).toBe(
      'applied',
    );
  });

  test('an unencodable commit over the operation cap is dropped, not capacity-errored', async () => {
    const server = makeServer(SERVER_SCHEMA);
    server.allowed['actor-1'] = { project_id: ['p1'] };
    const handle = await makeClient(server, {
      clientId: 'unencodable-cap',
      schema: CLIENT_SCHEMA,
      encryption,
      limits: { maxPushOperationsPerRequest: 1 },
    });
    try {
      handle.client.subscribe({ project_id: 'p1' });
      await handle.client.syncUntilIdle();
      handle.client.mutate([
        {
          op: 'upsert',
          table: 'secrets',
          values: {
            id: 'ghost',
            project_id: 'p1',
            encryption_key_id: null,
            memo: null,
            note: null,
          },
        },
      ]);
      await handle.client.syncUntilIdle();
      // Two encrypted patches exceed the operation cap, but the commit cannot
      // resolve a key: the durable rejection wins over a capacity error,
      // matching the native prepass order.
      const badId = handle.client.mutate([
        { op: 'patch', table: 'secrets', values: { id: 'ghost', note: 'x' } },
        { op: 'patch', table: 'secrets', values: { id: 'ghost', memo: 'y' } },
      ]);
      await handle.client.sync();
      expect(outcomeOf(handle.client.commitDelivery(badId))).toMatchObject({
        status: 'rejected',
        results: [
          { status: 'error', rejection: { code: 'client.encrypt_failed' } },
        ],
      });
      expect(handle.client.rejections()).toHaveLength(1);
      expect(handle.client.pendingCommits()).toEqual([]);
    } finally {
      await handle.client.close();
      handle.db.close();
    }
  });
});

test('atomic plain-column patches apply locally with locked keys and omit encrypted payloads', async () => {
  const table = {
    ...SECRETS_TABLE,
    columns: [
      ...SECRETS_COLUMNS,
      { name: 'starts', type: 'integer' as const, nullable: false },
    ],
  };
  const schema: ClientSchema = { version: 1, tables: [table] };
  const server = makeServer(schema);
  server.allowed['actor-1'] = { project_id: ['p1'] };
  const a = await makeClient(server, {
    clientId: 'locked-batch',
    schema,
    encryption: GOOD,
  });
  try {
    const unit = a.client.subscribe({ project_id: 'p1' });
    a.client.mutate(
      ['s1', 's2'].map((id) => ({
        op: 'upsert' as const,
        table: 'secrets',
        values: {
          id,
          project_id: 'p1',
          note: 'private',
          amount: 42,
          starts: 10,
        },
      })),
    );
    await a.client.syncUntilIdle();
    // Lock the keys: a preflight releases the keyring, activation installs none.
    await a.client.beginSecurityPreflight();
    await a.client.activateSecurity({ encryption: { keys: {} } });
    a.client.unsubscribe(unit);
    const id = a.client.mutate(
      ['s1', 's2'].map((id, index) => ({
        op: 'patch' as const,
        table: 'secrets',
        values: { id, starts: 20 + index },
        baseVersion: 1,
      })),
    );
    expect(
      tableRows(a.db, 'secrets').map((row) => [row.starts, row.note]),
    ).toEqual([
      [20, 'private'],
      [21, 'private'],
    ]);
    expect(a.client.pendingCommits()).toHaveLength(1);
    await a.client.syncUntilIdle();
    expect(outcomeOf(a.client.commitDelivery(id))?.status).toBe('applied');
    expect(a.client.rejections()).toHaveLength(0);
  } finally {
    await a.client.close();
    a.db.close();
  }
});

describe('§5.11 sealed apply', () => {
  test('a missing key seals the row, the round completes, and the key reveals it', async () => {
    const server = makeServer(SERVER_SCHEMA);
    server.allowed['actor-1'] = { project_id: ['p1'] };
    const writer = await makeClient(server, {
      clientId: 'client-writer',
      schema: CLIENT_SCHEMA,
      encryption: GOOD,
    });
    writer.client.subscribe({ project_id: 'p1' });
    await writer.client.syncUntilIdle();
    writer.client.mutate([
      {
        table: 'secrets',
        op: 'upsert',
        values: { id: 's1', project_id: 'p1', note: 'first', amount: 1 },
      },
    ]);
    await writer.client.sync();

    const reader = await makeClient(server, {
      clientId: 'client-reader',
      schema: CLIENT_SCHEMA,
      encryption: { keys: {} },
    });
    reader.client.subscribe({ project_id: 'p1' });
    // The bootstrap segment carries the row.
    await reader.client.syncUntilIdle();
    const sealedRead = () =>
      reader.client.query(
        'SELECT id, project_id, note, amount, _sync_sealed_key AS sealed_key FROM secrets',
      );
    expect(sealedRead()).toEqual([
      {
        id: 's1',
        project_id: 'p1',
        note: null,
        amount: null,
        sealed_key: 'secrets',
      },
    ]);
    // `SELECT *` strips the reserved columns like `_sync_version`.
    expect(reader.client.query('SELECT * FROM secrets')).toEqual([
      { id: 's1', project_id: 'p1', note: null, amount: null },
    ]);

    // A COMMIT for the sealed row keeps it sealed.
    writer.client.mutate([
      {
        table: 'secrets',
        op: 'upsert',
        values: { id: 's1', project_id: 'p1', note: 'second', amount: 2 },
      },
    ]);
    await writer.client.sync();
    await reader.client.syncUntilIdle();
    expect(sealedRead()).toEqual([
      {
        id: 's1',
        project_id: 'p1',
        note: null,
        amount: null,
        sealed_key: 'secrets',
      },
    ]);

    // A sealed row is read-only; nothing enters the outbox.
    const sealed = {
      code: 'client.encryption_key_missing',
      details: { table: 'secrets', keyId: 'secrets' },
    };
    expect(() =>
      reader.client.mutate([
        {
          table: 'secrets',
          op: 'upsert',
          values: { id: 's1', project_id: 'p1', note: 'overwrite', amount: 3 },
        },
      ]),
    ).toThrow(expect.objectContaining(sealed));
    expect(() => reader.client.patch('secrets', 's1', { amount: 3 })).toThrow(
      expect.objectContaining(sealed),
    );
    expect(() =>
      reader.client.mutate([{ table: 'secrets', op: 'delete', rowId: 's1' }]),
    ).toThrow(expect.objectContaining(sealed));
    expect(reader.client.pendingCommits()).toHaveLength(0);

    // Adding the key reveals the row at once, one revision for the table.
    const revision = reader.client.localRevision;
    await reader.client.addEncryptionKeys(GOOD.keys);
    expect(reader.client.localRevision).toBeGreaterThan(revision);
    expect(sealedRead()).toEqual([
      {
        id: 's1',
        project_id: 'p1',
        note: 'second',
        amount: 2,
        sealed_key: null,
      },
    ]);
  });

  test('addEncryptionKeys is serialized against the security preflight in both orders', async () => {
    const server = makeServer(SERVER_SCHEMA);
    server.allowed['actor-1'] = { project_id: ['p1'] };
    const writer = await makeClient(server, {
      clientId: 'race-writer',
      schema: CLIENT_SCHEMA,
      encryption: GOOD,
    });
    const reader = await makeClient(server, {
      clientId: 'race-reader',
      schema: CLIENT_SCHEMA,
      encryption: { keys: {} },
    });
    const write = async (id: string) => {
      writer.client.mutate([
        {
          table: 'secrets',
          op: 'upsert',
          values: { id, project_id: 'p1', note: id, amount: null },
        },
      ]);
      await writer.client.syncUntilIdle();
      await reader.client.syncUntilIdle();
    };
    const sealedKeys = () =>
      reader.client
        .query('SELECT id, _sync_sealed_key AS k FROM secrets ORDER BY id')
        .map((row) => [row.id, row.k]);
    try {
      writer.client.subscribe({ project_id: 'p1' });
      reader.client.subscribe({ project_id: 'p1' });
      await write('s1');
      expect(sealedKeys()).toEqual([['s1', 'secrets']]);

      // Preflight first: the add is refused and installs nothing.
      const barrier = reader.client.beginSecurityPreflight();
      await expect(
        reader.client.addEncryptionKeys(GOOD.keys),
      ).rejects.toMatchObject({ code: 'client.security_preflight_required' });
      await barrier;
      await reader.client.activateSecurity({ encryption: { keys: {} } });
      expect(sealedKeys()).toEqual([['s1', 'secrets']]);

      // Add first, preflight in the same tick: the barrier waits for the
      // started add, which reveals, and then releases the whole keyring.
      const adding = reader.client.addEncryptionKeys(GOOD.keys);
      const second = reader.client.beginSecurityPreflight();
      await adding;
      await second;
      await reader.client.activateSecurity({ encryption: { keys: {} } });
      expect(sealedKeys()).toEqual([['s1', null]]);
      await write('s2');
      expect(sealedKeys()).toEqual([
        ['s1', null],
        ['s2', 'secrets'],
      ]);

      // A refused add changes nothing; a closed client refuses with its code.
      await expect(
        reader.client.addEncryptionKeys({ secrets: new Uint8Array(31) }),
      ).rejects.toMatchObject({
        code: 'sync.invalid_request',
        details: { keyId: 'secrets' },
      });
      expect(sealedKeys()[1]).toEqual(['s2', 'secrets']);
      await reader.client.close();
      await expect(
        reader.client.addEncryptionKeys(GOOD.keys),
      ).rejects.toMatchObject({ code: 'client.closed' });
    } finally {
      await writer.client.close();
      await reader.client.close();
      writer.db.close();
      reader.db.close();
    }
  });

  test('a wrong key is never sealed', async () => {
    const schema = compileClientSchema(CLIENT_SCHEMA);
    const table = schema.tables.get('secrets')!;
    const envelope = await encryptValue('string', 'x', 'secrets', KEY);
    await expect(
      decryptOrSealRowValues(installKeys(WRONG), table, [
        's1',
        'p1',
        envelope,
        null,
      ]),
    ).rejects.toMatchObject({ code: 'client.decrypt_failed' });
  });

  test('a replica with NOT NULL encrypted columns is rebuilt with its rows', () => {
    const db = new BunClientDatabase();
    try {
      db.exec(
        'CREATE TABLE secrets(id TEXT NOT NULL PRIMARY KEY, project_id TEXT NOT NULL, note TEXT NOT NULL, amount INTEGER, _sync_version INTEGER NOT NULL DEFAULT 0)',
      );
      db.exec('CREATE INDEX secrets_by_project ON secrets(project_id)');
      db.exec("INSERT INTO secrets VALUES ('s1','p1','kept',7,3)");
      ensureLocalSchema(db, compileClientSchema(CLIENT_SCHEMA));
      expect(
        db
          .query('PRAGMA table_info(secrets)')
          .map((column) => [column.name, column.notnull]),
      ).toEqual([
        ['id', 1],
        ['project_id', 1],
        ['note', 0],
        ['amount', 0],
        ['_sync_version', 1],
        ['_sync_sealed_key', 0],
        ['_sync_sealed', 0],
      ]);
      expect(db.query('SELECT * FROM secrets')).toEqual([
        {
          id: 's1',
          project_id: 'p1',
          note: 'kept',
          amount: 7,
          _sync_version: 3,
          _sync_sealed_key: null,
          _sync_sealed: null,
        },
      ]);
      expect(
        db.query(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='secrets' AND sql IS NOT NULL ORDER BY name",
        ),
      ).toEqual([{ name: '_syncular_sealed_secrets' }]);
    } finally {
      db.close();
    }
  });
});

describe('§5.11 rows-segment decrypt', () => {
  test('a block decrypts its rows together and fails on its first failing row', async () => {
    const schema = compileClientSchema(CLIENT_SCHEMA);
    const table = schema.tables.get('secrets')!;
    const db = new BunClientDatabase();
    ensureLocalSchema(db, schema);
    const note = (key: Uint8Array) =>
      encryptValue('string', 'n', 'secrets', key);
    const segment = (values: readonly (readonly RowValue[])[]) => ({
      table: 'secrets',
      schemaVersion: 1,
      columns: table.columns,
      blocks: [values.map((row) => ({ serverVersion: 1, values: row }))],
    });
    const options = {
      clearFirst: true,
      effective: { project_id: ['p1'] },
      owners: () => [],
    };
    try {
      // Row s1 fails in WebCrypto after row s2 fails its type check; the
      // block reports s1, the first in block order.
      await expect(
        drive(
          applyRowsSegment(
            db,
            schema,
            table,
            segment([
              ['s1', 'p1', await note(new Uint8Array(32).fill(0x99)), null],
              ['s2', 'p1', 'not an envelope', null],
            ]),
            options,
            installKeys(GOOD),
          ),
        ),
      ).rejects.toThrow('GCM authentication failed');
      expect(tableRows(db, 'secrets')).toHaveLength(0);
      await drive(
        applyRowsSegment(
          db,
          schema,
          table,
          segment(
            await Promise.all(
              ['s1', 's2', 's3'].map(async (id) => [
                id,
                'p1',
                await note(KEY),
                null,
              ]),
            ),
          ),
          options,
          installKeys(GOOD),
        ),
      );
      expect(
        db
          .query('SELECT id, note FROM secrets ORDER BY id')
          .map((row) => [row.id, row.note]),
      ).toEqual([
        ['s1', 'n'],
        ['s2', 'n'],
        ['s3', 'n'],
      ]);
    } finally {
      db.close();
    }
  });
});

test('a retained base keeps its sealed state through a restore and reveals with the key', async () => {
  // Nullable encrypted columns: replaying intent over a sealed row with a
  // NOT NULL encrypted column fails today (reported separately).
  const table = {
    ...SECRETS_TABLE,
    columns: [
      ...SECRETS_COLUMNS.map((column) => ({ ...column, nullable: true })),
      { name: 'starts', type: 'integer' as const, nullable: false },
    ],
  };
  const schema: ClientSchema = { version: 1, tables: [table] };
  const server = makeServer(schema);
  server.allowed['actor-1'] = { project_id: ['p1'] };
  const writer = await makeClient(server, {
    clientId: 'retained-writer',
    schema,
    encryption: GOOD,
  });
  const reader = await makeClient(server, {
    clientId: 'retained-reader',
    schema,
    encryption: GOOD,
    retainFailedCommits: true,
  });
  const write = async (note: string) => {
    writer.client.mutate([
      {
        op: 'upsert',
        table: 'secrets',
        values: { id: 's1', project_id: 'p1', note, amount: 1, starts: 1 },
      },
    ]);
    await writer.client.syncUntilIdle();
  };
  const retained = () =>
    reader.db.query('SELECT base,sealed FROM _syncular_failed_rows');
  try {
    writer.client.subscribe({ project_id: 'p1' });
    reader.client.subscribe({ project_id: 'p1' });
    await write('first');
    await reader.client.syncUntilIdle();
    // Lock the keys; a plain-column patch then conflicts with a newer write.
    await reader.client.beginSecurityPreflight();
    await reader.client.activateSecurity({ encryption: { keys: {} } });
    reader.client.mutate([
      {
        op: 'patch',
        table: 'secrets',
        values: { id: 's1', starts: 5 },
        baseVersion: 1,
      },
    ]);
    await write('second');
    await reader.client.syncUntilIdle();
    await write('third');
    await reader.client.syncUntilIdle();
    // The delivery under the missing key seals the retained base too.
    expect(retained()).toEqual([
      expect.objectContaining({
        sealed: expect.stringContaining('"keyId":"secrets"'),
      }),
    ]);
    const { restoreFailedBases } = await import('../src/failed-overlay');
    restoreFailedBases(reader.db, compileClientSchema(schema));
    expect(
      reader.db.query('SELECT note,_sync_sealed_key AS k FROM secrets'),
    ).toEqual([{ note: null, k: 'secrets' }]);
    // The next delivery seals the base again, under its own envelopes.
    await write('fourth');
    await reader.client.syncUntilIdle();
    expect(retained()).toEqual([
      expect.objectContaining({
        sealed: expect.stringContaining('"keyId":"secrets"'),
      }),
    ]);
    await reader.client.addEncryptionKeys(GOOD.keys);
    expect(retained()).toEqual([{ base: expect.any(String), sealed: null }]);
    expect(JSON.parse(String(retained()[0]!.base))).toMatchObject({
      note: 'fourth',
      amount: 1,
    });
  } finally {
    await writer.client.close();
    await reader.client.close();
    writer.db.close();
    reader.db.close();
  }
});
