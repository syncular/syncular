/**
 * §12 local authority: the reference server in the client's process, and the
 * §12.3 attach upload to a remote server.
 */
import { describe, expect, test } from 'bun:test';
import {
  decodeMessage,
  decodeRow,
  encodeMessage,
  encodeSparseRow,
  PROTOCOL_WIRE_VERSION,
  type PushCommitFrame,
  type RequestFrame,
  type ResponseMessage,
  type RowColumn,
} from '@syncular/core';
import {
  BunSqliteDatabase,
  handleSyncRequest,
  type LocalAuthority,
  LocalAuthorityAttachError,
  openLocalAuthority,
  type ServerSchema,
  SyncError,
} from '@syncular/server';
import {
  makeContext,
  pullHeader,
  pushResults,
  section,
  subFrame,
} from './helpers';

const NODE_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'parent_id', type: 'string', nullable: true },
];

const NODE_SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'nodes',
      columns: NODE_COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
      references: [
        { column: 'parent_id', parentTable: 'nodes', onDelete: 'SET NULL' },
      ],
      indexes: [
        {
          name: 'idx_nodes_parent_id_ref',
          columns: ['parent_id'],
          unique: false,
        },
      ],
    },
  ],
};

function node(id: string, parentId: string | null, projectId = 'p1') {
  return {
    table: 'nodes',
    rowId: id,
    op: 'upsert' as const,
    payload: encodeSparseRow(NODE_COLUMNS, 0, [id, projectId, parentId]),
  };
}

function request(frames: RequestFrame[], logEpoch?: string): Uint8Array {
  return encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [
      {
        type: 'REQ_HEADER',
        clientId: 'app',
        schemaVersion: 1,
        ...(logEpoch !== undefined ? { logEpoch } : {}),
      },
      ...frames,
    ],
  });
}

function response(bytes: Uint8Array): ResponseMessage {
  const message = decodeMessage(bytes);
  if (message.msgKind !== 'response') throw new Error('expected a response');
  return message;
}

/** Acquire the authority's epoch, then run one round under it. */
async function round(
  authority: LocalAuthority,
  frames: RequestFrame[],
): Promise<ResponseMessage> {
  const header = response(await authority.sync(request([pullHeader()])))
    .frames[0];
  if (header?.type !== 'RESP_HEADER' || header.logEpoch === undefined) {
    throw new Error('epoch acquisition returned no log epoch');
  }
  return response(await authority.sync(request(frames, header.logEpoch)));
}

let writes = 0;

async function writeNodes(
  authority: LocalAuthority,
  commits: ReturnType<typeof node>[][],
): Promise<void> {
  const message = await round(
    authority,
    commits.map((operations, index) => ({
      type: 'PUSH_COMMIT',
      clientCommitId: `write-${(writes += 1)}-${index}`,
      operations,
    })),
  );
  expect(pushResults(message).map((result) => result.status)).toEqual(
    commits.map(() => 'applied'),
  );
}

/** A remote reference server plus the attach transport that reaches it. */
function remote(options?: { readonly allowed?: readonly string[] }) {
  const cloud = makeContext({
    schema: NODE_SCHEMA,
    partition: 'cloud',
    resolveScopes: () => ({ project_id: [...(options?.allowed ?? ['p1'])] }),
  });
  const commits: PushCommitFrame[] = [];
  const statuses: string[] = [];
  const faults = { dropResponseOfCommit: -1 };
  const transport = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const sent = decodeMessage(bytes);
    const out = await handleSyncRequest(bytes, cloud.ctx);
    const commit = sent.frames.find((frame) => frame.type === 'PUSH_COMMIT');
    if (commit === undefined) return out;
    commits.push(commit);
    statuses.push(...pushResults(response(out)).map((result) => result.status));
    if (faults.dropResponseOfCommit === commits.length - 1) {
      faults.dropResponseOfCommit = -1;
      throw new Error('injected: response lost');
    }
    return out;
  };
  const rows = () =>
    cloud.storage.db
      .query<{ payload: Uint8Array; version: number }, []>(
        `SELECT _sync_payload AS payload, _sync_server_version AS version
           FROM nodes ORDER BY _sync_row_id`,
      )
      .all()
      .map((row) => ({
        values: decodeRow(NODE_COLUMNS, new Uint8Array(row.payload)),
        version: row.version,
      }));
  return { cloud, transport, commits, statuses, faults, rows };
}

describe('local authority (§12)', () => {
  test('serves rounds for its one partition with every scope value granted', async () => {
    const authority = await openLocalAuthority({
      database: new BunSqliteDatabase(':memory:'),
      schema: NODE_SCHEMA,
    });
    await writeNodes(authority, [
      [node('a', null, 'p1'), node('b', null, 'p9')],
    ]);

    const pulled = await round(authority, [
      pullHeader({ limitSnapshotRows: 100, maxSnapshotPages: 1 }),
      subFrame('nodes', 'nodes', { project_id: ['p1', 'p9'] }, -1),
    ]);
    expect(section(pulled, 'nodes').start.status).toBe('active');
    expect(section(pulled, 'nodes').start.effectiveScopes).toEqual({
      project_id: ['p1', 'p9'],
    });
  });

  test('attach uploads parents first and keeps a reference cycle in one commit', async () => {
    const authority = await openLocalAuthority({
      database: new BunSqliteDatabase(':memory:'),
      schema: NODE_SCHEMA,
    });
    // 499 independent rows that sort before the cycle, a chain whose children
    // sort before their parents, and a two-row cycle.
    const singles = Array.from({ length: 497 }, (_, i) =>
      node(`a${String(i).padStart(3, '0')}`, null),
    );
    await writeNodes(authority, [singles.slice(0, 250), singles.slice(250)]);
    await writeNodes(authority, [
      [node('m3', null), node('m2', 'm3'), node('m1', 'm2')],
    ]);
    await writeNodes(authority, [[node('x', null), node('y', 'x')]]);
    await writeNodes(authority, [[node('x', 'y')]]);

    const target = remote();
    await authority.attach(target.transport);

    expect(authority.state).toBe('attached');
    expect(target.commits.map((commit) => commit.operations.length)).toEqual([
      500, 2,
    ]);
    const firstOrder = target.commits[0]!.operations.map((op) => op.rowId);
    expect(firstOrder.slice(497)).toEqual(['m3', 'm2', 'm1']);
    expect(target.commits[1]!.operations.map((op) => op.rowId)).toEqual([
      'x',
      'y',
    ]);
    expect(
      target.commits.flatMap((commit) =>
        commit.operations.map((op) => op.baseVersion),
      ),
    ).toEqual(new Array(502).fill(0));
    expect(target.statuses).toEqual(['applied', 'applied']);
    const rows = target.rows();
    expect(rows).toHaveLength(502);
    expect(rows.every((row) => row.version === 1)).toBe(true);
    expect(rows.find((row) => row.values[0] === 'x')?.values[2]).toBe('y');

    const refused = authority.sync(request([pullHeader()]));
    await expect(refused).rejects.toBeInstanceOf(SyncError);
    await expect(refused).rejects.toMatchObject({
      code: 'sync.authority_unavailable',
      details: '{"state":"attached"}',
    });
  });

  test('a restarted attach resumes the same plan and the remote replays applied commits', async () => {
    const database = new BunSqliteDatabase(':memory:');
    const authority = await openLocalAuthority({
      database,
      schema: NODE_SCHEMA,
    });
    await writeNodes(authority, [
      Array.from({ length: 300 }, (_, i) => node(`a${i}`, null)),
    ]);
    await writeNodes(authority, [
      Array.from({ length: 300 }, (_, i) => node(`b${i}`, null)),
    ]);
    const target = remote();
    target.faults.dropResponseOfCommit = 1;
    await expect(authority.attach(target.transport)).rejects.toThrow(
      'injected: response lost',
    );
    expect(authority.state).toBe('attaching');
    await expect(authority.sync(request([pullHeader()]))).rejects.toMatchObject(
      { code: 'sync.authority_unavailable', details: '{"state":"attaching"}' },
    );

    const restarted = await openLocalAuthority({
      database,
      schema: NODE_SCHEMA,
    });
    expect(restarted.state).toBe('attaching');
    await restarted.attach(target.transport);

    expect(restarted.state).toBe('attached');
    expect(target.commits.map((commit) => commit.clientCommitId)).toEqual([
      target.commits[0]!.clientCommitId,
      target.commits[1]!.clientCommitId,
      target.commits[0]!.clientCommitId,
      target.commits[1]!.clientCommitId,
    ]);
    expect(target.statuses).toEqual(['applied', 'applied', 'cached', 'cached']);
    expect(target.rows()).toHaveLength(600);

    // The attached authority keeps only its state, across a reopen.
    const retired = await openLocalAuthority({ database, schema: NODE_SCHEMA });
    expect(retired.state).toBe('attached');
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all(),
    ).toEqual([{ name: 'sync_local_authority' }]);
    await expect(retired.sync(request([pullHeader()]))).rejects.toMatchObject({
      code: 'sync.authority_unavailable',
      details: '{"state":"attached"}',
    });
  });

  test('a rejected commit stops attach and abandonAttach serves the client again', async () => {
    const authority = await openLocalAuthority({
      database: new BunSqliteDatabase(':memory:'),
      schema: NODE_SCHEMA,
    });
    await writeNodes(authority, [
      [node('a', null, 'p1'), node('b', null, 'p2')],
    ]);
    const target = remote({ allowed: ['p1'] });

    const attempt = authority.attach(target.transport);
    await expect(attempt).rejects.toBeInstanceOf(LocalAuthorityAttachError);
    await expect(attempt).rejects.toMatchObject({
      code: 'sync.attach_rejected',
      details: {
        reason: 'commit_rejected',
        clientCommitId: target.commits[0]!.clientCommitId,
        opIndex: 1,
        code: 'sync.forbidden',
      },
    });
    expect(authority.state).toBe('attaching');

    // The request reached the remote server, so abandoning needs it.
    await expect(authority.abandonAttach()).rejects.toMatchObject({
      code: 'sync.invalid_request',
    });
    await authority.abandonAttach(target.transport);
    expect(authority.state).toBe('local');
    // The remote replayed its stored rejection; nothing applied, nothing deleted.
    expect(target.statuses).toEqual(['rejected', 'rejected']);
    expect(target.rows()).toEqual([]);
    await writeNodes(authority, [[node('c', null)]]);
  });

  test('abandoning after an applied prefix deletes those rows children first', async () => {
    const authority = await openLocalAuthority({
      database: new BunSqliteDatabase(':memory:'),
      schema: NODE_SCHEMA,
    });
    const chain = Array.from({ length: 500 }, (_, i) =>
      node(
        `a${String(i).padStart(3, '0')}`,
        i === 0 ? null : `a${String(i - 1).padStart(3, '0')}`,
      ),
    );
    await writeNodes(authority, [chain.slice(0, 250)]);
    await writeNodes(authority, [chain.slice(250)]);
    await writeNodes(authority, [[node('z', null, 'p2')]]);
    const target = remote({ allowed: ['p1'] });

    await expect(authority.attach(target.transport)).rejects.toMatchObject({
      details: { reason: 'commit_rejected', code: 'sync.forbidden' },
    });
    expect(target.rows()).toHaveLength(500);

    await authority.abandonAttach(target.transport);

    expect(authority.state).toBe('local');
    expect(target.rows()).toEqual([]);
    const undo = target.commits.slice(3);
    expect(undo.map((commit) => commit.operations.length)).toEqual([500]);
    expect(
      undo[0]!.operations.slice(0, 2).map((op) => [op.op, op.rowId]),
    ).toEqual([
      ['delete', 'a499'],
      ['delete', 'a498'],
    ]);
  });

  test('abandoning before any upload request needs no transport', async () => {
    const authority = await openLocalAuthority({
      database: new BunSqliteDatabase(':memory:'),
      schema: NODE_SCHEMA,
    });
    await writeNodes(authority, [[node('a', null)]]);
    await expect(
      authority.attach(async () => {
        throw new Error('injected: remote unreachable');
      }),
    ).rejects.toThrow('injected: remote unreachable');
    expect(authority.state).toBe('attaching');
    await authority.abandonAttach();
    expect(authority.state).toBe('local');
  });

  test('a running upload refuses a second attach and abandonAttach', async () => {
    const authority = await openLocalAuthority({
      database: new BunSqliteDatabase(':memory:'),
      schema: NODE_SCHEMA,
    });
    await writeNodes(authority, [[node('a', null)]]);
    const target = remote();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = authority.attach(async (bytes) => {
      await held;
      return target.transport(bytes);
    });

    await expect(authority.attach(target.transport)).rejects.toMatchObject({
      code: 'sync.invalid_request',
    });
    await expect(authority.abandonAttach()).rejects.toThrow(
      'an attach upload is already running',
    );
    release();
    await first;
    expect(authority.state).toBe('attached');
  });

  test('a reference cycle larger than one commit stops attach before any upload', async () => {
    const authority = await openLocalAuthority({
      database: new BunSqliteDatabase(':memory:'),
      schema: NODE_SCHEMA,
    });
    const ids = Array.from({ length: 501 }, (_, i) => `n${i}`);
    const chain = ids.map((id, i) =>
      node(id, i === ids.length - 1 ? null : ids[i + 1]!),
    );
    // Parents first: the authority enforces §6.11 on every commit.
    await writeNodes(authority, [chain.slice(250).reverse()]);
    await writeNodes(authority, [chain.slice(0, 250).reverse()]);
    await writeNodes(authority, [[node('n500', 'n0')]]);
    const target = remote();

    await expect(authority.attach(target.transport)).rejects.toMatchObject({
      code: 'sync.attach_rejected',
      details: { reason: 'cycle_too_large', table: 'nodes', size: 501 },
    });
    expect(target.commits).toEqual([]);
  });
});
