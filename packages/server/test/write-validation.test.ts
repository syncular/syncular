/**
 * Server-side write-validation hooks (SPEC.md §6.7): per-table validators
 * run after decode + §3.4 authorization, inside the commit transaction; a
 * throw rejects the whole commit atomically with a host code that is NOT a
 * protocol code. Driven through bytes, like the rest of the push suite.
 */
import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  decodeRow,
  encodeRow,
  encodeSparseRow,
  type RowColumn,
} from '@syncular/core';
import {
  CommitValidationRejection,
  type CommitValidator,
  compileSchema,
  type CrdtMergerRegistry,
  PostgresServerStorage,
  RESERVED_VALIDATION_CODE_PREFIXES,
  type ServerSchema,
  StorageQueryError,
  SqliteServerStorage,
  type SyncularServerEvent,
  type SyncularServerEvents,
  ValidationRejection,
  type Validator,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import type { PgExecutor, PgQueryable } from '../src/pg-executor';
import {
  del,
  makeContext,
  pushCommit,
  pushResults,
  sync,
  TASK_COLUMNS,
  taskRow,
  TEST_SCHEMA,
  upsert,
} from './helpers';

describe('ValidationRejection reserved-prefix guard (§6.7)', () => {
  test('a non-reserved code constructs and carries its code + message', () => {
    const rejection = new ValidationRejection('app.too_long', 'nope');
    expect(rejection.code).toBe('app.too_long');
    expect(rejection.message).toBe('nope');
    expect(rejection).toBeInstanceOf(Error);
  });

  test('every reserved protocol prefix throws at construction', () => {
    for (const prefix of RESERVED_VALIDATION_CODE_PREFIXES) {
      expect(() => new ValidationRejection(`${prefix}whatever`)).toThrow();
    }
  });

  test('an empty code throws', () => {
    expect(() => new ValidationRejection('')).toThrow();
  });

  test('structured details are bounded and code-like', () => {
    const rejection = new ValidationRejection(
      'app.invalid_duration',
      'diagnostic',
      {
        fieldPaths: ['duration_minutes'],
        reason: 'outside_allowed_range',
        requiredAction: 'edit_fields',
        references: { surgery_id: 'surgery-1' },
      },
    );
    expect(rejection.details).toEqual({
      fieldPaths: ['duration_minutes'],
      reason: 'outside_allowed_range',
      requiredAction: 'edit_fields',
      references: { surgery_id: 'surgery-1' },
    });
    expect(
      () =>
        new ValidationRejection('app.invalid', 'diagnostic', {
          requiredAction: 'Render arbitrary prose',
        }),
    ).toThrow('lowercase stable token');
  });
});

/** A validator rejecting a title longer than `max`. */
function titleMax(max: number, code = 'app.title_too_long'): Validator {
  return (op) => {
    const title = op.row?.title;
    if (typeof title === 'string' && title.length > max) {
      throw new ValidationRejection(code, `title over ${max}`);
    }
  };
}

interface Captured {
  readonly sink: SyncularServerEvents;
  readonly events: SyncularServerEvent[];
}
function capture(): Captured {
  const events: SyncularServerEvent[] = [];
  return { sink: { emit: (e) => void events.push(e) }, events };
}

describe('write validation apply (§6.7)', () => {
  test('sanitizes unexpected row-validator exceptions before persistence and replay', async () => {
    const secret = 'synthetic-private-database-password';
    let calls = 0;
    const fail = () => {
      calls += 1;
      throw new Error(secret);
    };
    const cap = capture();
    const t = makeContext({
      validators: { tasks: fail },
      events: cap.sink,
    });
    const frames = [
      pushCommit('private-failure', [
        upsert('tasks', 't1', taskRow('t1', 'p1')),
      ]),
    ];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await sync(t, frames);
      expect(pushResults(result)[0]?.results[0]).toMatchObject({
        status: 'error',
        code: 'sync.constraint_violation',
        message: 'write validator failed',
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(calls).toBe(1);
    expect(
      JSON.stringify(
        await t.storage.getPushResult('part-1', 'client-1', 'private-failure'),
      ),
    ).not.toContain(secret);
    expect(JSON.stringify(cap.events)).not.toContain(secret);
    expect(await t.storage.getRow('part-1', 'tasks', 't1')).toBeUndefined();
    t.storage.db.close();
  });

  test('reports an unexpected whole-commit exception and answers sync.validator_error', async () => {
    const failure = new Error('validator exploded: synthetic-token');
    let calls = 0;
    const reports: Array<{ error: unknown; route: string }> = [];
    const t = makeContext({
      commitValidator: () => {
        calls += 1;
        throw failure;
      },
      onError: (error, { route }) => void reports.push({ error, route }),
    });
    const frames = [
      pushCommit('validator-threw', [
        upsert('tasks', 't1', taskRow('t1', 'p1')),
        upsert('tasks', 't2', taskRow('t2', 'p1')),
      ]),
    ];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const message = await sync(t, frames);
      expect(pushResults(message)[0]?.results[0]).toMatchObject({
        opIndex: 0,
        status: 'error',
        code: 'sync.validator_error',
        message: 'whole-commit validator failed',
        retryable: false,
      });
      expect(
        message.frames.find((frame) => frame.type === 'PUSH_RESULT_DETAILS'),
      ).toEqual({
        type: 'PUSH_RESULT_DETAILS',
        clientCommitId: 'validator-threw',
        entries: [
          {
            opIndex: 0,
            details: {
              reason: 'validator_threw',
              references: {
                validator: 'commit',
                message: 'validator exploded: synthetic-token',
              },
            },
          },
        ],
      });
    }
    // The hook sees the original exception (stack included) exactly once:
    // the replayed rejection is served from the idempotency record.
    expect(calls).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.error).toBe(failure);
    expect(reports[0]?.route).toBe('sync');
    expect(await t.storage.getRow('part-1', 'tasks', 't1')).toBeUndefined();
    expect(await t.storage.getRow('part-1', 'tasks', 't2')).toBeUndefined();
    t.storage.db.close();
  });

  test('bounds and sanitizes the thrown message it reports', async () => {
    const t = makeContext({
      commitValidator: () => {
        throw new Error(`  line one\nline two\u0007  ${'ü'.repeat(200)}  `);
      },
    });
    const message = await sync(t, [
      pushCommit('validator-bounds', [
        upsert('tasks', 't1', taskRow('t1', 'p1')),
      ]),
    ]);
    const details = message.frames.find(
      (frame) => frame.type === 'PUSH_RESULT_DETAILS',
    );
    const text =
      details?.type === 'PUSH_RESULT_DETAILS'
        ? details.entries[0]?.details.references?.message
        : undefined;
    if (text === undefined) throw new Error('details message missing');
    expect(text.startsWith('line one line two')).toBe(true);
    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThan(256);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(256);
    t.storage.db.close();
  });

  test('an empty thrown message keeps the reason without a reference', async () => {
    const t = makeContext({
      commitValidator: () => {
        throw new Error('   \n  ');
      },
    });
    const message = await sync(t, [
      pushCommit('validator-empty', [
        upsert('tasks', 't1', taskRow('t1', 'p1')),
      ]),
    ]);
    expect(
      message.frames.find((frame) => frame.type === 'PUSH_RESULT_DETAILS'),
    ).toEqual({
      type: 'PUSH_RESULT_DETAILS',
      clientCommitId: 'validator-empty',
      entries: [{ opIndex: 0, details: { reason: 'validator_threw' } }],
    });
    t.storage.db.close();
  });

  test('emits and idempotently replays a privacy-safe details companion', async () => {
    const t = makeContext({
      validators: {
        tasks: () => {
          throw new ValidationRejection(
            'app.invalid_title',
            'diagnostic only',
            {
              fieldPaths: ['title'],
              reason: 'invalid_value',
              requiredAction: 'edit_fields',
              references: { task_id: 't1' },
            },
          );
        },
      },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const message = await sync(t, [
        pushCommit('structured-c1', [
          upsert('tasks', 't1', taskRow('t1', 'p1', 'invalid')),
        ]),
      ]);
      expect(pushResults(message)[0]?.status).toBe('rejected');
      expect(
        message.frames.find((frame) => frame.type === 'PUSH_RESULT_DETAILS'),
      ).toEqual({
        type: 'PUSH_RESULT_DETAILS',
        clientCommitId: 'structured-c1',
        entries: [
          {
            opIndex: 0,
            details: {
              fieldPaths: ['title'],
              reason: 'invalid_value',
              requiredAction: 'edit_fields',
              references: { task_id: 't1' },
            },
          },
        ],
      });
    }
  });

  test('a rejecting validator rolls the whole commit back atomically', async () => {
    const cap = capture();
    const t = makeContext({
      validators: { tasks: titleMax(5) },
      events: cap.sink,
    });
    const message = await sync(t, [
      pushCommit('c1', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'way too long')),
        upsert('tasks', 't2', taskRow('t2', 'p1', 'ok')),
      ]),
    ]);
    const result = pushResults(message)[0];
    expect(result?.status).toBe('rejected');
    expect(result?.commitSeq).toBeUndefined();
    const record = result?.results[0];
    expect(record?.status).toBe('error');
    if (record?.status === 'error') {
      expect(record.code).toBe('app.title_too_long');
      expect(record.retryable).toBe(false);
    }
    // §6.4: the sibling insert rolled back with the rejected operation.
    expect(await t.storage.getRow('part-1', 'tasks', 't1')).toBeUndefined();
    expect(await t.storage.getRow('part-1', 'tasks', 't2')).toBeUndefined();
    // Events: reuse push.rejected carrying the host code (no new event).
    const rejected = cap.events.filter((e) => e.type === 'push.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      code: 'app.title_too_long',
      opIndex: 0,
    });
  });

  test('an accepting validator applies the write', async () => {
    const t = makeContext({ validators: { tasks: titleMax(50) } });
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1', 'fine'))]),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
    expect(
      (await t.storage.getRow('part-1', 'tasks', 't1'))?.serverVersion,
    ).toBe(1);
  });

  test('feature off (no validators): a would-fail write applies unchanged', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pushCommit('c1', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'x'.repeat(999))),
      ]),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
  });

  test('a non-ValidationRejection throw rejects with sync.constraint_violation', async () => {
    const t = makeContext({
      validators: {
        tasks: () => {
          throw new Error('boom');
        },
      },
    });
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    expect(record?.status).toBe('error');
    if (record?.status === 'error') {
      expect(record.code).toBe('sync.constraint_violation');
    }
    expect(await t.storage.getRow('part-1', 'tasks', 't1')).toBeUndefined();
  });

  test('the validator sees the stored row on an update (transition rule)', async () => {
    // Reject a title change while the STORED row is done.
    const frozen: Validator = (op) => {
      if (op.stored?.done === true && op.row?.title !== op.stored.title) {
        throw new ValidationRejection('app.frozen', 'done tasks are frozen');
      }
    };
    const t = makeContext({ validators: { tasks: frozen } });
    // Insert (stored undefined ⇒ passes), then mark done.
    await sync(t, [
      pushCommit('c1', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'first', false)),
      ]),
    ]);
    await sync(t, [
      pushCommit('c2', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'first', true)),
      ]),
    ]);
    // Rename the now-done row: the validator reads stored.done and rejects.
    const message = await sync(t, [
      pushCommit('c3', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'renamed', true)),
      ]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    expect(record?.status === 'error' && record.code).toBe('app.frozen');
    const stored = await t.storage.getRow('part-1', 'tasks', 't1');
    const values = decodeRow(TASK_COLUMNS, stored?.payload ?? new Uint8Array());
    expect(values[2]).toBe('first'); // title unchanged
  });

  test('a delete of an existing row validates against the stored row', async () => {
    const t = makeContext({
      validators: {
        tasks: (op) => {
          if (op.op === 'delete' && op.stored?.done === true) {
            throw new ValidationRejection('app.no_delete_done');
          }
        },
      },
    });
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1', 'x', true))]),
    ]);
    const message = await sync(t, [
      pushCommit('c2', [{ table: 'tasks', rowId: 't1', op: 'delete' }]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    expect(record?.status === 'error' && record.code).toBe(
      'app.no_delete_done',
    );
    // The row survived the rejected delete.
    expect(await t.storage.getRow('part-1', 'tasks', 't1')).toBeDefined();
  });

  test('a delete of an ABSENT row never runs the validator (§6.2)', async () => {
    let ran = false;
    const t = makeContext({
      validators: {
        tasks: () => {
          ran = true;
        },
      },
    });
    const message = await sync(t, [
      pushCommit('c1', [{ table: 'tasks', rowId: 'ghost', op: 'delete' }]),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
    expect(ran).toBe(false);
  });

  for (const backend of ['SQLite', 'PostgreSQL/PGlite'] as const) {
    test(`${backend}: an unrelated queryAuthoritative runs while another transaction is open`, async () => {
      const db =
        backend === 'PostgreSQL/PGlite' ? await PGlite.create() : undefined;
      const storage =
        backend === 'SQLite'
          ? new SqliteServerStorage()
          : new PostgresServerStorage(pgliteExecutor(db!));
      await storage.ensureSchema(compileSchema(TEST_SCHEMA));
      const sql = 'SELECT id FROM tasks';
      const start = sql.indexOf('tasks');
      const request = {
        plan: {
          sql,
          relations: [{ table: 'tasks', start, end: start + 'tasks'.length }],
        },
        params: [],
        tables: ['tasks'],
      };
      try {
        const seed = await storage.begin('part-1');
        await seed.upsertRow('tasks', {
          rowId: 't1',
          serverVersion: 1,
          scopes: { project_id: 'p1' },
          payload: encodeRow(TASK_COLUMNS, [
            't1',
            'p1',
            'one',
            false,
            null,
            null,
          ]),
        });
        await seed.appendCommit({
          clientId: 'seed',
          clientCommitId: 'seed-1',
          actorId: 'seed',
          createdAtMs: 1,
          changes: [],
        });
        await seed.commit();

        // Hold a transaction open while a separate caller issues a
        // registered query. The storage serializes that query behind the
        // open transaction and then serves it; only a query issued from
        // inside the transaction's own validator execution hangs.
        const held = await storage.begin('part-1');
        await held.upsertRow('tasks', {
          rowId: 't2',
          serverVersion: 1,
          scopes: { project_id: 'p1' },
          payload: encodeRow(TASK_COLUMNS, [
            't2',
            'p1',
            'two',
            false,
            null,
            null,
          ]),
        });
        const pending = storage.queryAuthoritative('part-1', request);
        await held.rollback();
        expect(await pending).toEqual({
          rows: [{ id: 't1' }],
          maxCommitSeq: 1,
        });
      } finally {
        if (storage instanceof SqliteServerStorage) storage.db.close();
        else await db?.close();
      }
    });
  }
});

/** The commit-reader index fixture: one declared non-unique index. */
const INDEXED_TASKS_SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: TASK_COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
      indexes: [{ name: 'tasks_by_project', columns: ['project_id'] }],
    },
  ],
};

describe('whole-commit validation (§6.8)', () => {
  test('rejects a missing sibling operation and rolls every staged row back', async () => {
    const requireAudit: CommitValidator = ({ operations }) => {
      const completed = operations.find(
        (operation) => operation.row?.done === true,
      );
      if (
        completed &&
        !operations.some(
          (operation) => operation.rowId === `${completed.rowId}-audit`,
        )
      ) {
        throw new CommitValidationRejection(
          completed.opIndex,
          'app.missing_completion_audit',
          'completed task requires its audit sibling',
          {
            fieldPaths: ['tasks.done'],
            reason: 'missing_sibling_operation',
            requiredAction: 'repair_aggregate',
          },
        );
      }
    };
    const reports: unknown[] = [];
    const t = makeContext({
      commitValidator: requireAudit,
      onError: (error) => void reports.push(error),
    });
    const rejected = await sync(t, [
      pushCommit('aggregate-rejected', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'done', true)),
        upsert('tasks', 't2', taskRow('t2', 'p1', 'ordinary', false)),
      ]),
    ]);
    const record = pushResults(rejected)[0]?.results[0];
    expect(record).toMatchObject({
      opIndex: 0,
      status: 'error',
      code: 'app.missing_completion_audit',
    });
    expect(
      rejected.frames.find((frame) => frame.type === 'PUSH_RESULT_DETAILS'),
    ).toEqual({
      type: 'PUSH_RESULT_DETAILS',
      clientCommitId: 'aggregate-rejected',
      entries: [
        {
          opIndex: 0,
          details: {
            fieldPaths: ['tasks.done'],
            reason: 'missing_sibling_operation',
            requiredAction: 'repair_aggregate',
          },
        },
      ],
    });
    expect(await t.storage.getRow('part-1', 'tasks', 't1')).toBeUndefined();
    expect(await t.storage.getRow('part-1', 'tasks', 't2')).toBeUndefined();

    const accepted = await sync(t, [
      pushCommit('aggregate-accepted', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'done', true)),
        upsert('tasks', 't1-audit', taskRow('t1-audit', 'p1', 'audit', false)),
      ]),
    ]);
    expect(pushResults(accepted)[0]?.status).toBe('applied');
    expect(reports).toHaveLength(0);
  });

  test('reads the final candidate state and operation version evidence', async () => {
    let seen: unknown;
    const inspect: CommitValidator = async ({ operations, read }) => {
      const exact = await read.getRow('tasks', 't2');
      const rows = await read.scanRows({
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
      });
      seen = {
        operations: operations.map((operation) => ({
          rowId: operation.rowId,
          storedServerVersion: operation.storedServerVersion,
          nextServerVersion: operation.nextServerVersion,
        })),
        exact: exact?.row.title,
        scan: rows.map((row) => row.row.id),
      };
    };
    const t = makeContext({ commitValidator: inspect });
    await sync(t, [
      pushCommit('candidate-state', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'one')),
        upsert('tasks', 't2', taskRow('t2', 'p1', 'two')),
      ]),
    ]);
    expect(seen).toEqual({
      operations: [
        { rowId: 't1', storedServerVersion: undefined, nextServerVersion: 1 },
        { rowId: 't2', storedServerVersion: undefined, nextServerVersion: 1 },
      ],
      exact: 'two',
      scan: ['t1', 't2'],
    });
  });

  test('getRows matches N getRow calls for stored, absent, and staged rows', async () => {
    let seen: unknown;
    const inspect: CommitValidator = async ({ read }) => {
      const ids = ['t-stored', 't-absent', 't-delete', 't-staged'];
      const batch = await read.getRows('tasks', ids);
      const mismatched: string[] = [];
      const absentSingles: string[] = [];
      for (const rowId of ids) {
        const single = await read.getRow('tasks', rowId);
        if (single === undefined) absentSingles.push(rowId);
        if (JSON.stringify(batch.get(rowId)) !== JSON.stringify(single)) {
          mismatched.push(rowId);
        }
      }
      seen = {
        keys: [...batch.keys()],
        versions: Object.fromEntries(
          [...batch].map(([rowId, row]) => [rowId, row.serverVersion]),
        ),
        mismatched,
        absentSingles,
      };
    };
    const t = makeContext({ commitValidator: inspect });
    await sync(t, [
      pushCommit('seed-batch-rows', [
        upsert('tasks', 't-stored', taskRow('t-stored', 'p1', 'stored')),
        upsert('tasks', 't-delete', taskRow('t-delete', 'p1', 'deleted')),
      ]),
    ]);
    await sync(t, [
      pushCommit('batch-read', [
        del('tasks', 't-delete', 1),
        upsert('tasks', 't-staged', taskRow('t-staged', 'p1', 'staged')),
      ]),
    ]);
    expect(seen).toEqual({
      keys: ['t-stored', 't-staged'],
      versions: { 't-stored': 1, 't-staged': 1 },
      mismatched: [],
      absentSingles: ['t-absent', 't-delete'],
    });
  });

  test('scanRowsByIndex pages the final candidate state through a declared index', async () => {
    let seen: unknown;
    const inspect: CommitValidator = async ({ read }) => {
      const first = await read.scanRowsByIndex({
        table: 'tasks',
        index: 'tasks_by_project',
        values: ['p1'],
        limit: 2,
      });
      const after = first[first.length - 1]?.row.id;
      const second = await read.scanRowsByIndex({
        table: 'tasks',
        index: 'tasks_by_project',
        values: ['p1'],
        afterRowId: typeof after === 'string' ? after : null,
        limit: 2,
      });
      seen = {
        first: first.map((row) => ({
          id: row.row.id,
          version: row.serverVersion,
        })),
        second: second.map((row) => row.row.id),
      };
    };
    const t = makeContext({
      schema: INDEXED_TASKS_SCHEMA,
      commitValidator: inspect,
      resolveScopes: () => ({ project_id: ['p1', 'p2'] }),
    });
    const seed = await sync(t, [
      pushCommit('indexed-seed', [
        upsert('tasks', 'a', taskRow('a', 'p1')),
        upsert('tasks', 'b', taskRow('b', 'p1')),
        upsert('tasks', 'c', taskRow('c', 'p1')),
        upsert('tasks', 'd', taskRow('d', 'p2')),
      ]),
    ]);
    const candidate = await sync(t, [
      pushCommit('indexed-candidate', [
        del('tasks', 'b', 1),
        upsert('tasks', 'e', taskRow('e', 'p1')),
        upsert('tasks', 'f', taskRow('f', 'p1')),
      ]),
    ]);
    expect(pushResults(seed)[0]?.status).toBe('applied');
    expect(pushResults(candidate)[0]?.status).toBe('applied');
    // The staged delete is absent, the staged upserts are present, and the
    // p2 row never matches the p1 index value.
    expect(seen).toEqual({
      first: [
        { id: 'a', version: 1 },
        { id: 'c', version: 1 },
      ],
      second: ['e', 'f'],
    });
  });

  test('scanRowsByIndex fails loudly on an undeclared index or invalid bounds', async () => {
    const errors: unknown[] = [];
    const inspect: CommitValidator = async ({ read }) => {
      for (const input of [
        { table: 'tasks', index: 'missing_index', values: ['p1'], limit: 10 },
        { table: 'tasks', index: 'tasks_by_project', values: ['p1'], limit: 0 },
        { table: 'tasks', index: 'tasks_by_project', values: [], limit: 10 },
      ] as const) {
        try {
          await read.scanRowsByIndex(input);
          errors.push('no error');
        } catch (error) {
          if (!(error instanceof StorageQueryError)) {
            errors.push('unexpected error');
            continue;
          }
          errors.push(error.code);
        }
      }
    };
    const t = makeContext({
      schema: INDEXED_TASKS_SCHEMA,
      commitValidator: inspect,
      resolveScopes: () => ({ project_id: ['p1'] }),
    });
    await sync(t, [
      pushCommit('indexed-errors', [upsert('tasks', 'a', taskRow('a', 'p1'))]),
    ]);
    expect(errors).toEqual([
      'sync.storage.index_not_found',
      'sync.storage.invalid_limit',
      'sync.storage.index_value_count_mismatch',
    ]);
  });

  test('a Postgres getRows answers N ids in one statement', async () => {
    const db = await PGlite.create();
    const inner = pgliteExecutor(db);
    const count = { transaction: 0 };
    const exec: PgExecutor = {
      query: <Row>(text: string, params?: readonly unknown[]) =>
        inner.query<Row>(text, params),
      transaction: <T>(fn: (client: PgQueryable) => Promise<T>) =>
        inner.transaction((client) =>
          fn({
            query: <Row>(text: string, params?: readonly unknown[]) => {
              count.transaction += 1;
              return client.query<Row>(text, params);
            },
          }),
        ),
      close: async () => {
        await inner.close?.();
      },
    };
    const storage = new PostgresServerStorage(exec);
    await storage.ensureSchema(compileSchema(TEST_SCHEMA));
    const ids = ['s1', 's2', 's3', 's4', 's5'];
    const seed = await storage.begin('part-1');
    for (const id of ids) {
      await seed.upsertRow('tasks', {
        rowId: id,
        serverVersion: 1,
        scopes: { project_id: 'p1' },
        payload: encodeRow(TASK_COLUMNS, [
          id,
          'p1',
          `title-${id}`,
          false,
          null,
          null,
        ]),
      });
    }
    await seed.commit();

    let statements = 0;
    let titles: unknown;
    const batchRead: CommitValidator = async ({ read }) => {
      const rows = await read.getRows('tasks', ids);
      titles = ids.map((rowId) => rows.get(rowId)?.row.title);
      // The first call also flushes the commit's staged upsert. Measure the
      // next one: the batch read itself must stay one statement at any N.
      const before = count.transaction;
      await read.getRows('tasks', ids);
      statements = count.transaction - before;
    };
    const t = makeContext({ storage, commitValidator: batchRead });
    const message = await sync(t, [
      pushCommit('batch-statement-count', [
        upsert('tasks', 'fresh', taskRow('fresh', 'p1')),
      ]),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
    expect(statements).toBe(1);
    expect(titles).toEqual(ids.map((id) => `title-${id}`));
    await db.close();
  });

  test('serializes a Promise.all of commit reads on one pinned Postgres client', async () => {
    const db = await PGlite.create();
    const inner = pgliteExecutor(db);
    // node-postgres warns about, and node-postgres 9 rejects, a second
    // statement issued on one connection before the first resolves. This
    // double stands in for that driver: it fails the push if the storage
    // ever overlaps two statements on the pinned client.
    let inFlight = 0;
    const guard = <T>(work: () => Promise<T>): Promise<T> => {
      if (inFlight > 0) {
        throw new Error('overlapping statement on a pinned client');
      }
      inFlight += 1;
      return work().finally(() => {
        inFlight -= 1;
      });
    };
    // Serialization is the claim under test, so only the pinned client is
    // guarded: a pool is allowed to run statements concurrently.
    const exec: PgExecutor = {
      query: <Row>(text: string, params?: readonly unknown[]) =>
        inner.query<Row>(text, params),
      transaction: <T>(fn: (client: PgQueryable) => Promise<T>) =>
        inner.transaction((client) =>
          fn({
            query: <Row>(text: string, params?: readonly unknown[]) =>
              guard(() => client.query<Row>(text, params)),
          }),
        ),
      close: async () => {
        await inner.close?.();
      },
    };
    const concurrentReads: CommitValidator = async ({ read }) => {
      await Promise.all([
        read.getRow('tasks', 't1'),
        read.getRow('tasks', 't2'),
      ]);
    };
    const storage = new PostgresServerStorage(exec);
    await storage.ensureSchema(compileSchema(TEST_SCHEMA));
    const t = makeContext({
      storage,
      commitValidator: concurrentReads,
    });
    const message = await sync(t, [
      pushCommit('concurrent-reads', [
        upsert('tasks', 't1', taskRow('t1', 'p1', 'one')),
        upsert('tasks', 't2', taskRow('t2', 'p1', 'two')),
      ]),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
    await db.close();
  });

  test('runs once for an idempotently replayed commit', async () => {
    let calls = 0;
    const t = makeContext({
      commitValidator: () => {
        calls += 1;
      },
    });
    const commit = pushCommit('whole-idempotent', [
      upsert('tasks', 't1', taskRow('t1', 'p1')),
    ]);
    await sync(t, [commit]);
    await sync(t, [commit]);
    expect(calls).toBe(1);
  });

  test('rechecks idempotency after partition serialization before validation', async () => {
    let validatorCalls = 0;
    const base = makeContext({
      commitValidator: () => {
        validatorCalls += 1;
      },
    });
    const seed = await base.storage.begin('part-1');
    await seed.putPushResult('client-1', 'serialized-replay', {
      status: 'applied',
      commitSeq: 42,
      results: [{ opIndex: 0, status: 'applied' }],
    });
    await seed.commit();

    // The admission read takes the partition lock and the persisted outcome
    // in one statement; a duplicate never reaches a validator.
    let admissions = 0;
    let poolReads = 0;
    const storage = new Proxy(base.storage, {
      get(target, property) {
        if (property === 'getPushResult') {
          return async (...args: [string, string, string]) => {
            poolReads += 1;
            return target.getPushResult(...args);
          };
        }
        if (property === 'begin') {
          return async (partition: string) => {
            const tx = await target.begin(partition);
            return new Proxy(tx, {
              get(txTarget, txProperty) {
                if (txProperty === 'preparePushApply') {
                  return async (...args: [string, string, number]) => {
                    admissions += 1;
                    return txTarget.preparePushApply(...args);
                  };
                }
                const value = Reflect.get(txTarget, txProperty, txTarget);
                return typeof value === 'function'
                  ? value.bind(txTarget)
                  : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const t = { ...base, ctx: { ...base.ctx, storage } };
    const message = await sync(t, [
      pushCommit('serialized-replay', [
        upsert('tasks', 'must-not-apply', taskRow('must-not-apply', 'p1')),
      ]),
    ]);

    expect(pushResults(message)[0]?.status).toBe('cached');
    expect(admissions).toBe(1);
    expect(poolReads).toBe(0);
    expect(validatorCalls).toBe(0);
    expect(
      await base.storage.getRow('part-1', 'tasks', 'must-not-apply'),
    ).toBeUndefined();
  });
});

// --- CRDT: the validator sees the MERGED value, not the raw update ---------

const NOTE_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'doc', type: 'crdt', nullable: true, crdtType: 'set-union' },
];
const NOTE_SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'notes',
      columns: NOTE_COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};
function setUnionMerge(
  stored: Uint8Array | null,
  incoming: Uint8Array,
): Uint8Array {
  const set = new Set<number>();
  for (const b of stored ?? []) set.add(b);
  for (const b of incoming) set.add(b);
  return new Uint8Array([...set].sort((a, b) => a - b));
}
const MERGERS: CrdtMergerRegistry = { 'set-union': setUnionMerge };
function noteRow(id: string, doc: Uint8Array | null): Uint8Array {
  return encodeSparseRow(NOTE_COLUMNS, 0, [id, 'p1', doc]);
}

describe('write validation sees the merged CRDT value (§6.7 / §5.10.3)', () => {
  test('the validator receives merge(stored, incoming), not the raw update', async () => {
    const seen: (Uint8Array | null)[] = [];
    // A validator that rejects if the MERGED doc would exceed 3 elements.
    const capDoc: Validator = (op) => {
      const doc = op.row?.doc;
      seen.push(doc instanceof Uint8Array ? doc : null);
      if (doc instanceof Uint8Array && doc.length > 3) {
        throw new ValidationRejection('app.doc_too_big');
      }
    };
    const t = makeContext({
      schema: NOTE_SCHEMA,
      crdtMergers: MERGERS,
      validators: { notes: capDoc },
      // NOTE_SCHEMA declares only project_id — the default resolver returns
      // extra variables the notes-only schema does not declare (§3.2).
      resolveScopes: () => ({ project_id: ['p1'] }),
    });

    // Insert with {1,2}: merged against empty = {1,2}, passes.
    let message = await sync(t, [
      pushCommit('c1', [
        upsert('notes', 'n1', noteRow('n1', new Uint8Array([1, 2]))),
      ]),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
    expect([...(seen[0] ?? [])]).toEqual([1, 2]);

    // Update with raw {5} (length 1). If the validator saw the RAW update it
    // would pass. But the MERGED doc is {1,2,5} — still ≤ 3, passes, and the
    // validator must have seen the 3-element merged value, not the 1-element
    // raw one.
    message = await sync(t, [
      pushCommit('c2', [
        upsert('notes', 'n1', noteRow('n1', new Uint8Array([5]))),
      ]),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
    expect([...(seen[1] ?? [])]).toEqual([1, 2, 5]);

    // Update with raw {9} (length 1). Raw would pass, but merged is
    // {1,2,5,9} (length 4 > 3) → the validator seeing the MERGED value
    // rejects. This is the load-bearing assertion.
    message = await sync(t, [
      pushCommit('c3', [
        upsert('notes', 'n1', noteRow('n1', new Uint8Array([9]))),
      ]),
    ]);
    const record = pushResults(message)[0]?.results[0];
    expect(record?.status === 'error' && record.code).toBe('app.doc_too_big');
    // The rejected update rolled back: stored doc stays {1,2,5}.
    const stored = await t.storage.getRow('part-1', 'notes', 'n1');
    const values = decodeRow(NOTE_COLUMNS, stored?.payload ?? new Uint8Array());
    expect([...(values[2] as Uint8Array)]).toEqual([1, 2, 5]);
  });
});
