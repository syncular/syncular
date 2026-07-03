/**
 * A hermetic local double for the Cloudflare Durable Object platform surface
 * `SyncularRealtimeHost` uses — the d1-double philosophy carried to the DO
 * runtime. It implements exactly the subset the host touches, over in-process
 * objects, so the tests drive the REAL `RealtimeSession`/`RealtimeHub` logic
 * through the real DO class with no `workerd`.
 *
 * What it doubles:
 *   - `WebSocketPair` → a linked `[client, server]` pair of in-memory sockets
 *     with `send`/`close`/`serializeAttachment`/`deserializeAttachment`.
 *   - `DurableObjectState.acceptWebSocket` / `getWebSockets` → a registry.
 *   - the hibernation dispatch (`webSocketMessage`) — the double calls the
 *     host's callbacks, exactly as the runtime would.
 *   - a `DurableObjectNamespace` → `idFromName` (partition → id) →
 *     `get(id).fetch(request)`, so one host per partition, addressed by name.
 *
 * ## Fidelity limits (documented honestly, like `d1-double.ts`)
 *
 *   - **No true eviction.** Real hibernation evicts the DO from memory between
 *     deliveries and re-instantiates the class on the next event; the double
 *     keeps one host instance alive. Hibernation of the SESSION MAP (the
 *     rehydration path) is what matters for correctness, and the double
 *     simulates it explicitly with `simulateHibernation()` — it clears the
 *     host's in-memory session map so the next `webSocketMessage` must
 *     rehydrate from the attachment + D1, exactly as a real wake would. The
 *     sockets and their attachments survive (as they do on the platform).
 *   - **Synchronous transport.** Real WS delivery is async over a network;
 *     the double delivers into an in-memory inbox synchronously. Ordering is
 *     preserved (a FIFO queue), but wire latency/backpressure is not modeled —
 *     the §8.7 round loop's backpressure `await` is exercised (the host awaits
 *     `send`) but always resolves immediately.
 *   - **No 101 wire handshake.** The double's upgrade returns the client
 *     socket on the `Response` (`webSocket` field), which the test reads
 *     directly rather than completing an HTTP/1.1 Upgrade — the same shape
 *     `workerd` produces, minus the socket-frame layer.
 *   - **Single-threaded by construction** (as a real DO is): all dispatch runs
 *     on the test's event loop; there is no concurrent delivery to race.
 */
import type { D1DatabaseDouble } from '../../server/test/d1-double';
import type {
  DurableObjectNamespaceLike,
  DurableObjectStubLike,
} from '../src/index';
import {
  type DurableObjectStateLike,
  type RealtimeDOConfig,
  SyncularRealtimeHost,
  type WebSocketLike,
  type WebSocketPairLike,
} from '../src/realtime-do';

/** A captured outbound frame (what the server socket sent to the client). */
export type SocketFrame = string | Uint8Array;

/** One in-memory WebSocket end of a pair. */
export class FakeWebSocket implements WebSocketLike {
  /** Frames this socket has SENT (i.e. what the peer would receive). */
  readonly sent: SocketFrame[] = [];
  #attachment: unknown = null;
  #peer: FakeWebSocket | undefined;
  closed = false;
  closeCode: number | undefined;

  link(peer: FakeWebSocket): void {
    this.#peer = peer;
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) throw new Error('send on a closed socket');
    if (typeof data === 'string') {
      this.sent.push(data);
    } else if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data.slice(0)));
    } else {
      const view = new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      this.sent.push(new Uint8Array(view));
    }
  }

  close(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
  }

  serializeAttachment(value: unknown): void {
    // Real DO serializes to a structured clone; JSON round-trip is a faithful
    // stand-in for the plain identity object the host stores.
    this.#attachment = JSON.parse(JSON.stringify(value));
  }

  deserializeAttachment(): unknown {
    return this.#attachment === null
      ? null
      : JSON.parse(JSON.stringify(this.#attachment));
  }

  /** Test helper: the frames the CLIENT would receive = the server's sends.
   * When this is the client socket, its `sent` is what the client wrote. */
  peerFrames(): SocketFrame[] {
    return this.#peer?.sent ?? [];
  }
}

export class FakeWebSocketPair implements WebSocketPairLike {
  readonly 0: FakeWebSocket;
  readonly 1: FakeWebSocket;
  constructor() {
    const client = new FakeWebSocket();
    const server = new FakeWebSocket();
    client.link(server);
    server.link(client);
    this[0] = client;
    this[1] = server;
  }
}

/** The `DurableObjectState` double: the accepted-socket registry. */
class FakeDurableObjectState implements DurableObjectStateLike {
  readonly #sockets: WebSocketLike[] = [];
  acceptWebSocket(ws: WebSocketLike): void {
    this.#sockets.push(ws);
  }
  getWebSockets(): WebSocketLike[] {
    return [...this.#sockets];
  }
}

/**
 * One DO instance for a single partition: a `SyncularRealtimeHost` over a
 * fresh D1 double (or a shared one, for the HTTP-push-wakes-DO test where the
 * plain handler and the DO must read the SAME D1).
 */
export class FakeRealtimeDO implements DurableObjectStubLike {
  readonly state = new FakeDurableObjectState();
  host: SyncularRealtimeHost;

  constructor(
    readonly db: D1DatabaseDouble,
    readonly config: RealtimeDOConfig,
  ) {
    this.host = new SyncularRealtimeHost(this.state, db, config);
  }

  fetch(request: Request): Promise<Response> {
    return this.host.fetch(request);
  }

  /** Simulate a hibernation wake: the honest lever is a fresh host over the
   * SAME state + D1, which starts with an empty session map but the same
   * accepted sockets (attachments intact) — exactly what a real wake
   * produces: a new class instance, same sockets. The next
   * `webSocketMessage` must therefore rehydrate the session from the
   * attachment + D1. */
  simulateHibernation(): void {
    this.host = new SyncularRealtimeHost(this.state, this.db, this.config);
  }

  /** Deliver an inbound frame to the host (the hibernation callback). */
  async deliver(
    server: WebSocketLike,
    message: ArrayBuffer | string,
  ): Promise<void> {
    await this.host.webSocketMessage(server, message);
  }

  async closeSocket(server: WebSocketLike): Promise<void> {
    await this.host.webSocketClose(server);
  }
}

/**
 * A `DurableObjectNamespace` double: partition name → one `FakeRealtimeDO`,
 * created lazily and cached (so `idFromName(p)` always resolves to the same
 * DO for a partition, as the platform guarantees). All DOs over one namespace
 * share the SAME D1 double — realtime rounds and HTTP pushes hit one commit
 * log, exactly as one D1 database backs the whole deployment.
 */
export class FakeDurableObjectNamespace implements DurableObjectNamespaceLike {
  readonly #dos = new Map<string, FakeRealtimeDO>();
  constructor(
    readonly db: D1DatabaseDouble,
    readonly config: RealtimeDOConfig,
  ) {}

  idFromName(name: string): { toString(): string } {
    return { toString: () => name };
  }

  get(id: { toString(): string }): FakeRealtimeDO {
    const name = id.toString();
    let existing = this.#dos.get(name);
    if (existing === undefined) {
      existing = new FakeRealtimeDO(this.db, this.config);
      this.#dos.set(name, existing);
    }
    return existing;
  }
}
