/**
 * A TCP proxy that holds every chunk for a fixed delay in each direction, so
 * a local PostgreSQL answers with the round-trip time of a remote one. The
 * partition ceiling spawns it as its own process; its timers do not share an
 * event loop with the clients or the server.
 *
 *   bun load/src/rtt-proxy.ts <target-host> <target-port> <delay-ms-each-way>
 *
 * It prints `LOAD_SERVER_READY <port>` once listening. Chunks leave in
 * arrival order; a write the socket does not take whole waits for `drain`.
 */
import type { Socket } from 'bun';

const [host = '127.0.0.1', port = '5432', delay = '0'] = process.argv.slice(2);
const delayMs = Number(delay);

/** One direction: queued chunks, each released `delayMs` after it arrived. */
class DelayedPipe {
  target: Socket<unknown> | undefined;
  readonly #queue: { at: number; data: Uint8Array }[] = [];
  #pending: Uint8Array | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  push(data: Uint8Array): void {
    this.#queue.push({ at: performance.now() + delayMs, data: data.slice() });
    this.#schedule();
  }

  flush(): void {
    if (this.#pending === undefined || this.target === undefined) return;
    const written = this.target.write(this.#pending);
    this.#pending =
      written < this.#pending.length
        ? this.#pending.subarray(written)
        : undefined;
  }

  #schedule(): void {
    const head = this.#queue[0];
    if (this.#timer !== undefined || head === undefined) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        const now = performance.now();
        while (this.#queue[0] !== undefined && this.#queue[0].at <= now + 0.5) {
          const { data } = this.#queue.shift() ?? { data: new Uint8Array() };
          const pending = this.#pending;
          if (pending === undefined) this.#pending = data;
          else {
            const joined = new Uint8Array(pending.length + data.length);
            joined.set(pending);
            joined.set(data, pending.length);
            this.#pending = joined;
          }
        }
        this.flush();
        this.#schedule();
      },
      Math.max(0, head.at - performance.now()),
    );
  }
}

interface Connection {
  readonly toServer: DelayedPipe;
  readonly toClient: DelayedPipe;
  upstream?: Socket<unknown>;
}

const listener = Bun.listen<Connection>({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    open(client) {
      const connection: Connection = {
        toServer: new DelayedPipe(),
        toClient: new DelayedPipe(),
      };
      connection.toClient.target = client;
      client.data = connection;
      void Bun.connect({
        hostname: host,
        port: Number(port),
        socket: {
          open(upstream) {
            connection.upstream = upstream;
            connection.toServer.target = upstream;
            connection.toServer.flush();
          },
          data(_upstream, data) {
            connection.toClient.push(data);
          },
          drain() {
            connection.toServer.flush();
          },
          close() {
            client.end();
          },
          error() {
            client.end();
          },
        },
      });
    },
    data(client, data) {
      client.data.toServer.push(data);
    },
    drain(client) {
      client.data.toClient.flush();
    },
    close(client) {
      client.data.upstream?.end();
    },
  },
});

process.stdout.write(`LOAD_SERVER_READY ${listener.port}\n`);
