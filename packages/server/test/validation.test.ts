/**
 * Error-catalog conformance for the request-validation cases §1.7 assigns
 * to the server, plus schema-floor signalling (§1.6) and clientId binding.
 */
import { describe, expect, test } from 'bun:test';
import type { RespHeaderFrame } from '@syncular/core';
import { ERROR_CATALOG, handleSyncRequest } from '@syncular/server';
import {
  expectSyncError,
  makeContext,
  pullHeader,
  pushCommit,
  pushResults,
  requestBytes,
  subFrame,
  sync,
  taskRow,
  upsert,
} from './helpers';

describe('request validation (§1.7)', () => {
  test('duplicate subscription ids fail with sync.invalid_subscription', async () => {
    const t = makeContext();
    const bytes = requestBytes([
      pullHeader(),
      subFrame('dup', 'tasks', { project_id: ['p1'] }, 0),
      subFrame('dup', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    const error = await expectSyncError(
      handleSyncRequest(bytes, t.ctx),
      'sync.invalid_subscription',
    );
    expect(error.category).toBe('invalid-request');
    expect(error.retryable).toBe(false);
    expect(error.recommendedAction).toBe('fixRequest');
  });

  test("a requested '*' fails with sync.invalid_subscription (§3.2 tightening)", async () => {
    const t = makeContext();
    const bytes = requestBytes([
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['*'] }, 0),
    ]);
    await expectSyncError(
      handleSyncRequest(bytes, t.ctx),
      'sync.invalid_subscription',
    );
  });

  test('an undeclared requested scope key fails loud (§3.2 rule 2)', async () => {
    const t = makeContext();
    const bytes = requestBytes([
      pullHeader(),
      subFrame('s1', 'tasks', { typo_key: ['p1'] }, 0),
    ]);
    await expectSyncError(
      handleSyncRequest(bytes, t.ctx),
      'sync.invalid_subscription',
    );
  });

  test('a resolver returning undeclared keys fails the request (§3.2 rule 3)', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1'], not_declared_anywhere: ['x'] };
    const bytes = requestBytes([
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    await expectSyncError(
      handleSyncRequest(bytes, t.ctx),
      'sync.invalid_subscription',
    );
  });

  test('a subscription naming an unknown table fails with sync.unknown_table', async () => {
    const t = makeContext();
    const bytes = requestBytes([
      pullHeader(),
      subFrame('s1', 'not_a_table', { project_id: ['p1'] }, 0),
    ]);
    const error = await expectSyncError(
      handleSyncRequest(bytes, t.ctx),
      'sync.unknown_table',
    );
    expect(error.category).toBe('schema-mismatch');
    expect(error.recommendedAction).toBe('regenerateClient');
  });

  test('missing rows-segment acceptance is rejected (§4.2)', async () => {
    const t = makeContext();
    const bytes = requestBytes([
      pullHeader({ accept: 0b0100 }),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    await expectSyncError(
      handleSyncRequest(bytes, t.ctx),
      'sync.invalid_request',
    );
  });

  test('a clientId bound to a different actor fails with sync.invalid_client_id (§1.5)', async () => {
    const t = makeContext();
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    const otherActor = { ...t.ctx, actorId: 'actor-2' };
    const bytes = requestBytes([
      pushCommit('c2', [upsert('tasks', 't2', taskRow('t2', 'p1'))]),
    ]);
    const error = await expectSyncError(
      handleSyncRequest(bytes, otherActor),
      'sync.invalid_client_id',
    );
    expect(error.recommendedAction).toBe('resetClientId');
  });

  test('undecodable bytes fail with the DecodeError code', async () => {
    const t = makeContext();
    await expectSyncError(
      handleSyncRequest(new Uint8Array([1, 2, 3]), t.ctx),
      'sync.invalid_request',
    );
  });

  test('a response message fed as a request is invalid', async () => {
    const t = makeContext();
    // Build a minimal response envelope via a real response round-trip.
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    expect(message.msgKind).toBe('response');
    const { encodeMessage } = await import('@syncular/core');
    const bytes = encodeMessage(message);
    await expectSyncError(
      handleSyncRequest(bytes, t.ctx),
      'sync.invalid_request',
    );
  });
});

describe('schema versioning (§1.6, §2.4)', () => {
  test('an unsupported schemaVersion answers the floor and processes nothing', async () => {
    const t = makeContext();
    const message = await sync(
      t,
      [pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))])],
      { schemaVersion: 2 },
    );
    const header = message.frames[0] as RespHeaderFrame;
    expect(header.requiredSchemaVersion).toBe(1);
    expect(header.latestSchemaVersion).toBe(1);
    expect(pushResults(message)).toHaveLength(0);
    expect(await t.storage.getRow('part-1', 'tasks', 't1')).toBeUndefined();
  });

  test('a served schemaVersion carries latestSchemaVersion only', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    const header = message.frames[0] as RespHeaderFrame;
    expect(header.requiredSchemaVersion).toBeUndefined();
    expect(header.latestSchemaVersion).toBe(1);
  });
});

describe('error catalog (§10.2)', () => {
  test('catalog metadata is fixed per code', () => {
    expect(ERROR_CATALOG['sync.version_conflict']).toMatchObject({
      category: 'conflict',
      retryable: false,
      recommendedAction: 'resolveConflict',
    });
    expect(ERROR_CATALOG['sync.cursor_expired']).toMatchObject({
      category: 'reset-required',
      recommendedAction: 'rebootstrap',
    });
    expect(ERROR_CATALOG['sync.segment_expired']).toMatchObject({
      category: 'not-found',
      retryable: true,
      recommendedAction: 'retryLater',
    });
    expect(ERROR_CATALOG['sync.scope_revoked']).toMatchObject({
      category: 'scope-revoked',
      recommendedAction: 'checkPermissions',
    });
    // §5.9 blobs added the closed blob.* set of four codes.
    expect(ERROR_CATALOG['blob.not_found']).toMatchObject({
      category: 'not-found',
      recommendedAction: 'fixRequest',
    });
    expect(ERROR_CATALOG['blob.forbidden']).toMatchObject({
      category: 'forbidden',
      recommendedAction: 'checkPermissions',
    });
    // §5.10.6 CRDT fields added one internal code.
    expect(ERROR_CATALOG['sync.crdt_merge_failed']).toMatchObject({
      category: 'internal',
      retryable: false,
      recommendedAction: 'inspectServer',
    });
    // §7.3 auth leases added two request-level auth-required codes.
    expect(ERROR_CATALOG['sync.auth_lease_required']).toMatchObject({
      category: 'auth-required',
      retryable: true,
      recommendedAction: 'refreshAuth',
    });
    expect(ERROR_CATALOG['sync.auth_lease_revoked']).toMatchObject({
      category: 'auth-required',
      retryable: true,
      recommendedAction: 'refreshAuth',
    });
    expect(Object.keys(ERROR_CATALOG)).toHaveLength(28);
  });
});
