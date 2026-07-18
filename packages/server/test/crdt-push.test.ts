/**
 * CRDT column push-merge semantics (SPEC.md §5.10.3). Driven through bytes,
 * with a tiny in-test merger (a commutative/associative/idempotent byte-set
 * union) so the server test stays CRDT-library-free — the merge CONTRACT is
 * what's under test, not Yjs (that lives in @syncular/crdt-yjs).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  decodeMessage,
  decodeRow,
  encodeMessage,
  encodeRow,
  PROTOCOL_WIRE_VERSION,
  type PushResultFrame,
  type RequestFrame,
  type RowColumn,
} from '@syncular/core';
import {
  type CrdtMergerRegistry,
  handleSyncRequest,
  MemorySegmentStore,
  type ServerSchema,
  SqliteServerStorage,
  type SyncRequestContext,
} from '@syncular/server';
import { overlapAfterTwoOptimisticMisses } from './helpers';

/** A note table: an ordinary `title` (LWW) + a `doc` crdt column. */
const NOTE_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'doc', type: 'crdt', nullable: true, crdtType: 'set-union' },
];

const SCHEMA: ServerSchema = {
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

/** Commutative/associative/idempotent: merged = sorted union of the byte
 * values present in stored ∪ incoming. */
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

function noteRow(
  id: string,
  projectId: string,
  title: string,
  doc: Uint8Array | null,
): Uint8Array {
  return encodeRow(NOTE_COLUMNS, [id, projectId, title, doc]);
}

let storage: SqliteServerStorage;
let ctx: SyncRequestContext;

function makeCtx(mergers?: CrdtMergerRegistry): SyncRequestContext {
  return {
    partition: 'part-1',
    actorId: 'actor-1',
    schema: SCHEMA,
    storage,
    segments: new MemorySegmentStore(),
    resolveScopes: () => ({ project_id: ['p1'] }),
    clock: () => 1_750_000_000_000,
    ...(mergers !== undefined ? { crdtMergers: mergers } : {}),
  };
}

async function push(
  context: SyncRequestContext,
  clientCommitId: string,
  op: {
    rowId: string;
    payload: Uint8Array;
    baseVersion?: number;
  },
  clientId = 'client-1',
): Promise<PushResultFrame> {
  const frames: RequestFrame[] = [
    {
      type: 'PUSH_COMMIT',
      clientCommitId,
      operations: [
        {
          table: 'notes',
          rowId: op.rowId,
          op: 'upsert',
          payload: op.payload,
          ...(op.baseVersion !== undefined
            ? { baseVersion: op.baseVersion }
            : {}),
        },
      ],
    },
  ];
  const bytes = encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [{ type: 'REQ_HEADER', clientId, schemaVersion: 1 }, ...frames],
  });
  const out = await handleSyncRequest(bytes, context);
  const message = decodeMessage(out);
  if (message.msgKind !== 'response') throw new Error('expected a response');
  const result = message.frames.find(
    (f): f is PushResultFrame => f.type === 'PUSH_RESULT',
  );
  if (result === undefined) throw new Error('no PUSH_RESULT');
  return result;
}

/** Read the stored `doc` crdt column bytes for a row. */
async function storedDoc(rowId: string): Promise<Uint8Array | null> {
  const row = await storage.getRow('part-1', 'notes', rowId);
  if (row === undefined) return null;
  const values = decodeRow(NOTE_COLUMNS, row.payload);
  const doc = values[3];
  return doc instanceof Uint8Array ? doc : null;
}

async function storedTitle(rowId: string): Promise<string> {
  const row = await storage.getRow('part-1', 'notes', rowId);
  if (row === undefined) throw new Error('no row');
  return decodeRow(NOTE_COLUMNS, row.payload)[2] as string;
}

describe('CRDT column push merge (SPEC.md §5.10.3)', () => {
  beforeEach(() => {
    storage = new SqliteServerStorage();
    ctx = makeCtx(MERGERS);
  });

  test('crdt column merges (stored ⊕ incoming), never overwrites', async () => {
    const insert = await push(ctx, 'c1', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([1, 3])),
    });
    expect(insert.status).toBe('applied');
    // Incoming {2,3} merges with stored {1,3} → {1,2,3}, not {2,3}.
    const merged = await push(ctx, 'c2', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([2, 3])),
    });
    expect(merged.status).toBe('applied');
    expect([...((await storedDoc('n1')) ?? [])]).toEqual([1, 2, 3]);
  });

  test('concurrent crdt edits converge order-independently (both orders)', async () => {
    await push(ctx, 'base', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([0])),
    });
    // Order A→B on one row, B→A on a twin row, then compare.
    await push(ctx, 'a1', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([10])),
    });
    await push(ctx, 'b1', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([20])),
    });
    expect([...((await storedDoc('n1')) ?? [])]).toEqual([0, 10, 20]);

    const storage2 = new SqliteServerStorage();
    const saved = storage;
    storage = storage2;
    const ctx2 = makeCtx(MERGERS);
    await push(ctx2, 'base2', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([0])),
    });
    await push(ctx2, 'b2', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([20])),
    });
    await push(ctx2, 'a2', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([10])),
    });
    expect([...((await storedDoc('n1')) ?? [])]).toEqual([0, 10, 20]);
    storage = saved;
  });

  test('a baseVersion-less crdt push never conflicts, however stale', async () => {
    await push(ctx, 'c1', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([1])),
    });
    // Advance server_version a few times (non-crdt LWW writes).
    await push(ctx, 'c2', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't2', new Uint8Array([2])),
    });
    await push(ctx, 'c3', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't3', new Uint8Array([3])),
    });
    // A LWW push (no baseVersion) merges crdt cleanly, no conflict.
    const r = await push(ctx, 'c4', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't4', new Uint8Array([4])),
    });
    expect(r.status).toBe('applied');
    expect([...((await storedDoc('n1')) ?? [])]).toEqual([1, 2, 3, 4]);
  });

  test('baseVersion conflict on non-crdt columns fires with the crdt merged in the winner', async () => {
    // Insert (version 1).
    await push(ctx, 'c1', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't1', new Uint8Array([1])),
    });
    // Winner: baseVersion 1 matches → applies, version → 2, doc {1}∪{2}={1,2}.
    const win = await push(ctx, 'win', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 'won', new Uint8Array([2])),
      baseVersion: 1,
    });
    expect(win.status).toBe('applied');
    // Loser: also baseVersion 1 (now stale) → conflict; NO merge applied
    // (atomic rollback), and the conflict serverRow carries the merged {1,2}.
    const lose = await push(ctx, 'lose', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 'lost', new Uint8Array([9])),
      baseVersion: 1,
    });
    expect(lose.status).toBe('rejected');
    const conflict = lose.results[0];
    if (conflict?.status !== 'conflict') throw new Error('expected conflict');
    expect(conflict.code).toBe('sync.version_conflict');
    // The loser's {9} did NOT merge (rolled back); serverRow shows {1,2}.
    expect([...((await storedDoc('n1')) ?? [])]).toEqual([1, 2]);
    const serverRow = decodeRow(NOTE_COLUMNS, conflict.serverRow);
    expect([...(serverRow[3] as Uint8Array)]).toEqual([1, 2]);
    expect(await storedTitle('n1')).toBe('won');
  });

  test('idempotent replay of a crdt push does not double-merge', async () => {
    await push(ctx, 'c1', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([5])),
    });
    // Replay the SAME clientCommitId — returns cached, no re-merge.
    const replay = await push(ctx, 'c1', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([5])),
    });
    expect(replay.status).toBe('cached');
    expect([...((await storedDoc('n1')) ?? [])]).toEqual([5]);
    // Even a fresh commit re-pushing {5} is idempotent by merge (no change).
    const again = await push(ctx, 'c2', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([5])),
    });
    expect(again.status).toBe('applied');
    expect([...((await storedDoc('n1')) ?? [])]).toEqual([5]);
  });

  test('overlapping duplicate CRDT deliveries merge exactly once', async () => {
    let mergeCalls = 0;
    const mergers: CrdtMergerRegistry = {
      'set-union': (stored, incoming) => {
        mergeCalls += 1;
        return setUnionMerge(stored, incoming);
      },
    };
    const overlapStorage = overlapAfterTwoOptimisticMisses(storage);
    const overlapContext: SyncRequestContext = {
      ...makeCtx(mergers),
      storage: overlapStorage,
    };
    const operation = {
      rowId: 'overlap-crdt',
      payload: noteRow('overlap-crdt', 'p1', 'one merge', new Uint8Array([7])),
    };

    const [left, right] = await Promise.all([
      push(overlapContext, 'overlap-crdt-commit', operation),
      push(overlapContext, 'overlap-crdt-commit', operation),
    ]);
    expect([left.status, right.status].sort()).toEqual(['applied', 'cached']);
    expect(mergeCalls).toBe(1);
    expect([...((await storedDoc('overlap-crdt')) ?? [])]).toEqual([7]);
    expect(
      (await storage.getRow('part-1', 'notes', 'overlap-crdt'))?.serverVersion,
    ).toBe(1);
  });

  test('a crdt push with no merger registered fails loud (§5.10.6)', async () => {
    const noMergerCtx = makeCtx(undefined);
    const r = await push(noMergerCtx, 'c1', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([1])),
    });
    expect(r.status).toBe('rejected');
    const record = r.results[0];
    if (record?.status !== 'error') throw new Error('expected error result');
    expect(record.code).toBe('sync.crdt_merge_failed');
    // Rolled back whole — no row landed.
    expect(await storage.getRow('part-1', 'notes', 'n1')).toBeUndefined();
  });

  test('a NULL crdt value is a clear, not a merge', async () => {
    await push(ctx, 'c1', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', new Uint8Array([1, 2])),
    });
    const cleared = await push(ctx, 'c2', {
      rowId: 'n1',
      payload: noteRow('n1', 'p1', 't', null),
    });
    expect(cleared.status).toBe('applied');
    expect(await storedDoc('n1')).toBeNull();
  });
});
