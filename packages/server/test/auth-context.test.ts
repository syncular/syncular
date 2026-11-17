/**
 * The host authentication context (SPEC.md §1.1): one actor holding two
 * sessions of different reach resolves, pulls, downloads and leases under
 * the context each session authenticated, and never under the other's.
 */
import { describe, expect, test } from 'bun:test';
import {
  canonicalScopeJson,
  decodeMessage,
  decodeRowsSegment,
  REALTIME_TAG_ROUND,
  type ResponseMessage,
  type SegmentRefFrame,
  type UnitScopes,
} from '@syncular/core';
import {
  AuthContextTooLargeError,
  createRealtimeHub,
  handleSegmentDownload,
  handleSyncRequest,
  MemoryLeaseStore,
  RESOLVER_OUTAGE,
  type ResolveScopesArgs,
  signSegmentToken,
  type SyncRequestContext,
  verifySegmentToken,
} from '@syncular/server';
import { BunSqliteDatabase, SqliteLeaseStore } from '@syncular/server/sqlite';
import {
  expectSyncError,
  makeContext,
  pullFrames,
  pushCommit,
  requestBytes,
  section,
  seedTask,
  sync,
  type TestContext,
  taskRow,
  upsert,
} from './helpers';

const A = 'facility:a';
const B = 'facility:b';
const PA: UnitScopes = { project_id: 'pa' };
const PB: UnitScopes = { project_id: 'pb' };

/** Context a reaches project pa, context b project pb, no context both. */
function contextScopes(
  t: TestContext,
  seen: ResolveScopesArgs[] = [],
  outage = { on: false },
) {
  Object.assign(t.ctx, {
    resolveScopes: (args: ResolveScopesArgs) => {
      seen.push(args);
      if (outage.on) return RESOLVER_OUTAGE;
      if (args.context === A) return { project_id: ['pa'] };
      if (args.context === B) return { project_id: ['pb'] };
      return { project_id: ['pa', 'pb'] };
    },
  });
  return seen;
}

function under(
  t: TestContext,
  context: string | undefined,
): SyncRequestContext {
  return { ...t.ctx, ...(context !== undefined ? { context } : {}) };
}

async function pullUnder(
  t: TestContext,
  context: string | undefined,
  clientId: string,
  accept?: number,
): Promise<ResponseMessage> {
  const out = await handleSyncRequest(
    requestBytes(
      pullFrames([PA, PB], accept !== undefined ? { accept } : {}),
      clientId,
    ),
    under(t, context),
  );
  const message = decodeMessage(out);
  if (message.msgKind !== 'response') throw new Error('expected a response');
  return message;
}

function refOf(message: ResponseMessage, unit: UnitScopes): SegmentRefFrame {
  const ref = section(message, unit).body.find(
    (f): f is SegmentRefFrame => f.type === 'SEGMENT_REF',
  );
  if (ref === undefined) throw new Error('expected SEGMENT_REF');
  return ref;
}

async function seeded(
  overrides?: Partial<SyncRequestContext>,
): Promise<TestContext> {
  const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 }, ...overrides });
  contextScopes(t);
  await seedTask(t, 'seed-a', 'ta', 'pa');
  await seedTask(t, 'seed-b', 'tb', 'pb');
  return t;
}

describe('authentication context (§1.1)', () => {
  test('one actor pulls only the rows of the context each session holds', async () => {
    const t = await seeded();
    const seen = contextScopes(t);
    const kiosk = await pullUnder(t, A, 'kiosk');
    const device = await pullUnder(t, B, 'device');
    expect(section(kiosk, PA).start.status).toBe('active');
    expect(section(kiosk, PB).start.status).toBe('revoked');
    expect(section(device, PA).start.status).toBe('revoked');
    expect(section(device, PB).start.status).toBe('active');
    expect(seen.map((args) => [args.clientId, args.context])).toEqual([
      ['kiosk', A],
      ['device', B],
    ]);
    // Absent context resolves without one, as before.
    const all = await pullUnder(t, undefined, 'admin-device');
    expect(section(all, PA).start.status).toBe('active');
    expect(section(all, PB).start.status).toBe('active');
    expect(seen[2]).toEqual({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'admin-device',
    });
  });

  test('a segment download re-authorizes under the request context (§5.5)', async () => {
    const t = await seeded();
    const ref = refOf(await pullUnder(t, A, 'kiosk'), PA);
    const request = {
      segmentId: ref.segmentId,
      scopesHeader: canonicalScopeJson({ project_id: ['pa'] }),
    };
    const result = await handleSegmentDownload(under(t, A), request);
    expect(decodeRowsSegment(result.bytes).blocks.flat()).toHaveLength(1);
    await expectSyncError(
      handleSegmentDownload(under(t, B), request),
      'sync.forbidden',
    );
  });

  test('a signed grant minted under one context never verifies under another (§5.4)', async () => {
    const key = 'signing-key';
    const t = await seeded({
      signedUrls: {
        key,
        baseUrl: 'https://cdn.example/segments',
        audience: (partition) => `aud-${partition}`,
      },
    });
    const ref = refOf(await pullUnder(t, A, 'kiosk', 0b1011), PA);
    const token = new URL(ref.url ?? '').searchParams.get('st') ?? '';
    const expected = {
      segmentId: ref.segmentId,
      scopeDigest: ref.scopeDigest,
      audience: 'aud-part-1',
      nowMs: t.now.ms,
    };
    const claims = await verifySegmentToken(key, token, {
      ...expected,
      context: A,
    });
    expect(claims.ctx).toBe(A);
    await expectSyncError(
      verifySegmentToken(key, token, { ...expected, context: B }),
      'sync.forbidden',
    );
    // A headerless signed download (§5.4) passes no context: the MAC-bound
    // claims are the grant.
    expect((await verifySegmentToken(key, token, expected)).ctx).toBe(A);
    // A token minted before contexts existed carries no claim: it verifies
    // without a context and is refused under one.
    const legacy = await signSegmentToken(key, {
      v: 1,
      seg: ref.segmentId,
      sd: ref.scopeDigest,
      aud: 'aud-part-1',
      exp: Math.floor(t.now.ms / 1000) + 60,
    });
    expect(
      (await verifySegmentToken(key, legacy, expected)).ctx,
    ).toBeUndefined();
    await expectSyncError(
      verifySegmentToken(key, legacy, { ...expected, context: A }),
      'sync.forbidden',
    );
  });

  test('a lease issued under one context does not authorize another (§7.3.3)', async () => {
    for (const store of [
      new MemoryLeaseStore(),
      new SqliteLeaseStore(new BunSqliteDatabase()),
    ]) {
      const t = await seeded({ leases: { ttlMs: 60_000, store } });
      const outage = { on: false };
      contextScopes(t, [], outage);
      await pullUnder(t, A, 'kiosk');
      expect(await store.get('part-1', 'kiosk')).toMatchObject({
        actorId: 'actor-1',
        context: A,
      });
      outage.on = true;
      const leased = await pullUnder(t, A, 'kiosk');
      expect(section(leased, PA).start.status).toBe('active');
      expect(section(leased, PB).start.status).toBe('revoked');
      for (const context of [B, undefined]) {
        await expectSyncError(
          pullUnder(t, context, 'kiosk'),
          'sync.auth_lease_required',
        );
      }
      // A refresh under another context mints a fresh lease id.
      outage.on = false;
      const before = (await store.get('part-1', 'kiosk'))?.leaseId;
      await pullUnder(t, B, 'kiosk');
      const after = await store.get('part-1', 'kiosk');
      expect(after?.context).toBe(B);
      expect(after?.leaseId).not.toBe(before);
    }
  });

  test('commit and row validators see the context of HTTP and socket pushes (§6.7)', async () => {
    const t = makeContext();
    contextScopes(t);
    const seen: {
      commit: (string | undefined)[];
      row: (string | undefined)[];
    } = { commit: [], row: [] };
    Object.assign(t.ctx, {
      commitValidator: (input: { context?: string }) => {
        seen.commit.push(input.context);
      },
      validators: {
        tasks: (_op: unknown, ambient: { context?: string }) => {
          seen.row.push(ambient.context);
        },
      },
    });
    const push = (id: string) =>
      requestBytes(
        [pushCommit(id, [upsert('tasks', id, taskRow(id, 'pa'))])],
        'kiosk',
      );
    await handleSyncRequest(push('http-a'), under(t, A));
    await handleSyncRequest(push('http-none'), t.ctx);

    const hub = createRealtimeHub({
      ...t.ctx,
      segments: t.segments,
      limits: { inlineSegmentMaxBytes: 1 },
    });
    const session = await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'kiosk',
      context: A,
      send: () => {},
    });
    const bytes = push('socket-a');
    const tagged = new Uint8Array(bytes.length + 1);
    tagged[0] = REALTIME_TAG_ROUND;
    tagged.set(bytes, 1);
    await session.handleBinary(tagged);
    session.close();

    expect(seen.commit).toEqual([A, undefined, A]);
    expect(seen.row).toEqual([A, undefined, A]);
  });

  test('socket rounds, registrations and deltas resolve under the connect context (§8.1)', async () => {
    const t = makeContext();
    const seen = contextScopes(t);
    const hub = createRealtimeHub({
      schema: t.ctx.schema,
      storage: t.ctx.storage,
      segments: t.segments,
      resolveScopes: t.ctx.resolveScopes,
      limits: { inlineSegmentMaxBytes: 1 },
      ...(t.ctx.clock !== undefined ? { clock: t.ctx.clock } : {}),
    });
    Object.assign(t.ctx, { realtime: hub });
    const wires = new Map<string, Uint8Array[]>();
    const connect = (clientId: string, context: string) => {
      const binaries: Uint8Array[] = [];
      wires.set(clientId, binaries);
      return hub.connect({
        partition: 'part-1',
        actorId: 'actor-1',
        clientId,
        context,
        send: (data) => {
          if (typeof data !== 'string') binaries.push(data);
        },
      });
    };
    const kiosk = await connect('kiosk', A);
    const device = await connect('device', B);
    const round = async (
      session: typeof kiosk,
      clientId: string,
    ): Promise<ResponseMessage> => {
      const bytes = requestBytes(pullFrames([PA, PB]), clientId);
      const tagged = new Uint8Array(bytes.length + 1);
      tagged[0] = REALTIME_TAG_ROUND;
      tagged.set(bytes, 1);
      const binaries = wires.get(clientId)!;
      binaries.length = 0;
      await session.handleBinary(tagged);
      const chunks = binaries.map((chunk) => chunk.subarray(1));
      const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      binaries.length = 0;
      const message = decodeMessage(joined);
      if (message.msgKind !== 'response') throw new Error('expected response');
      return message;
    };
    const kioskRound = await round(kiosk, 'kiosk');
    const deviceRound = await round(device, 'device');
    expect(section(kioskRound, PA).start.status).toBe('active');
    expect(section(kioskRound, PB).start.status).toBe('revoked');
    expect(section(deviceRound, PA).start.status).toBe('revoked');
    expect(section(deviceRound, PB).start.status).toBe('active');
    expect(
      new Set(
        seen
          .filter((args) => args.clientId === 'kiosk')
          .map((args) => args.context),
      ),
    ).toEqual(new Set([A]));
    expect(
      new Set(
        seen
          .filter((args) => args.clientId === 'device')
          .map((args) => args.context),
      ),
    ).toEqual(new Set([B]));
    expect(kiosk.registrations.map((r) => r.effective)).toEqual([
      { project_id: ['pa'] },
    ]);
    expect(device.registrations.map((r) => r.effective)).toEqual([
      { project_id: ['pb'] },
    ]);
    // A session that has not acknowledged the log holds deltas back (§8.2);
    // reconnecting loads the stored cursor and registers under the connect
    // context again.
    kiosk.close();
    device.close();
    const kioskAgain = await connect('kiosk', A);
    const deviceAgain = await connect('device', B);
    // Each socket's registrations carry its own context: a write to pa
    // reaches the kiosk only, a write to pb the device only.
    await sync(
      t,
      [pushCommit('w-a', [upsert('tasks', 'ta2', taskRow('ta2', 'pa'))])],
      {
        clientId: 'writer',
      },
    );
    expect([wires.get('kiosk')!.length, wires.get('device')!.length]).toEqual([
      1, 0,
    ]);
    await sync(
      t,
      [pushCommit('w-b', [upsert('tasks', 'tb2', taskRow('tb2', 'pb'))])],
      {
        clientId: 'writer',
      },
    );
    expect([wires.get('kiosk')!.length, wires.get('device')!.length]).toEqual([
      1, 1,
    ]);
    kioskAgain.close();
    deviceAgain.close();
  });

  test('a context longer than 256 UTF-8 bytes fails before any resolver runs', async () => {
    const t = await seeded();
    const seen = contextScopes(t);
    // 128 two-byte characters fit; one more does not.
    await pullUnder(t, 'é'.repeat(128), 'kiosk');
    const error = await pullUnder(t, 'é'.repeat(129), 'kiosk').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AuthContextTooLargeError);
    expect(error).toMatchObject({
      code: 'sync.auth_context_too_large',
      details: { byteLength: 258, max: 256 },
    });
    expect(seen).toHaveLength(1);
  });
});
