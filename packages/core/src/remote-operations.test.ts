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
      cursor: 9_007_199_254_740_993n,
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
