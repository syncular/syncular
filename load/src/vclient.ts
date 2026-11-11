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
  encodeSparseRow,
  MessageStreamScanner,
  PROTOCOL_WIRE_VERSION,
  type PushResultFrame,
  parseRealtimeServerEvent,
  REALTIME_TAG_DELTA,
  REALTIME_TAG_ROUND,
  type RequestFrame,
  type ResponseFrame,
  type ResponseMessage,
  type RowValue,
  registrationDigest,
  type UnitScopes,
  unitId,
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

interface UnitState {
  readonly id: string;
  readonly scopes: UnitScopes;
  /** Absent once the unit is live (§4.5); otherwise `-1` or its cursor. */
  cursor?: number;
  bootstrapState?: string;
}

export interface RoundResult {
  readonly latencyMs: number;
  readonly message: ResponseMessage;
  /** Rows carried by the response (inline + ref rowCount + commit changes). */
  readonly appliedRows: number;
  /** True once no unit section left a bootstrapState. */
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
    clientSeq: seq,
    operations: [
      {
        table: TABLE,
        rowId: id,
        op: 'upsert',
        payload: encodeSparseRow(COLUMNS, 0, values),
      },
    ],
  };
}

function requestBytes(
  clientId: string,
  frames: readonly RequestFrame[],
  logEpoch?: string,
): Uint8Array {
  return encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [
      {
        type: 'REQ_HEADER',
        clientId,
        schemaVersion: SCHEMA.version,
        ...(logEpoch !== undefined ? { logEpoch } : {}),
        outboxId: clientId,
      },
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

/**
 * A rejected push is a valid response, so an accounting pass alone would not
 * notice it: the round would report a latency and zero changed rows while the
 * server discarded every write (§6.3). Treat it as the protocol error it is
 * and let the scenario's zero-error budget bite.
 */
function assertPushAccepted(message: ResponseMessage): void {
  const rejected = message.frames.find(
    (frame): frame is PushResultFrame =>
      frame.type === 'PUSH_RESULT' && frame.status === 'rejected',
  );
  if (rejected === undefined) return;
  throw new VClientError(
    `push rejected: ${rejected.results
      .map((result) => (result.status === 'applied' ? 'applied' : result.code))
      .join(', ')}`,
  );
}

/**
 * §2.1: every round after the first carries the partition log epoch, and the
 * round that acquires it carries no push commit. A request without the epoch
 * is answered with a header-only reset response, so a client that never sends
 * it measures a server that returns nothing at all: no commits, no snapshot,
 * no segment, and an empty bootstrap that looks complete.
 */
function acquiredLogEpoch(message: ResponseMessage): string {
  const header = message.frames[0];
  if (header?.type !== 'RESP_HEADER' || header.logEpoch === undefined) {
    throw new VClientError('epoch acquisition returned no logEpoch');
  }
  if (header.requiredSchemaVersion !== undefined) {
    throw new VClientError(
      `server requires schema version ${header.requiredSchemaVersion}`,
    );
  }
  return header.logEpoch;
}

/** True for the header-only §2.1 answer to a round the log restarted under. */
function isEpochReset(message: ResponseMessage): boolean {
  const header = message.frames[0];
  return header?.type === 'RESP_HEADER' && header.resetRequired === true;
}

interface PullLimits {
  readonly limitCommits: number;
  readonly limitSnapshotRows: number;
  readonly maxSnapshotPages: number;
  readonly accept: number;
}

/**
 * The client side of §4.1 and §4.5 without a local database: the
 * registration list, each catching-up unit's cursor and resume token, the
 * replica cursor and the last echo digest.
 */
class UnitRegistry {
  readonly #units = new Map<string, UnitState>();
  #travel = false;
  #replicaCursor = -1;
  #echoDigest: Uint8Array = new Uint8Array();

  subscribe(scopes: UnitScopes): void {
    const id = unitId(scopes);
    if (this.#units.has(id)) return;
    this.#units.set(id, { id, scopes, cursor: -1 });
    this.#travel = true;
  }

  /** `PULL_HEADER`, the list when it travels, one `PROGRESS` per catching-up unit (§4.3). */
  pullFrames(limits: PullLimits): RequestFrame[] {
    const units = [...this.#units.values()];
    return [
      {
        type: 'PULL_HEADER',
        ...limits,
        cursor: this.#replicaCursor,
        registrationDigest: registrationDigest(
          units.map((unit) => unit.scopes),
        ),
        echoDigest: this.#echoDigest,
      },
      ...(this.#travel
        ? units.map((unit) => ({ type: 'UNIT' as const, scopes: unit.scopes }))
        : []),
      ...units.flatMap((unit) =>
        unit.cursor === undefined
          ? []
          : [
              {
                type: 'PROGRESS' as const,
                id: unit.id,
                cursor: unit.cursor,
                ...(unit.bootstrapState !== undefined
                  ? { bootstrapState: unit.bootstrapState }
                  : {}),
              },
            ],
      ),
    ];
  }

  /**
   * Walk a decoded response: count applied rows, fold `SUB_END` into the
   * unit states, apply join rule J at `LIVE_END` (§4.5), and report whether
   * any unit is still paging.
   */
  account(message: ResponseMessage): {
    appliedRows: number;
    bootstrapComplete: boolean;
  } {
    assertNoErrorFrames(message.frames);
    let appliedRows = 0;
    let bootstrapComplete = true;
    let current: UnitState | undefined;
    let liveStatus: string | undefined;
    for (const frame of message.frames) {
      switch (frame.type) {
        case 'SUB_START':
          current = this.#units.get(frame.id);
          if (frame.status === 'revoked')
            throw new VClientError('unit revoked', frame.reasonCode);
          if (current !== undefined && frame.status === 'reset') {
            current.cursor = -1;
            delete current.bootstrapState;
          }
          break;
        case 'SEGMENT_INLINE': {
          const decoded = decodeRowsSegment(frame.payload);
          for (const block of decoded.blocks) appliedRows += block.length;
          break;
        }
        case 'SEGMENT_REF':
          appliedRows += frame.rowCount;
          break;
        case 'COMMIT':
          appliedRows += frame.changes.length;
          break;
        case 'SUB_END':
          if (current !== undefined) {
            current.cursor = frame.nextCursor;
            if (frame.bootstrapState !== undefined) {
              current.bootstrapState = frame.bootstrapState;
              bootstrapComplete = false;
            } else {
              delete current.bootstrapState;
            }
          }
          current = undefined;
          break;
        case 'LIVE_START':
          liveStatus = frame.status;
          if (frame.status === 'unregistered') this.#travel = true;
          break;
        case 'LIVE_END': {
          if (liveStatus !== 'active') break;
          this.#travel = false;
          this.#echoDigest = frame.echoDigest;
          const joined = Math.max(this.#replicaCursor, frame.throughSeq);
          let live = false;
          for (const unit of this.#units.values()) {
            if (unit.cursor !== undefined && unit.cursor >= 0) {
              if (unit.bootstrapState === undefined) {
                unit.cursor = Math.max(unit.cursor, frame.throughSeq);
                if (unit.cursor >= joined) delete unit.cursor;
              }
            }
            live ||= unit.cursor === undefined;
          }
          this.#replicaCursor = live ? joined : -1;
          break;
        }
        default:
          break;
      }
    }
    return { appliedRows, bootstrapComplete };
  }
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
  readonly #units = new UnitRegistry();
  #pushSeq = 0;
  #logEpoch: string | undefined;

  constructor(options: VClientOptions) {
    this.clientId = options.clientId;
    this.#baseUrl = options.baseUrl;
  }

  subscribe(scopes: UnitScopes): void {
    this.#units.subscribe(scopes);
  }

  /** The wire round: one request, one response, no epoch bookkeeping. */
  async #roundRaw(
    frames: readonly RequestFrame[],
    logEpoch?: string,
  ): Promise<RoundResult> {
    const body = requestBytes(this.clientId, frames, logEpoch);
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
    const { appliedRows, bootstrapComplete } = this.#units.account(decoded);
    assertPushAccepted(decoded);
    return { latencyMs, message: decoded, appliedRows, bootstrapComplete };
  }

  /**
   * A round bound to the partition log epoch. The first one acquires it; a
   * response that reports the log restarted re-acquires and repeats the round
   * once, which is safe for a push because the server keys idempotency on the
   * client commit id (§2.3).
   */
  async #round(frames: readonly RequestFrame[]): Promise<RoundResult> {
    let epoch = await this.#ensureLogEpoch();
    let result = await this.#roundRaw(frames, epoch);
    if (isEpochReset(result.message)) {
      this.#logEpoch = undefined;
      epoch = await this.#ensureLogEpoch();
      result = await this.#roundRaw(frames, epoch);
      if (isEpochReset(result.message)) {
        throw new VClientError('server kept resetting the log epoch');
      }
    }
    return result;
  }

  /** One pull round (PULL_HEADER, then UNIT and PROGRESS frames, §1.5 order). */
  pull(overrides?: {
    limitSnapshotRows?: number;
    maxSnapshotPages?: number;
    accept?: number;
  }): Promise<RoundResult> {
    return this.#round(
      this.#units.pullFrames({
        limitCommits: 0,
        limitSnapshotRows: overrides?.limitSnapshotRows ?? 5_000,
        maxSnapshotPages: overrides?.maxSnapshotPages ?? 1,
        accept: overrides?.accept ?? ACCEPT_ROWS,
      }),
    );
  }

  /** One push+pull round; increments the client's write sequence. */
  async pushPull(id: string, project: string): Promise<RoundResult> {
    this.#pushSeq += 1;
    return this.#round([
      upsertOp(id, project, this.#pushSeq),
      ...this.#units.pullFrames({
        limitCommits: 100,
        limitSnapshotRows: 5_000,
        maxSnapshotPages: 1,
        accept: ACCEPT_ROWS,
      }),
    ]);
  }

  /** Acquire the partition log epoch once: a pull that asks for nothing. */
  async #ensureLogEpoch(): Promise<string> {
    const epoch =
      this.#logEpoch ??
      acquiredLogEpoch(
        (
          await this.#roundRaw(
            this.#units.pullFrames({
              limitCommits: 0,
              limitSnapshotRows: 0,
              maxSnapshotPages: 0,
              accept: ACCEPT_ROWS,
            }),
          )
        ).message,
      );
    this.#logEpoch = epoch;
    return epoch;
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
  readonly #units = new UnitRegistry();
  #ws: WebSocket | undefined;
  #roundResolve: ((message: ResponseMessage) => void) | undefined;
  #roundReject: ((error: Error) => void) | undefined;
  #scanner: MessageStreamScanner | undefined;
  #handlers: RealtimeVClientHandlers = {};
  #pushSeq = 0;
  #logEpoch: string | undefined;

  constructor(options: VClientOptions) {
    this.clientId = options.clientId;
    this.#baseUrl = options.baseUrl;
  }

  subscribe(scopes: UnitScopes): void {
    this.#units.subscribe(scopes);
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

  #roundOverSocket(
    frames: readonly RequestFrame[],
    logEpoch?: string,
  ): Promise<ResponseMessage> {
    const ws = this.#ws;
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new VClientError('socket not open'));
    }
    const body = requestBytes(this.clientId, frames, logEpoch);
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
    const message = await this.#socketRound(
      this.#units.pullFrames({
        limitCommits: 200,
        limitSnapshotRows: 10_000,
        maxSnapshotPages: 1,
        accept: ACCEPT_ROWS,
      }),
    );
    const latencyMs = performance.now() - t0;
    const { appliedRows, bootstrapComplete } = this.#units.account(message);
    return { latencyMs, message, appliedRows, bootstrapComplete };
  }

  /** One push round over the socket. */
  async pushRound(id: string, project: string): Promise<RoundResult> {
    this.#pushSeq += 1;
    const t0 = performance.now();
    const message = await this.#socketRound([
      upsertOp(id, project, this.#pushSeq),
      ...this.#units.pullFrames({
        limitCommits: 100,
        limitSnapshotRows: 5_000,
        maxSnapshotPages: 1,
        accept: ACCEPT_ROWS,
      }),
    ]);
    const latencyMs = performance.now() - t0;
    const { appliedRows, bootstrapComplete } = this.#units.account(message);
    assertPushAccepted(message);
    return { latencyMs, message, appliedRows, bootstrapComplete };
  }

  /** The socket round bound to the log epoch; same rule as the HTTP client. */
  async #socketRound(
    frames: readonly RequestFrame[],
  ): Promise<ResponseMessage> {
    let result = await this.#roundOverSocket(
      frames,
      await this.#ensureLogEpoch(),
    );
    if (isEpochReset(result)) {
      this.#logEpoch = undefined;
      result = await this.#roundOverSocket(
        frames,
        await this.#ensureLogEpoch(),
      );
      if (isEpochReset(result)) {
        throw new VClientError('server kept resetting the log epoch');
      }
    }
    return result;
  }

  /** Acquire the partition log epoch once, over the socket. */
  async #ensureLogEpoch(): Promise<string> {
    const epoch =
      this.#logEpoch ??
      acquiredLogEpoch(
        await this.#roundOverSocket(
          this.#units.pullFrames({
            limitCommits: 0,
            limitSnapshotRows: 0,
            maxSnapshotPages: 0,
            accept: ACCEPT_ROWS,
          }),
        ),
      );
    this.#logEpoch = epoch;
    return epoch;
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
