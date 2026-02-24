/**
 * Browser entry point for runtime tests.
 *
 * Bundled by Bun.build() and served to the browser. Exposes scenario
 * functions on window.__runtime for Playwright to call via page.evaluate().
 */

import {
  type ClientHandlerCollection,
  enqueueOutboxCommit,
  ensureClientSyncSchema,
  syncPullOnce,
  syncPushOnce,
} from '../../../../packages/client/src/index';
import { codecs, createDatabase } from '../../../../packages/core/src/index';
import { createWaSqliteDialect } from '../../../../packages/dialect-wa-sqlite/src/index';
import { createHttpTransport } from '../../../../packages/transport-http/src/index';
import type {
  ConformanceDb,
  RuntimeClientDb,
} from '../../shared/runtime-types';
import { tasksClientHandler } from '../../shared/tasks-handler';
import { assert, bytesToArray, jsonEqual } from '../../shared/test-helpers';

// --- Helpers ---

function createDb<T>(fileName: string) {
  return createDatabase<T>({
    dialect: createWaSqliteDialect({
      fileName,
      preferOPFS: false,
      url: (useAsyncWasm: boolean) =>
        `/wasqlite/${useAsyncWasm ? 'wa-sqlite-async.wasm' : 'wa-sqlite.wasm'}`,
      worker: () =>
        new Worker('/wasqlite/worker.js', {
          type: 'module',
          credentials: 'same-origin',
        }),
    }),
    family: 'sqlite',
    codecs: (col) => {
      if (col.table !== 'dialect_conformance') return undefined;
      if (col.column === 'b_bool' || col.column === 'nullable_bool') {
        return codecs.numberBoolean();
      }
      if (
        col.column === 'j_json' ||
        col.column === 'j_large' ||
        col.column === 'nullable_json'
      ) {
        return codecs.stringJson();
      }
      if (col.column === 'd_date' || col.column === 'nullable_date') {
        return codecs.timestampDate();
      }
      return undefined;
    },
  });
}

// --- Conformance scenario ---

async function runConformance(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const db = createDb<ConformanceDb>(`conf-${Date.now()}.sqlite`);
  try {
    // Create schema
    await db.schema
      .createTable('dialect_conformance')
      .ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('n_int', 'integer', (c) => c.notNull())
      .addColumn('n_bigint', 'integer', (c) => c.notNull())
      .addColumn('bigint_text', 'text', (c) => c.notNull())
      .addColumn('t_text', 'text', (c) => c.notNull())
      .addColumn('u_unique', 'text', (c) => c.notNull())
      .addColumn('b_bool', 'text', (c) => c.notNull())
      .addColumn('j_json', 'text', (c) => c.notNull())
      .addColumn('j_large', 'text', (c) => c.notNull())
      .addColumn('d_date', 'text', (c) => c.notNull())
      .addColumn('bytes', 'blob', (c) => c.notNull())
      .addColumn('nullable_text', 'text')
      .addColumn('nullable_int', 'integer')
      .addColumn('nullable_bigint', 'integer')
      .addColumn('nullable_bool', 'text')
      .addColumn('nullable_bytes', 'blob')
      .addColumn('nullable_json', 'text')
      .addColumn('nullable_date', 'text')
      .execute();
    await db.schema
      .createIndex('dialect_conformance_u_unique_idx')
      .ifNotExists()
      .on('dialect_conformance')
      .column('u_unique')
      .unique()
      .execute();

    const now = new Date('2025-01-02T03:04:05.678Z');
    const payload = {
      a: 1,
      b: [true, null, { c: 'x', d: [1, 2, 3] }],
      e: { nested: { ok: true } },
    };
    const largePayload = {
      unicode: 'こんにちは 🌍 — café — 😀',
      nested: {
        ok: true,
        bigString: 'x'.repeat(64 * 1024),
        list: Array.from({ length: 2000 }, (_, i) => ({
          i,
          v: `value-${i}`,
        })),
      },
    };
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 42]);
    const tText = 'unicode: 北京 — café — 😀 — newline:\nsecond-line';

    await db
      .insertInto('dialect_conformance')
      .values({
        id: 'row-1',
        n_int: 123,
        n_bigint: 42,
        bigint_text: '9007199254740993',
        t_text: tText,
        u_unique: 'u-1',
        b_bool: true,
        j_json: payload,
        j_large: largePayload,
        d_date: now,
        bytes,
        nullable_text: null,
        nullable_int: null,
        nullable_bigint: null,
        nullable_bool: null,
        nullable_bytes: null,
        nullable_json: null,
        nullable_date: null,
      })
      .execute();

    type Row = Record<string, unknown>;
    const row = (await db
      .selectFrom('dialect_conformance')
      .selectAll()
      .where('id', '=', 'row-1')
      .executeTakeFirstOrThrow()) as Row;

    assert(row.n_int === 123, 'n_int mismatch');
    assert(row.t_text === tText, 't_text mismatch');
    jsonEqual(row.j_json, payload, 'j_json');
    jsonEqual(row.j_large, largePayload, 'j_large');
    assert(row.b_bool === true, 'b_bool mismatch');
    assert(row.d_date instanceof Date, 'd_date should be Date');
    assert((row.d_date as Date).getTime() === now.getTime(), 'd_date mismatch');
    assert(
      JSON.stringify(bytesToArray(row.bytes)) ===
        JSON.stringify(Array.from(bytes)),
      'bytes mismatch'
    );

    // Unique constraint + upsert
    await db
      .insertInto('dialect_conformance')
      .values({
        id: 'uniq-1',
        n_int: 1,
        n_bigint: 1,
        bigint_text: '1',
        t_text: 'one',
        u_unique: 'unique-key',
        b_bool: true,
        j_json: { ok: true },
        j_large: { ok: true },
        d_date: now,
        bytes: new Uint8Array([1]),
        nullable_text: null,
        nullable_int: null,
        nullable_bigint: null,
        nullable_bool: null,
        nullable_bytes: null,
        nullable_json: null,
        nullable_date: null,
      })
      .execute();

    await db
      .insertInto('dialect_conformance')
      .values({
        id: 'uniq-2',
        n_int: 2,
        n_bigint: 1,
        bigint_text: '1',
        t_text: 'two',
        u_unique: 'unique-key',
        b_bool: false,
        j_json: { ok: false },
        j_large: { ok: false },
        d_date: now,
        bytes: new Uint8Array([2]),
        nullable_text: null,
        nullable_int: null,
        nullable_bigint: null,
        nullable_bool: null,
        nullable_bytes: null,
        nullable_json: null,
        nullable_date: null,
      })
      .onConflict((oc) =>
        oc.column('u_unique').doUpdateSet({
          id: 'uniq-2',
          n_int: 2,
          t_text: 'two',
          b_bool: false,
        })
      )
      .execute();

    const uniq = (await db
      .selectFrom('dialect_conformance')
      .select(['id', 'n_int', 't_text', 'b_bool'])
      .where('u_unique', '=', 'unique-key')
      .executeTakeFirstOrThrow()) as Row;

    assert(uniq.id === 'uniq-2', 'upsert id mismatch');
    assert(uniq.n_int === 2, 'upsert n_int mismatch');

    // Transaction rollback
    let rolledBack = false;
    await db
      .transaction()
      .execute(async (trx) => {
        await trx
          .insertInto('dialect_conformance')
          .values({
            id: 'tx-row',
            n_int: 1,
            n_bigint: 1,
            bigint_text: '1',
            t_text: 'tx',
            u_unique: 'u-tx',
            b_bool: false,
            j_json: { ok: true },
            j_large: { ok: true },
            d_date: new Date('2025-01-01T00:00:00.000Z'),
            bytes: new Uint8Array([1, 2, 3]),
            nullable_text: null,
            nullable_int: null,
            nullable_bigint: null,
            nullable_bool: null,
            nullable_bytes: null,
            nullable_json: null,
            nullable_date: null,
          })
          .execute();
        throw new Error('rollback');
      })
      .catch((e: unknown) => {
        rolledBack = String(e).includes('rollback');
      });

    assert(rolledBack, 'expected rollback error');
    const txRow = await db
      .selectFrom('dialect_conformance')
      .select(['id'])
      .where('id', '=', 'tx-row')
      .executeTakeFirst();
    assert(txRow === undefined, 'tx-row should not persist after rollback');

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await db.destroy();
  }
}

// --- Sync scenarios ---

async function createSyncClient(serverUrl: string, actorId: string) {
  const db = createDb<RuntimeClientDb>(`sync-${Date.now()}.sqlite`);
  await ensureClientSyncSchema(db);

  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('completed', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (c) => c.notNull())
    .addColumn('project_id', 'text', (c) => c.notNull())
    .addColumn('server_version', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();

  const handlers: ClientHandlerCollection<RuntimeClientDb> = [
    tasksClientHandler,
  ];

  const transport = createHttpTransport({
    baseUrl: serverUrl,
    getHeaders: () => ({ 'x-actor-id': actorId }),
  });

  return { db, handlers, transport };
}

async function runBootstrap(params: {
  serverUrl: string;
  actorId: string;
  clientId: string;
}): Promise<{ ok: boolean; rowCount?: number; error?: string }> {
  const client = await createSyncClient(params.serverUrl, params.actorId);
  try {
    await syncPullOnce(client.db, client.transport, client.handlers, {
      clientId: params.clientId,
      subscriptions: [
        {
          id: 'tasks',
          table: 'tasks',
          scopes: { user_id: params.actorId, project_id: 'p1' },
        },
      ],
    });
    const rows = await client.db.selectFrom('tasks').selectAll().execute();
    return { ok: true, rowCount: rows.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.db.destroy();
  }
}

async function runPushPull(params: {
  serverUrl: string;
  actorId: string;
  clientId: string;
}): Promise<{ ok: boolean; finalRowCount?: number; error?: string }> {
  const client = await createSyncClient(params.serverUrl, params.actorId);
  try {
    const sub = {
      id: 'tasks',
      table: 'tasks',
      scopes: { user_id: params.actorId, project_id: 'p1' },
    };

    await syncPullOnce(client.db, client.transport, client.handlers, {
      clientId: params.clientId,
      subscriptions: [sub],
    });

    await enqueueOutboxCommit(client.db, {
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 'browser-task-1',
          op: 'upsert',
          payload: {
            title: 'Browser Task',
            completed: 0,
            project_id: 'p1',
          },
          base_version: null,
        },
      ],
    });

    const pushResult = await syncPushOnce(client.db, client.transport, {
      clientId: params.clientId,
    });

    if (!pushResult.pushed || pushResult.response?.status !== 'applied') {
      return {
        ok: false,
        error: `Push failed: ${pushResult.response?.status}`,
      };
    }

    await syncPullOnce(client.db, client.transport, client.handlers, {
      clientId: params.clientId,
      subscriptions: [sub],
    });

    const rows = await client.db.selectFrom('tasks').selectAll().execute();
    return { ok: true, finalRowCount: rows.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.db.destroy();
  }
}

// --- Expose to Playwright ---

const runtime = {
  conformance: runConformance,
  bootstrap: runBootstrap,
  pushPull: runPushPull,
};

Object.assign(window, { __runtime: runtime, __runtimeReady: true });
