/**
 * RFC 0005 previous-version context (TS core). Covers the contract acceptance
 * items 1-8 and 10: default off, opt-in typed round-trip, no-descriptor, the
 * pre-materialization budgets, the D6 audit, lifetime/discard, crash
 * atomicity, and coverage exclusion.
 *
 * Storage note: the container now lives in a SECOND database file beside the
 * replica (`<path>.prev-context`), so every "container absent" assertion reads
 * that file directly, never the feature's own read API (A2 step 3).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClientSchema,
  type SiblingDatabase,
  type SqlValue,
  type SyncClientConfig,
} from '@syncular/client';
import type { RowColumn } from '@syncular/core';
import { BunClientDatabase } from '@syncular/client/bun';
import type { ServerSchema } from '@syncular/server';
import { makeClient, makeServer, type TestServer } from './helpers';

const CONTAINER = 'syncular_prev_context';
const CONTAINER_META = '_syncular_prev_context_meta';
const CONTEXT_KEY = 'previousVersionContext';
const AUDIT_KEY = 'previousVersionAudit';
const DESCRIPTOR_KEY = 'localSchemaDescriptor';
const CLIENT_ID = 'pvc-client';

const PROJECT_SCOPE = ['project:{project_id}'] as const;

const THING_COLUMNS_V1: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 's', type: 'string', nullable: true },
  { name: 'i', type: 'integer', nullable: true },
  { name: 'f', type: 'float', nullable: true },
  { name: 'b', type: 'boolean', nullable: true },
  { name: 'j', type: 'json', nullable: true },
  { name: 'by', type: 'bytes', nullable: true },
  { name: 'cr', type: 'crdt', nullable: true, crdtType: 'yjs-doc' },
  { name: 'br', type: 'blob_ref', nullable: true },
  { name: 'meta', type: 'string', nullable: true },
];

const THING_COLUMNS_V2: readonly RowColumn[] = [
  ...THING_COLUMNS_V1.filter((column) => column.name !== 'meta'),
  { name: 'note', type: 'string', nullable: true },
];

const NOTE_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'body', type: 'string', nullable: false },
];

const V1_TABLES = [
  {
    name: 'things',
    columns: THING_COLUMNS_V1,
    primaryKey: 'id',
    scopes: PROJECT_SCOPE,
  },
  {
    name: 'notes',
    columns: NOTE_COLUMNS,
    primaryKey: 'id',
    scopes: PROJECT_SCOPE,
  },
] as const;

const V2_TABLES = [
  {
    name: 'things',
    columns: THING_COLUMNS_V2,
    primaryKey: 'id',
    scopes: PROJECT_SCOPE,
  },
  {
    name: 'notes',
    columns: NOTE_COLUMNS,
    primaryKey: 'id',
    scopes: PROJECT_SCOPE,
  },
] as const;

const V1_SCHEMA: ClientSchema = { version: 1, tables: V1_TABLES };
const V2_SCHEMA: ClientSchema = { version: 2, tables: V2_TABLES };
const V2_SERVER: ServerSchema = { version: 2, tables: V2_TABLES };

function v2Server(): TestServer {
  const server = makeServer(V2_SERVER);
  server.allowed['actor-1'] = { project_id: ['*'] };
  return server;
}

const THING_ROW = {
  id: 'r1',
  project_id: 'p1',
  s: 'hello',
  i: 7,
  f: 1.5,
  b: true,
  j: '{"a":1}',
  by: new Uint8Array([1, 2, 3]),
  cr: new Uint8Array([9, 8]),
  br: 'blob:xyz',
  meta: 'm1',
};

function tempPath(label: string): string {
  return join(
    mkdtempSync(join(tmpdir(), `syncular-pvc-${label}-`)),
    'client.db',
  );
}

function enabled(
  overrides: Partial<
    NonNullable<SyncClientConfig['previousVersionContext']>
  > = {},
): SyncClientConfig['previousVersionContext'] {
  return { enabled: true, ...overrides };
}

/** The sibling file the bun adapter uses for the container. */
function containerPath(path: string): string {
  return `${path}.prev-context`;
}

/** The §7.4.3 schema marker; rewritten LAST inside the reset transaction. */
const MARKER_KEY = 'localSchemaVersion';

/** Correction 2b: a discard must remove the FILE, not merely drop its tables. */
function expectNoContainerFile(path: string): void {
  const container = containerPath(path);
  expect(existsSync(container)).toBe(false);
  expect(existsSync(`${container}-wal`)).toBe(false);
  expect(existsSync(`${container}-shm`)).toBe(false);
}

function containerTableCount(path: string): number {
  if (!existsSync(containerPath(path))) return 0;
  const db = new BunClientDatabase(containerPath(path));
  try {
    return Number(
      db.query(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = ?",
        [CONTAINER],
      )[0]?.c ?? 0,
    );
  } finally {
    db.close();
  }
}

/** Seed a v1 local replica (descriptor written by D1) and close it. */
async function seedV1(
  server: TestServer,
  path: string,
  options: { readonly subscribe?: boolean; readonly row?: boolean } = {},
): Promise<void> {
  const seeded = await makeClient(server, {
    clientId: CLIENT_ID,
    databasePath: path,
    schema: V1_SCHEMA,
  });
  try {
    if (options.row !== false) {
      seeded.client.mutate([
        { table: 'things', op: 'upsert', values: THING_ROW },
      ]);
    }
    if (options.subscribe === true) {
      seeded.client.subscribe({
        id: 'sub-things',
        table: 'things',
        scopes: { project_id: ['p1'] },
      });
    }
  } finally {
    await seeded.client.close();
    seeded.db.close();
  }
}

async function openAt(
  server: TestServer,
  path: string,
  schema: ClientSchema,
  pvc?: SyncClientConfig['previousVersionContext'],
  database?: BunClientDatabase,
) {
  return makeClient(server, {
    clientId: CLIENT_ID,
    databasePath: path,
    schema,
    ...(database !== undefined ? { database } : {}),
    ...(pvc !== undefined ? { previousVersionContext: pvc } : {}),
  });
}

function rawDb(path: string): BunClientDatabase {
  return new BunClientDatabase(path);
}

function metaValue(db: BunClientDatabase, key: string): string | undefined {
  const row = db.query('SELECT value FROM _syncular_meta WHERE key = ?', [
    key,
  ])[0];
  return row === undefined ? undefined : String(row.value);
}

describe('RFC 0005 default off', () => {
  test('no container, reset unchanged, snapshot reports not-configured', async () => {
    const server = v2Server();
    const path = tempPath('off');
    await seedV1(server, path);
    const bumped = await openAt(server, path, V2_SCHEMA);
    try {
      expect(containerTableCount(path)).toBe(0);
      const inspect = rawDb(path);
      expect(metaValue(inspect, CONTEXT_KEY)).toBeUndefined();
      inspect.close();
      // The §7.4.3 reset still ran: the table is empty at the new schema.
      expect(
        bumped.client.query('SELECT COUNT(*) AS c FROM things')[0]?.c,
      ).toBe(0);
      const snap = bumped.client.previousVersionSnapshot({ table: 'things' });
      expect(snap.state).toBe('previousVersion');
      expect(snap.available).toBe(false);
      expect(snap.reason).toBe('not-configured');
      expect(
        bumped.client.statusSnapshot().previousVersionContext.present,
      ).toBe(false);
    } finally {
      await bumped.client.close();
      bumped.db.close();
    }
  });
});

describe('RFC 0005 opt-in capture', () => {
  test('every semantic type round-trips and state is previousVersion', async () => {
    const server = v2Server();
    const path = tempPath('types');
    await seedV1(server, path);
    const bumped = await openAt(server, path, V2_SCHEMA, enabled());
    try {
      const snap = bumped.client.previousVersionSnapshot({ table: 'things' });
      expect(snap.state).toBe('previousVersion');
      expect(snap.available).toBe(true);
      expect(snap.previousVersion).toBe(1);
      expect(snap.currentVersion).toBe(2);
      expect(snap.previousVersion).not.toBe(snap.currentVersion);
      const row = snap.rows[0] as Record<string, unknown>;
      expect(row.s).toBe('hello');
      expect(row.i).toBe(7);
      expect(row.f).toBe(1.5);
      expect(row.b).toBe(true);
      expect(row.j).toBe('{"a":1}');
      expect(row.br).toBe('blob:xyz');
      expect([...(row.by as Uint8Array)]).toEqual([1, 2, 3]);
      expect([...(row.cr as Uint8Array)]).toEqual([9, 8]);
      expect('_sync_version' in row).toBe(false);
      expect(
        bumped.client.statusSnapshot().previousVersionContext.present,
      ).toBe(true);
      // The container lives in its own file; the replica connection cannot see it.
      expect(
        bumped.db.query(
          'SELECT 1 AS present FROM sqlite_master WHERE name = ?',
          [CONTAINER],
        ),
      ).toHaveLength(0);
      // Unknown previous table is a loud request error.
      expect(() =>
        bumped.client.previousVersionSnapshot({ table: 'notes' }),
      ).not.toThrow();
      expect(() =>
        bumped.client.previousVersionSnapshot({ table: 'missing' }),
      ).toThrow();
    } finally {
      await bumped.client.close();
      bumped.db.close();
    }
  });

  test('a 0.22.0 database straight-bumps to no-previous-descriptor; one aware boot backfills', async () => {
    const server = v2Server();
    const straight = tempPath('straight');
    await seedV1(server, straight);
    {
      const inspect = rawDb(straight);
      inspect.exec('DELETE FROM _syncular_meta WHERE key = ?', [
        DESCRIPTOR_KEY,
      ]);
      inspect.close();
    }
    const bumped = await openAt(server, straight, V2_SCHEMA, enabled());
    try {
      const snap = bumped.client.previousVersionSnapshot({ table: 'things' });
      expect(snap.available).toBe(false);
      expect(snap.reason).toBe('no-previous-descriptor');
      expect(containerTableCount(straight)).toBe(0);
      expectNoContainerFile(straight);
    } finally {
      await bumped.client.close();
      bumped.db.close();
    }

    const backed = tempPath('backfill');
    await seedV1(server, backed);
    {
      const inspect = rawDb(backed);
      inspect.exec('DELETE FROM _syncular_meta WHERE key = ?', [
        DESCRIPTOR_KEY,
      ]);
      inspect.close();
    }
    const awareV1 = await openAt(server, backed, V1_SCHEMA, enabled());
    {
      const inspect = rawDb(backed);
      expect(metaValue(inspect, DESCRIPTOR_KEY)).toBeDefined();
      inspect.close();
    }
    await awareV1.client.close();
    awareV1.db.close();
    const afterBackfill = await openAt(server, backed, V2_SCHEMA, enabled());
    try {
      const snap = afterBackfill.client.previousVersionSnapshot({
        table: 'things',
      });
      expect(snap.available).toBe(true);
      expect(snap.previousVersion).toBe(1);
    } finally {
      await afterBackfill.client.close();
      afterBackfill.db.close();
    }
  });
});

describe('RFC 0005 budgets abort before materializing', () => {
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly config: SyncClientConfig['previousVersionContext'];
  }> = [
    { label: 'maxTables', config: enabled({ maxTables: 1 }) },
    { label: 'maxRows', config: enabled({ maxRows: 1 }) },
    { label: 'maxBytes', config: enabled({ maxBytes: 1 }) },
    { label: 'maxRowBytes', config: enabled({ maxRowBytes: 1 }) },
  ];
  for (const entry of cases) {
    test(`${entry.label} over budget captures nothing`, async () => {
      const server = v2Server();
      const path = tempPath(entry.label);
      await seedV1(server, path);
      if (entry.label === 'maxRows') {
        const seeded = await makeClient(server, {
          clientId: CLIENT_ID,
          databasePath: path,
          schema: V1_SCHEMA,
        });
        seeded.client.mutate([
          {
            table: 'things',
            op: 'upsert',
            values: { ...THING_ROW, id: 'r2' },
          },
        ]);
        await seeded.client.close();
        seeded.db.close();
      }
      const bumped = await openAt(server, path, V2_SCHEMA, entry.config);
      try {
        const snap = bumped.client.previousVersionSnapshot({ table: 'things' });
        expect(snap.available).toBe(false);
        expect(snap.reason).toBe('capture-exceeded-budget');
        expect(containerTableCount(path)).toBe(0);
        expectNoContainerFile(path);
      } finally {
        await bumped.client.close();
        bumped.db.close();
      }
    });
  }
});

describe('RFC 0005 compatibility audit', () => {
  test('names the incompatible commit with a typed reason and no envelope', async () => {
    const server = v2Server();
    const path = tempPath('audit');
    await seedV1(server, path);
    const bumped = await openAt(server, path, V2_SCHEMA, enabled());
    try {
      const audit = bumped.client.previousVersionAudit();
      expect(audit?.pending).toBe(1);
      expect(audit?.encodable).toBe(0);
      expect(audit?.incompatible).toHaveLength(1);
      expect(audit?.incompatible[0]).toMatchObject({
        table: 'things',
        reason: 'unknown-column',
        column: 'meta',
      });
      const inspect = rawDb(path);
      const raw = metaValue(inspect, AUDIT_KEY) ?? '';
      expect(raw).not.toContain('operations');
      expect(raw).not.toContain('m1');
      expect(raw).not.toContain('payload');
      inspect.close();
      // The incompatible commit stays queued until the §7.4.4 send-time drop.
      expect(bumped.client.pendingCommits()).toHaveLength(1);
      const commitId = bumped.client.pendingCommits()[0]!.clientCommitId;
      await bumped.client.sync();
      // §7.4.4: the incompatible commit leaves at send time, its full envelope
      // preserved in the §7.2.1 journal.
      expect(bumped.client.pendingCommits()).toHaveLength(0);
      const outcome = bumped.client.commitOutcome(commitId);
      expect(outcome?.operations).toEqual([
        {
          table: 'things',
          rowId: 'r1',
          op: 'upsert',
          values: {
            id: 'r1',
            project_id: 'p1',
            s: 'hello',
            i: 7,
            f: 1.5,
            b: true,
            j: '{"a":1}',
            by: { $bytes: '010203' },
            cr: { $bytes: '0908' },
            br: 'blob:xyz',
            meta: 'm1',
          },
        },
      ]);
    } finally {
      await bumped.client.close();
      bumped.db.close();
    }
  });
});

describe('RFC 0005 lifetime and discard', () => {
  test('coverage completion drops the container and closes reads', async () => {
    const server = v2Server();
    const path = tempPath('coverage');
    await seedV1(server, path, { subscribe: true });
    const bumped = await openAt(server, path, V2_SCHEMA, enabled());
    try {
      expect(
        bumped.client.statusSnapshot().previousVersionContext.present,
      ).toBe(true);
      await bumped.client.sync();
      expect(containerTableCount(path)).toBe(0);
      expectNoContainerFile(path);
      const snap = bumped.client.previousVersionSnapshot({ table: 'things' });
      expect(snap.available).toBe(false);
      expect(snap.reason).toBe('coverage-complete');
    } finally {
      await bumped.client.close();
      bumped.db.close();
    }
  });

  test('TTL expiry drops the container on an aware read', async () => {
    const server = v2Server();
    const path = tempPath('ttl');
    await seedV1(server, path);
    const bumped = await openAt(
      server,
      path,
      V2_SCHEMA,
      enabled({ maxAgeMs: 1_000 }),
    );
    try {
      server.now.ms += 5_000;
      const snap = bumped.client.previousVersionSnapshot({ table: 'things' });
      expect(snap.available).toBe(false);
      expect(snap.reason).toBe('expired');
      expect(containerTableCount(path)).toBe(0);
      expectNoContainerFile(path);
    } finally {
      await bumped.client.close();
      bumped.db.close();
    }
  });

  test('a lease stop state drops the container', async () => {
    const server = v2Server();
    const path = tempPath('lease');
    await seedV1(server, path);
    const bumped = await openAt(server, path, V2_SCHEMA, enabled());
    await bumped.client.close();
    bumped.db.close();
    {
      const inspect = rawDb(path);
      inspect.exec(
        'INSERT OR REPLACE INTO _syncular_meta(key, value) VALUES (?, ?)',
        [
          'leaseState',
          JSON.stringify({ errorCode: 'sync.auth_lease_revoked' }),
        ],
      );
      inspect.close();
    }
    const reopened = await openAt(server, path, V2_SCHEMA, enabled());
    try {
      expect(containerTableCount(path)).toBe(1);
      const snap = reopened.client.previousVersionSnapshot({ table: 'things' });
      expect(snap.available).toBe(false);
      expect(snap.reason).toBe('lease-inactive');
      expect(containerTableCount(path)).toBe(0);
      expectNoContainerFile(path);
    } finally {
      await reopened.client.close();
      reopened.db.close();
    }
  });

  test('a revoked scope drops the container', async () => {
    const server = v2Server();
    const path = tempPath('revoked');
    await seedV1(server, path, { subscribe: true });
    const bumped = await openAt(server, path, V2_SCHEMA, enabled());
    try {
      bumped.db.exec(
        "UPDATE _syncular_subscriptions SET status = 'revoked', reason_code = 'sync.scope_revoked'",
      );
      const snap = bumped.client.previousVersionSnapshot({ table: 'things' });
      expect(snap.available).toBe(false);
      expect(snap.reason).toBe('scope-revoked');
      expect(containerTableCount(path)).toBe(0);
      expectNoContainerFile(path);
    } finally {
      await bumped.client.close();
      bumped.db.close();
    }
  });

  test('purgeLocalData drops the container unconditionally', async () => {
    const server = v2Server();
    const path = tempPath('purge');
    await seedV1(server, path);
    const bumped = await openAt(server, path, V2_SCHEMA, enabled());
    try {
      bumped.client.purgeLocalData({
        purgeId: 'pvc-purge',
        targets: [{ table: 'things', selectors: { project_id: ['p1'] } }],
      });
      expect(containerTableCount(path)).toBe(0);
      expectNoContainerFile(path);
      const inspect = rawDb(path);
      expect(metaValue(inspect, CONTEXT_KEY)).toBeUndefined();
      expect(metaValue(inspect, AUDIT_KEY)).toBeUndefined();
      inspect.close();
      const snap = bumped.client.previousVersionSnapshot({ table: 'things' });
      expect(snap.available).toBe(false);
    } finally {
      await bumped.client.close();
      bumped.db.close();
    }
  });

  test('the executable discard sequence leaves nothing behind and an unaware client boots', async () => {
    const server = v2Server();
    const path = tempPath('discard');
    await seedV1(server, path);
    const bumped = await openAt(server, path, V2_SCHEMA, enabled());
    const result = bumped.client.previousVersionDiscard();
    expect(result).toEqual({ present: true, discarded: true });
    await bumped.client.close();
    bumped.db.close();

    // A2 step 3: direct database query, never the feature's read API.
    expect(containerTableCount(path)).toBe(0);
    expectNoContainerFile(path);
    const inspect = rawDb(path);
    expect(metaValue(inspect, CONTEXT_KEY)).toBeUndefined();
    expect(metaValue(inspect, AUDIT_KEY)).toBeUndefined();
    inspect.close();

    // A2 step 5: the pre-change (feature-off) path boots normally.
    const unaware = await makeClient(server, {
      clientId: CLIENT_ID,
      databasePath: path,
      schema: V2_SCHEMA,
    });
    try {
      expect(unaware.client.previousVersionDiscard()).toEqual({
        present: false,
        discarded: false,
      });
      expect(
        unaware.client.query('SELECT COUNT(*) AS c FROM things')[0]?.c,
      ).toBe(0);
    } finally {
      await unaware.client.close();
      unaware.db.close();
    }
  });

  test('previousVersionDiscard is idempotent and a feature-off no-op success', async () => {
    const server = v2Server();
    const path = tempPath('idempotent');
    await seedV1(server, path);
    const bumped = await openAt(server, path, V2_SCHEMA, enabled());
    try {
      expect(bumped.client.previousVersionDiscard()).toEqual({
        present: true,
        discarded: true,
      });
      // RFC 0006 key-loss contract: a repeated discard is SUCCESS, not an error.
      expect(bumped.client.previousVersionDiscard()).toEqual({
        present: false,
        discarded: false,
      });
      expectNoContainerFile(path);
    } finally {
      await bumped.client.close();
      bumped.db.close();
    }
    // The feature-disabled default path must also succeed as a no-op.
    const off = await openAt(server, path, V2_SCHEMA);
    try {
      expect(off.client.previousVersionDiscard()).toEqual({
        present: false,
        discarded: false,
      });
    } finally {
      await off.client.close();
      off.db.close();
    }
  });
});

describe('RFC 0005 crash atomicity', () => {
  function faultingDatabase(
    path: string,
    shouldFail: (sql: string, params: readonly unknown[]) => boolean,
  ): BunClientDatabase {
    class FaultDatabase extends BunClientDatabase {
      #fired = false;
      override exec(sql: string, params: readonly never[] = []): void {
        if (!this.#fired && shouldFail(sql, params)) {
          this.#fired = true;
          throw new Error('simulated crash');
        }
        super.exec(sql, params as never);
      }

      /** The container is a separate file; fault its connection too. */
      override openSibling(name: string): SiblingDatabase {
        const handle = super.openSibling(name);
        const database = handle.database;
        const original = database.exec.bind(database);
        let fired = false;
        database.exec = (sql: string, params: readonly SqlValue[] = []) => {
          if (!fired && shouldFail(sql, params)) {
            fired = true;
            throw new Error('simulated crash');
          }
          original(sql, params);
        };
        return handle;
      }
    }
    return new FaultDatabase(path);
  }

  const crashes: ReadonlyArray<{
    readonly label: string;
    readonly fail: (sql: string, params: readonly unknown[]) => boolean;
  }> = [
    {
      label: 'capture before the container record is written',
      fail: (sql) =>
        sql.startsWith(`CREATE TABLE IF NOT EXISTS "${CONTAINER_META}"`),
    },
    {
      label: 'capture during row materialization',
      fail: (sql) => sql.startsWith(`INSERT INTO "${CONTAINER}"(`),
    },
    {
      label: 'capture after the container committed',
      fail: (sql, params) =>
        sql.startsWith('DELETE FROM _syncular_meta') &&
        params[0] === CONTEXT_KEY,
    },
    {
      label: 'reset before the wipe (audit write)',
      fail: (_sql, params) => params[0] === AUDIT_KEY,
    },
    {
      label: 'reset during the wipe (drop)',
      fail: (sql) => sql.startsWith('DROP TABLE') && sql.includes('things'),
    },
    {
      label: 'reset after the wipe (descriptor write)',
      fail: (_sql, params) => params[0] === DESCRIPTOR_KEY,
    },
  ];

  for (const crash of crashes) {
    test(`interrupt ${crash.label}: reset re-runs and exactly one container exists`, async () => {
      const server = v2Server();
      const path = tempPath('crash');
      await seedV1(server, path);

      const faulting = faultingDatabase(path, crash.fail);
      await expect(
        openAt(server, path, V2_SCHEMA, enabled(), faulting),
      ).rejects.toThrow('simulated crash');
      faulting.close();
      {
        const inspect = rawDb(path);
        // Marker-last: the reset transaction never committed, so the marker is
        // still the OLD version and no container can sit beside a matching one.
        expect(metaValue(inspect, MARKER_KEY)).toBe('1');
        inspect.close();
      }

      const recovered = await openAt(server, path, V2_SCHEMA, enabled());
      try {
        expect(containerTableCount(path)).toBe(1);
        const snap = recovered.client.previousVersionSnapshot({
          table: 'things',
        });
        expect(snap.available).toBe(true);
        expect(snap.rows).toHaveLength(1);
      } finally {
        await recovered.client.close();
        recovered.db.close();
      }
    });
  }
});

describe('RFC 0005 stated limitations', () => {
  test('an unaware schema-changing rollback does NOT remove the container file', async () => {
    const server = v2Server();
    const path = tempPath('downgrade');
    await seedV1(server, path);
    const bumped = await openAt(server, path, V2_SCHEMA, enabled());
    await bumped.client.close();
    bumped.db.close();

    // The 0.22.0 §7.4.3 drop, verbatim: every non-reserved table in the REPLICA.
    // It cannot see the container file, so the file and its rows survive.
    const unawareDb = rawDb(path);
    const dropped: string[] = [];
    for (const row of unawareDb.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_syncular_%' AND name NOT LIKE 'sqlite_%'",
    )) {
      unawareDb.exec(`DROP TABLE IF EXISTS ${String(row.name)}`);
      dropped.push(String(row.name));
    }
    expect(dropped).not.toContain(CONTAINER);
    unawareDb.close();
    expect(containerTableCount(path)).toBe(1);

    const unaware = await openAt(server, path, V2_SCHEMA);
    try {
      expect(
        unaware.client.query('SELECT COUNT(*) AS c FROM things')[0]?.c,
      ).toBe(0);
    } finally {
      await unaware.client.close();
      unaware.db.close();
    }
  });

  test('an unaware same-schema rollback leaves the container, and no safety claim is made about it', async () => {
    const server = v2Server();
    const path = tempPath('same-schema');
    await seedV1(server, path);
    const bumped = await openAt(server, path, V2_SCHEMA, enabled());
    await bumped.client.close();
    bumped.db.close();
    // The unaware binary runs no reset at the same schema version and executes
    // none of our cleanup, so the container is still there. This is residual
    // exposure, not a mitigation.
    expect(containerTableCount(path)).toBe(1);
  });

  test('the TTL fires only in an aware binary', async () => {
    const server = v2Server();
    const path = tempPath('ttl-unaware');
    await seedV1(server, path);
    const bumped = await openAt(
      server,
      path,
      V2_SCHEMA,
      enabled({ maxAgeMs: 1_000 }),
    );
    await bumped.client.close();
    bumped.db.close();
    // Time passes and no aware binary opens the database: nothing deletes it.
    server.now.ms += 10 * 24 * 60 * 60 * 1000;
    expect(containerTableCount(path)).toBe(1);
  });

  test('an orphan container is discarded at the next aware boot', async () => {
    const server = v2Server();
    const path = tempPath('orphan');
    await seedV1(server, path);
    const bumped = await openAt(server, path, V2_SCHEMA, enabled());
    await bumped.client.close();
    bumped.db.close();
    {
      // Orphan: the row table exists with no container metadata.
      const container = new BunClientDatabase(containerPath(path));
      container.exec(`DROP TABLE ${CONTAINER_META}`);
      container.close();
    }
    const aware = await openAt(server, path, V2_SCHEMA, enabled());
    try {
      expect(containerTableCount(path)).toBe(0);
      expectNoContainerFile(path);
      expect(
        aware.client.previousVersionSnapshot({ table: 'things' }).available,
      ).toBe(false);
    } finally {
      await aware.client.close();
      aware.db.close();
    }
  });
});

describe('RFC 0005 coverage exclusion', () => {
  test('the container never makes querySnapshot coverage complete', async () => {
    const server = v2Server();
    const path = tempPath('coverage-exclusion');
    await seedV1(server, path);
    const bumped = await openAt(server, path, V2_SCHEMA, enabled());
    try {
      const base = { table: 'things', variable: 'project_id' } as const;
      await bumped.client.setWindow(base, ['p1']);
      const pending = bumped.client.querySnapshot({
        sql: 'SELECT 1 AS one',
        coverage: [{ base, units: ['p1'] }],
      });
      expect(pending.coverage.complete).toBe(false);
      expect(containerTableCount(path)).toBe(1);
      await bumped.client.sync();
      const complete = bumped.client.querySnapshot({
        sql: 'SELECT 1 AS one',
        coverage: [{ base, units: ['p1'] }],
      });
      expect(complete.coverage.complete).toBe(true);
      expect(containerTableCount(path)).toBe(0);
      expectNoContainerFile(path);
    } finally {
      await bumped.client.close();
      bumped.db.close();
    }
  });
});
