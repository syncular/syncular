import {
  MessageStreamScanner,
  REALTIME_TAG_DELTA,
  REALTIME_TAG_ROUND,
} from '@syncular/core';
import { handleSegmentDownload, handleSyncRequest } from '@syncular/server';
import { ACTOR_ID, PROJECT_ID, SCHEMA } from './fixture';
import type { BenchServer } from './loopback';
import { processObject } from './process-driver';
import { withinDeadline } from './instrumentation';

/** Private Rust client and actual async server in one process, on separate threads. */
export async function createEngineDriver(
  library: string,
  server: BenchServer,
  dbPath?: string,
  clientId = crypto.randomUUID(),
) {
  const shared = new SharedArrayBuffer(16 + 32 * 1024 * 1024);
  const control = new Int32Array(shared, 0, 4);
  const response = new Uint8Array(shared, 16);
  const worker = new Worker(
    new URL('./engine-worker.ts', import.meta.url).href,
  );
  const waiting = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  const ready = Promise.withResolvers<void>();
  const readiness = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  // Attach the failure handler now, including failures during startup.
  void closed.promise.catch(() => {});
  let session: Awaited<ReturnType<BenchServer['hub']['connect']>> | undefined;
  let round:
    | { scanner: MessageStreamScanner; bytes: number; message?: Uint8Array }
    | undefined;
  const inbound: Uint8Array[] = [];
  let inboundBytes = 0;
  let wake: (() => void) | undefined;
  let fatal: Error | undefined;
  let sequence = 0;
  let hostSequence = 0;
  let closing: Promise<void> | undefined;
  const delivery = {
    hostCalls: 0,
    hostRequestBytes: 0,
    hostResponseBytes: 0,
    hostElapsedMs: 0,
    commandCalls: 0,
  };
  const disconnect = () => {
    session?.close();
    session = undefined;
    inbound.length = 0;
    inboundBytes = 0;
    wake?.();
  };
  const dispatch = async (
    method: number,
    bytes: Uint8Array,
  ): Promise<Uint8Array> => {
    if (method === 7) {
      disconnect();
      return new Uint8Array();
    }
    if (closing) throw new Error('Engine client is closing');
    if (fatal) throw fatal;
    switch (method) {
      case 1:
        return handleSyncRequest(bytes, server.ctx);
      case 2: {
        if (!session || round)
          throw new Error('Engine round requires an idle realtime session');
        const current: {
          scanner: MessageStreamScanner;
          bytes: number;
          message?: Uint8Array;
        } = {
          scanner: new MessageStreamScanner(),
          bytes: 0,
        };
        round = current;
        const framed = new Uint8Array(bytes.length + 1);
        framed[0] = REALTIME_TAG_ROUND;
        framed.set(bytes, 1);
        try {
          await session.handleBinary(framed);
          if (fatal) throw fatal;
          if (!current.message)
            throw new Error('Engine realtime response did not reach END');
          return current.message;
        } finally {
          round = undefined;
        }
      }
      case 3: {
        const request = processObject(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
        if (
          typeof request.segmentId !== 'string' ||
          typeof request.requestedScopesJson !== 'string'
        )
          throw new Error('Invalid engine segment request');
        return (
          await handleSegmentDownload(server.ctx, {
            segmentId: request.segmentId,
            scopesHeader: request.requestedScopesJson,
          })
        ).bytes;
      }
      case 4: {
        if (session)
          throw new Error('Engine realtime session is already connected');
        const identity = new TextDecoder('utf-8', { fatal: true }).decode(
          bytes,
        );
        if (identity !== clientId)
          throw new Error('Engine client identity mismatch');
        session = await server.hub.connect({
          partition: server.ctx.partition,
          actorId: ACTOR_ID,
          clientId,
          closeSocket: () => {
            fatal = new Error(
              'Engine realtime session was closed by the server',
            );
            wake?.();
          },
          send: (data) => {
            if (typeof data !== 'string' && data[0] === REALTIME_TAG_ROUND) {
              if (!round)
                throw new Error(
                  'Engine received an unsolicited round response',
                );
              round.bytes += data.length - 1;
              if (round.bytes > response.length)
                throw new Error('Engine round response exceeds capacity');
              const scanned = round.scanner.push(data.subarray(1));
              if (scanned) {
                if (scanned.excess)
                  throw new Error('Engine response contains bytes past END');
                round.message = scanned.message;
              }
              return;
            }
            if (typeof data !== 'string' && data[0] !== REALTIME_TAG_DELTA)
              return;
            const payload =
              typeof data === 'string'
                ? new TextEncoder().encode(data)
                : data.subarray(1);
            const frame = new Uint8Array(5 + payload.length);
            frame[0] = typeof data === 'string' ? 1 : 0;
            new DataView(frame.buffer).setUint32(1, payload.length, true);
            frame.set(payload, 5);
            if (inboundBytes + frame.length > response.length) {
              fatal = new Error('Engine inbound queue exceeds capacity');
              wake?.();
              throw fatal;
            }
            inbound.push(frame);
            inboundBytes += frame.length;
            wake?.();
          },
        });
        if (closing) {
          disconnect();
          throw new Error('Engine client is closing');
        }
        return new Uint8Array();
      }
      case 5:
        if (!session)
          throw new Error('Engine control requires a realtime session');
        session.handleMessage(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
        return new Uint8Array();
      case 6: {
        const result = new Uint8Array(inboundBytes);
        let offset = 0;
        for (const frame of inbound) {
          result.set(frame, offset);
          offset += frame.length;
        }
        inbound.length = 0;
        inboundBytes = 0;
        return result;
      }
      case 8:
        if (bytes.length !== 4 || wake)
          throw new Error('Invalid engine readiness request');
        if (!session)
          throw new Error('Engine readiness requires a realtime session');
        if (inbound.length === 0) {
          const pending = Promise.withResolvers<void>();
          wake = () => pending.resolve();
          readiness.resolve();
          try {
            await withinDeadline(
              pending.promise,
              'engine readiness',
              new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(
                0,
                true,
              ),
            );
          } finally {
            wake = undefined;
          }
        }
        if (fatal) throw fatal;
        if (!session) throw new Error('Engine readiness was cancelled');
        return new Uint8Array();
      default:
        throw new Error('Unknown engine host method');
    }
  };
  worker.onerror = (event) => {
    const error = new Error(event.message);
    fatal = error;
    ready.reject(error);
    closed.reject(error);
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
    disconnect();
  };
  worker.onmessage = async ({ data }: MessageEvent<unknown>) => {
    const message = processObject(data);
    if (message.ready === true) {
      ready.resolve();
      return;
    }
    if ('closed' in message) {
      if (message.closed === 1) closed.resolve();
      else closed.reject(new Error('Engine native shutdown failed'));
      return;
    }
    if (typeof message.host === 'number') {
      const started = performance.now();
      let bytes: Uint8Array;
      let failed = false;
      try {
        if (
          message.host !== ++hostSequence ||
          typeof message.method !== 'number' ||
          !(message.bytes instanceof Uint8Array)
        )
          throw new Error('Invalid engine host request');
        delivery.hostCalls++;
        delivery.hostRequestBytes += message.bytes.length;
        bytes = await dispatch(message.method, message.bytes);
        if (bytes.length > response.length)
          throw new Error('Engine response exceeds capacity');
      } catch (error) {
        failed = true;
        bytes = new TextEncoder().encode(
          JSON.stringify({
            code: 'bench.host_failed',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        if (bytes.length > response.length)
          bytes = new TextEncoder().encode(
            '{"code":"bench.host_failed","message":"Engine error exceeds capacity"}',
          );
      }
      delivery.hostElapsedMs += performance.now() - started;
      delivery.hostResponseBytes += bytes.length;
      response.set(bytes);
      Atomics.store(control, 1, failed ? -(bytes.length + 1) : bytes.length);
      Atomics.store(control, 0, message.host);
      Atomics.notify(control, 0);
      return;
    }
    if (typeof message.id !== 'number')
      throw new Error('Engine response has no command identity');
    const pending = waiting.get(message.id);
    if (!pending) throw new Error('Engine response identity mismatch');
    waiting.delete(message.id);
    const envelope = processObject(message.envelope);
    if ('error' in envelope)
      pending.reject(
        new Error(`Engine command failed: ${JSON.stringify(envelope.error)}`),
      );
    else if ('result' in envelope) pending.resolve(envelope.result);
    else pending.reject(new Error('Engine response has no result'));
  };
  const invoke = (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> => {
    if (closing || fatal)
      return Promise.reject(fatal ?? new Error('Engine client is closed'));
    const id = ++sequence;
    delivery.commandCalls++;
    const pending = Promise.withResolvers<unknown>();
    waiting.set(id, pending);
    worker.postMessage({ id, method, params });
    return pending.promise;
  };
  const close = () =>
    (closing ??= (async () => {
      // Wake an active read before queuing close on the owning worker. Never
      // terminate the worker or unload the library while Rust is executing.
      disconnect();
      worker.postMessage({ close: true });
      await closed.promise;
    })());
  worker.postMessage({ shared, library });
  try {
    await ready.promise;
    await invoke('create', {
      schema: {
        ...SCHEMA,
        tables: SCHEMA.tables.map((table) => ({
          ...table,
          scopes: table.scopes.map((scope) =>
            typeof scope === 'string' ? { pattern: scope } : scope,
          ),
        })),
      },
      clientId,
      ...(dbPath ? { dbPath } : {}),
    });
    await invoke('subscribe', {
      id: 'bench',
      table: 'tasks',
      scopes: { project_id: [PROJECT_ID] },
    });
    const info = processObject(await invoke('benchEngineInfo'));
    if (info.processId !== process.pid || typeof info.threadId !== 'string')
      throw new Error('Rust engine is not in the host process');
    return {
      invoke,
      close,
      clientId,
      info,
      hostReadiness: readiness.promise,
      deliveryStats: () => ({ ...delivery }),
    };
  } catch (error) {
    if (!fatal) await close();
    throw error;
  }
}
