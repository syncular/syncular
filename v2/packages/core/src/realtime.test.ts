import { describe, expect, it } from 'bun:test';
import { DecodeError, parseRealtimeServerEvent } from './index';

describe('realtime control messages (SPEC.md §8)', () => {
  it('parses a hello event', () => {
    const parsed = parseRealtimeServerEvent(
      JSON.stringify({
        event: 'hello',
        data: {
          protocolVersion: 1,
          sessionId: 's',
          actorId: 'a',
          clientId: 'c',
          cursor: 5,
          latestCursor: 9,
          requiresSync: true,
          timestamp: 123,
        },
      }),
    );
    expect(parsed.known).toBe(true);
    if (parsed.known) {
      expect(parsed.event.event).toBe('hello');
    }
  });

  it('parses all three wake reasons and rejects unknown ones', () => {
    for (const reason of [
      'delta-too-large',
      'catchup-required',
      'reset-required',
    ]) {
      const parsed = parseRealtimeServerEvent(
        JSON.stringify({
          event: 'sync',
          data: { cursor: 1, requiresPull: true, reason, timestamp: 0 },
        }),
      );
      expect(parsed.known).toBe(true);
    }
    expect(() =>
      parseRealtimeServerEvent(
        JSON.stringify({
          event: 'sync',
          data: {
            cursor: 1,
            requiresPull: true,
            reason: 'payload-too-large', // v1 legacy reason, removed in v2
            timestamp: 0,
          },
        }),
      ),
    ).toThrow(DecodeError);
  });

  it('tolerates unknown control events (§8.1 forward compat)', () => {
    const parsed = parseRealtimeServerEvent(
      JSON.stringify({ event: 'presence', data: { anything: true } }),
    );
    expect(parsed).toEqual({ known: false, eventName: 'presence' });
  });

  it('rejects malformed known events', () => {
    expect(() =>
      parseRealtimeServerEvent(
        JSON.stringify({ event: 'heartbeat', data: { timestamp: 'soon' } }),
      ),
    ).toThrow(DecodeError);
    expect(() => parseRealtimeServerEvent('not json')).toThrow(DecodeError);
  });
});
