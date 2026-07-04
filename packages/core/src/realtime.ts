/**
 * Realtime JSON control messages and channel tags (SPEC.md §8).
 *
 * Control messages are JSON text frames; binary frames carry a one-byte
 * channel tag (§8.7) followed by either a complete SSP2 response message
 * (deltas) or a chunk of an in-flight sync round's byte stream, handled
 * by the message codec / stream scanner. Per §8.1 a client MUST tolerate
 * and ignore unknown JSON control events, so parsing returns
 * `known: false` for unrecognized event names instead of failing.
 */
import { DecodeError } from './errors';

/** §8.7 channel tag: a standalone SSP2 response message — a delta. */
export const REALTIME_TAG_DELTA = 0x00;
/** §8.7 channel tag: one chunk of the in-flight sync round's byte
 * stream (request client→server, response server→client). */
export const REALTIME_TAG_ROUND = 0x01;

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

/** §8.6.2 presence fanout kind — a closed set of three. */
export type PresenceKind = 'join' | 'update' | 'leave';

const PRESENCE_KINDS: readonly PresenceKind[] = ['join', 'update', 'leave'];

/**
 * Server → client presence fanout (§8.6.2): a scope-mate's presence for a
 * key the receiver holds changed. `doc` is the peer's document for
 * `join`/`update` and `null` for `leave`. An `error` variant carries a
 * client-runtime `presence.*` code back to the publisher (size cap /
 * forbidden, §8.6.2); it never fans out to peers.
 */
export interface RealtimePresenceEvent {
  event: 'presence';
  data: {
    scopeKey: string;
    kind?: PresenceKind;
    actorId?: string;
    clientId?: string;
    doc?: Record<string, unknown> | null;
    error?: string;
    timestamp?: number;
  };
}

export type RealtimeServerEvent =
  | RealtimeHelloEvent
  | RealtimeSyncEvent
  | RealtimeHeartbeatEvent
  | RealtimePresenceEvent;

/** Client → server delta acknowledgement (§8.2). */
export interface RealtimeAck {
  type: 'ack';
  cursor: number;
}

/** Client → server presence publish/leave (§8.6.2). `doc: null` = leave. */
export interface RealtimePresencePublish {
  event: 'presence';
  data: {
    scopeKey: string;
    doc: Record<string, unknown> | null;
  };
}

export type ParsedRealtimeEvent =
  | { known: true; event: RealtimeServerEvent }
  | { known: false; eventName: string };

/** Serialize a client→server presence publish/leave (§8.6.2). */
export function encodePresencePublish(
  scopeKey: string,
  doc: Record<string, unknown> | null,
): string {
  return JSON.stringify({ event: 'presence', data: { scopeKey, doc } });
}

/** Serialize a server→client presence fanout event (§8.6.2). */
export function encodePresenceFanout(
  scopeKey: string,
  kind: PresenceKind,
  actorId: string,
  clientId: string,
  doc: Record<string, unknown> | null,
  timestamp: number,
): string {
  return JSON.stringify({
    event: 'presence',
    data: { scopeKey, kind, actorId, clientId, doc, timestamp },
  });
}

/** Serialize a server→client presence error directed at the publisher
 * (§8.6.2 `presence.too_large` / `presence.forbidden`). */
export function encodePresenceError(
  scopeKey: string,
  error: string,
  timestamp: number,
): string {
  return JSON.stringify({
    event: 'presence',
    data: { scopeKey, error, timestamp },
  });
}

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
  if (event === 'presence') {
    // §8.6.2: validate the presence shape but carry `data` through
    // verbatim so re-encoding is byte-identical (host-defined `doc`). A
    // `presence` message is recognized in both directions: a fanout (has
    // `kind`), a publisher-directed error (has `error`), or a client→server
    // publish (neither — just `scopeKey`/`doc`, §8.6.2).
    const data = requireObject(root.data, 'presence.data');
    validatePresenceScopeKey(data.scopeKey);
    if ('error' in data) {
      // The publisher-directed error variant (`presence.too_large` /
      // `presence.forbidden`, §8.6.2) — a string code, no `kind`/`doc`.
      requireString(data.error, 'presence.data.error');
    } else if ('kind' in data) {
      validatePresenceKind(data.kind);
      requireString(data.actorId, 'presence.data.actorId');
      requireString(data.clientId, 'presence.data.clientId');
      validatePresenceFanoutDoc(data.kind as PresenceKind, data.doc);
    } else {
      // Client→server publish/leave: scopeKey + doc (object or null).
      if (data.doc !== null) requirePresenceDocObject(data.doc);
    }
    if (data.timestamp !== undefined) {
      requireNumber(data.timestamp, 'presence.data.timestamp');
    }
    return {
      known: true,
      event: { event: 'presence', data: data as RealtimePresenceEvent['data'] },
    };
  }
  return { known: false, eventName: event };
}

function validatePresenceScopeKey(value: unknown): string {
  const key = requireString(value, 'presence.data.scopeKey');
  if (key.length === 0) malformed('presence.data.scopeKey must be non-empty');
  return key;
}

function validatePresenceKind(value: unknown): void {
  const kind = requireString(value, 'presence.data.kind');
  if (!(PRESENCE_KINDS as readonly string[]).includes(kind)) {
    malformed(`unknown presence kind ${JSON.stringify(kind)}`);
  }
}

/** §8.6.2 `doc`-present-iff-not-`leave`: a leave carries null, a
 * join/update carries an object. */
function validatePresenceFanoutDoc(kind: PresenceKind, doc: unknown): void {
  if (kind === 'leave') {
    if (doc !== null && doc !== undefined) {
      malformed('presence leave must carry doc: null');
    }
    return;
  }
  requirePresenceDocObject(doc);
}

function requirePresenceDocObject(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    malformed('presence.data.doc must be a JSON object');
  }
}

/**
 * Parse a client → server presence publish/leave (§8.6.2). Used by the
 * server to validate inbound `presence` control messages. A malformed
 * message (missing/empty `scopeKey`, or a `doc` that is neither an object
 * nor `null`) throws a `DecodeError` — a known event with wrong-shape data
 * is never a tolerated variant (§8.1).
 */
export function parseRealtimePresencePublish(
  text: string,
): RealtimePresencePublish {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    malformed('not valid JSON');
  }
  const root = requireObject(value, 'control message');
  if (root.event !== 'presence') {
    malformed('not a presence control message');
  }
  const data = requireObject(root.data, 'presence.data');
  const scopeKey = validatePresenceScopeKey(data.scopeKey);
  const doc = data.doc;
  if (doc !== null) requirePresenceDocObject(doc);
  return {
    event: 'presence',
    data: { scopeKey, doc: doc as Record<string, unknown> | null },
  };
}
