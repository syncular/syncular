/**
 * RFC 0005 "Separate-file regression, recorded": the REAL pre-change binary.
 *
 * `previous-version.test.ts` documents the reset SHAPE by dropping the replica
 * tables by hand. That is a simulation: a feature-OFF client still runs the new
 * boot sweep and would delete the container. The only binary with no sweep is
 * the actual 8b22d819 checkout, so this lane executes it for real.
 *
 * Mechanism: a detached `git worktree` of 8b22d819, imported in-process by
 * absolute path. There is no install and no network; the old workspace resolves
 * `@syncular/core` (byte-identical between 8b22d819 and HEAD) through symlinked
 * `node_modules`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientSchema } from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import type { ServerSchema } from '@syncular/server';
import { makeClient, makeServer, type TestServer } from './helpers';

/** The pre-change revision; `git worktree add` fails loud if it is gone. */
const BASE_COMMIT = '8b22d81934001681bc4c8de105df67976b1824e5';
const CONTAINER = 'syncular_prev_context';
const CLIENT_ID = 'pvc-downgrade-client';
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

const THING_COLUMNS_V1 = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 's', type: 'string', nullable: true },
  { name: 'i', type: 'integer', nullable: true },
] as const;

const THING_COLUMNS_V2 = [
  ...THING_COLUMNS_V1,
  { name: 'note', type: 'string', nullable: true },
] as const;

const V1_TABLES = [
  {
    name: 'things',
    columns: THING_COLUMNS_V1,
    primaryKey: 'id',
    scopes: ['project:{project_id}'],
  },
] as const;

const V2_TABLES = [
  {
    name: 'things',
    columns: THING_COLUMNS_V2,
    primaryKey: 'id',
    scopes: ['project:{project_id}'],
  },
] as const;

const V1_SCHEMA: ClientSchema = { version: 1, tables: V1_TABLES };
const V2_SCHEMA: ClientSchema = { version: 2, tables: V2_TABLES };
const V1_SERVER: ServerSchema = { version: 1, tables: V1_TABLES };
const V2_SERVER: ServerSchema = { version: 2, tables: V2_TABLES };

const SEED_ROW = { id: 'r1', project_id: 'p1', s: 'kept-in-container', i: 7 };

/** The old client surface this test drives; RFC 0005 must be absent from it. */
interface OldSyncClient {
  start(): Promise<void>;
  close(): Promise<void>;
  query(sql: string, params?: readonly unknown[]): Record<string, unknown>[];
}
interface OldClientConfig {
  readonly database: unknown;
  readonly schema: unknown;
  readonly clientId: string;
  readonly transport: () => Promise<never>;
}

let oldRoot: string | undefined;
let oldParent: string | undefined;
const tempDirs: string[] = [];
let oldSyncClient: new (config: OldClientConfig) => OldSyncClient;
let oldBunDatabase: new (path: string) => {
  close(): void;
  query(sql: string, params?: readonly unknown[]): Record<string, unknown>[];
};

/** Loud, never-skipped failure if the pre-change checkout cannot be produced. */
function git(args: readonly string[], cwd = REPO_ROOT): string {
  const result = Bun.spawnSync({
    cmd: ['git', '-C', cwd, ...args],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

beforeAll(async () => {
  oldParent = mkdtempSync(join(tmpdir(), 'syncular-pvc-downgrade-'));
  oldRoot = join(oldParent, 'base');
  git(['worktree', 'add', '--detach', oldRoot, BASE_COMMIT]);
  // The old worktree has no install. Its workspace resolution needs the
  // dependency trees; @syncular/core is byte-identical at HEAD.
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(oldRoot, 'node_modules'));
  symlinkSync(
    join(REPO_ROOT, 'packages', 'web-client', 'node_modules'),
    join(oldRoot, 'packages', 'web-client', 'node_modules'),
  );
  const index = (await import(
    join(oldRoot, 'packages', 'web-client', 'src', 'index.ts')
  )) as { SyncClient: typeof oldSyncClient };
  const bun = (await import(
    join(oldRoot, 'packages', 'web-client', 'src', 'bun-database.ts')
  )) as { BunClientDatabase: typeof oldBunDatabase };
  oldSyncClient = index.SyncClient;
  oldBunDatabase = bun.BunClientDatabase;
});

afterAll(() => {
  if (oldRoot !== undefined) {
    Bun.spawnSync({
      cmd: ['git', '-C', REPO_ROOT, 'worktree', 'remove', '--force', oldRoot],
    });
  }
  if (oldParent !== undefined)
    rmSync(oldParent, { recursive: true, force: true });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function serverFor(schema: ServerSchema): TestServer {
  const server = makeServer(schema);
  server.allowed['actor-1'] = { project_id: ['*'] };
  return server;
}

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'syncular-pvc-dg-'));
  tempDirs.push(dir);
  return join(dir, 'client.db');
}

function containerPath(path: string): string {
  return `${path}.prev-context`;
}

function containerRows(path: string): Record<string, unknown>[] {
  if (!existsSync(containerPath(path))) return [];
  const db = new BunClientDatabase(containerPath(path));
  try {
    return db.query(
      `SELECT tbl, row_id, payload FROM "${CONTAINER}" ORDER BY row_id`,
    );
  } finally {
    db.close();
  }
}

/** The container cargo, decoded from the payload the capture wrote. */
function containerCargo(
  path: string,
): Array<{ tbl: string; rowId: string; row: Record<string, unknown> }> {
  return containerRows(path).map((raw) => ({
    tbl: String(raw.tbl),
    rowId: String(raw.row_id),
    row: JSON.parse(String(raw.payload)) as Record<string, unknown>,
  }));
}

function metaValue(db: BunClientDatabase, key: string): string | undefined {
  const row = db.query('SELECT value FROM _syncular_meta WHERE key = ?', [
    key,
  ])[0];
  return row === undefined ? undefined : String(row.value);
}

describe('RFC 0005 separate-file regression against the real 8b22d819 binary', () => {
  test('the pre-change binary resets the replica but cannot see the container file', async () => {
    const path = tempPath();

    // 1. Seed a V1 replica with a real synced row and drain the outbox, so the
    //    post-reset replica is genuinely empty and the container has cargo.
    const seedServer = serverFor(V1_SERVER);
    const seeded = await makeClient(seedServer, {
      clientId: CLIENT_ID,
      databasePath: path,
      schema: V1_SCHEMA,
    });
    seeded.client.mutate([{ table: 'things', op: 'upsert', values: SEED_ROW }]);
    await seeded.client.sync();
    expect(seeded.client.pendingCommits()).toHaveLength(0);
    await seeded.client.close();
    seeded.db.close();

    // 2. The NEW client bumps V1 -> V2 with the feature on: a real container
    //    file now exists beside the replica.
    const bumpServer = serverFor(V2_SERVER);
    const bumped = await makeClient(bumpServer, {
      clientId: CLIENT_ID,
      databasePath: path,
      schema: V2_SCHEMA,
      previousVersionContext: { enabled: true },
    });
    try {
      expect(existsSync(containerPath(path))).toBe(true);
      expect(containerCargo(path)).toEqual([
        { tbl: 'things', rowId: 'r1', row: SEED_ROW },
      ]);
      expect(
        bumped.client.query('SELECT COUNT(*) AS c FROM things')[0]?.c,
      ).toBe(0);
    } finally {
      await bumped.client.close();
      bumped.db.close();
    }

    // 3. Proof the loaded module is genuinely the pre-change binary, not the
    //    new client with a flag off.
    expect(git(['rev-parse', 'HEAD'], oldRoot!)).toBe(BASE_COMMIT);
    const oldIndexSource = readFileSync(
      join(oldRoot!, 'packages', 'web-client', 'src', 'index.ts'),
      'utf8',
    );
    expect(oldIndexSource).not.toContain('previous-version');
    expect(oldIndexSource).not.toContain('previousVersionContext');
    // The executed binary really has no sweep; HEAD does.
    expect(
      readFileSync(
        join(oldRoot!, 'packages', 'web-client', 'src', 'client.ts'),
        'utf8',
      ),
    ).not.toContain('sweepPreviousVersionContainer');
    expect(
      readFileSync(
        join(REPO_ROOT, 'packages', 'web-client', 'src', 'client.ts'),
        'utf8',
      ),
    ).toContain('sweepPreviousVersionContainer');

    // 4. Run the OLD binary in-process against the same database path with the
    //    OLD V1 schema, so it performs its own §7.4.3 schema-changing reset.
    const oldDb = new oldBunDatabase(path);
    const oldClient = new oldSyncClient({
      database: oldDb,
      schema: V1_SCHEMA,
      clientId: CLIENT_ID,
      transport: async () => {
        throw new Error('downgrade lane: the old binary must not sync');
      },
    });
    try {
      await oldClient.start();
      expect(
        typeof (oldClient as unknown as Record<string, unknown>)[
          'previousVersionSnapshot'
        ],
      ).toBe('undefined');
      expect(
        typeof (oldClient as unknown as Record<string, unknown>)[
          'previousVersionDiscard'
        ],
      ).toBe('undefined');

      // (a) The container file and its row survive, because the old binary
      //     ships no sweep. Storage is read directly, never by the feature API.
      expect(existsSync(containerPath(path))).toBe(true);
      expect(containerCargo(path)).toEqual([
        { tbl: 'things', rowId: 'r1', row: SEED_ROW },
      ]);

      // (b) Ordinary-query behaviour on the old binary is unaffected: its own
      //     reset ran (marker back to 1, V1 columns restored) and the replica
      //     is the expected empty post-reset table.
      expect(oldClient.query('SELECT COUNT(*) AS c FROM things')[0]?.c).toBe(0);
      const inspect = new BunClientDatabase(path);
      try {
        expect(metaValue(inspect, 'localSchemaVersion')).toBe('1');
        const columns = inspect
          .query('PRAGMA table_info(things)')
          .map((row) => String(row.name));
        expect(columns).toContain('s');
        expect(columns).not.toContain('note');
      } finally {
        inspect.close();
      }
    } finally {
      await oldClient.close();
      oldDb.close();
    }
  });
});
