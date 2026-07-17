import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  decodeMessage,
  encodeMessage,
  encodeRow,
  PROTOCOL_WIRE_VERSION,
  type PushCommitFrame,
  type PushOperation,
  type PushResultFrame,
  type ResponseMessage,
  type RowColumn,
} from '@syncular/core';
import {
  D1ServerStorage,
  handleSyncRequest,
  MemorySegmentStore,
  PostgresServerStorage,
  type ServerSchema,
  type ServerStorage,
  SqliteServerStorage,
  type SyncularServerEvent,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { D1DatabaseDouble } from './d1-double';

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'workspace_id', type: 'string', nullable: false },
  { name: 'surgery_id', type: 'string', nullable: false },
  { name: 'body', type: 'string', nullable: false },
];

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'reports',
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: ['workspace:{workspace_id}'],
      indexes: [
        {
          name: 'reports_by_surgery',
          columns: ['workspace_id', 'surgery_id'],
          unique: true,
        },
      ],
    },
  ],
};

function row(
  id: string,
  workspaceId: string,
  surgeryId: string,
  body: string,
): Uint8Array {
  return encodeRow(COLUMNS, [id, workspaceId, surgeryId, body]);
}

function upsert(rowId: string, payload: Uint8Array): PushOperation {
  return { table: 'reports', rowId, op: 'upsert', payload };
}

function commit(
  clientCommitId: string,
  operations: PushOperation[],
): PushCommitFrame {
  return { type: 'PUSH_COMMIT', clientCommitId, operations };
}

async function push(
  storage: ServerStorage,
  commits: readonly PushCommitFrame[],
  events?: SyncularServerEvent[],
): Promise<ResponseMessage> {
  const bytes = encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [
      { type: 'REQ_HEADER', clientId: 'constraint-client', schemaVersion: 1 },
      ...commits,
    ],
  });
  const response = await handleSyncRequest(bytes, {
    partition: 'workspace-partition',
    actorId: 'surgeon',
    schema: SCHEMA,
    storage,
    segments: new MemorySegmentStore(),
    resolveScopes: () => ({ workspace_id: ['w1'] }),
    ...(events === undefined
      ? {}
      : {
          events: { emit: (event: SyncularServerEvent) => events.push(event) },
        }),
  });
  const decoded = decodeMessage(response);
  if (decoded.msgKind !== 'response') throw new Error('expected response');
  return decoded;
}

function pushResult(message: ResponseMessage): PushResultFrame {
  const result = message.frames.find(
    (frame): frame is PushResultFrame => frame.type === 'PUSH_RESULT',
  );
  if (result === undefined) throw new Error('missing PUSH_RESULT');
  return result;
}

interface StorageFixture {
  readonly storage: ServerStorage;
  readonly close: () => Promise<void>;
}

const fixtures: ReadonlyArray<{
  readonly name: string;
  readonly open: () => Promise<StorageFixture>;
}> = [
  {
    name: 'SQLite',
    open: async () => ({
      storage: new SqliteServerStorage(),
      close: async () => {},
    }),
  },
  {
    name: 'PostgreSQL/PGlite',
    open: async () => {
      const db = await PGlite.create();
      return {
        storage: new PostgresServerStorage(pgliteExecutor(db)),
        close: async () => db.close(),
      };
    },
  },
  {
    name: 'D1',
    open: async () => ({
      storage: new D1ServerStorage(new D1DatabaseDouble()),
      close: async () => {},
    }),
  },
];

describe('durable relational constraint rejection', () => {
  for (const fixture of fixtures) {
    test(`${fixture.name}: a secondary-unique collision rejects durably and the host continues`, async () => {
      const { storage, close } = await fixture.open();
      try {
        const existingPayload = row(
          'report-existing',
          'w1',
          'surgery-1',
          'original',
        );
        expect(
          pushResult(
            await push(storage, [
              commit('seed', [upsert('report-existing', existingPayload)]),
            ]),
          ).status,
        ).toBe('applied');

        const rejectedCommit = commit('collision', [
          upsert(
            'report-sibling',
            row('report-sibling', 'w1', 'surgery-2', 'must roll back'),
          ),
          upsert(
            'report-collision',
            row('report-collision', 'w1', 'surgery-1', 'must reject'),
          ),
        ]);
        const events: SyncularServerEvent[] = [];
        const first = pushResult(await push(storage, [rejectedCommit], events));
        expect(first.status).toBe('rejected');
        expect(first.results).toEqual([
          {
            opIndex: 1,
            status: 'error',
            code: 'sync.constraint_violation',
            message: 'write violates a relational constraint',
            retryable: false,
          },
        ]);
        expect(JSON.stringify(first)).not.toContain('reports_by_surgery');
        expect(JSON.stringify(first)).not.toContain('UNIQUE');
        const serializedEvents = JSON.stringify(events);
        expect(serializedEvents).toContain('sync.constraint_violation');
        expect(serializedEvents).not.toContain('reports_by_surgery');
        expect(serializedEvents).not.toContain('UNIQUE');

        const existing = await storage.getRow(
          'workspace-partition',
          'reports',
          'report-existing',
        );
        expect(existing?.payload).toEqual(existingPayload);
        expect(
          await storage.getRow(
            'workspace-partition',
            'reports',
            'report-sibling',
          ),
        ).toBeUndefined();
        expect(await storage.getMaxCommitSeq('workspace-partition')).toBe(1);

        const replay = pushResult(await push(storage, [rejectedCommit]));
        expect(replay).toEqual(first);

        const after = pushResult(
          await push(storage, [
            commit('after', [
              upsert(
                'report-after',
                row('report-after', 'w1', 'surgery-3', 'server survived'),
              ),
            ]),
          ]),
        );
        expect(after.status).toBe('applied');
        expect(await storage.getMaxCommitSeq('workspace-partition')).toBe(2);
      } finally {
        await close();
      }
    });
  }
});
