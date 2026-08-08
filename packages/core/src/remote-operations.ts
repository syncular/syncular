import { bytesToBase64 } from './render';

export type RemoteOperationRequest =
  | {
      readonly revision: 1;
      readonly kind: 'query';
      readonly clientId: string;
      readonly operationId: string;
      readonly params: unknown;
    }
  | {
      readonly revision: 1;
      readonly kind: 'command';
      readonly clientId: string;
      readonly operationId: string;
      readonly requestId: string;
      readonly params: unknown;
    };

export type RemoteOperationResponse =
  | {
      readonly revision: 1;
      readonly kind: 'query';
      readonly operationId: string;
      readonly rows: readonly Readonly<Record<string, unknown>>[];
      readonly maxCommitSeq: number;
    }
  | {
      readonly revision: 1;
      readonly kind: 'command';
      readonly operationId: string;
      readonly requestId: string;
      readonly status: 'applied' | 'cached' | 'rejected';
      readonly commitSeq?: number;
      readonly results: readonly unknown[];
    }
  | {
      readonly revision: 1;
      readonly kind: 'error';
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export type RemoteOperationRealtimeMessage =
  | {
      readonly revision: 1;
      readonly kind: 'watch';
      readonly watchId: string;
      readonly clientId: string;
      readonly operationId: string;
      readonly params: unknown;
    }
  | {
      readonly revision: 1;
      readonly kind: 'unwatch';
      readonly watchId: string;
    }
  | {
      readonly revision: 1;
      readonly kind: 'snapshot';
      readonly watchId: string;
      readonly operationId: string;
      readonly rows: readonly Readonly<Record<string, unknown>>[];
      readonly maxCommitSeq: number;
    }
  | {
      readonly revision: 1;
      readonly kind: 'watch_error';
      readonly watchId: string;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

type EncodedValue =
  | { readonly t: 'null' }
  | { readonly t: 'boolean'; readonly v: boolean }
  | { readonly t: 'number'; readonly v: number }
  | { readonly t: 'string'; readonly v: string }
  | { readonly t: 'integer'; readonly v: string }
  | { readonly t: 'bytes'; readonly v: string }
  | { readonly t: 'array'; readonly v: readonly EncodedValue[] }
  | {
      readonly t: 'object';
      readonly v: readonly (readonly [string, EncodedValue])[];
    };

function base64ToBytes(text: string): Uint8Array {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (
    text.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      text,
    )
  ) {
    throw new Error('invalid base64 value');
  }
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < text.length; index += 4) {
    const values = [...text.slice(index, index + 4)].map((char) =>
      char === '=' ? 0 : alphabet.indexOf(char),
    );
    if (values.some((value) => value < 0))
      throw new Error('invalid base64 value');
    const chunk =
      ((values[0] ?? 0) << 18) |
      ((values[1] ?? 0) << 12) |
      ((values[2] ?? 0) << 6) |
      (values[3] ?? 0);
    if (offset < out.length) out[offset++] = (chunk >> 16) & 255;
    if (offset < out.length) out[offset++] = (chunk >> 8) & 255;
    if (offset < out.length) out[offset++] = chunk & 255;
  }
  if (bytesToBase64(out) !== text) throw new Error('invalid base64 value');
  return out;
}

function encodeValue(value: unknown): EncodedValue {
  if (value === null) return { t: 'null' };
  if (value === undefined)
    throw new Error('remote operation value cannot be undefined');
  if (typeof value === 'boolean') return { t: 'boolean', v: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('remote operation number must be finite');
    return { t: 'number', v: value };
  }
  if (typeof value === 'string') return { t: 'string', v: value };
  if (typeof value === 'bigint') {
    if (
      value < -9_223_372_036_854_775_808n ||
      value > 9_223_372_036_854_775_807n
    ) {
      throw new Error('remote operation integer exceeds signed 64-bit range');
    }
    return { t: 'integer', v: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { t: 'bytes', v: bytesToBase64(value) };
  }
  if (Array.isArray(value)) {
    return { t: 'array', v: value.map(encodeValue) };
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('remote operation value must be a plain object');
    }
    return {
      t: 'object',
      v: Object.entries(value).map(([key, entry]) => [key, encodeValue(entry)]),
    };
  }
  throw new Error('remote operation value has an unsupported type');
}

function decodeValue(value: EncodedValue): unknown {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.t !== 'string'
  ) {
    throw new Error('invalid remote operation value');
  }
  switch (value.t) {
    case 'null':
      return null;
    case 'boolean':
      if (typeof value.v !== 'boolean')
        throw new Error('invalid remote boolean value');
      return value.v;
    case 'number':
      if (typeof value.v !== 'number' || !Number.isFinite(value.v))
        throw new Error('invalid remote number value');
      return value.v;
    case 'string':
      if (typeof value.v !== 'string')
        throw new Error('invalid remote string value');
      return value.v;
    case 'integer': {
      if (typeof value.v !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(value.v))
        throw new Error('invalid remote integer value');
      const integer = BigInt(value.v);
      if (
        integer < -9_223_372_036_854_775_808n ||
        integer > 9_223_372_036_854_775_807n
      ) {
        throw new Error('remote operation integer exceeds signed 64-bit range');
      }
      return integer;
    }
    case 'bytes':
      if (typeof value.v !== 'string')
        throw new Error('invalid remote bytes value');
      return base64ToBytes(value.v);
    case 'array':
      if (!Array.isArray(value.v))
        throw new Error('invalid remote array value');
      return value.v.map(decodeValue);
    case 'object': {
      if (!Array.isArray(value.v))
        throw new Error('invalid remote object value');
      const entries: Array<readonly [string, unknown]> = [];
      const keys = new Set<string>();
      for (const entry of value.v) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string'
        ) {
          throw new Error('invalid remote object entry');
        }
        if (keys.has(entry[0])) throw new Error('duplicate remote object key');
        keys.add(entry[0]);
        entries.push([entry[0], decodeValue(entry[1])]);
      }
      return Object.fromEntries(entries);
    }
    default:
      throw new Error('unknown remote operation value tag');
  }
}

function encodeEnvelope(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(encodeValue(value)));
}

function decodeEnvelope(bytes: Uint8Array): unknown {
  return decodeValue(
    JSON.parse(new TextDecoder().decode(bytes)) as EncodedValue,
  );
}

export function encodeRemoteOperationRequest(
  request: RemoteOperationRequest,
): Uint8Array {
  return encodeEnvelope(request);
}

export function decodeRemoteOperationRequest(
  bytes: Uint8Array,
): RemoteOperationRequest {
  return decodeEnvelope(bytes) as RemoteOperationRequest;
}

export function encodeRemoteOperationResponse(
  response: RemoteOperationResponse,
): Uint8Array {
  return encodeEnvelope(response);
}

export function decodeRemoteOperationResponse(
  bytes: Uint8Array,
): RemoteOperationResponse {
  return decodeEnvelope(bytes) as RemoteOperationResponse;
}

export function encodeRemoteOperationRealtimeMessage(
  message: RemoteOperationRealtimeMessage,
): Uint8Array {
  return encodeEnvelope(message);
}

export function decodeRemoteOperationRealtimeMessage(
  bytes: Uint8Array,
): RemoteOperationRealtimeMessage {
  return decodeEnvelope(bytes) as RemoteOperationRealtimeMessage;
}
