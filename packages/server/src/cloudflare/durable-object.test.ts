import { describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { SyncDurableObject } from './durable-object';

const staleSocketCloseCode = 1012;
const staleSocketCloseReason = 'WebSocket session expired; reconnect required';

class TestSyncDurableObject extends SyncDurableObject<Record<string, never>> {
  async setup(
    _app: Hono<{ Bindings: Record<string, never> }>,
    _env: Record<string, never>,
    _upgradeWebSocket: UpgradeWebSocket<WebSocket>
  ): Promise<void> {}
}

function createSocketTracker(): {
  socket: WebSocket;
  closes: Array<{ code: number | undefined; reason: string | undefined }>;
} {
  const closes: Array<{
    code: number | undefined;
    reason: string | undefined;
  }> = [];
  const socket = {
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
    },
  } as WebSocket;
  return { socket, closes };
}

function createState(sockets: WebSocket[]): DurableObjectState {
  return {
    acceptWebSocket() {},
    getWebSockets() {
      return sockets;
    },
  } as DurableObjectState;
}

describe('SyncDurableObject stale websocket handling', () => {
  test('closes untracked sockets on construction (hibernation wake-up path)', () => {
    const tracked = createSocketTracker();
    const state = createState([tracked.socket]);

    new TestSyncDurableObject(state, {});

    expect(tracked.closes).toEqual([
      { code: staleSocketCloseCode, reason: staleSocketCloseReason },
    ]);
  });

  test('closes unknown sockets when receiving websocket messages', async () => {
    const state = createState([]);
    const durableObject = new TestSyncDurableObject(state, {});
    const tracked = createSocketTracker();

    await durableObject.webSocketMessage(tracked.socket, 'hello');

    expect(tracked.closes).toEqual([
      { code: staleSocketCloseCode, reason: staleSocketCloseReason },
    ]);
  });
});
