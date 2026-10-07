/**
 * The shared adapter error contract (§10.2): `onError` observes the original
 * once without changing the response, and the optional `mapError` hook may
 * answer a catalog error with structured metadata. Mapper throws and invalid
 * returns are contained as `sync.internal_error`.
 */
import { describe, expect, test } from 'bun:test';
import {
  adapterSyncError,
  SyncError,
  type SyncularErrorMapper,
} from '@syncular/server';

describe('adapterSyncError (§10.2)', () => {
  test('a SyncError passes through and bypasses both hooks', () => {
    let observed = 0;
    let mapped = 0;
    const error = new SyncError('sync.rate_limited', 'slow down');
    const result = adapterSyncError(
      error,
      () => {
        observed += 1;
      },
      'sync',
      () => {
        mapped += 1;
        return undefined;
      },
    );
    expect(result).toBe(error);
    expect(observed).toBe(0);
    expect(mapped).toBe(0);
  });

  test('a source-compatible onError returning a number observes the original once', () => {
    const seen: unknown[] = [];
    // `array.push` returns a number; the observer contract is `void`.
    const observer = (error: unknown): number => seen.push(error);
    const result = adapterSyncError(new Error('boom'), observer, 'sync');
    expect(result.code).toBe('sync.internal_error');
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe('boom');
  });

  test('a throwing onError is contained', () => {
    const result = adapterSyncError(
      new Error('boom'),
      () => {
        throw new Error('hook failure');
      },
      'sync',
    );
    expect(result.code).toBe('sync.internal_error');
  });

  test('a mapper answers the mapped catalog error with retry metadata', () => {
    const result = adapterSyncError(
      new Error('quota'),
      undefined,
      'sync',
      () =>
        new SyncError(
          'sync.rate_limited',
          'service paused',
          JSON.stringify({ retryAfterMs: 1500 }),
        ),
    );
    expect(result.code).toBe('sync.rate_limited');
    expect(result.httpStatus).toBe(429);
    expect(result.retryable).toBe(true);
    expect(JSON.parse(result.details ?? 'null')).toEqual({
      retryAfterMs: 1500,
    });
  });

  test('a mapper returning nothing keeps sync.internal_error', () => {
    const result = adapterSyncError(
      new Error('boom'),
      undefined,
      'sync',
      () => undefined,
    );
    expect(result.code).toBe('sync.internal_error');
    expect(result.details).toBeUndefined();
  });

  test('a throwing mapper is contained', () => {
    const result = adapterSyncError(
      new Error('boom'),
      undefined,
      'sync',
      () => {
        throw new Error('mapper failure');
      },
    );
    expect(result.code).toBe('sync.internal_error');
  });

  test('a mapper returning malformed details JSON is contained', () => {
    const result = adapterSyncError(
      new Error('boom'),
      undefined,
      'sync',
      () => new SyncError('sync.rate_limited', 'paused', 'not json'),
    );
    expect(result.code).toBe('sync.internal_error');
  });

  test('a throwing metadata getter is contained', () => {
    const mapped = new SyncError('sync.rate_limited');
    Object.defineProperty(mapped, 'details', {
      get() {
        throw new Error('private mapper detail');
      },
    });
    expect(
      adapterSyncError(new Error('quota'), undefined, 'sync', () => mapped),
    ).toMatchObject({
      code: 'sync.internal_error',
      message: 'internal server error',
    });
  });

  test('mapped status and retryability come from the catalog', () => {
    const mapped = new SyncError('sync.rate_limited');
    Object.defineProperties(mapped, {
      httpStatus: { value: 200 },
      retryable: { value: false },
    });
    expect(
      adapterSyncError(new Error('quota'), undefined, 'sync', () => mapped),
    ).toMatchObject({ httpStatus: 429, retryable: true });
  });

  test('an invalid JavaScript mapper return is contained', () => {
    expect(
      Reflect.apply(adapterSyncError, undefined, [
        new Error('quota'),
        undefined,
        'sync',
        () => ({ code: 'sync.rate_limited' }),
      ]),
    ).toMatchObject({ code: 'sync.internal_error', httpStatus: 500 });
  });

  test('a mapper returning non-string details is contained', () => {
    const mapper: SyncularErrorMapper = () => {
      const error = new SyncError('sync.rate_limited', 'paused');
      Object.defineProperty(error, 'details', { value: 42 });
      return error;
    };
    expect(
      adapterSyncError(new Error('boom'), undefined, 'sync', mapper).code,
    ).toBe('sync.internal_error');
  });

  test('a mapper returning an inherited catalog name is contained', () => {
    const mapper: SyncularErrorMapper = () => {
      const error = new SyncError('sync.rate_limited', 'paused');
      Object.defineProperty(error, 'code', { value: 'toString' });
      return error;
    };
    expect(
      adapterSyncError(new Error('boom'), undefined, 'sync', mapper).code,
    ).toBe('sync.internal_error');
  });

  test('a catalog SyncError cannot be constructed from an inherited name', () => {
    for (const code of ['toString', 'constructor', 'hasOwnProperty']) {
      expect(() => new SyncError(code)).toThrow('not in the §10.2 catalog');
    }
  });
});
