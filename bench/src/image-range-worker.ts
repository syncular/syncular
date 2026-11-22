/**
 * Browser half of the image range lane: a module worker bootstraps through the
 * real `SyncClient` over HTTP into the production OPFS SAH-pool replica, and
 * reports the import time, the pull rounds, the image refs per table and the
 * final wasm heap size, per image apply its transactions and times, and the
 * VFS flush totals. Phase messages let the page tag its memory samples.
 */
import { decodeMessage } from '../../packages/core/src/index';
import { SyncClient } from '../../packages/web-client/src/client';
import { compileLocalProjections } from '../../packages/web-client/src/projection';
import {
  httpSegmentDownloader,
  httpSyncTransport,
} from '../../packages/web-client/src/http';
import type { SyncProgress } from '../../packages/web-client/src/progress';
import { openPersistentWasmDatabase } from '../../packages/web-client/src/wasm-database';
import { IMAGE_SCHEMA } from './image-import-fixture';

const scope = globalThis as typeof globalThis & {
  __sqlite3?: { wasm: { heap8u(): Uint8Array } };
  __vfs?: { syncMs: number; syncCalls: number };
  postMessage(message: unknown): void;
};

scope.onmessage = async (event: MessageEvent) => {
  try {
    const { maxSnapshotPages, variable, unitValues, unitScopes, fts } =
      event.data as {
        maxSnapshotPages?: number;
        variable: string;
        unitScopes?: string[];
        unitValues: string[];
        fts: boolean;
      };
    const schema = {
      ...IMAGE_SCHEMA,
      tables: IMAGE_SCHEMA.tables.map((table) => ({
        ...table,
        ...(unitScopes === undefined ? {} : { scopes: unitScopes }),
        ...(fts && table.name === 'codes'
          ? {
              localProjections: [
                {
                  name: 'codes_search',
                  generation: '1',
                  columns: [
                    {
                      name: 'title',
                      declaredType: 'string' as const,
                      source: 'title',
                    },
                    {
                      name: 'description',
                      declaredType: 'string' as const,
                      source: 'description',
                    },
                  ],
                  fts: {
                    tokenize: 'unicode61',
                    columns: ['title', 'description'],
                  },
                },
              ],
            }
          : {}),
      })),
    };
    const database = await openPersistentWasmDatabase('image-range-lane');
    let rounds = 0;
    // Timeline of the import: one entry per pull round, and the intervals of
    // segment downloads and of image applies inside it.
    const roundStarts: { at: number; httpMs: number }[] = [];
    const downloads: [number, number][] = [];
    const downloadMs = new Map<string, number>();
    // Per image apply: first import progress, last chunk commit, chunks, the
    // largest chunk, and the rows and write+commit time at the last chunk.
    const perImage = new Map<
      string,
      {
        table: string;
        first: number;
        last: number;
        chunks: number;
        maxChunkRows: number;
        rows: number;
        writeMs: number;
        commitMs: number;
      }
    >();
    let current: SyncProgress | undefined;
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
        downloadMs.set(request.segmentId, performance.now() - at);
      }
    };
    const client = new SyncClient({
      database,
      schema,
      createProjections: compileLocalProjections,
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
    client.onChange(() => {
      chunks++;
      const progress = current;
      if (progress?.segmentId === undefined) return;
      const image = perImage.get(progress.segmentId);
      if (image === undefined) return;
      image.last = performance.now();
      image.chunks++;
      image.maxChunkRows = Math.max(
        image.maxChunkRows,
        progress.rowsProcessed - image.rows,
      );
      image.rows = progress.rowsProcessed;
    });
    client.onProgress((progress) => {
      current = progress;
      if (progress.phase !== 'import' || progress.segmentId === undefined)
        return;
      const now = performance.now();
      if (!perImage.has(progress.segmentId))
        perImage.set(progress.segmentId, {
          table: progress.table ?? '',
          first: now,
          last: now,
          chunks: 0,
          maxChunkRows: 0,
          rows: progress.rowsProcessed,
          writeMs: 0,
          commitMs: 0,
        });
      const image = perImage.get(progress.segmentId)!;
      image.writeMs = progress.importWriteMs ?? 0;
      image.commitMs = progress.importCommitMs ?? 0;
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
    rounds = 0;
    chunks = 0;
    roundStarts.length = 0;
    downloads.length = 0;
    applies.clear();
    perImage.clear();
    downloadMs.clear();
    // A fixed amount of JavaScript work, to show the worker's CPU rate.
    let probe = performance.now();
    let sink = 0;
    for (let i = 0; i < 2e7; i++) sink = (sink + i * 7) % 1_000_003;
    probe = performance.now() - probe + (sink < 0 ? 1 : 0);
    const vfsBefore = { ...(scope.__vfs ?? { syncMs: 0, syncCalls: 0 }) };
    for (const table of Object.keys(images)) delete images[table];
    scope.postMessage({ t: 'phase', phase: 'import' });
    const started = performance.now();
    // A reader timer every 50 ms measures how long a local read waits for the
    // worker (its lag past the due time).
    const lags: number[] = [];
    let due = performance.now() + 50;
    const reader = setInterval(() => {
      lags.push(performance.now() - due);
      due = performance.now() + 50;
    }, 50);
    // The first unit loads alone, then the window widens to all of them.
    const base =
      variable === 'release_id'
        ? { variable, fixedScopes: { catalogue_set_id: 'set-1' } }
        : { variable };
    await client.setWindow(base, unitValues.slice(0, 1));
    await client.syncUntilIdle({ timeoutMs: Infinity });
    const firstUnitMs = Math.round(performance.now() - started);
    if (unitValues.length > 1) {
      await client.setWindow(base, unitValues);
      await client.syncUntilIdle({ timeoutMs: Infinity });
    }
    const importMs = performance.now() - started;
    clearInterval(reader);
    lags.sort((a, b) => a - b);
    const readLagMs = {
      p50: Math.round(lags[Math.floor(lags.length / 2)] ?? 0),
      p95: Math.round(lags[Math.floor(lags.length * 0.95)] ?? 0),
      max: Math.round(lags.at(-1) ?? 0),
    };
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
    const vfs = scope.__vfs ?? { syncMs: 0, syncCalls: 0 };
    scope.postMessage({
      t: 'done',
      value: {
        importMs,
        rounds,
        perRound,
        chunks,
        images,
        rows,
        firstUnitMs,
        readLagMs,
        cpuProbeMs: Math.round(probe),
        vfs: {
          syncCalls: vfs.syncCalls - vfsBefore.syncCalls,
          syncMs: Math.round(vfs.syncMs - vfsBefore.syncMs),
        },
        perImage: [...perImage].map(([segmentId, image]) => ({
          table: image.table,
          rows: image.rows,
          chunks: image.chunks,
          maxChunkRows: image.maxChunkRows,
          writeMs: image.writeMs,
          commitMs: image.commitMs,
          wallMs: Math.round(image.last - image.first),
          outsideMs: Math.round(
            image.last - image.first - image.writeMs - image.commitMs,
          ),
          downloadMs: Math.round(downloadMs.get(segmentId) ?? 0),
        })),
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
