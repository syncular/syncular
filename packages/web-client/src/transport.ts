/**
 * Transport seams: request/response bytes, segment download,
 * and the realtime attach surface matching §8's client side. Tests use
 * loopback implementations that call the server library directly — the
 * loopback doctrine; HTTP/WebSocket bindings live in `./http`.
 */

/**
 * One combined push+pull round trip: SSP2 request bytes → response bytes.
 * `signal` aborts when the `syncUntilIdle` deadline elapses (§7.8); a
 * transport that honors it releases the round instead of holding it open.
 */
export type SyncTransport = (
  request: Uint8Array,
  signal?: AbortSignal,
) => Promise<Uint8Array>;

/** One registered authoritative query or command request. */
export type RemoteOperationTransport = (
  request: Uint8Array,
) => Promise<Uint8Array>;

export interface RemoteOperationRealtimeHandlers {
  onMessage(bytes: Uint8Array): void;
  onClose?(): void;
}

export interface RemoteOperationRealtimeSocket {
  send(bytes: Uint8Array): void;
  close(): void;
}

export type RemoteOperationRealtimeConnector = (
  handlers: RemoteOperationRealtimeHandlers,
) => RemoteOperationRealtimeSocket | Promise<RemoteOperationRealtimeSocket>;

export interface SegmentFetchRequest {
  readonly segmentId: string;
  readonly table: string;
  /** Canonical JSON (§11.2) of the requested scope map (§5.5 header). */
  readonly requestedScopesJson: string;
  /**
   * The descriptor's `byteLength` (§5.4): the downloader stops reading once
   * the body exceeds it, and the client core rejects the result.
   */
  readonly byteLength?: number;
  readonly onProgress?: (bytesReceived: number) => void;
  /** Aborts with the round when the `syncUntilIdle` deadline elapses (§7.8). */
  readonly signal?: AbortSignal;
}

/**
 * Fetch segment bytes from the direct endpoint (§5.5). `fetchUrl`, when
 * present, is the §5.4 direct-URL capability: its presence makes the
 * client advertise accept bit 3, and the client core then routes
 * url-carrying descriptors through it — capability negotiation, never a
 * fallback pair. A `fetchUrl` implementation MUST NOT attach host
 * authentication (the URL is the entire grant, §5.4).
 */
export interface SegmentDownloader {
  (request: SegmentFetchRequest): Promise<Uint8Array>;
  readonly fetchUrl?: (
    url: string,
    onProgress?: (bytesReceived: number) => void,
    signal?: AbortSignal,
    /** The descriptor's `byteLength`; reading stops once the body exceeds it. */
    byteLength?: number,
  ) => Promise<Uint8Array>;
}

export interface RealtimeHandlers {
  /** JSON control frame (§8.1): hello / sync / heartbeat / unknown. */
  onText(text: string): void;
  /** Binary frame: channel tag byte + payload (§8.7) — a `0x00`-tagged
   * standalone SSP2 response (delta) or a `0x01`-tagged round chunk. */
  onBinary(bytes: Uint8Array): void;
  onClose?(): void;
}

export interface RealtimeSocket {
  /** Send a JSON control message (acks, §8.2). */
  send(text: string): void;
  /** Send one binary message (tagged round chunk, §8.7). The socket is
   * the sync-round transport whenever it is connected — Direction
   * decision 1: one loop, no fallback pair. */
  sendBytes(bytes: Uint8Array): void;
  close(): void;
}

export type RealtimeConnector = (
  handlers: RealtimeHandlers,
  /** The client's id; the client passes it on every connect. */
  clientId?: string,
) => Promise<RealtimeSocket> | RealtimeSocket;
