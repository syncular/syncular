/**
 * Rust ClientDriver: spawns the `conformance-shim` binary (the Rust client
 * core on rusqlite, `v2/rust/crates/client`) — one subprocess per
 * `ClientInstance` — and bridges the driver interface over stdio as JSON
 * lines, one request per line, one response per line. Bytes travel as
 * `{ "$bytes": "<lowercase hex>" }`.
 *
 * Transport inversion: the harness owns the sync/downloadSegment/realtime
 * endpoints, so the shim ASKS this bridge for transport (a JSON-line
 * request flowing the other way on the same stdio channel, with its own
 * id space `t<n>`), and realtime traffic flows shim-ward as notifications
 * (no id). Request ids are direction-local, so nested callbacks work.
 *
 * Binary resolution: `SYNCULAR_RUST_CLIENT_BIN` env var, else
 * `v2/rust/target/{debug,release}/conformance-shim`. `ensureRustShim`
 * builds it via cargo when asked to.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  MessageStreamScanner,
  REALTIME_TAG_DELTA,
  REALTIME_TAG_ROUND,
} from '@syncular-v2/core';
import type {
  ClientConflict,
  ClientCreateOptions,
  ClientDriver,
  ClientEndpoints,
  ClientInstance,
  ClientMutation,
  ClientPresencePeer,
  ClientRejection,
  ClientRowState,
  ClientSubscriptionState,
  ClientSyncReport,
  ClientSyncResult,
  CodecDriver,
  CodecRoundtrip,
  DriverSchema,
  JsonValue,
} from '../driver';
import { bytesToHex, hexToBytes } from '../raw';

const RUST_DIR = join(import.meta.dir, '..', '..', '..', '..', 'rust');

/** Resolve the shim binary path (env override, then debug, then release). */
export function rustShimBinaryPath(): string | undefined {
  const fromEnv = process.env.SYNCULAR_RUST_CLIENT_BIN;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return existsSync(fromEnv) ? fromEnv : undefined;
  }
  for (const profile of ['debug', 'release']) {
    const candidate = join(RUST_DIR, 'target', profile, 'conformance-shim');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Ensure the shim binary exists; with `build: true`, run
 * `cargo build -p conformance-shim` in `v2/rust` first (one-time cost,
 * gated behind SYNCULAR_RUST_CONFORMANCE=1 in the test wiring).
 */
export function ensureRustShim(options?: { build?: boolean }): string {
  const existing = rustShimBinaryPath();
  if (existing !== undefined) return existing;
  if (options?.build !== true) {
    throw new Error(
      'conformance-shim binary not found — build it with ' +
        '`cargo build -p conformance-shim` in v2/rust or set ' +
        'SYNCULAR_RUST_CLIENT_BIN',
    );
  }
  const result = Bun.spawnSync({
    cmd: ['cargo', 'build', '-p', 'conformance-shim'],
    cwd: RUST_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) {
    throw new Error('cargo build -p conformance-shim failed');
  }
  const built = rustShimBinaryPath();
  if (built === undefined) {
    throw new Error('cargo build succeeded but the shim binary is missing');
  }
  return built;
}

// ---------------------------------------------------------------------------
// JSON-lines protocol plumbing
// ---------------------------------------------------------------------------

interface ShimError {
  readonly code?: string;
  readonly message?: string;
}

interface ShimMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, JsonValue>;
  readonly result?: JsonValue;
  readonly error?: ShimError;
}

const TRACE = process.env.SYNCULAR_SHIM_TRACE === '1';

function errorCodeOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'transport.failed';
}

function bytesParam(bytes: Uint8Array): JsonValue {
  return { $bytes: bytesToHex(bytes) };
}

function bytesOf(value: JsonValue | undefined, what: string): Uint8Array {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof value.$bytes !== 'string'
  ) {
    throw new Error(`${what}: expected a {"$bytes": hex} value`);
  }
  return hexToBytes(value.$bytes);
}

class ShimProcess {
  readonly #proc: ReturnType<typeof Bun.spawn>;
  readonly #pending = new Map<
    number,
    { resolve: (value: JsonValue) => void; reject: (error: Error) => void }
  >();
  readonly #endpoints: ClientEndpoints | undefined;
  #connection:
    | Awaited<ReturnType<ClientEndpoints['connectRealtime']>>
    | undefined;
  /** §8.7 socket round in flight on the shim's behalf: the host owns
   * the WS-binding seam for the native core (tagging, chunk assembly),
   * mirroring what a native app shell does at its socket layer. */
  #round:
    | {
        readonly scanner: MessageStreamScanner;
        readonly resolve: (bytes: Uint8Array) => void;
        readonly reject: (error: Error) => void;
      }
    | undefined;
  #nextId = 1;
  #buffer = '';
  #closed = false;

  constructor(binaryPath: string, endpoints?: ClientEndpoints) {
    this.#endpoints = endpoints;
    this.#proc = Bun.spawn({
      cmd: [binaryPath],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    });
    void this.#readLoop();
  }

  async #readLoop(): Promise<void> {
    const stdout = this.#proc.stdout;
    if (!(stdout instanceof ReadableStream)) {
      throw new Error('shim stdout is not piped');
    }
    const decoder = new TextDecoder();
    for await (const chunk of stdout as unknown as AsyncIterable<Uint8Array>) {
      this.#buffer += decoder.decode(chunk, { stream: true });
      let index = this.#buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        if (line.length > 0) this.#handleLine(line);
        index = this.#buffer.indexOf('\n');
      }
    }
    this.#closed = true;
    for (const [, entry] of this.#pending) {
      entry.reject(new Error('shim process closed its stdout'));
    }
    this.#pending.clear();
  }

  #handleLine(line: string): void {
    if (TRACE) console.error(`shim→host ${line}`);
    let message: ShimMessage;
    try {
      message = JSON.parse(line) as ShimMessage;
    } catch {
      return; // tolerate garbled lines
    }
    if (typeof message.method === 'string') {
      // A shim → host transport request (the inversion): answer it.
      void this.#handleShimRequest(
        message.id,
        message.method,
        message.params ?? {},
      );
      return;
    }
    if (typeof message.id === 'number') {
      const entry = this.#pending.get(message.id);
      if (entry === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        const error = new Error(message.error.message ?? 'shim error');
        if (message.error.code !== undefined) {
          (error as { code?: string }).code = message.error.code;
        }
        entry.reject(error);
      } else {
        entry.resolve(message.result ?? null);
      }
    }
  }

  async #handleShimRequest(
    id: number | string | undefined,
    method: string,
    params: Record<string, JsonValue>,
  ): Promise<void> {
    try {
      const result = await this.#dispatchEndpoint(method, params);
      this.#write({ id, result });
    } catch (error) {
      this.#write({
        id,
        error: {
          code: errorCodeOf(error),
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async #dispatchEndpoint(
    method: string,
    params: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const endpoints = this.#endpoints;
    if (endpoints === undefined) {
      throw new Error(`no endpoints wired for shim request ${method}`);
    }
    switch (method) {
      case 'sync': {
        const request = bytesOf(params.request, 'sync.request');
        const response = await endpoints.sync(request);
        return { response: bytesParam(response) };
      }
      case 'downloadSegment': {
        const segmentId = params.segmentId;
        const table = params.table;
        const requestedScopesJson = params.requestedScopesJson;
        if (
          typeof segmentId !== 'string' ||
          typeof table !== 'string' ||
          typeof requestedScopesJson !== 'string'
        ) {
          throw new Error('downloadSegment: malformed request');
        }
        const bytes = await endpoints.downloadSegment({
          segmentId,
          table,
          requestedScopesJson,
        });
        return { bytes: bytesParam(bytes) };
      }
      case 'fetchUrl': {
        // §5.4: the URL is the entire grant — nothing else crosses.
        const url = params.url;
        if (typeof url !== 'string') {
          throw new Error('fetchUrl: missing url');
        }
        const fetchSegmentUrl = endpoints.fetchSegmentUrl;
        if (fetchSegmentUrl === undefined) {
          throw new Error('fetchUrl: endpoints have no URL host');
        }
        const bytes = await fetchSegmentUrl(url);
        return { bytes: bytesParam(bytes) };
      }
      case 'blobUpload': {
        const blobId = params.blobId;
        if (typeof blobId !== 'string') {
          throw new Error('blobUpload: missing blobId');
        }
        const bytes = bytesOf(params.bytes, 'blobUpload.bytes');
        const mediaType =
          typeof params.mediaType === 'string' ? params.mediaType : undefined;
        const upload = endpoints.uploadBlob;
        if (upload === undefined) {
          throw new Error('blobUpload: endpoints have no blob upload');
        }
        await upload(blobId, bytes, mediaType);
        return {};
      }
      case 'blobDownload': {
        const blobId = params.blobId;
        if (typeof blobId !== 'string') {
          throw new Error('blobDownload: missing blobId');
        }
        const download = endpoints.downloadBlob;
        if (download === undefined) {
          throw new Error('blobDownload: endpoints have no blob download');
        }
        const bytes = await download(blobId);
        return { bytes: bytesParam(bytes) };
      }
      case 'realtimeConnect': {
        this.#connection = await endpoints.connectRealtime({
          onText: (text) => this.#notify('realtimeText', { text }),
          onBinary: (bytes) => this.#routeBinary(bytes),
          onClose: () => this.#failRound('realtime socket closed (§8.7)'),
        });
        return {};
      }
      case 'realtimeSync': {
        // §8.7 socket round for the native core: send the tagged
        // request, assemble the tagged response stream to its END.
        const request = bytesOf(params.request, 'realtimeSync.request');
        const response = await this.#realtimeRound(request);
        return { response: bytesParam(response) };
      }
      case 'realtimeSend': {
        const text = params.text;
        if (typeof text !== 'string') {
          throw new Error('realtimeSend: missing text');
        }
        this.#connection?.send(text);
        return {};
      }
      case 'realtimeClose': {
        this.#connection?.close();
        this.#connection = undefined;
        this.#failRound('realtime disconnected mid-round (§8.7)');
        return {};
      }
      default:
        throw new Error(`unknown shim request method ${method}`);
    }
  }

  /** §8.7 channel-tag routing: round chunks feed the in-flight round's
   * assembler; standalone deltas flow shim-ward untagged (the native
   * core consumes bare SSP2 messages behind its transport seam). */
  #routeBinary(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const tag = bytes[0];
    const body = bytes.subarray(1);
    if (tag === REALTIME_TAG_ROUND) {
      const round = this.#round;
      if (round === undefined) return;
      let done: ReturnType<MessageStreamScanner['push']>;
      try {
        done = round.scanner.push(body);
      } catch (error) {
        this.#round = undefined;
        round.reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (done === undefined) return;
      this.#round = undefined;
      if (done.excess > 0) {
        round.reject(new Error('response bytes past END (§8.7)'));
        return;
      }
      round.resolve(done.message.slice());
      return;
    }
    if (tag === REALTIME_TAG_DELTA) {
      this.#notify('realtimeBinary', { bytes: bytesParam(body) });
    }
    // Unknown tag: tolerated and ignored (§8.7 closed registry).
  }

  #realtimeRound(request: Uint8Array): Promise<Uint8Array> {
    const connection = this.#connection;
    if (connection === undefined) {
      throw new Error('realtimeSync without a realtime connection');
    }
    return new Promise((resolve, reject) => {
      this.#round = { scanner: new MessageStreamScanner(), resolve, reject };
      const tagged = new Uint8Array(request.length + 1);
      tagged[0] = REALTIME_TAG_ROUND;
      tagged.set(request, 1);
      connection.sendBinary(tagged);
    });
  }

  #failRound(reason: string): void {
    const round = this.#round;
    if (round === undefined) return;
    this.#round = undefined;
    const error = new Error(reason);
    (error as { code?: string }).code = 'sync.transport_failed';
    round.reject(error);
  }

  #notify(method: string, params: Record<string, JsonValue>): void {
    this.#write({ method, params });
  }

  #write(value: unknown): void {
    if (this.#closed) return;
    if (TRACE) console.error(`host→shim ${JSON.stringify(value)}`);
    const stdin = this.#proc.stdin;
    if (typeof stdin === 'object' && stdin !== null && 'write' in stdin) {
      stdin.write(`${JSON.stringify(value)}\n`);
      stdin.flush();
    }
  }

  call(method: string, params: Record<string, JsonValue>): Promise<JsonValue> {
    const id = this.#nextId;
    this.#nextId += 1;
    const promise = new Promise<JsonValue>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#write({ id, method, params });
    return promise;
  }

  async close(): Promise<void> {
    try {
      await this.call('close', {});
    } catch {
      // the shim may already be gone
    }
    const stdin = this.#proc.stdin;
    if (typeof stdin === 'object' && stdin !== null && 'end' in stdin) {
      stdin.end();
    }
    await this.#proc.exited;
  }
}

// ---------------------------------------------------------------------------
// ClientDriver
// ---------------------------------------------------------------------------

function asObject(value: JsonValue, what: string): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what}: expected an object result`);
  }
  return value;
}

class RustClientInstance implements ClientInstance {
  readonly #shim: ShimProcess;

  constructor(shim: ShimProcess) {
    this.#shim = shim;
  }

  async subscribe(input: {
    readonly id: string;
    readonly table: string;
    readonly scopes: Readonly<Record<string, readonly string[]>>;
    readonly params?: string;
  }): Promise<void> {
    await this.#shim.call('subscribe', {
      id: input.id,
      table: input.table,
      scopes: input.scopes as unknown as JsonValue,
      ...(input.params !== undefined ? { params: input.params } : {}),
    });
  }

  async unsubscribe(id: string): Promise<void> {
    await this.#shim.call('unsubscribe', { id });
  }

  async mutate(mutations: readonly ClientMutation[]): Promise<string> {
    const wire = mutations.map((mutation) =>
      mutation.op === 'upsert'
        ? {
            op: 'upsert',
            table: mutation.table,
            values: mutation.values,
            ...(mutation.baseVersion !== undefined
              ? { baseVersion: mutation.baseVersion }
              : {}),
          }
        : {
            op: 'delete',
            table: mutation.table,
            rowId: mutation.rowId,
            ...(mutation.baseVersion !== undefined
              ? { baseVersion: mutation.baseVersion }
              : {}),
          },
    );
    const result = asObject(
      await this.#shim.call('mutate', { mutations: wire as JsonValue }),
      'mutate',
    );
    if (typeof result.clientCommitId !== 'string') {
      throw new Error('mutate: shim returned no clientCommitId');
    }
    return result.clientCommitId;
  }

  async sync(): Promise<ClientSyncResult> {
    return (await this.#shim.call('sync', {})) as unknown as ClientSyncResult;
  }

  async syncUntilIdle(maxRounds?: number): Promise<ClientSyncResult> {
    const result = await this.#shim.call('syncUntilIdle', {
      ...(maxRounds !== undefined ? { maxRounds } : {}),
    });
    return result as unknown as ClientSyncResult;
  }

  async readRows(table: string): Promise<ClientRowState[]> {
    const result = asObject(
      await this.#shim.call('readRows', { table }),
      'readRows',
    );
    return (result.rows ?? []) as unknown as ClientRowState[];
  }

  async conflicts(): Promise<ClientConflict[]> {
    const result = asObject(
      await this.#shim.call('conflicts', {}),
      'conflicts',
    );
    return (result.conflicts ?? []) as unknown as ClientConflict[];
  }

  async rejections(): Promise<ClientRejection[]> {
    const result = asObject(
      await this.#shim.call('rejections', {}),
      'rejections',
    );
    return (result.rejections ?? []) as unknown as ClientRejection[];
  }

  async pendingCommitIds(): Promise<string[]> {
    const result = asObject(
      await this.#shim.call('pendingCommitIds', {}),
      'pendingCommitIds',
    );
    return (result.ids ?? []) as unknown as string[];
  }

  async subscriptionState(
    id: string,
  ): Promise<ClientSubscriptionState | undefined> {
    const result = asObject(
      await this.#shim.call('subscriptionState', { id }),
      'subscriptionState',
    );
    if (result.state === null || result.state === undefined) return undefined;
    return result.state as unknown as ClientSubscriptionState;
  }

  async schemaFloor(): Promise<ClientSyncReport['schemaFloor'] | undefined> {
    const result = asObject(
      await this.#shim.call('schemaFloor', {}),
      'schemaFloor',
    );
    if (result.floor === null || result.floor === undefined) return undefined;
    return result.floor as unknown as ClientSyncReport['schemaFloor'];
  }

  async leaseState(): Promise<
    | {
        readonly leaseId?: string;
        readonly expiresAtMs?: number;
        readonly errorCode?: string;
      }
    | undefined
  > {
    const result = asObject(
      await this.#shim.call('leaseState', {}),
      'leaseState',
    );
    if (result.lease === null || result.lease === undefined) return undefined;
    return result.lease as unknown as {
      readonly leaseId?: string;
      readonly expiresAtMs?: number;
      readonly errorCode?: string;
    };
  }

  async connectRealtime(): Promise<void> {
    await this.#shim.call('connectRealtime', {});
  }

  async disconnectRealtime(): Promise<void> {
    await this.#shim.call('disconnectRealtime', {});
  }

  async syncNeeded(): Promise<boolean> {
    const result = asObject(
      await this.#shim.call('syncNeeded', {}),
      'syncNeeded',
    );
    return result.value === true;
  }

  async setPresence(
    scopeKey: string,
    doc: Record<string, unknown> | null,
  ): Promise<void> {
    await this.#shim.call('setPresence', {
      scopeKey,
      doc: (doc ?? null) as JsonValue,
    });
  }

  async presence(scopeKey: string): Promise<readonly ClientPresencePeer[]> {
    const result = asObject(
      await this.#shim.call('presence', { scopeKey }),
      'presence',
    );
    const peers = Array.isArray(result.peers) ? result.peers : [];
    return peers as unknown as ClientPresencePeer[];
  }

  async upgrading(): Promise<boolean> {
    const result = asObject(
      await this.#shim.call('upgrading', {}),
      'upgrading',
    );
    return result.value === true;
  }

  /**
   * §7.4.2 "app ships new code": swap the shim's core to a new schema on the
   * SAME in-memory DB (identity, outbox, tables preserved). The §7.4.1
   * marker check drives the wipe/re-bootstrap. Returns `this` — the shim
   * process (and its DB) is unchanged.
   */
  async recreateWithSchema(schema: DriverSchema): Promise<ClientInstance> {
    await this.#shim.call('recreateWithSchema', {
      schema: schema as unknown as JsonValue,
    });
    return this;
  }

  async uploadBlob(
    bytes: Uint8Array,
    options?: { readonly mediaType?: string; readonly name?: string },
  ): Promise<string> {
    const result = asObject(
      await this.#shim.call('uploadBlob', {
        bytes: { $bytes: bytesToHex(bytes) },
        ...(options?.mediaType !== undefined
          ? { mediaType: options.mediaType }
          : {}),
        ...(options?.name !== undefined ? { name: options.name } : {}),
      }),
      'uploadBlob',
    );
    const ref = result.ref as Record<string, JsonValue> | undefined;
    if (
      ref === undefined ||
      ref.blobId === undefined ||
      ref.byteLength === undefined
    ) {
      throw new Error('uploadBlob: shim returned no ref');
    }
    // Canonical BlobRef string (§5.9.1 key order): blobId, byteLength,
    // mediaType?, name?.
    const obj: Record<string, JsonValue> = {
      blobId: ref.blobId,
      byteLength: ref.byteLength,
    };
    if (ref.mediaType !== undefined) obj.mediaType = ref.mediaType;
    if (ref.name !== undefined) obj.name = ref.name;
    return JSON.stringify(obj);
  }

  async fetchBlob(blobIdOrRef: string): Promise<{ $bytes: string }> {
    const result = asObject(
      await this.#shim.call('fetchBlob', { blob: blobIdOrRef }),
      'fetchBlob',
    );
    const blob = result.blob as Record<string, JsonValue> | undefined;
    const bytes = blob?.bytes as { $bytes?: string } | undefined;
    if (bytes?.$bytes === undefined) {
      throw new Error('fetchBlob: shim returned no bytes');
    }
    return { $bytes: bytes.$bytes };
  }

  async close(): Promise<void> {
    await this.#shim.close();
  }
}

/** Rust client core (rusqlite) behind the stdio shim. */
export const rustClientDriver: ClientDriver = {
  name: 'rust-client(rusqlite)',
  async create(options: ClientCreateOptions): Promise<ClientInstance> {
    const binary = ensureRustShim();
    const shim = new ShimProcess(binary, options.endpoints);
    await shim.call('create', {
      clientId: options.clientId,
      schema: options.schema as unknown as JsonValue,
      ...(options.limits !== undefined
        ? { limits: options.limits as unknown as JsonValue }
        : {}),
      // §5.4: bit-3 capability of the harness endpoint set + the pinned
      // client clock for the urlExpiresAtMs check.
      signedUrls: options.endpoints.fetchSegmentUrl !== undefined,
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    });
    return new RustClientInstance(shim);
  },
};

// ---------------------------------------------------------------------------
// CodecDriver — the ssp2 codec through the same shim (Appendix A)
// ---------------------------------------------------------------------------

let codecShim: ShimProcess | undefined;

function codecProcess(): ShimProcess {
  if (codecShim === undefined) {
    codecShim = new ShimProcess(ensureRustShim());
  }
  return codecShim;
}

async function roundtrip(
  method: 'messageRoundtrip' | 'segmentRoundtrip',
  bytes: Uint8Array,
): Promise<CodecRoundtrip> {
  const result = asObject(
    await codecProcess().call(method, { bytes: bytesParam(bytes) }),
    method,
  );
  if (result.ok !== true) {
    return {
      ok: false,
      errorCode:
        typeof result.errorCode === 'string'
          ? result.errorCode
          : 'sync.invalid_request',
    };
  }
  if (typeof result.renderedJson !== 'string') {
    throw new Error(`${method}: shim returned no renderedJson`);
  }
  return {
    ok: true,
    bytes: bytesOf(result.bytes, method),
    renderedJson: result.renderedJson,
  };
}

/** Rust ssp2 codec behind the stdio shim. */
export const rustCodecDriver: CodecDriver = {
  name: 'rust-ssp2',
  async messageRoundtrip(bytes: Uint8Array): Promise<CodecRoundtrip> {
    return roundtrip('messageRoundtrip', bytes);
  },
  async segmentRoundtrip(bytes: Uint8Array): Promise<CodecRoundtrip> {
    return roundtrip('segmentRoundtrip', bytes);
  },
  async realtimeKnown(text: string): Promise<boolean> {
    const result = asObject(
      await codecProcess().call('realtimeKnown', { text }),
      'realtimeKnown',
    );
    return result.value === true;
  },
};
