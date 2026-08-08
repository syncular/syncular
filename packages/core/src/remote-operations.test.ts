import { expect, test } from 'bun:test';
import {
  decodeRemoteOperationRequest,
  encodeRemoteOperationRequest,
} from './remote-operations';

test('remote operation values preserve nested integers and bytes', () => {
  const request = {
    revision: 1,
    kind: 'query',
    clientId: 'worker',
    operationId: 'reports/by-project',
    params: {
      projectId: 'project-1',
      cursor: 9_223_372_036_854_775_807n,
      digest: new Uint8Array([0, 1, 2, 255]),
      nested: [true, null, { count: -42n }],
    },
  } as const;

  expect(
    decodeRemoteOperationRequest(encodeRemoteOperationRequest(request)),
  ).toEqual(request);
});

test('remote operation decoding rejects malformed tagged values', () => {
  expect(() =>
    decodeRemoteOperationRequest(
      new TextEncoder().encode('{"t":"bytes","v":"=bad"}'),
    ),
  ).toThrow('invalid base64 value');
});

test('remote operation values reject lossy JavaScript inputs', () => {
  expect(() =>
    encodeRemoteOperationRequest({
      revision: 1,
      kind: 'query',
      clientId: 'worker',
      operationId: 'reports/by-project',
      params: { missing: undefined },
    }),
  ).toThrow('cannot be undefined');
  expect(() =>
    encodeRemoteOperationRequest({
      revision: 1,
      kind: 'query',
      clientId: 'worker',
      operationId: 'reports/by-project',
      params: new Date(0),
    }),
  ).toThrow('plain object');
  expect(() =>
    encodeRemoteOperationRequest({
      revision: 1,
      kind: 'query',
      clientId: 'worker',
      operationId: 'reports/by-project',
      params: 9_223_372_036_854_775_808n,
    }),
  ).toThrow('signed 64-bit');
});

test('remote operation decoding rejects duplicate object keys', () => {
  expect(() =>
    decodeRemoteOperationRequest(
      new TextEncoder().encode(
        '{"t":"object","v":[["x",{"t":"null"}],["x",{"t":"null"}]]}',
      ),
    ),
  ).toThrow('duplicate remote object key');
  expect(() =>
    decodeRemoteOperationRequest(
      new TextEncoder().encode('{"t":"bytes","v":"AB=="}'),
    ),
  ).toThrow('invalid base64 value');
  expect(() =>
    decodeRemoteOperationRequest(
      new TextEncoder().encode('{"t":"integer","v":"9223372036854775808"}'),
    ),
  ).toThrow('signed 64-bit');
});
