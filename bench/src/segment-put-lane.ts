/**
 * Segment put lane: a cold pull whose rows segments all go to a segment store
 * with a fixed latency per put, the shape of a pull after a schema bump on
 * `R2SegmentStore`. Four units of 4,000 rows of about 875 bytes, 1,000 rows
 * per page and four pages per unit, give sixteen segments of about 875 KB.
 *
 * Run: `bun run --cwd bench bench:segment-puts [--latency-ms 250]`. Each line
 * reports the pull's wall time with a store that runs one put at a time (the
 * sequential pull before 0.95.0) and with one that takes them as they come
 * (the pull keeps six in flight).
 */
import { parseArgs } from 'node:util';
import {
  decodeMessage,
  encodeMessage,
  encodeRow,
  PROTOCOL_WIRE_VERSION,
  registrationDigest,
  type RowColumn,
  unitId,
} from '../../packages/core/src/index';
import {
  compileSchema,
  handleSyncRequest,
  MemorySegmentStore,
  type ServerSchema,
  SqliteServerStorage,
} from '../../packages/server/src/index-bun';

const { values } = parseArgs({
  options: {
    'latency-ms': { type: 'string', default: '250' },
    runs: { type: 'string', default: '3' },
  },
});
const latencyMs = Number(values['latency-ms']);
const runs = Number(values.runs);

const columns: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'body', type: 'string', nullable: false },
];
const schema: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'notes',
      columns,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};
const projects = ['p1', 'p2', 'p3', 'p4'];
const storage = new SqliteServerStorage();
await storage.ensureSchema(compileSchema(schema));
await storage.touchPartition('bench', Date.now(), 'epoch');
const tx = await storage.begin('bench');
for (const project of projects) {
  for (let i = 0; i < 4_000; i++) {
    const id = `${project}-${String(i).padStart(5, '0')}`;
    await tx.upsertRow('notes', {
      rowId: id,
      serverVersion: 1,
      scopes: { project_id: project },
      payload: encodeRow(columns, [id, project, 'b'.repeat(850)]),
    });
  }
}
await tx.commit();

/**
 * A memory store whose every put first waits `latencyMs`; a serial store
 * starts a put once the one before it completed.
 */
class SlowSegmentStore extends MemorySegmentStore {
  #last: Promise<unknown> = Promise.resolve();
  constructor(readonly serial: boolean) {
    super();
  }
  override async put(
    ...args: Parameters<MemorySegmentStore['put']>
  ): ReturnType<MemorySegmentStore['put']> {
    const before = this.serial ? this.#last : Promise.resolve();
    const put = before.then(async () => {
      await Bun.sleep(latencyMs);
      return super.put(...args);
    });
    this.#last = put;
    return put;
  }
}

const units = projects.map((project) => ({ project_id: project }));
const request = (clientId: string) =>
  encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [
      { type: 'REQ_HEADER', clientId, schemaVersion: 1, logEpoch: 'epoch' },
      {
        type: 'PULL_HEADER',
        limitCommits: 0,
        limitSnapshotRows: 0,
        maxSnapshotPages: 0,
        accept: 0b0011,
        cursor: -1,
        registrationDigest: registrationDigest(units),
        echoDigest: new Uint8Array(),
      },
      ...units.map((scopes) => ({ type: 'UNIT' as const, scopes })),
      ...units.map((scopes) => ({
        type: 'PROGRESS' as const,
        id: unitId(scopes),
        cursor: -1,
      })),
    ],
  });

for (const serial of [true, false]) {
  const times: number[] = [];
  let refs = 0;
  for (let run = 0; run < runs; run++) {
    // A fresh store per run: every put is a cold build.
    const segments = new SlowSegmentStore(serial);
    const started = performance.now();
    const response = decodeMessage(
      await handleSyncRequest(request(`client-${run}`), {
        partition: 'bench',
        actorId: 'bench-actor',
        schema,
        storage,
        segments,
        resolveScopes: () => ({ project_id: projects }),
      }),
    );
    times.push(performance.now() - started);
    refs = response.frames.filter(
      (frame) => frame.type === 'SEGMENT_REF',
    ).length;
  }
  const median = times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
  console.log(
    `${serial ? 1 : 6} puts in flight, refs=${refs} put latency=${latencyMs} ms: median ${median.toFixed(0)} ms (${times.map((t) => t.toFixed(0)).join(', ')})`,
  );
}
