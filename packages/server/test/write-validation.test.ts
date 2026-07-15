/**
 * Server-side write-validation hooks (SPEC.md §6.7): per-table validators
 * run after decode + §3.4 authorization, inside the commit transaction; a
 * throw rejects the whole commit atomically with a host code that is NOT a
 * protocol code. Driven through bytes, like the rest of the push suite.
 */
import { describe, expect, test } from 'bun:test';
import { decodeRow, encodeRow, type RowColumn } from '@syncular/core';
import {
  type CrdtMergerRegistry,
  RESERVED_VALIDATION_CODE_PREFIXES,
  type ServerSchema,
  type SyncularServerEvent,
  type SyncularServerEvents,
  ValidationRejection,
  type Validator,
} from '@syncular/server';
import {
  makeContext,
  pushCommit,
  pushResults,
  sync,
  TASK_COLUMNS,
  taskRow,
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
  return encodeRow(NOTE_COLUMNS, [id, 'p1', doc]);
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
