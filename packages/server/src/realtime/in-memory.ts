import type { SyncRealtimeBroadcaster, SyncRealtimeEvent } from './types';

/**
 * In-memory broadcaster for tests and single-process setups.
 *
 * This simulates multi-instance fanout when shared across "instances" in a test.
 */
export class InMemorySyncRealtimeBroadcaster
  implements SyncRealtimeBroadcaster
{
  private handlers = new Set<(event: SyncRealtimeEvent) => void>();

  subscribe(handler: (event: SyncRealtimeEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(event: SyncRealtimeEvent): Promise<void> {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // ignore individual handler errors; realtime is best-effort
      }
    }
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
