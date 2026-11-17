/**
 * Browser half of the image range lane: a module worker bootstraps through the
 * real `SyncClient` over HTTP into the production OPFS SAH-pool replica, and
 * reports the import time, the pull rounds, the image refs per table and the
 * final wasm heap size. Phase messages let the page tag its memory samples.
 */
import { decodeMessage } from '../../packages/core/src/index';
import { SyncClient } from '../../packages/web-client/src/client';
import {
  httpSegmentDownloader,
  httpSyncTransport,
} from '../../packages/web-client/src/http';
import { openPersistentWasmDatabase } from '../../packages/web-client/src/wasm-database';
import { IMAGE_SCHEMA } from './image-import-fixture';

const scope = globalThis as typeof globalThis & {
  __sqlite3?: { wasm: { heap8u(): Uint8Array } };
  postMessage(message: unknown): void;
};

scope.onmessage = async (event: MessageEvent) => {
  try {
    const { maxSnapshotPages } = event.data as { maxSnapshotPages?: number };
    const database = await openPersistentWasmDatabase('image-range-lane');
    let rounds = 0;
    // Timeline of the import: one entry per pull round, and the intervals of
    // segment downloads and of image applies inside it.
    const roundStarts: { at: number; httpMs: number }[] = [];
    const downloads: [number, number][] = [];
    const applies = new Map<string, [number, number, number]>();
    let chunks = 0;
    const images: Record<string, number> = {};
    const http = httpSyncTransport('/sync');
    const fetchSegment = httpSegmentDownloader('/segments');
    // The lane serves direct downloads only (no signed URLs).
    const timedDownloads = async (
      request: Parameters<typeof fetchSegment>[0],
    ) => {
      const at = performance.now();
      try {
        return await fetchSegment(request);
      } finally {
        downloads.push([at, performance.now()]);
      }
    };
    const client = new SyncClient({
      database,
      schema: IMAGE_SCHEMA,
      transport: async (request, signal) => {
        const at = performance.now();
        const response = await http(request, signal);
        roundStarts.push({ at, httpMs: performance.now() - at });
        rounds++;
        const message = decodeMessage(response);
        if (message.msgKind === 'response')
          for (const frame of message.frames)
            if (frame.type === 'SEGMENT_REF')
              images[frame.table] = (images[frame.table] ?? 0) + 1;
        return response;
      },
      segments: timedDownloads,
      ...(maxSnapshotPages === undefined
        ? {}
        : { limits: { maxSnapshotPages } }),
    });
    client.onChange(() => chunks++);
    client.onProgress((progress) => {
      if (progress.phase !== 'import' || progress.segmentId === undefined)
        return;
      const now = performance.now();
      const apply = applies.get(progress.segmentId);
      const spent =
        (progress.importWriteMs ?? 0) + (progress.importCommitMs ?? 0);
      if (apply === undefined)
        applies.set(progress.segmentId, [now, now, spent]);
      else {
        apply[1] = now;
        apply[2] = spent;
      }
    });
    await client.start();
    // The first contact adopts the server log epoch (§3.8); the window and the import follow.
    await client.sync();
    await client.setWindow({ variable: 'catalogue_set_id' }, ['set-1']);
    rounds = 0;
    chunks = 0;
    roundStarts.length = 0;
    downloads.length = 0;
    applies.clear();
    for (const table of Object.keys(images)) delete images[table];
    scope.postMessage({ t: 'phase', phase: 'import' });
    const started = performance.now();
    await client.syncUntilIdle({ timeoutMs: Infinity });
    const importMs = performance.now() - started;
    const finished = performance.now();
    scope.postMessage({ t: 'phase', phase: 'idle' });
    // Per round: wall time, the /sync request, the image applies that began in
    // it (sum of write and commit time of their chunks) and the time a segment
    // download ran while no image was applying (sampled every 0.5 ms).
    const within = (spans: readonly (readonly number[])[], at: number) =>
      spans.some(([from, to]) => from! <= at && at < to!);
    const perRound = roundStarts.map(({ at, httpMs }, index) => {
      const end = roundStarts[index + 1]?.at ?? finished;
      const mine = [...applies.values()].filter(
        ([from]) => from >= at && from < end,
      );
      let waiting = 0;
      for (let t = at; t < end; t += 0.5)
        if (within(downloads, t) && !within([...applies.values()], t))
          waiting += 0.5;
      return {
        wallMs: Math.round(end - at),
        httpMs: Math.round(httpMs),
        applyMs: Math.round(mine.reduce((sum, [, , spent]) => sum + spent, 0)),
        downloadWaitMs: Math.round(waiting),
      };
    });
    const rows = Object.fromEntries(
      IMAGE_SCHEMA.tables.map(({ name }) => [
        name,
        Number(client.query(`SELECT count(*) AS n FROM ${name}`)[0]?.n),
      ]),
    );
    await client.close();
    scope.postMessage({
      t: 'done',
      value: {
        importMs,
        rounds,
        perRound,
        chunks,
        images,
        rows,
        wasmHeapBytes: scope.__sqlite3!.wasm.heap8u().byteLength,
      },
    });
  } catch (error) {
    scope.postMessage({
      t: 'error',
      message:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
};
