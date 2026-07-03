/**
 * Realtime JSON control messages (SPEC.md §8).
 *
 * Control messages are JSON text frames; binary frames carry complete SSP2
 * response messages and are handled by the message codec. Per §8.1 a client
 * MUST tolerate and ignore unknown JSON control events, so parsing returns
 * `known: false` for unrecognized event names instead of failing.
 */
import { DecodeError } from './errors';

export interface RealtimeHelloEvent {
  event: 'hello';
  data: {
    protocolVersion: number;
    sessionId: string;
    actorId: string;
    clientId: string;
    cursor: number;
    latestCursor: number;
    requiresSync: boolean;
    timestamp: number;
  };
}

export type WakeReason =
  | 'delta-too-large'
  | 'catchup-required'
  | 'reset-required';

export interface RealtimeSyncEvent {
  event: 'sync';
  data: {
    cursor: number;
    requiresPull: true;
    reason: WakeReason;
    timestamp: number;
  };
}

export interface RealtimeHeartbeatEvent {
  event: 'heartbeat';
  data: { timestamp: number };
}

export type RealtimeServerEvent =
  | RealtimeHelloEvent
  | RealtimeSyncEvent
  | RealtimeHeartbeatEvent;

/** Client → server delta acknowledgement (§8.2). */
export interface RealtimeAck {
  type: 'ack';
  cursor: number;
}

export type ParsedRealtimeEvent =
  | { known: true; event: RealtimeServerEvent }
  | { known: false; eventName: string };

function malformed(what: string): never {
  throw new DecodeError(
    'sync.invalid_request',
    `malformed realtime control message: ${what}`,
  );
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    malformed(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireNumber(value: unknown, what: string): number {
  // Realtime numeric fields are integers within the ±(2^53−1) i64 contract
  // (SPEC.md §8.1); fractional or non-finite numbers are malformed.
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    malformed(`${what} must be an integer within the i64 safe range`);
  }
  return value;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') malformed(`${what} must be a string`);
  return value;
}

function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') malformed(`${what} must be a boolean`);
  return value;
}

const WAKE_REASONS: readonly WakeReason[] = [
  'delta-too-large',
  'catchup-required',
  'reset-required',
];

export function parseRealtimeServerEvent(text: string): ParsedRealtimeEvent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    malformed('not valid JSON');
  }
  const root = requireObject(value, 'control message');
  const event = requireString(root.event, 'event');
  if (event === 'hello') {
    const data = requireObject(root.data, 'hello.data');
    return {
      known: true,
      event: {
        event: 'hello',
        data: {
          protocolVersion: requireNumber(
            data.protocolVersion,
            'hello.data.protocolVersion',
          ),
          sessionId: requireString(data.sessionId, 'hello.data.sessionId'),
          actorId: requireString(data.actorId, 'hello.data.actorId'),
          clientId: requireString(data.clientId, 'hello.data.clientId'),
          cursor: requireNumber(data.cursor, 'hello.data.cursor'),
          latestCursor: requireNumber(
            data.latestCursor,
            'hello.data.latestCursor',
          ),
          requiresSync: requireBoolean(
            data.requiresSync,
            'hello.data.requiresSync',
          ),
          timestamp: requireNumber(data.timestamp, 'hello.data.timestamp'),
        },
      },
    };
  }
  if (event === 'sync') {
    const data = requireObject(root.data, 'sync.data');
    const reason = requireString(data.reason, 'sync.data.reason');
    if (!(WAKE_REASONS as readonly string[]).includes(reason)) {
      malformed(`unknown wake reason ${JSON.stringify(reason)}`);
    }
    if (data.requiresPull !== true) {
      malformed('sync.data.requiresPull must be true');
    }
    return {
      known: true,
      event: {
        event: 'sync',
        data: {
          cursor: requireNumber(data.cursor, 'sync.data.cursor'),
          requiresPull: true,
          reason: reason as WakeReason,
          timestamp: requireNumber(data.timestamp, 'sync.data.timestamp'),
        },
      },
    };
  }
  if (event === 'heartbeat') {
    const data = requireObject(root.data, 'heartbeat.data');
    return {
      known: true,
      event: {
        event: 'heartbeat',
        data: {
          timestamp: requireNumber(data.timestamp, 'heartbeat.data.timestamp'),
        },
      },
    };
  }
  return { known: false, eventName: event };
}
