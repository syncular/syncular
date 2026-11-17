/**
 * The §8.9 Workers topology on PostgreSQL, under workerd with real Durable
 * Objects and sockets (`workerd/sharded-worker.ts`):
 *
 *   - a commit accepted through the Worker, or through a socket round in one
 *     shard object, reaches a socket held by another shard object;
 *   - a pull-only round, with a scope resolver that reads under
 *     `prepareReadTransaction`, completes while a push holds the partition
 *     lock, and a second push waits for it.
 *
 * The Worker reaches PostgreSQL through a service binding this process
 * answers. With `SYNCULAR_PG_URL` it is a real server; without it PGlite,
 * whose single connection cannot let a pull pass a held lock, so the lock
 * test runs only against a real server (CI's postgres job sets the URL).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  decodeMessage,
  encodeMessage,
  encodeSparseRow,
  MessageStreamScanner,
  PROTOCOL_WIRE_VERSION,
  REALTIME_TAG_DELTA,
  REALTIME_TAG_ROUND,
  registrationDigest,
  type RequestFrame,
  type RowColumn,
  unitId,
} from '@syncular/core';
import {
  type PgExecutor,
  type PgQueryable,
  SSP2_CONTENT_TYPE,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { Miniflare, Response as MiniflareResponse } from 'miniflare';
import {
  BunSQL,
  bunSqlExecutor,
  PG_URL,
  resetPublicSchema,
} from '../../server/test/pg-real';

const LOG_EPOCH = 'test-log-epoch';
const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'list_id', type: 'string', nullable: false },
];
const realPg = PG_URL !== undefined && BunSQL !== undefined;

let mf: Miniflare;
let executor: PgExecutor & { close(): Promise<void> };
/** Open transactions of the `PG` service, by id. */
const transactions = new Map<
  string,
  {
    client: PgQueryable;
    finish: (commit: boolean) => void;
    done: Promise<void>;
  }
>();
/** The `GATE` service: a held commit waits here until `release`. */
let gate: { reached: () => void; release: Promise<void> } | undefined;

const ROLLBACK = new Error('rollback');

function json(body: unknown, status = 200): MiniflareResponse {
  return new MiniflareResponse(
    JSON.stringify(body, function (this: Record<string, unknown>, key, value) {
      const raw = this[key];
      if (raw instanceof Uint8Array)
        return { $b: Buffer.from(raw).toString('base64') };
      return typeof raw === 'bigint' ? raw.toString() : value;
    }),
    { status },
  );
}

async function pgService(request: { url: string; text(): Promise<string> }) {
  const path = new URL(request.url).pathname;
  const body = JSON.parse(await request.text(), (_key, value) =>
    typeof value === 'object' && value !== null && typeof value.$b === 'string'
      ? new Uint8Array(Buffer.from(value.$b, 'base64'))
      : value,
  ) as { tx?: string; text?: string; params?: unknown[] };
  try {
    if (path === '/begin') {
      let opened!: (client: PgQueryable) => void;
      const client = new Promise<PgQueryable>((resolve) => {
        opened = resolve;
      });
      let finish!: (commit: boolean) => void;
      const settled = new Promise<void>((resolve, reject) => {
        finish = (commit) => (commit ? resolve() : reject(ROLLBACK));
      });
      const done = executor
        .transaction(async (tx) => {
          opened(tx);
          await settled;
        })
        .catch((error: unknown) => {
          if (error !== ROLLBACK) throw error;
        });
      const tx = crypto.randomUUID();
      transactions.set(tx, { client: await client, finish, done });
      return json({ tx });
    }
    if (path === '/commit' || path === '/rollback') {
      const open = transactions.get(body.tx ?? '')!;
      transactions.delete(body.tx ?? '');
      open.finish(path === '/commit');
      await open.done;
      return json({});
    }
    const target =
      body.tx === undefined ? executor : transactions.get(body.tx)!.client;
    return json(await target.query(body.text ?? '', body.params));
  } catch (error) {
    const { message, code } = error as { message: string; code?: string };
    return json({ message, code }, 500);
  }
}

beforeAll(async () => {
  if (realPg) {
    const sql = new BunSQL!(PG_URL!);
    await resetPublicSchema(sql);
    executor = bunSqlExecutor(sql);
  } else {
    const db = await PGlite.create();
    executor = { ...pgliteExecutor(db), close: () => db.close() };
  }
  const outdir = mkdtempSync(join(tmpdir(), 'syncular-workerd-sharded-'));
  // A separate process: see segment-encoding.workerd.test.ts.
  const built = Bun.spawnSync({
    cmd: [
      process.execPath,
      'build',
      resolve(import.meta.dir, 'workerd/sharded-worker.ts'),
      '--outdir',
      outdir,
      '--target',
      'browser',
      '--format',
      'esm',
      '--conditions',
      'bun',
    ],
    cwd: resolve(import.meta.dir, '../..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(built.stderr.toString()).toBe('');
  expect(built.exitCode).toBe(0);
  mf = new Miniflare({
    modules: [
      { type: 'ESModule' as const, path: join(outdir, 'sharded-worker.js') },
    ],
    modulesRoot: outdir,
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { REALTIME: { className: 'RealtimeDO' } },
    serviceBindings: {
      PG: pgService,
      GATE: async () => {
        const held = gate!;
        held.reached();
        await held.release;
        return new MiniflareResponse(null, { status: 204 });
      },
    },
  });
  const url = await mf.ready;
  const setup = await fetch(new URL('/setup', url), { method: 'POST' });
  expect(setup.status).toBe(204);
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  await executor?.close();
});

function requestBytes(clientId: string, frames: RequestFrame[]): Uint8Array {
  return encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [
      { type: 'REQ_HEADER', clientId, schemaVersion: 1, logEpoch: LOG_EPOCH },
      ...frames,
    ],
  });
}

const PULL: RequestFrame[] = [
  {
    type: 'PULL_HEADER',
    limitCommits: 100,
    limitSnapshotRows: 100,
    maxSnapshotPages: 4,
    accept: 0b0011,
    cursor: -1,
    registrationDigest: registrationDigest([{ list_id: 'L' }]),
    echoDigest: new Uint8Array(),
  },
  { type: 'UNIT', scopes: { list_id: 'L' } },
  { type: 'PROGRESS', id: unitId({ list_id: 'L' }), cursor: -1 },
];

function push(clientCommitId: string, rowId: string): RequestFrame {
  return {
    type: 'PUSH_COMMIT',
    clientCommitId,
    clientSeq: 0,
    operations: [
      {
        table: 'tasks',
        rowId,
        op: 'upsert',
        payload: encodeSparseRow(COLUMNS, 0, [rowId, 'L']),
      },
    ],
  };
}

async function httpRound(clientId: string, frames: RequestFrame[]) {
  const response = await fetch(new URL('/sync', await mf.ready), {
    method: 'POST',
    headers: { 'content-type': SSP2_CONTENT_TYPE },
    body: requestBytes(clientId, frames).slice(),
  });
  expect(response.status).toBe(200);
  return decodeMessage(new Uint8Array(await response.arrayBuffer())).frames;
}

/** A socket in shard object `shard`; `next` resolves with the first
 * received message `match` accepts, waiting for it if needed. */
async function openSocket(clientId: string, shard: string) {
  const url = new URL('/realtime', await mf.ready);
  url.protocol = 'ws:';
  url.searchParams.set('client', clientId);
  url.searchParams.set('shard', shard);
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const inbox: (string | Uint8Array)[] = [];
  let wake: (() => void) | undefined;
  ws.onmessage = (event) => {
    inbox.push(
      typeof event.data === 'string'
        ? event.data
        : new Uint8Array(event.data as ArrayBuffer),
    );
    wake?.();
  };
  await new Promise((resolve) => {
    ws.onopen = resolve;
  });
  const next = async (match: (message: string | Uint8Array) => boolean) => {
    for (;;) {
      const at = inbox.findIndex(match);
      if (at >= 0) return inbox.splice(at, 1)[0]!;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };
  /** One §8.7 round over the socket; answers its response frames. */
  const round = async (frames: RequestFrame[]) => {
    const bytes = requestBytes(clientId, frames);
    const tagged = new Uint8Array(bytes.byteLength + 1);
    tagged[0] = REALTIME_TAG_ROUND;
    tagged.set(bytes, 1);
    ws.send(tagged);
    const scanner = new MessageStreamScanner();
    for (;;) {
      const chunk = await next(
        (m) => typeof m !== 'string' && m[0] === REALTIME_TAG_ROUND,
      );
      const done = scanner.push((chunk as Uint8Array).subarray(1));
      if (done !== undefined) return decodeMessage(done.message.slice()).frames;
    }
  };
  /** Register the unit and lift the connect-time delta suppression (§8.2):
   * pull, ack the cursor, then a steady-state round (the stored list by
   * digest) that the socket answers after it applied the ack. */
  const subscribe = async () => {
    const pulled = await round(PULL);
    const end = pulled.find((frame) => frame.type === 'LIVE_END');
    if (end?.type !== 'LIVE_END') throw new Error('no live section');
    ws.send(JSON.stringify({ type: 'ack', cursor: end.throughSeq }));
    const header = PULL[0]!;
    if (header.type !== 'PULL_HEADER') throw new Error('no pull header');
    await round([{ ...header, cursor: end.throughSeq }]);
  };
  /** The next delta's changed row ids. */
  const delta = async () => {
    const bytes = (await next(
      (m) => typeof m !== 'string' && m[0] === REALTIME_TAG_DELTA,
    )) as Uint8Array;
    return decodeMessage(bytes.slice(1)).frames.flatMap((frame) =>
      frame.type === 'COMMIT'
        ? frame.changes.map((change) => change.rowId)
        : [],
    );
  };
  return { ws, round, subscribe, delta };
}

test('a commit accepted through one object reaches a socket in another', async () => {
  const a = await openSocket('reader-a', 'facility-a');
  const b = await openSocket('reader-b', 'facility-b');
  await a.subscribe();
  await b.subscribe();
  // Accepted by the Worker: both shards receive it through the relay.
  const http = await httpRound('writer', [push('http-1', 'from-worker')]);
  expect(http).toContainEqual(
    expect.objectContaining({ type: 'PUSH_RESULT', status: 'applied' }),
  );
  expect(await a.delta()).toEqual(['from-worker']);
  expect(await b.delta()).toEqual(['from-worker']);
  // Accepted by shard object A in a socket round: B receives it as a delta.
  const pushed = await a.round([push('socket-1', 'from-shard-a')]);
  expect(pushed).toContainEqual(
    expect.objectContaining({ type: 'PUSH_RESULT', status: 'applied' }),
  );
  expect(await b.delta()).toEqual(['from-shard-a']);
  a.ws.close();
  b.ws.close();
}, 60_000);

test.skipIf(!realPg)(
  'a pull-only round completes while a push holds the partition lock',
  async () => {
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    gate = {
      reached,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    let heldDone = false;
    const held = httpRound('holder', [push('held', 'held-row')]).then(
      (frames) => {
        heldDone = true;
        return frames;
      },
    );
    // The held commit's validator runs under the partition lock.
    await atGate;
    let nextDone = false;
    const next = httpRound('second-writer', [push('next', 'next-row')]).then(
      (frames) => {
        nextDone = true;
        return frames;
      },
    );
    const pulled = await httpRound('puller', PULL);
    expect(pulled.some((frame) => frame.type === 'ERROR')).toBe(false);
    expect(pulled).toContainEqual(
      expect.objectContaining({ type: 'SUB_START' }),
    );
    expect(heldDone).toBe(false);
    expect(nextDone).toBe(false);
    release();
    const [first, second] = [await held, await next];
    const seq = (frames: typeof first) =>
      frames.find((frame) => frame.type === 'PUSH_RESULT');
    expect(seq(first)).toMatchObject({ status: 'applied' });
    expect(seq(second)).toMatchObject({ status: 'applied' });
  },
  60_000,
);
