/**
 * A lightweight, protocol-level virtual client — the k6-VU equivalent, but
 * built on the reference SSP2 codec instead of a full SyncClient (load brief
 * §1). It encodes sync rounds with `@syncular/core`, sends them over real
 * HTTP (POST /sync) or a real WebSocket (§8.7 socket loop), decodes the
 * response, resolves segment refs against GET /segments/:id, and drains
 * bootstrap paging until complete. It keeps NO local SQLite: bootstrap
 * "completion" is verified by counting applied rows out of the response
 * (inline segment rows + ref rowCounts + commit changes), which is what the
 * scenarios assert. 100× lighter than a SyncClient per VU.
 *
 * All rounds return a RoundResult with the wall-clock latency and a decoded
 * view; a protocol error (in-band ERROR frame, non-200, decode failure)
 * throws a VClientError so the scenario's zero-protocol-error budget bites.
 */
import {
  decodeMessage,
  decodeRowsSegment,
  encodeMessage,
  encodeRow,
  MessageStreamScanner,
  PROTOCOL_WIRE_VERSION,
  parseRealtimeServerEvent,
  REALTIME_TAG_DELTA,
  REALTIME_TAG_ROUND,
  type RequestFrame,
  type ResponseFrame,
  type ResponseMessage,
  type RowValue,
  type ScopeMap,
} from '@syncular/core';
import { COLUMNS, SCHEMA, SSP2_CONTENT_TYPE, TABLE } from './wire';

export class VClientError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'VClientError';
  }
}

export interface SubscriptionState {
  readonly id: string;
  readonly table: string;
  readonly scopes: ScopeMap;
  cursor: number;
  bootstrapState?: string;
}

export interface RoundResult {
  readonly latencyMs: number;
  readonly message: ResponseMessage;
  /** Rows carried by the response (inline + ref rowCount + commit changes). */
  readonly appliedRows: number;
  /** True once no subscription section left a bootstrapState. */
  readonly bootstrapComplete: boolean;
}

/** Bit 0 inline rows, bit 1 external rows — the default rows-lane accept. */
const ACCEPT_ROWS = 0b0011;

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function upsertOp(id: string, project: string, seq: number): RequestFrame {
  const values: RowValue[] = [
    id,
    project,
    `load ${id} @${seq}`,
    seq % 2 === 0,
    seq % 5,
    1_750_000_000_000 + seq,
  ];
  return {
    type: 'PUSH_COMMIT',
    clientCommitId: `${id}-c${seq}`,
    operations: [
      {
        table: TABLE,
        rowId: id,
        op: 'upsert',
        payload: encodeRow(COLUMNS, values),
      },
    ],
  };
}

function requestBytes(
  clientId: string,
  frames: readonly RequestFrame[],
): Uint8Array {
  return encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [
      { type: 'REQ_HEADER', clientId, schemaVersion: SCHEMA.version },
      ...frames,
    ],
  });
}

// ---------------------------------------------------------------------------
// Response accounting
// ---------------------------------------------------------------------------

function assertNoErrorFrames(frames: readonly ResponseFrame[]): void {
  for (const frame of frames) {
    if (frame.type === 'ERROR') {
      throw new VClientError(
        `server ERROR frame: ${frame.message}`,
        frame.code,
      );
    }
  }
}

interface Accounting {
  readonly appliedRows: number;
  readonly bootstrapComplete: boolean;
}

/**
 * Walk a decoded response: count applied rows, fold SUB_END nextCursor +
 * bootstrapState back into the subscription states, and report whether any
 * section is still paging.
 */
function account(
  message: ResponseMessage,
  subs: Map<string, SubscriptionState>,
): Accounting {
  assertNoErrorFrames(message.frames);
  let appliedRows = 0;
  let bootstrapComplete = true;
  let currentSub: SubscriptionState | undefined;
  const refIds: Array<{ segmentId: string; scopes: ScopeMap }> = [];
  for (const frame of message.frames) {
    switch (frame.type) {
      case 'SUB_START':
        currentSub = subs.get(frame.id);
        break;
      case 'SEGMENT_INLINE': {
        const decoded = decodeRowsSegment(frame.payload);
        for (const block of decoded.blocks) appliedRows += block.length;
        break;
      }
      case 'SEGMENT_REF':
        appliedRows += frame.rowCount;
        if (currentSub !== undefined) {
          refIds.push({
            segmentId: frame.segmentId,
            scopes: currentSub.scopes,
          });
        }
        break;
      case 'COMMIT':
        appliedRows += frame.changes.length;
        break;
      case 'SUB_END': {
        if (currentSub !== undefined) {
          currentSub.cursor = frame.nextCursor;
          if (frame.bootstrapState !== undefined) {
            currentSub.bootstrapState = frame.bootstrapState;
            bootstrapComplete = false;
          } else {
            delete currentSub.bootstrapState;
          }
        }
        currentSub = undefined;
        break;
      }
      default:
        break;
    }
  }
  // External row segments carry their row count in the ref frame; the
  // scenarios that assert reuse read the server metrics, and bootstrap
  // paging is driven by SUB_END, so we do not need to fetch ref bodies to
  // account rows. Segment fetching is exercised explicitly below.
  void refIds;
  return { appliedRows, bootstrapComplete };
}

// ---------------------------------------------------------------------------
// The virtual client
// ---------------------------------------------------------------------------

export interface VClientOptions {
  readonly baseUrl: string;
  readonly clientId: string;
}

export class HttpVClient {
  readonly clientId: string;
  readonly #baseUrl: string;
  readonly #subs = new Map<string, SubscriptionState>();
  #pushSeq = 0;

  constructor(options: VClientOptions) {
    this.clientId = options.clientId;
    this.#baseUrl = options.baseUrl;
  }

  subscribe(id: string, table: string, scopes: ScopeMap): void {
    this.#subs.set(id, { id, table, scopes, cursor: -1 });
  }

  #subFrames(): RequestFrame[] {
    return [...this.#subs.values()].map((s) => ({
      type: 'SUBSCRIPTION' as const,
      id: s.id,
      table: s.table,
      scopes: s.scopes,
      cursor: s.cursor,
      ...(s.bootstrapState !== undefined
        ? { bootstrapState: s.bootstrapState }
        : {}),
    }));
  }

  async #round(frames: readonly RequestFrame[]): Promise<RoundResult> {
    const body = requestBytes(this.clientId, frames);
    const t0 = performance.now();
    const response = await fetch(`${this.#baseUrl}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': SSP2_CONTENT_TYPE },
      body: body.slice() as unknown as BodyInit,
    });
    if (!response.ok) {
      throw new VClientError(
        `POST /sync ${response.status}: ${await response.text()}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const latencyMs = performance.now() - t0;
    const decoded = decodeMessage(bytes);
    if (decoded.msgKind !== 'response') {
      throw new VClientError('expected a response message');
    }
    const { appliedRows, bootstrapComplete } = account(decoded, this.#subs);
    return { latencyMs, message: decoded, appliedRows, bootstrapComplete };
  }

  /** One pull round (PULL_HEADER then subscription frames, §1.5 order). */
  pull(overrides?: {
    limitSnapshotRows?: number;
    maxSnapshotPages?: number;
    accept?: number;
  }): Promise<RoundResult> {
    return this.#round([
      {
        type: 'PULL_HEADER',
        limitCommits: 0,
        limitSnapshotRows: overrides?.limitSnapshotRows ?? 5_000,
        maxSnapshotPages: overrides?.maxSnapshotPages ?? 1,
        accept: overrides?.accept ?? ACCEPT_ROWS,
      },
      ...this.#subFrames(),
    ]);
  }

  /** One push+pull round; increments the client's write sequence. */
  pushPull(id: string, project: string): Promise<RoundResult> {
    this.#pushSeq += 1;
    return this.#round([
      upsertOp(id, project, this.#pushSeq),
      {
        type: 'PULL_HEADER',
        limitCommits: 100,
        limitSnapshotRows: 5_000,
        maxSnapshotPages: 1,
        accept: ACCEPT_ROWS,
      },
      ...this.#subFrames(),
    ]);
  }

  /**
   * Page a full bootstrap to completion: repeat pull rounds until no
   * subscription section returns a bootstrapState. Returns the aggregate
   * (total rows, page count, whole-bootstrap wall time, last-page p-latency).
   */
  async bootstrap(options?: {
    maxPages?: number;
    limitSnapshotRows?: number;
    /** Advertise the §5.3 sqlite-image lane (accept bit 2) — the storm rule. */
    imageLane?: boolean;
  }): Promise<{
    totalRows: number;
    pages: number;
    wallMs: number;
    pageLatenciesMs: number[];
  }> {
    const maxPages = options?.maxPages ?? 200;
    const accept = options?.imageLane === true ? 0b0111 : ACCEPT_ROWS;
    const limitSnapshotRows = options?.limitSnapshotRows ?? 10_000;
    const t0 = performance.now();
    let totalRows = 0;
    let pages = 0;
    const pageLatenciesMs: number[] = [];
    for (;;) {
      const result = await this.pull({
        limitSnapshotRows,
        maxSnapshotPages: 1,
        accept,
      });
      totalRows += result.appliedRows;
      pages += 1;
      pageLatenciesMs.push(result.latencyMs);
      if (result.bootstrapComplete) break;
      if (pages >= maxPages) {
        throw new VClientError(
          `bootstrap did not complete in ${maxPages} pages`,
        );
      }
    }
    return {
      totalRows,
      pages,
      wallMs: performance.now() - t0,
      pageLatenciesMs,
    };
  }

  /** Fetch a segment body over GET /segments/:id (§5.5 direct endpoint). */
  async fetchSegment(segmentId: string, scopes: ScopeMap): Promise<number> {
    const response = await fetch(`${this.#baseUrl}/segments/${segmentId}`, {
      headers: { 'x-syncular-scopes': JSON.stringify(scopes) },
    });
    if (!response.ok) {
      throw new VClientError(`GET /segments ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length;
  }
}

// ---------------------------------------------------------------------------
// The realtime (WebSocket) virtual client — §8.7 socket loop
// ---------------------------------------------------------------------------

export interface RealtimeVClientHandlers {
  /** A wake-up ('sync' control event) arrived — caller should catch up. */
  onWake?: () => void;
  /** A standalone delta message arrived (tag 0x00). */
  onDelta?: (message: ResponseMessage) => void;
}

/**
 * A realtime virtual client: a real WebSocket to /realtime that drives sync
 * rounds over the socket (tag 0x01) and receives deltas/wakes. Round
 * responses are reassembled with the MessageStreamScanner exactly as the TS
 * client does. One round in flight at a time (§8.7).
 */
export class RealtimeVClient {
  readonly clientId: string;
  readonly #baseUrl: string;
  readonly #subs = new Map<string, SubscriptionState>();
  #ws: WebSocket | undefined;
  #roundResolve: ((message: ResponseMessage) => void) | undefined;
  #roundReject: ((error: Error) => void) | undefined;
  #scanner: MessageStreamScanner | undefined;
  #handlers: RealtimeVClientHandlers = {};
  #pushSeq = 0;

  constructor(options: VClientOptions) {
    this.clientId = options.clientId;
    this.#baseUrl = options.baseUrl;
  }

  subscribe(id: string, table: string, scopes: ScopeMap): void {
    this.#subs.set(id, { id, table, scopes, cursor: -1 });
  }

  /** Connect and resolve once the 'hello' control event has arrived. */
  connect(handlers: RealtimeVClientHandlers = {}): Promise<void> {
    this.#handlers = handlers;
    const wsUrl = `${this.#baseUrl.replace(/^http/, 'ws')}/realtime?clientId=${encodeURIComponent(this.clientId)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    return new Promise((resolve, reject) => {
      let opened = false;
      const timer = setTimeout(() => {
        if (!opened) reject(new VClientError('realtime connect timeout'));
      }, 15_000);
      ws.addEventListener('message', (ev) =>
        this.#onMessage(ev, () => {
          if (!opened) {
            opened = true;
            clearTimeout(timer);
            resolve();
          }
        }),
      );
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        if (!opened) reject(new VClientError('realtime socket error'));
        this.#roundReject?.(new VClientError('socket error mid-round'));
      });
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        this.#roundReject?.(new VClientError('socket closed mid-round'));
      });
    });
  }

  #onMessage(ev: MessageEvent, onHello: () => void): void {
    const data = ev.data;
    if (typeof data === 'string') {
      const parsed = parseRealtimeServerEvent(data);
      if (parsed.known && parsed.event.event === 'hello') onHello();
      else if (parsed.known && parsed.event.event === 'sync') {
        this.#handlers.onWake?.();
      }
      return;
    }
    const bytes = new Uint8Array(data as ArrayBuffer);
    if (bytes.length === 0) return;
    const tag = bytes[0];
    const chunk = bytes.subarray(1);
    if (tag === REALTIME_TAG_DELTA) {
      const message = decodeMessage(chunk);
      if (message.msgKind === 'response') this.#handlers.onDelta?.(message);
      return;
    }
    if (tag === REALTIME_TAG_ROUND) {
      this.#scanner ??= new MessageStreamScanner();
      const done = this.#scanner.push(chunk);
      if (done === undefined) return;
      this.#scanner = undefined;
      const message = decodeMessage(done.message.slice());
      const resolve = this.#roundResolve;
      this.#roundResolve = undefined;
      this.#roundReject = undefined;
      if (message.msgKind === 'response' && resolve !== undefined) {
        resolve(message);
      }
    }
  }

  #subFrames(): RequestFrame[] {
    return [...this.#subs.values()].map((s) => ({
      type: 'SUBSCRIPTION' as const,
      id: s.id,
      table: s.table,
      scopes: s.scopes,
      cursor: s.cursor,
      ...(s.bootstrapState !== undefined
        ? { bootstrapState: s.bootstrapState }
        : {}),
    }));
  }

  #roundOverSocket(frames: readonly RequestFrame[]): Promise<ResponseMessage> {
    const ws = this.#ws;
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new VClientError('socket not open'));
    }
    const body = requestBytes(this.clientId, frames);
    const tagged = new Uint8Array(body.length + 1);
    tagged[0] = REALTIME_TAG_ROUND;
    tagged.set(body, 1);
    return new Promise((resolve, reject) => {
      this.#roundResolve = resolve;
      this.#roundReject = reject;
      ws.send(tagged);
    });
  }

  /** One sync (catch-up) round over the socket; returns latency + rows. */
  async syncRound(): Promise<RoundResult> {
    const t0 = performance.now();
    const message = await this.#roundOverSocket([
      {
        type: 'PULL_HEADER',
        limitCommits: 200,
        limitSnapshotRows: 10_000,
        maxSnapshotPages: 1,
        accept: ACCEPT_ROWS,
      },
      ...this.#subFrames(),
    ]);
    const latencyMs = performance.now() - t0;
    const { appliedRows, bootstrapComplete } = account(message, this.#subs);
    return { latencyMs, message, appliedRows, bootstrapComplete };
  }

  /** One push round over the socket. */
  async pushRound(id: string, project: string): Promise<RoundResult> {
    this.#pushSeq += 1;
    const t0 = performance.now();
    const message = await this.#roundOverSocket([
      upsertOp(id, project, this.#pushSeq),
      {
        type: 'PULL_HEADER',
        limitCommits: 100,
        limitSnapshotRows: 5_000,
        maxSnapshotPages: 1,
        accept: ACCEPT_ROWS,
      },
      ...this.#subFrames(),
    ]);
    const latencyMs = performance.now() - t0;
    const { appliedRows, bootstrapComplete } = account(message, this.#subs);
    return { latencyMs, message, appliedRows, bootstrapComplete };
  }

  /** Page a full bootstrap to completion over the socket. */
  async bootstrap(
    maxPages = 200,
  ): Promise<{ totalRows: number; pages: number; wallMs: number }> {
    const t0 = performance.now();
    let totalRows = 0;
    let pages = 0;
    for (;;) {
      const result = await this.syncRound();
      totalRows += result.appliedRows;
      pages += 1;
      if (result.bootstrapComplete) break;
      if (pages >= maxPages) {
        throw new VClientError(
          `bootstrap did not complete in ${maxPages} pages`,
        );
      }
    }
    return { totalRows, pages, wallMs: performance.now() - t0 };
  }

  close(): void {
    try {
      this.#ws?.close();
    } catch {
      // ignore
    }
  }
}
